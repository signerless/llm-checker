/**
 * Unified Scoring Core (GitHub issue #88)
 * =======================================
 *
 * Historically the three user-facing recommendation surfaces each ran a
 * DIFFERENT scoring engine, so they could disagree about the best model and
 * only one of them ("recommend") received the PR #89 high-capacity
 * right-sizing fix:
 *
 *   - `check`           -> MultiObjectiveSelector  (src/ai/multi-objective-selector.js)
 *   - `recommend`       -> DeterministicModelSelector (src/models/deterministic-selector.js)
 *   - `smart-recommend` -> ScoringEngine            (src/models/scoring-engine.js)
 *
 * This module establishes the DeterministicModelSelector as the SINGLE
 * canonical ranking core (it already carries PR #89's
 * `calculateHighCapacitySizeAdjustment` / `getHighCapacitySizeTarget`). The
 * other commands keep their own model SOURCE and DISPLAY shape, but route the
 * actual ranking/selection through `rankModels()` below so that, for identical
 * (model, hardware) inputs, every command produces identical scores and the
 * high-capacity floor applies everywhere.
 *
 * The hard part is that each command feeds the engine a different model shape:
 *   - `check` uses ExpandedModelsDatabase rows ({ name: "Llama 3.1 8B", size: "8B", ... })
 *   - `smart-recommend` uses sql.js variant rows ({ model_id, params_b, size_gb, quant, ... })
 *   - `recommend` uses the Ollama scrape/catalog (already deterministic-friendly)
 *
 * `normalizeToDeterministic()` converts any of those into the
 * already-normalized deterministic model shape and keeps a back-reference
 * (`__source`) so callers can recover their original object after ranking.
 */

const DeterministicModelSelector = require('./deterministic-selector');

// One shared selector instance: it is stateless w.r.t. the model pool (the
// pool is always passed in via options), so sharing it is safe and avoids
// re-allocating the large prior tables on every call.
const canonicalSelector = new DeterministicModelSelector();

const PARAM_HINT_REGEX = /(\d+(?:\.\d+)?)\s*([bm])\b/i;

function toFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return null;
}

/**
 * Best-effort parameter-count extraction (in billions) from a model's various
 * shapes. Mirrors the heuristics the individual engines used so the unified
 * ranking sees the same parameter counts they would have.
 */
function deriveParamsB(model = {}) {
    const direct =
        toFiniteNumber(model.paramsB) ??
        toFiniteNumber(model.params_b) ??
        toFiniteNumber(model.parameter_count_b);
    if (Number.isFinite(direct) && direct > 0) return direct;

    // Parse from explicit "size" / name strings (e.g. "8B", "Qwen 0.5B", "405b").
    const textCandidates = [model.size, model.parameter_size, model.name, model.model_name, model.model_id, model.model_identifier, model.tag];
    for (const candidate of textCandidates) {
        if (typeof candidate !== 'string') continue;
        const match = candidate.match(PARAM_HINT_REGEX);
        if (match) {
            const value = parseFloat(match[1]);
            if (Number.isFinite(value) && value > 0) {
                return match[2].toLowerCase() === 'm' ? value / 1000 : value;
            }
        }
    }

    // Fall back to inferring from an artifact size in GB (Q4 ~ 0.6GB/B).
    const sizeGB = deriveSizeGB(model, null);
    if (Number.isFinite(sizeGB) && sizeGB > 0) {
        return Math.max(0.5, Math.round((sizeGB / 0.6) * 2) / 2);
    }

    return 7; // Same neutral fallback the engines used.
}

function deriveSizeGB(model = {}, paramsB = null) {
    const direct =
        toFiniteNumber(model.sizeGB) ??
        toFiniteNumber(model.size_gb) ??
        toFiniteNumber(model.real_size_gb) ??
        toFiniteNumber(model.estimated_size_gb);
    if (Number.isFinite(direct) && direct > 0) return direct;

    // "size" may be a file size like "4.4GB" (vs a parameter count like "8B").
    if (typeof model.size === 'string') {
        const gbMatch = model.size.match(/(\d+(?:\.\d+)?)\s*g(?:i)?b\b/i);
        if (gbMatch) return parseFloat(gbMatch[1]);
    }
    if (typeof model.installedSize === 'string') {
        const gbMatch = model.installedSize.match(/(\d+(?:\.\d+)?)\s*g(?:i)?b\b/i);
        if (gbMatch) return parseFloat(gbMatch[1]);
    }

    if (Number.isFinite(paramsB) && paramsB > 0) {
        return Math.max(0.4, Math.round((paramsB * 0.6 + 0.4) * 10) / 10);
    }
    return null;
}

function deriveContext(model = {}) {
    const candidates = [
        model.ctxMax,
        model.context_length,
        model.contextLength,
        model.context,
        model.performance && model.performance.context_length
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
            return Math.round(candidate);
        }
        if (typeof candidate === 'string') {
            const parsed = canonicalSelector.parseContextLength(candidate);
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
    }
    return 4096;
}

function deriveQuant(model = {}) {
    const candidates = [model.quant, model.quantization];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return canonicalSelector.normalizeQuantization(candidate);
        }
        if (Array.isArray(candidate) && candidate.length > 0) {
            // ExpandedModelsDatabase stores quantization as an array of options;
            // prefer the highest-quality option that the hierarchy knows about.
            const normalized = candidate.map((q) => canonicalSelector.normalizeQuantization(q));
            for (const q of canonicalSelector.quantHierarchy) {
                if (normalized.includes(q)) return q;
            }
            return normalized[0];
        }
    }
    return 'Q4_K_M';
}

function deriveModalities(model = {}) {
    if (Array.isArray(model.modalities) && model.modalities.length > 0) {
        return model.modalities.map((m) => String(m).toLowerCase());
    }
    const text = [
        model.name,
        model.model_name,
        model.model_id,
        model.model_identifier,
        model.specialization,
        model.category,
        ...(Array.isArray(model.capabilities) ? model.capabilities : [String(model.capabilities || '')]),
        ...(Array.isArray(model.input_types) ? model.input_types : [])
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    const hasVision = /\b(vision|vl\b|llava|bakllava|moondream|multimodal|image)\b/.test(text);
    return hasVision ? ['text', 'vision'] : ['text'];
}

function deriveTags(model = {}, modalities = ['text']) {
    const explicit = Array.isArray(model.tags) ? model.tags.map((t) => String(t).toLowerCase()) : [];
    const tags = new Set(explicit);

    const text = [
        model.name,
        model.model_name,
        model.model_id,
        model.model_identifier,
        model.specialization,
        model.category,
        model.tag,
        ...(Array.isArray(model.capabilities)
            ? model.capabilities
            : [String(model.capabilities || '')]),
        ...(Array.isArray(model.use_cases) ? model.use_cases : [])
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    if (/\b(coder|code|programming|deepseek-coder|starcoder|codellama|codegemma)\b/.test(text)) tags.add('coder');
    if (/\binstruct\b/.test(text)) tags.add('instruct');
    if (/\b(chat|assistant|conversation)\b/.test(text)) tags.add('chat');
    if (/\bembed/.test(text)) tags.add('embedding');
    if (/\b(reason|math|logic)\b/.test(text)) tags.add('reasoning');
    if (modalities.includes('vision')) tags.add('vision');

    // Most general/instruct models should compete in the general category even
    // when no explicit tag exists, matching the permissive engines' behavior.
    if (tags.size === 0) tags.add('chat');

    return [...tags];
}

function deriveIdentifier(model = {}) {
    return (
        model.model_identifier ||
        model.tag ||
        model.model_id ||
        model.model_name ||
        model.name ||
        'unknown-model'
    );
}

/**
 * Convert an arbitrary model object (any of the three command shapes) into the
 * already-normalized deterministic model shape. The original object is kept on
 * `__source` so callers can map ranking output back to their display shape.
 */
function normalizeToDeterministic(model = {}) {
    const paramsB = deriveParamsB(model);
    const sizeGB = deriveSizeGB(model, paramsB) ?? Math.max(0.4, paramsB * 0.6);
    const modalities = deriveModalities(model);
    const tags = deriveTags(model, modalities);
    const quant = deriveQuant(model);
    const identifier = deriveIdentifier(model);

    const moeFlag = Boolean(model.isMoE || model.is_moe);
    const totalParamsB =
        toFiniteNumber(model.totalParamsB) ?? toFiniteNumber(model.total_params_b) ?? null;
    const activeParamsB =
        toFiniteNumber(model.activeParamsB) ?? toFiniteNumber(model.active_params_b) ?? null;

    return {
        // Canonical deterministic fields (pass `alreadyNormalized` branch).
        name: identifier,
        model_identifier: identifier,
        family: model.family || canonicalSelector.extractFamily(String(identifier)),
        paramsB,
        ctxMax: deriveContext(model),
        quant,
        sizeGB,
        modalities,
        tags,
        installed: Boolean(model.installed || model.isOllamaInstalled),
        pulls: toFiniteNumber(model.pulls) ?? toFiniteNumber(model.actual_pulls) ?? 0,
        availableQuantizations: [quant],
        sizeByQuant: { [quant]: sizeGB },
        // MoE passthrough so memory/speed estimation stays accurate.
        isMoE: moeFlag,
        is_moe: moeFlag,
        totalParamsB,
        activeParamsB,
        expertCount: toFiniteNumber(model.expertCount) ?? toFiniteNumber(model.expert_count) ?? null,
        expertsActivePerToken:
            toFiniteNumber(model.expertsActivePerToken) ??
            toFiniteNumber(model.experts_active_per_token) ??
            null,
        // Freshness defaults: neutral so we never penalize callers that lack
        // timestamps (the per-command sources already carry these when known).
        freshnessScore: toFiniteNumber(model.freshnessScore) ?? 55,
        isStale: Boolean(model.isStale),
        isDeprecated: Boolean(model.isDeprecated || model.deprecated),
        source: model.source || 'unified_core',
        // Back-reference for result mapping.
        __source: model
    };
}

/**
 * Canonical ranking entrypoint. Returns the deterministic selector's ranked
 * candidates (each carries `.score`, `.components {Q,S,F,C,H}`, `.meta`, etc.)
 * for the supplied models/hardware. Each candidate's `meta.__source` points
 * back to the caller's original model object.
 *
 * @param {Array<Object>} models   Arbitrary model objects (any command shape).
 * @param {Object} hardware        Hardware profile (any detector shape).
 * @param {Object} options
 * @param {string} [options.category='general']  Use-case / category.
 * @param {string} [options.optimizeFor='balanced']
 * @param {string} [options.runtime='ollama']
 * @param {number} [options.topN]  Limit (default: all candidates).
 * @returns {Promise<{category, candidates, total_evaluated, hardware}>}
 */
async function rankModels(models, hardware, options = {}) {
    const category = normalizeCategory(options.category || options.useCase || 'general');
    const pool = (Array.isArray(models) ? models : [])
        .filter(Boolean)
        .map(normalizeToDeterministic);

    const result = await canonicalSelector.selectModels(category, {
        topN: typeof options.topN === 'number' ? options.topN : pool.length || 1,
        enableProbe: false,
        silent: true,
        optimizeFor: options.optimizeFor || options.optimize || options.objective || 'balanced',
        runtime: options.runtime || 'ollama',
        hardware: hardware || undefined,
        installedModels: [],
        modelPool: pool
    });

    return result;
}

/**
 * Map deterministic-engine categories from the broader vocabulary the commands
 * use (e.g. `check`/`smart-recommend` accept `chat`, `creative`, `vision`,
 * `talking`) onto the categories the deterministic core scores.
 */
function normalizeCategory(category) {
    const normalized = String(category || 'general').toLowerCase().trim();
    const map = {
        general: 'general',
        chat: 'general',
        talking: 'general',
        assistant: 'general',
        coding: 'coding',
        code: 'coding',
        programming: 'coding',
        reasoning: 'reasoning',
        math: 'reasoning',
        multimodal: 'multimodal',
        vision: 'multimodal',
        embeddings: 'embeddings',
        embedding: 'embeddings',
        summarization: 'summarization',
        reading: 'reading',
        creative: 'general',
        fast: 'general',
        quality: 'general',
        longctx: 'reading'
    };
    return map[normalized] || 'general';
}

module.exports = {
    canonicalSelector,
    rankModels,
    normalizeToDeterministic,
    normalizeCategory,
    deriveParamsB,
    deriveSizeGB
};
