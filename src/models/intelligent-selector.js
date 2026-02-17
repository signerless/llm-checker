/**
 * Intelligent Model Selector
 * Uses scoring engine and hardware detection to recommend optimal LLM models
 * Provides smart recommendations based on use case, hardware, and preferences
 */

const fs = require('fs');
const path = require('path');
const ScoringEngine = require('./scoring-engine');
const UnifiedDetector = require('../hardware/unified-detector');
const PolicyManager = require('../policy/policy-manager');
const PolicyEngine = require('../policy/policy-engine');

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class IntelligentSelector {
    constructor(options = {}) {
        this.scoring = new ScoringEngine(options.scoring || {});
        this.detector = options.detector || new UnifiedDetector();
        this.database = options.database || null;
        this.policyManager = options.policyManager || new PolicyManager();
        this.policyEngine = options.policyEngine || null;
        this.defaultPolicyFile = options.policyFile || 'policy.yaml';

        // Default preferences
        this.defaults = {
            useCase: 'general',
            targetContext: 8192,
            targetTPS: 20,
            preferQuantization: null,  // null = auto select
            preferFamily: null,
            maxSize: null,  // null = auto from hardware
            minSize: null,
            excludeFamilies: [],
            includeVision: false,
            includeEmbeddings: false,
            policyFile: this.defaultPolicyFile,
            limit: 10
        };
    }

    /**
     * Initialize hardware detection
     */
    async init() {
        await this.detector.detect();
    }

    /**
     * Get optimal model recommendations
     *
     * @param {Array} variants - Array of model variants from database
     * @param {Object} options - Selection options
     * @returns {Object} Recommendations organized by category
     */
    async recommend(variants, options = {}) {
        // Merge with defaults
        const opts = { ...this.defaults, ...options };

        // Ensure hardware is detected
        const hardware = await this.detector.detect();

        // Apply filters
        const filtered = this.applyFilters(variants, opts, hardware);

        // Score all filtered variants
        const scored = this.scoring.filterAndScore(filtered, hardware, {
            useCase: opts.useCase,
            targetContext: opts.targetContext,
            targetTPS: opts.targetTPS,
            headroom: opts.headroom || 2
        });

        const policyEngine = this.resolvePolicyEngine(opts);
        const scoredWithPolicy = policyEngine.evaluateScoredVariants(
            scored,
            this.buildPolicyContext(hardware, opts)
        );

        // Categorize scores
        const categories = this.scoring.categorizeScores(scoredWithPolicy);

        // Get top picks
        const topPicks = this.selectTopPicks(scoredWithPolicy, opts);

        // Generate insights
        const insights = this.generateInsights(scoredWithPolicy, hardware, opts);

        return {
            topPicks,
            categories,
            all: scoredWithPolicy.slice(0, opts.limit),
            hardware: {
                description: this.detector.getHardwareDescription(),
                tier: this.detector.getHardwareTier(),
                maxSize: this.detector.getMaxModelSize(),
                backend: hardware.summary.bestBackend
            },
            policy: {
                mode: policyEngine.getMode(),
                active: policyEngine.hasActiveRules()
            },
            insights,
            meta: {
                totalCandidates: variants.length,
                afterFiltering: filtered.length,
                useCase: opts.useCase
            }
        };
    }

    /**
     * Resolve policy engine from explicit options, in-memory policy, or policy file.
     */
    resolvePolicyEngine(opts = {}) {
        const explicitEngine = opts.policyEngine || this.policyEngine;
        if (
            explicitEngine &&
            typeof explicitEngine.evaluateScoredVariants === 'function' &&
            typeof explicitEngine.getMode === 'function'
        ) {
            return explicitEngine;
        }

        if (isPlainObject(opts.policy)) {
            return new PolicyEngine(opts.policy);
        }

        const policyFile = opts.policyFile || this.defaultPolicyFile;
        if (!policyFile) {
            return new PolicyEngine(null);
        }

        const policyPath = path.isAbsolute(policyFile)
            ? policyFile
            : path.resolve(process.cwd(), policyFile);

        if (!fs.existsSync(policyPath)) {
            return new PolicyEngine(null);
        }

        const validation = this.policyManager.validatePolicyFile(policyPath);
        if (!validation.valid) {
            const details = validation.errors
                .map((error) => `${error.path}: ${error.message}`)
                .join('; ');
            throw new Error(`Invalid policy file at ${policyPath}. ${details}`);
        }

        return new PolicyEngine(validation.policy);
    }

    /**
     * Build runtime context for policy checks.
     */
    buildPolicyContext(hardware, opts = {}) {
        const summary = hardware?.summary || {};
        const systemRAM = typeof summary.systemRAM === 'number' ? summary.systemRAM : null;

        const context = {
            backend: summary.bestBackend || null,
            runtimeBackend: summary.bestBackend || null,
            ramGB: systemRAM,
            totalRamGB: systemRAM,
            hardware
        };

        if (typeof opts.isLocal === 'boolean') {
            context.isLocal = opts.isLocal;
        }

        return context;
    }

    /**
     * Apply filters to variant list
     */
    applyFilters(variants, opts, hardware) {
        let filtered = [...variants];

        // Size filters
        const maxSize = opts.maxSize || this.detector.getMaxModelSize() + 2;
        const minSize = opts.minSize || 0;

        filtered = filtered.filter(v => {
            const size = v.size_gb || v.sizeGB || 0;
            return size >= minSize && size <= maxSize;
        });

        // Family exclusions
        if (opts.excludeFamilies.length > 0) {
            const excludeLower = opts.excludeFamilies.map(f => f.toLowerCase());
            filtered = filtered.filter(v => {
                const modelId = (v.model_id || v.modelId || '').toLowerCase();
                return !excludeLower.some(ex => modelId.includes(ex));
            });
        }

        // Family preference (boost, don't exclude others)
        if (opts.preferFamily) {
            const prefLower = opts.preferFamily.toLowerCase();
            filtered.sort((a, b) => {
                const aMatches = (a.model_id || a.modelId || '').toLowerCase().includes(prefLower);
                const bMatches = (b.model_id || b.modelId || '').toLowerCase().includes(prefLower);
                if (aMatches && !bMatches) return -1;
                if (!aMatches && bMatches) return 1;
                return 0;
            });
        }

        // Vision filter
        if (!opts.includeVision) {
            filtered = filtered.filter(v => {
                const inputTypes = v.input_types || v.inputTypes || [];
                const modelId = (v.model_id || v.modelId || '').toLowerCase();
                return !inputTypes.includes('image') &&
                       !modelId.includes('llava') &&
                       !modelId.includes('vision') &&
                       !modelId.includes('bakllava') &&
                       !modelId.includes('moondream');
            });
        }

        // Embeddings filter
        if (!opts.includeEmbeddings) {
            filtered = filtered.filter(v => {
                const modelId = (v.model_id || v.modelId || '').toLowerCase();
                return !modelId.includes('embed') &&
                       !modelId.includes('nomic') &&
                       !modelId.includes('mxbai') &&
                       !modelId.includes('minilm') &&
                       !modelId.includes('arctic-embed');
            });
        }

        // Quantization preference
        if (opts.preferQuantization) {
            const prefQuant = opts.preferQuantization.toUpperCase();
            filtered.sort((a, b) => {
                const aQuant = (a.quant || '').toUpperCase();
                const bQuant = (b.quant || '').toUpperCase();
                if (aQuant === prefQuant && bQuant !== prefQuant) return -1;
                if (aQuant !== prefQuant && bQuant === prefQuant) return 1;
                return 0;
            });
        }

        return filtered;
    }

    /**
     * Select top picks from scored variants
     */
    selectTopPicks(scored, opts) {
        const picks = {
            best: null,
            balanced: null,
            fast: null,
            quality: null
        };

        if (scored.length === 0) return picks;

        // Best overall (highest score)
        picks.best = scored[0];

        // Balanced (good quality + speed)
        const balanced = scored.find(s =>
            s.score.components.quality >= 70 &&
            s.score.components.speed >= 70 &&
            s.score.components.fit >= 80
        );
        picks.balanced = balanced || scored[0];

        // Fastest (highest speed score among acceptable quality)
        const fast = scored
            .filter(s => s.score.components.quality >= 60)
            .sort((a, b) => b.score.components.speed - a.score.components.speed)[0];
        picks.fast = fast || scored[0];

        // Highest quality (that fits)
        const quality = scored
            .filter(s => s.score.components.fit >= 70)
            .sort((a, b) => b.score.components.quality - a.score.components.quality)[0];
        picks.quality = quality || scored[0];

        return picks;
    }

    /**
     * Generate insights about the recommendations
     */
    generateInsights(scored, hardware, opts) {
        const insights = [];

        if (scored.length === 0) {
            insights.push({
                type: 'warning',
                message: 'No models found that match your criteria. Try relaxing filters.'
            });
            return insights;
        }

        const top = scored[0];
        const maxSize = this.detector.getMaxModelSize();

        // Hardware-based insights
        if (hardware.summary.bestBackend === 'cpu') {
            insights.push({
                type: 'info',
                message: 'Running on CPU only. Consider smaller models (≤7B) with aggressive quantization (Q4 or lower).'
            });
        }

        if (hardware.summary.isMultiGPU) {
            insights.push({
                type: 'tip',
                message: `Multi-GPU detected (${hardware.summary.gpuCount} GPUs). Larger models can utilize combined VRAM.`
            });
        }

        if (hardware.summary.bestBackend === 'metal') {
            insights.push({
                type: 'info',
                message: 'Apple Silicon detected. Unified memory allows running larger models efficiently.'
            });
        }

        // Score-based insights
        if (top.score.final >= 85) {
            insights.push({
                type: 'success',
                message: `Excellent match found! ${this.formatModelName(top.variant)} scores ${top.score.final}/100.`
            });
        } else if (top.score.final >= 70) {
            insights.push({
                type: 'success',
                message: `Good match found. ${this.formatModelName(top.variant)} should perform well.`
            });
        } else if (top.score.final >= 55) {
            insights.push({
                type: 'warning',
                message: 'Limited options for your hardware. Consider upgrading RAM/VRAM for better choices.'
            });
        }

        // Memory pressure insight
        const topSize = top.variant.size_gb || top.variant.sizeGB || 0;
        if (topSize > maxSize * 0.85) {
            insights.push({
                type: 'warning',
                message: 'Top recommendation uses most available memory. Close other applications before running.'
            });
        }

        // Use case specific insights
        if (opts.useCase === 'coding') {
            const codingModels = scored.filter(s => {
                const modelId = (s.variant.model_id || s.variant.modelId || '').toLowerCase();
                return modelId.includes('coder') || modelId.includes('codellama') || modelId.includes('starcoder');
            });
            if (codingModels.length > 0) {
                insights.push({
                    type: 'tip',
                    message: `Found ${codingModels.length} coding-specialized model(s). These are optimized for code completion.`
                });
            }
        }

        if (opts.useCase === 'reasoning' && top.score.components.quality >= 80) {
            insights.push({
                type: 'tip',
                message: 'For complex reasoning, consider using higher temperature (0.7-0.9) and longer contexts.'
            });
        }

        // Quantization insight
        const topQuant = top.variant.quant || 'Q4_K_M';
        if (topQuant.includes('Q2') || topQuant.includes('IQ2')) {
            insights.push({
                type: 'warning',
                message: 'Very aggressive quantization reduces quality. Use for testing only.'
            });
        } else if (topQuant.includes('Q8') || topQuant === 'FP16') {
            insights.push({
                type: 'tip',
                message: 'High-quality quantization selected. Good balance of quality and performance.'
            });
        }

        return insights;
    }

    /**
     * Format model name for display
     */
    formatModelName(variant) {
        const modelId = variant.model_id || variant.modelId || 'Unknown';
        const tag = variant.tag || '';

        // Tag already contains model:variant format (e.g., "qwen2.5:14b-instruct-q3_K_S")
        if (tag && tag.includes(':')) {
            return tag;
        }

        // Otherwise build the name
        if (tag) {
            return `${modelId}:${tag}`;
        }

        const params = variant.params_b || variant.paramsB;
        const quant = variant.quant;

        let name = modelId;
        if (params) name += ` ${params}B`;
        if (quant) name += ` (${quant})`;

        return name;
    }

    /**
     * Get quick recommendation for a specific use case
     */
    async quickRecommend(variants, useCase = 'general') {
        const result = await this.recommend(variants, { useCase, limit: 5 });
        return {
            recommended: result.topPicks.best?.variant || null,
            alternatives: result.all.slice(1, 4).map(s => s.variant),
            score: result.topPicks.best?.score.final || 0
        };
    }

    /**
     * Find the best variant of a specific model
     */
    async findBestVariant(variants, modelName, options = {}) {
        const modelNameLower = modelName.toLowerCase();

        // Filter to just this model's variants
        const modelVariants = variants.filter(v => {
            const id = (v.model_id || v.modelId || '').toLowerCase();
            return id.includes(modelNameLower);
        });

        if (modelVariants.length === 0) {
            return null;
        }

        const result = await this.recommend(modelVariants, options);
        return result.topPicks.best;
    }

    /**
     * Compare two models
     */
    async compare(variant1, variant2, options = {}) {
        const hardware = await this.detector.detect();
        const opts = { ...this.defaults, ...options };

        const score1 = this.scoring.score(variant1, hardware, opts);
        const score2 = this.scoring.score(variant2, hardware, opts);

        const winner = score1.final > score2.final ? variant1 : variant2;
        const winnerScore = score1.final > score2.final ? score1 : score2;

        return {
            model1: {
                variant: variant1,
                score: score1
            },
            model2: {
                variant: variant2,
                score: score2
            },
            winner: {
                variant: winner,
                score: winnerScore
            },
            difference: Math.abs(score1.final - score2.final),
            breakdown: {
                quality: score1.components.quality - score2.components.quality,
                speed: score1.components.speed - score2.components.speed,
                fit: score1.components.fit - score2.components.fit,
                context: score1.components.context - score2.components.context
            }
        };
    }

    /**
     * Get recommendations by category (coding, chat, etc.)
     */
    async recommendByCategory(variants) {
        const categories = ['general', 'coding', 'reasoning', 'chat', 'fast', 'quality'];
        const results = {};

        for (const category of categories) {
            const result = await this.recommend(variants, { useCase: category, limit: 3 });
            results[category] = result.topPicks.best;
        }

        return results;
    }

    /**
     * Get installed model recommendations
     */
    async recommendInstalled(installedModels, options = {}) {
        // installedModels should be array of { name, size, modified_at, ... } from Ollama
        const variants = installedModels.map(m => this.convertInstalledToVariant(m));
        return this.recommend(variants, options);
    }

    /**
     * Convert installed Ollama model to variant format
     */
    convertInstalledToVariant(installed) {
        const name = installed.name || '';
        const size = installed.size || 0;
        const sizeGB = size / (1024 ** 3);

        // Parse model name for params and quant
        const parsed = this.parseModelName(name);

        return {
            model_id: name.split(':')[0],
            tag: name.includes(':') ? name.split(':')[1] : 'latest',
            params_b: parsed.params,
            quant: parsed.quant,
            size_gb: sizeGB,
            context_length: parsed.context || 4096,
            is_moe: parsed.isMoE,
            input_types: parsed.inputTypes,
            installed: true
        };
    }

    /**
     * Parse model name to extract parameters
     */
    parseModelName(name) {
        const result = {
            params: null,
            quant: 'Q4_K_M',
            context: 4096,
            isMoE: false,
            inputTypes: ['text']
        };

        const nameLower = name.toLowerCase();

        // Extract params (e.g., "7b", "70b", "3.1b")
        const paramsMatch = nameLower.match(/(\d+\.?\d*)b/);
        if (paramsMatch) {
            result.params = parseFloat(paramsMatch[1]);
        }

        // Extract quantization
        const quantPatterns = [
            'fp16', 'f16', 'q8_0', 'q6_k', 'q5_k_m', 'q5_k_s', 'q5_0',
            'q4_k_m', 'q4_k_s', 'q4_0', 'q3_k_m', 'q3_k_s', 'q3_k_l',
            'iq4_xs', 'iq4_nl', 'iq3_xxs', 'iq3_xs', 'iq3_s',
            'iq2_xs', 'iq2_xxs', 'q2_k', 'q2_k_s'
        ];
        for (const q of quantPatterns) {
            if (nameLower.includes(q)) {
                result.quant = q.toUpperCase().replace(/_/g, '_');
                break;
            }
        }

        // Check for MoE
        if (nameLower.includes('mixtral') || nameLower.includes('moe')) {
            result.isMoE = true;
        }

        // Check for vision
        if (nameLower.includes('llava') || nameLower.includes('vision') ||
            nameLower.includes('bakllava') || nameLower.includes('moondream')) {
            result.inputTypes = ['text', 'image'];
        }

        // Extract context length
        const contextMatch = nameLower.match(/(\d+)k/);
        if (contextMatch) {
            result.context = parseInt(contextMatch[1]) * 1024;
        }

        return result;
    }

    /**
     * Generate pull commands for top recommendations
     */
    getPullCommands(recommendations, limit = 5) {
        const commands = [];

        const models = recommendations.all || [];
        for (const item of models.slice(0, limit)) {
            const variant = item.variant;
            const tag = variant.tag || 'latest';
            const modelId = variant.model_id || variant.modelId;

            commands.push({
                model: `${modelId}:${tag}`,
                command: `ollama pull ${modelId}:${tag}`,
                score: item.score.final,
                size: variant.size_gb || variant.sizeGB
            });
        }

        return commands;
    }
}

module.exports = IntelligentSelector;
