const ModelDatabase = require('./model-database');
const DeterministicModelSelector = require('../models/deterministic-selector');

function toArray(value) {
    return Array.isArray(value) ? value : [];
}

function parseParamsB(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return value;
        }
        const text = String(value || '').replace(/,/g, '');
        // Mixture-of-Experts "NxMB" (e.g. 8x7B) -> experts * per-expert size,
        // so MoE models are not sized as if they were a single expert.
        const moe = text.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/i);
        if (moe) {
            const experts = Number(moe[1]);
            const perExpert = Number(moe[2]);
            if (experts > 0 && Number.isFinite(perExpert) && perExpert > 0) {
                return experts * perExpert;
            }
        }
        const match = text.match(/(\d+(?:\.\d+)?)\s*([bmt])\b/i);
        if (!match) continue;
        const amount = Number(match[1]);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const unit = match[2].toLowerCase();
        if (unit === 't') return amount * 1000;
        if (unit === 'm') return amount / 1000;
        return amount;
    }
    return null;
}

// Active-param naming, e.g. "...-A17B" in "Qwen3-397B-A17B".
function parseActiveParamsFromName(...values) {
    for (const value of values) {
        const m = String(value || '').match(/(?:^|[-_\s/])a(\d+(?:\.\d+)?)\s*b\b/i);
        if (m) {
            const v = Number(m[1]);
            if (Number.isFinite(v) && v > 0) return v;
        }
    }
    return null;
}

// Detect Mixture-of-Experts naming so we size by total params (memory) and can
// apply MoE speed assumptions. Covers "8x7B", "397B-A17B", "moe", and Mixtral.
function isMoEName(...values) {
    return values.some((value) =>
        /(\d+\s*x\s*\d+(?:\.\d+)?\s*b\b)|(\d+(?:\.\d+)?\s*b[-_\s]*a\d)|\bmoe\b|mixtral/i.test(String(value || ''))
    );
}

function inferFamily(identifier = '') {
    const text = String(identifier || '').toLowerCase();
    const families = [
        ['deepseek-r1', /deepseek[-_ ]?r1/],
        ['deepseek-coder', /deepseek[-_ ]?coder/],
        ['deepseek', /deepseek/],
        ['qwen3', /qwen3/],
        ['qwen2.5', /qwen2\.5/],
        ['qwen2', /qwen2/],
        ['qwen', /qwen/],
        ['llama3.2', /llama3\.2|llama-?3\.2/],
        ['llama3.1', /llama3\.1|llama-?3\.1/],
        ['llama3', /llama3|llama-?3/],
        ['llama2', /llama2|llama-?2/],
        ['mistral', /mistral/],
        ['mixtral', /mixtral/],
        ['gemma3', /gemma3/],
        ['gemma2', /gemma2/],
        ['gemma', /gemma/],
        ['phi4', /phi-?4/],
        ['phi3', /phi-?3/],
        ['phi', /phi/],
        ['codellama', /codellama|code-?llama/],
        ['starcoder', /starcoder/],
        ['llava', /llava/],
        ['nomic-embed', /nomic-embed/],
        ['bge', /\bbge\b/]
    ];

    for (const [family, pattern] of families) {
        if (pattern.test(text)) return family;
    }
    return 'other';
}

function normalizeQuantization(row = {}) {
    const raw = row.quantization || row.precision || '';
    if (raw) return raw;
    if (row.format === 'safetensors' || row.format === 'pytorch' || row.format === 'pytorch_bin') {
        return 'FP16';
    }
    return 'Q4_K_M';
}

function isShardedWeightFile(filename = '') {
    return /-\d{5,}-of-\d{5,}\.(safetensors|bin)$/i.test(String(filename || ''));
}

function choosePreferredRuntime(runtimeSupport = [], format = '', sourceId = '') {
    const runtimes = toArray(runtimeSupport).map((runtime) => String(runtime).toLowerCase());
    const normalizedFormat = String(format || '').toLowerCase();
    const source = String(sourceId || '').toLowerCase();

    if (source === 'ollama' || runtimes.includes('ollama')) return 'ollama';
    if (normalizedFormat === 'mlx' || runtimes.includes('mlx')) return 'mlx';
    if (normalizedFormat === 'gguf' || runtimes.includes('llama.cpp')) return 'llama.cpp';
    if (runtimes.includes('vllm')) return 'vllm';
    if (runtimes.includes('transformers')) return 'transformers';
    return runtimes[0] || 'transformers';
}

function artifactToSelectorModel(row) {
    const shardedFile = row.source_id === 'huggingface' && isShardedWeightFile(row.filename || row.artifact_name);
    const identifier = shardedFile
        ? (row.canonical_model_id || row.repo_id)
        : (row.artifact_name || row.filename || row.canonical_model_id || row.repo_id);
    const displayName = row.canonical_model_id || row.repo_display_name || identifier;
    const quant = normalizeQuantization(row);

    // MEMORY sizing must use the TOTAL parameter count (for MoE, ALL experts are
    // resident), never the active count. We re-derive the total from the model
    // name (MoE-aware) and take the max with the stored column, so a stale or
    // under-reported DB value (an MoE saved as one expert, or an active-param
    // count) can never make a huge model look tiny and "fit" small hardware.
    const nameStrings = [row.artifact_name, row.filename, row.canonical_model_id, row.repo_id];
    const storedTotalB = parseParamsB(row.parameter_count_b);
    const nameTotalB = parseParamsB(...nameStrings);
    const totalParamsB = Math.max(storedTotalB || 0, nameTotalB || 0) || null;
    const activeParamsB = parseParamsB(row.active_parameter_count_b) || parseActiveParamsFromName(...nameStrings);
    const isMoE = isMoEName(...nameStrings)
        || (Number.isFinite(activeParamsB) && Number.isFinite(totalParamsB) && activeParamsB < totalParamsB);

    // The sizing param is the total; fall back to the active count only if no
    // total can be determined at all.
    const paramsB = Number.isFinite(totalParamsB) && totalParamsB > 0
        ? totalParamsB
        : parseParamsB(row.active_parameter_count_b);

    if (!identifier || !Number.isFinite(paramsB) || paramsB <= 0) {
        return null;
    }

    // Flag MoE and carry the TOTAL parameter count so memory is sized by the
    // full weight set (all experts are resident under Ollama / Metal / vLLM).
    // We deliberately do NOT set activeParamsB here: that would switch the memory
    // model to "sparse inference" (sizing by active params), which would let a
    // 397B-A17B model falsely "fit" ~11GB. Active params drive speed only, and
    // sparse offload is not how the local runtimes this tool targets behave, so
    // we stay conservative on memory.
    const moeFields = {};
    if (isMoE && Number.isFinite(totalParamsB) && totalParamsB > 0) {
        moeFields.isMoE = true;
        moeFields.totalParamsB = totalParamsB;
        moeFields.total_params_b = totalParamsB;
    }

    const runtimeSupport = toArray(row.runtime_support);
    const preferredRuntime = choosePreferredRuntime(runtimeSupport, row.format, row.source_id);
    const tasks = toArray(row.tasks);
    const modalities = toArray(row.modalities);
    const tags = [
        row.source_id,
        row.format,
        quant,
        ...runtimeSupport,
        ...tasks
    ]
        .filter(Boolean)
        .map((tag) => String(tag).toLowerCase());

    const sizeGB = Number(row.size_gb);
    const sizeByQuant = Number.isFinite(sizeGB) && sizeGB > 0
        ? { [quant]: sizeGB }
        : {};

    return {
        name: displayName,
        model_identifier: identifier,
        family: inferFamily(`${displayName} ${identifier}`),
        paramsB,
        ...moeFields,
        quant,
        availableQuantizations: [quant],
        sizeGB: Number.isFinite(sizeGB) && sizeGB > 0 ? sizeGB : undefined,
        sizeByQuant,
        ctxMax: Number(row.context_length) > 0 ? Number(row.context_length) : 4096,
        tags,
        modalities: modalities.length > 0 ? modalities : ['text'],
        pulls: Number(row.downloads) || 0,
        source: row.source_id,
        registry: row.source_name || row.source_id,
        version: shardedFile ? (row.repo_id || identifier) : (row.artifact_name || row.filename || identifier),
        license: row.license || 'unknown',
        digest: row.sha256 || row.etag || 'unknown',
        installCommand: shardedFile && row.repo_id ? `hf download ${row.repo_id}` : (row.install_command || ''),
        downloadUrl: shardedFile ? (row.repo_url || '') : (row.download_url || ''),
        preferredRuntime,
        artifact: row,
        provenance: {
            source: row.source_id,
            registry: row.source_name || row.source_id,
            version: shardedFile ? (row.repo_id || identifier) : (row.artifact_name || row.filename || identifier),
            license: row.license || 'unknown',
            digest: row.sha256 || row.etag || 'unknown',
            download_url: shardedFile ? (row.repo_url || '') : (row.download_url || ''),
            install_command: shardedFile && row.repo_id ? `hf download ${row.repo_id}` : (row.install_command || ''),
            repo_url: row.repo_url || ''
        }
    };
}

function dedupeRecommendationPool(models) {
    const deduped = new Map();
    for (const model of models) {
        const artifact = model.artifact || {};
        const key = [
            model.source,
            artifact.repo_id || model.name,
            model.model_identifier,
            model.preferredRuntime
        ].join('|');

        const existing = deduped.get(key);
        if (!existing) {
            deduped.set(key, model);
            continue;
        }

        const existingSize = Number(existing.sizeGB || existing.artifact?.size_gb || Number.MAX_SAFE_INTEGER);
        const size = Number(model.sizeGB || model.artifact?.size_gb || Number.MAX_SAFE_INTEGER);
        if (size < existingSize) {
            deduped.set(key, model);
        }
    }
    return [...deduped.values()];
}

// A source may trail the top score by up to this and still earn a guaranteed slot.
const SOURCE_DIVERSITY_MARGIN = 15;
// Never surface a model below this score purely for source diversity.
const SOURCE_DIVERSITY_FLOOR = 55;

// Group key that ignores quantization / shard / tag so variants of the SAME
// model collapse together (e.g. all `qwen2.5-coder:7b-*` quants, or every
// `layers-N.safetensors` shard of one HF repo).
function modelDiversityKey(candidate) {
    const meta = (candidate && candidate.meta) || {};
    const name = String(meta.name || meta.model_identifier || '')
        .toLowerCase()
        .replace(/:.*$/, '')   // drop an ollama :tag
        .replace(/\s+/g, ' ')
        .trim();
    const params = Number(meta.paramsB) > 0 ? Math.round(Number(meta.paramsB) * 10) / 10 : 'na';
    return `${name}|${params}`;
}

// Collapse quant/shard/tag variants of the same model to a single best-scoring
// entry, so the top picks are DISTINCT models instead of 12 quants of one.
function collapseToDistinctModels(candidates) {
    const best = new Map();
    for (const c of Array.isArray(candidates) ? candidates : []) {
        if (!c) continue;
        const key = modelDiversityKey(c);
        const cur = best.get(key);
        if (!cur || (Number(c.score) || 0) > (Number(cur.score) || 0)) best.set(key, c);
    }
    return [...best.values()].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
}

// Guarantee that each source with a competitive candidate appears in the top
// `limit`, so Hugging Face / GPT4All artifacts are visible when they score close
// to Ollama. Diversity never promotes a clearly worse model (floor + margin gates).
function applySourceDiversity(distinctSorted, limit) {
    const list = Array.isArray(distinctSorted) ? distinctSorted : [];
    if (list.length === 0) return [];
    const max = Number(limit) > 0 ? Number(limit) : 10;
    const topScore = Number(list[0].score) || 0;

    const seeds = [];
    const seenSource = new Set();
    for (const c of list) {
        const src = (c.meta && c.meta.source) || 'unknown';
        if (seenSource.has(src)) continue;
        const score = Number(c.score) || 0;
        if (score >= SOURCE_DIVERSITY_FLOOR && score >= topScore - SOURCE_DIVERSITY_MARGIN) {
            seeds.push(c);
            seenSource.add(src);
        }
    }

    const chosen = new Set(seeds);
    const result = [...seeds];
    for (const c of list) {
        if (result.length >= max) break;
        if (chosen.has(c)) continue;
        result.push(c);
        chosen.add(c);
    }
    return result
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
        .slice(0, max);
}

function candidateToRecommendation(candidate) {
    const artifact = candidate.meta.artifact || {};
    return {
        model: candidate.meta.name,
        artifact: candidate.meta.model_identifier,
        source: candidate.meta.source,
        registry: candidate.meta.registry,
        score: candidate.score,
        params_b: candidate.meta.paramsB,
        quantization: candidate.quant,
        size_gb: candidate.meta.sizeGB || artifact.size_gb || null,
        required_gb: candidate.requiredGB,
        estimated_tps: candidate.estTPS,
        runtime: candidate.runtime,
        install_command: candidate.meta.installCommand || artifact.install_command || '',
        download_url: candidate.meta.downloadUrl || artifact.download_url || '',
        license: candidate.meta.license,
        gated: Boolean(artifact.gated),
        requires_auth: Boolean(artifact.requires_auth),
        tasks: toArray(artifact.tasks),
        modalities: toArray(artifact.modalities),
        rationale: candidate.rationale,
        components: candidate.components,
        memory: candidate.memory,
        speed: candidate.speed
    };
}

function normalizeHardwareForSelector(hardware = {}) {
    if (hardware.memory?.totalGB && hardware.gpu && hardware.acceleration) {
        return hardware;
    }

    const summary = hardware.summary || {};
    const cpuInfo = hardware.cpu || hardware.backends?.cpu?.info || {};
    const cpuCores = cpuInfo.cores || {};
    const bestBackend = summary.bestBackend || hardware.primary?.type || 'cpu';
    const systemRAM = Number(summary.systemRAM || summary.effectiveMemory || 8);
    const totalVRAM = Number(summary.totalVRAM || 0);
    const gpuModel = summary.gpuModel || summary.gpuInventory || hardware.primary?.name || '';
    const isMetal = bestBackend === 'metal';
    const isCuda = bestBackend === 'cuda';
    const isRocm = bestBackend === 'rocm';

    return {
        cpu: {
            architecture: cpuInfo.architecture || process.arch,
            cores: Number(cpuCores.logical || cpuCores.physical || cpuInfo.cores || 4),
            model: cpuInfo.brand || summary.cpuModel || ''
        },
        gpu: {
            type: isMetal ? 'apple_silicon' : (isCuda ? 'nvidia' : (isRocm ? 'amd' : 'cpu_only')),
            model: gpuModel,
            vramGB: totalVRAM,
            totalVRAM,
            gpuCount: Math.max(1, Number(summary.gpuCount || 1)),
            unified: Boolean(isMetal || (summary.hasIntegratedGPU && !summary.hasDedicatedGPU)),
            isMultiGPU: Boolean(summary.isMultiGPU)
        },
        memory: {
            totalGB: systemRAM,
            total: systemRAM
        },
        acceleration: {
            supports_metal: isMetal,
            supports_cuda: isCuda,
            supports_rocm: isRocm
        },
        usableMemGB: Number(summary.effectiveMemory) > 0 ? Number(summary.effectiveMemory) : undefined
    };
}

class RegistryRecommender {
    constructor(options = {}) {
        this.database = options.database || new ModelDatabase(options.databaseOptions || {});
        this.selector = options.selector || new DeterministicModelSelector();
    }

    async initialize() {
        await this.database.initialize();
    }

    async recommend(options = {}) {
        const selection = await this.selectCategory(options);
        return {
            category: selection.category,
            runtime: selection.runtime,
            optimizeFor: selection.result.optimizeFor,
            total_artifacts: selection.rows.length,
            total_candidates: selection.modelPool.length,
            total_evaluated: selection.result.total_evaluated,
            recommendations: selection.result.candidates.map(candidateToRecommendation),
            registry: this.database.getRegistryStats(),
            generated_at: new Date().toISOString()
        };
    }

    async selectCategory(options = {}) {
        const category = options.category || 'general';
        const runtime = options.runtime || 'auto';
        const runtimeFilter = ['auto', 'all', '*'].includes(String(runtime).toLowerCase()) ? undefined : runtime;
        const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
        const poolLimit = Number(options.poolLimit) > 0 ? Number(options.poolLimit) : 20000;
        const targetCtx = Number(options.targetContext) > 0 ? Number(options.targetContext) : undefined;

        const rows = this.database.searchModelArtifacts(options.query || '', {
            source: options.source,
            format: options.format,
            runtime: runtimeFilter,
            quantization: options.quantization,
            maxSizeGB: options.maxSizeGB,
            minParamsB: options.minParamsB,
            maxParamsB: options.maxParamsB,
            localOnly: options.localOnly !== false,
            limit: poolLimit
        });
        const modelPool = dedupeRecommendationPool(rows.map(artifactToSelectorModel).filter(Boolean));

        const selectorHardware = normalizeHardwareForSelector(options.hardware || {});
        const normalizedRuntime = runtimeFilter || 'auto';
        // Rank a wider window than requested so we can collapse model variants and
        // apply source diversity before trimming to the caller's limit.
        const rankWindow = Math.max(limit * 8, 200);
        const result = runtimeFilter
            ? await this.selector.selectModels(category, {
                topN: rankWindow,
                enableProbe: false,
                silent: true,
                optimizeFor: options.optimizeFor || 'balanced',
                runtime: runtimeFilter,
                targetCtx,
                hardware: selectorHardware,
                installedModels: [],
                modelPool
            })
            : this.scoreAutoRuntimePool({
                category,
                limit: rankWindow,
                targetCtx,
                optimizeFor: options.optimizeFor || 'balanced',
                hardware: selectorHardware,
                modelPool
            });

        // Collapse quant/shard variants to distinct models, then guarantee source
        // diversity, and finally trim to the requested limit.
        if (result && Array.isArray(result.candidates)) {
            const distinct = collapseToDistinctModels(result.candidates);
            result.candidates = applySourceDiversity(distinct, limit);
        }

        return {
            category,
            runtime: normalizedRuntime,
            rows,
            modelPool,
            result
        };
    }

    async getBestModelsForHardware(hardware, options = {}) {
        const categories = options.categories || ['coding', 'reasoning', 'multimodal', 'creative', 'talking', 'reading', 'general'];
        const recommendations = {};
        const runtime = options.runtime || 'auto';
        const optimizeFor = options.optimizeFor || options.optimize || 'balanced';
        const limit = Number(options.limit) > 0 ? Number(options.limit) : 3;
        const registryStats = this.database.getRegistryStats();
        const analyzedModels = new Set();

        for (const category of categories) {
            try {
                const selection = await this.selectCategory({
                    ...options,
                    category,
                    runtime,
                    optimizeFor,
                    limit,
                    hardware
                });
                for (const model of selection.modelPool) {
                    const artifact = model.artifact || {};
                    analyzedModels.add([
                        artifact.artifact_id || artifact.id || artifact.filename || model.model_identifier,
                        model.source,
                        model.preferredRuntime
                    ].filter(Boolean).join('|'));
                }
                const normalizedHardware = this.selector.normalizeHardwareProfile(
                    normalizeHardwareForSelector(hardware || {})
                );
                recommendations[category] = {
                    tier: this.selector.mapHardwareTier(normalizedHardware),
                    optimizeFor: selection.result.optimizeFor,
                    runtime: selection.runtime,
                    source: 'registry',
                    bestModels: selection.result.candidates.map((candidate) => this.selector.mapCandidateToLegacyFormat(candidate)),
                    totalEvaluated: selection.result.total_evaluated,
                    totalArtifacts: selection.rows.length,
                    totalCandidates: selection.modelPool.length,
                    category: this.selector.getCategoryInfo(category)
                };
            } catch (error) {
                recommendations[category] = {
                    tier: 'unknown',
                    optimizeFor,
                    runtime,
                    source: 'registry',
                    bestModels: [],
                    totalEvaluated: 0,
                    totalArtifacts: 0,
                    totalCandidates: 0,
                    error: error.message,
                    category: this.selector.getCategoryInfo(category)
                };
            }
        }

        return {
            recommendations,
            registryStats,
            totalModelsAnalyzed: analyzedModels.size
        };
    }

    scoreAutoRuntimePool({ category, limit, targetCtx, optimizeFor, hardware, modelPool }) {
        const normalizedHardware = this.selector.normalizeHardwareProfile(hardware);
        const objective = this.selector.normalizeOptimizationObjective(optimizeFor);
        const ctx = targetCtx || this.selector.targetContexts[category] || this.selector.targetContexts.general;
        const totalMem = normalizedHardware?.memory?.totalGB ?? normalizedHardware?.memory?.total ?? 8;
        const usableMem = typeof normalizedHardware.usableMemGB === 'number'
            ? normalizedHardware.usableMemGB
            : Math.max(1, Math.min(0.8 * totalMem, totalMem - 2));
        const isUnified = Boolean(normalizedHardware?.gpu?.unified) || normalizedHardware?.gpu?.type === 'apple_silicon';
        const vram = normalizedHardware?.gpu?.vramGB ?? normalizedHardware?.gpu?.vram ?? 0;
        const budget = isUnified ? usableMem : (vram || usableMem);
        const filtered = this.selector.filterByCategory(modelPool, category);
        const candidates = [];

        for (const model of filtered) {
            const runtime = model.preferredRuntime || choosePreferredRuntime(
                model.artifact?.runtime_support,
                model.artifact?.format,
                model.source
            );
            const candidate = this.selector.evaluateModel(
                model,
                normalizedHardware,
                category,
                ctx,
                budget,
                objective,
                runtime
            );
            if (candidate) candidates.push(candidate);
        }

        candidates.sort((a, b) => b.score - a.score);

        return {
            category,
            optimizeFor: objective,
            runtime: 'auto',
            hardware: normalizedHardware,
            // Return a wide sorted window; selectCategory collapses variants and
            // applies source diversity before trimming to the caller's limit.
            candidates: candidates.slice(0, Math.max(limit, 2000)),
            total_evaluated: filtered.length,
            timestamp: new Date().toISOString()
        };
    }

    close() {
        this.database.close();
    }
}

module.exports = {
    RegistryRecommender,
    collapseToDistinctModels,
    applySourceDiversity,
    modelDiversityKey,
    artifactToSelectorModel,
    candidateToRecommendation,
    normalizeHardwareForSelector,
    choosePreferredRuntime,
    dedupeRecommendationPool
};
