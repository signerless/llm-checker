/**
 * Scoring Engine - Multi-dimensional model scoring system
 *
 * Calculates scores based on:
 * - Q (Quality): Model quality based on params, family, quantization
 * - S (Speed): Estimated inference speed on target hardware
 * - F (Fit): How well the model fits in available memory
 * - C (Context): Context length capability
 *
 * FinalScore = Q × wQ + S × wS + F × wF + C × wC
 */

const { SCORING_ENGINE_WEIGHTS } = require('./scoring-config');

class ScoringEngine {
    constructor(options = {}) {
        // Weight presets from centralized config
        this.weightPresets = SCORING_ENGINE_WEIGHTS;

        // Model family quality rankings (0-100 base score)
        this.familyQuality = {
            // Frontier models
            'qwen2.5': 95,
            'qwen2': 90,
            'llama3.3': 95,
            'llama3.2': 92,
            'llama3.1': 90,
            'llama3': 88,
            'deepseek-v3': 96,
            'deepseek-v2.5': 94,
            'deepseek-coder-v2': 92,
            'deepseek-r1': 96,
            'gemma2': 90,
            'gemma': 82,
            'phi-4': 92,
            'phi-3.5': 88,
            'phi-3': 85,
            'phi-2': 75,
            'mistral-large': 94,
            'mistral': 85,
            'mixtral': 88,
            'command-r': 90,
            'command-r-plus': 93,

            // Coding specialists
            'qwen2.5-coder': 96,
            'codellama': 82,
            'starcoder2': 85,
            'deepseek-coder': 88,
            'codegemma': 80,
            'granite-code': 78,

            // Chat/instruct
            'yi': 85,
            'yi-coder': 88,
            'openchat': 78,
            'neural-chat': 75,
            'zephyr': 80,
            'openhermes': 82,
            'nous-hermes': 82,
            'dolphin': 80,
            'orca': 78,

            // Vision models
            'llava': 82,
            'llava-llama3': 85,
            'llava-phi3': 80,
            'bakllava': 78,
            'moondream': 75,

            // Embeddings
            'nomic-embed-text': 85,
            'mxbai-embed-large': 88,
            'all-minilm': 80,
            'snowflake-arctic-embed': 85,

            // Other notable models
            'solar': 82,
            'falcon': 75,
            'vicuna': 72,
            'wizardlm': 78,
            'aya': 85,
            'smollm': 70,
            'tinyllama': 65
        };

        // Quantization quality penalties (subtracted from base score)
        this.quantPenalties = {
            'FP16': 0,
            'F16': 0,
            'Q8_0': 2,
            'Q6_K': 4,
            'Q5_K_M': 6,
            'Q5_K_S': 7,
            'Q5_0': 8,
            'Q4_K_M': 10,
            'Q4_K_S': 11,
            'Q4_0': 12,
            'Q3_K_M': 16,
            'Q3_K_S': 18,
            'Q3_K_L': 15,
            'IQ4_XS': 11,
            'IQ4_NL': 10,
            'IQ3_XXS': 20,
            'IQ3_XS': 18,
            'IQ3_S': 17,
            'IQ2_XS': 25,
            'IQ2_XXS': 28,
            'Q2_K': 22,
            'Q2_K_S': 24
        };

        // Task-specific bonuses for model families
        this.taskBonuses = {
            coding: {
                'qwen2.5-coder': 15,
                'deepseek-coder': 12,
                'deepseek-coder-v2': 15,
                'codellama': 10,
                'starcoder2': 12,
                'codegemma': 8,
                'yi-coder': 10,
                'granite-code': 8
            },
            reasoning: {
                'deepseek-r1': 15,
                'qwen2.5': 10,
                'llama3.3': 10,
                'phi-4': 12,
                'command-r-plus': 10,
                'mistral-large': 10
            },
            chat: {
                'llama3.2': 10,
                'mistral': 8,
                'gemma2': 8,
                'openchat': 10,
                'neural-chat': 8,
                'dolphin': 8
            },
            vision: {
                'llava': 15,
                'llava-llama3': 18,
                'llava-phi3': 15,
                'bakllava': 12,
                'moondream': 10
            },
            embeddings: {
                'nomic-embed-text': 15,
                'mxbai-embed-large': 18,
                'all-minilm': 12,
                'snowflake-arctic-embed': 15
            },
            creative: {
                'mistral': 8,
                'mixtral': 10,
                'openhermes': 8,
                'dolphin': 10
            },
            multilingual: {
                'aya': 15,
                'qwen2.5': 10,
                'command-r': 12
            }
        };

        // Speed coefficients by backend (tokens/sec for 7B Q4_K_M as baseline)
        // These are realistic values based on actual Ollama benchmarks
        this.backendSpeed = {
            // NVIDIA - based on real llama.cpp/Ollama benchmarks
            'cuda_h100': 120,    // ~100-140 TPS for 7B Q4
            'cuda_a100': 90,     // ~80-100 TPS for 7B Q4
            'cuda_gb10': 95,     // Grace Blackwell / DGX Spark class
            'cuda_4090': 70,     // ~60-80 TPS for 7B Q4
            'cuda_4080': 55,     // ~50-60 TPS for 7B Q4
            'cuda_3090': 50,     // ~45-55 TPS for 7B Q4
            'cuda_3080': 40,     // ~35-45 TPS for 7B Q4
            'cuda_3070': 32,     // ~28-35 TPS for 7B Q4
            'cuda_3060': 25,     // ~20-28 TPS for 7B Q4
            'cuda_2080': 28,     // ~25-30 TPS for 7B Q4
            'cuda_p100': 30,     // Tesla P100 class
            'cuda_default': 30,

            // AMD - slightly lower than equivalent NVIDIA
            'rocm_mi300': 100,
            'rocm_mi250': 70,
            'rocm_7900xtx': 55,
            'rocm_7900xt': 45,
            'rocm_7800xt': 38,
            'rocm_6900xt': 35,
            'rocm_default': 30,

            // Apple Silicon - based on real M-series benchmarks
            'metal_m4_ultra': 75,   // ~70-80 TPS for 7B Q4
            'metal_m4_max': 60,     // ~55-65 TPS for 7B Q4
            'metal_m4_pro': 45,     // ~40-50 TPS for 7B Q4
            'metal_m4': 35,         // ~30-40 TPS for 7B Q4
            'metal_m3_ultra': 65,
            'metal_m3_max': 50,
            'metal_m3_pro': 40,
            'metal_m3': 30,
            'metal_m2_ultra': 55,
            'metal_m2_max': 45,
            'metal_m2_pro': 35,
            'metal_m2': 28,
            'metal_m1_ultra': 45,
            'metal_m1_max': 38,
            'metal_m1_pro': 30,
            'metal_m1': 22,
            'metal_default': 30,

            // Intel Arc - limited real-world data
            'intel_arc_a770': 30,
            'intel_arc_a750': 25,
            'intel_arc_default': 20,

            // CPU - very conservative, based on actual CPU inference speeds
            'cpu_avx512_amx': 12,   // Best case server CPU
            'cpu_avx512': 8,        // Good desktop CPU
            'cpu_avx2': 5,          // Most modern CPUs
            'cpu_neon': 4,          // Apple Silicon fallback
            'cpu_avx': 3,           // Older CPUs
            'cpu_default': 2        // Very old CPUs
        };

        // Quantization speed multipliers (relative to Q4_K_M baseline)
        // More conservative than theoretical - accounts for real overhead
        this.quantSpeedMult = {
            'FP16': 0.5,      // Half speed of Q4 (2x memory bandwidth)
            'F16': 0.5,
            'Q8_0': 0.7,      // ~70% of Q4 speed
            'Q6_K': 0.85,     // ~85% of Q4 speed
            'Q5_K_M': 0.92,
            'Q5_K_S': 0.92,
            'Q5_0': 0.92,
            'Q4_K_M': 1.0,    // Baseline
            'Q4_K_S': 1.0,
            'Q4_0': 1.05,
            'Q3_K_M': 1.15,   // Faster but quality loss
            'Q3_K_S': 1.15,
            'Q3_K_L': 1.1,
            'IQ4_XS': 1.02,
            'IQ4_NL': 1.0,
            'IQ3_XXS': 1.2,
            'IQ3_XS': 1.18,
            'IQ3_S': 1.15,
            'IQ2_XS': 1.25,
            'IQ2_XXS': 1.28,
            'Q2_K': 1.22,
            'Q2_K_S': 1.25
        };

        this.options = options;
    }

    /**
     * Estimate model size from params and quantization
     * Returns estimated size in GB, or null if cannot estimate
     */
    estimateSizeFromParams(variant) {
        const params = variant.params_b || variant.paramsB;
        if (!params) return null;

        const quant = (variant.quant || 'Q4_K_M').toUpperCase();

        if (quant.includes('FP16') || quant.includes('F16')) {
            return params * 2;  // FP16: ~2GB per 1B params
        } else if (quant.includes('Q8')) {
            return params * 1;  // Q8: ~1GB per 1B params
        } else if (quant.includes('Q6')) {
            return params * 0.75;  // Q6: ~0.75GB per 1B params
        } else if (quant.includes('Q5')) {
            return params * 0.6;  // Q5: ~0.6GB per 1B params
        } else if (quant.includes('Q4')) {
            return params * 0.5;  // Q4: ~0.5GB per 1B params
        } else if (quant.includes('Q3')) {
            return params * 0.4;  // Q3: ~0.4GB per 1B params
        } else if (quant.includes('Q2') || quant.includes('IQ2')) {
            return params * 0.3;  // Q2: ~0.3GB per 1B params
        } else {
            return params * 0.5;  // Default to Q4 estimate
        }
    }

    /**
     * Get model size (actual or estimated)
     */
    getModelSize(variant) {
        const size = variant.size_gb || variant.sizeGB;
        if (size && size > 0) return size;
        return this.estimateSizeFromParams(variant);
    }

    /**
     * Calculate overall score for a model variant
     *
     * @param {Object} variant - Model variant data
     * @param {Object} hardware - Hardware info from UnifiedDetector
     * @param {Object} options - Scoring options
     * @returns {Object} Score breakdown and final score
     */
    score(variant, hardware, options = {}) {
        const useCase = options.useCase || 'general';
        const targetContext = options.targetContext || 8192;
        const targetTPS = options.targetTPS || 20;  // Target tokens per second

        const weights = this.weightPresets[useCase] || this.weightPresets.general;

        // Calculate individual scores
        const Q = this.calculateQualityScore(variant, useCase);
        const S = this.calculateSpeedScore(variant, hardware, targetTPS);
        const F = this.calculateFitScore(variant, hardware);
        const C = this.calculateContextScore(variant, targetContext);

        // Calculate weighted final score
        const finalScore = Math.round(
            Q * weights.Q +
            S * weights.S +
            F * weights.F +
            C * weights.C
        );

        return {
            final: Math.min(100, Math.max(0, finalScore)),
            components: {
                quality: Math.round(Q),
                speed: Math.round(S),
                fit: Math.round(F),
                context: Math.round(C)
            },
            weights,
            meta: {
                useCase,
                family: this.extractFamily(variant.model_id || variant.modelId),
                params: variant.params_b || variant.paramsB,
                quant: variant.quant,
                estimatedTPS: this.estimateTPS(variant, hardware),
                estimatedSize: variant.size_gb || variant.sizeGB
            }
        };
    }

    /**
     * Calculate Quality score (Q)
     * Based on model family, parameter count, and quantization
     */
    calculateQualityScore(variant, useCase) {
        const family = this.extractFamily(variant.model_id || variant.modelId);
        const params = variant.params_b || variant.paramsB || 7;
        const quant = (variant.quant || 'Q4_K_M').toUpperCase();

        // Base family score
        let baseScore = this.getFamilyScore(family);

        // Parameter size bonus (larger models generally better, with diminishing returns)
        let paramBonus = 0;
        if (params >= 70) paramBonus = 15;
        else if (params >= 32) paramBonus = 12;
        else if (params >= 14) paramBonus = 8;
        else if (params >= 7) paramBonus = 5;
        else if (params >= 3) paramBonus = 2;
        else paramBonus = 0;

        // Quantization penalty
        const quantPenalty = this.quantPenalties[quant] || 10;

        // Task-specific bonus
        const taskBonus = this.getTaskBonus(family, useCase);

        // MoE bonus (mixture of experts models are often better quality/speed ratio)
        const moeBonus = (variant.is_moe || variant.isMoE) ? 5 : 0;

        const score = baseScore + paramBonus - quantPenalty + taskBonus + moeBonus;

        return Math.min(100, Math.max(0, score));
    }

    /**
     * Calculate Speed score (S)
     * Based on estimated tokens per second vs target
     */
    calculateSpeedScore(variant, hardware, targetTPS) {
        const estimatedTPS = this.estimateTPS(variant, hardware);

        if (estimatedTPS >= targetTPS * 2) {
            return 100;  // 2x target = perfect score
        } else if (estimatedTPS >= targetTPS) {
            // Linear scaling from 80-100 for 1x-2x target
            return 80 + (estimatedTPS - targetTPS) / targetTPS * 20;
        } else if (estimatedTPS >= targetTPS * 0.5) {
            // Linear scaling from 50-80 for 0.5x-1x target
            return 50 + (estimatedTPS / targetTPS) * 30;
        } else {
            // Below 50% target, steep penalty
            return Math.max(0, (estimatedTPS / targetTPS) * 50);
        }
    }

    /**
     * Calculate Fit score (F)
     * Based on how well model fits in available memory
     */
    calculateFitScore(variant, hardware) {
        const modelSize = this.getModelSize(variant);

        // No size info available - give moderate score
        if (!modelSize) return 70;

        const availableMemory = hardware?.summary?.effectiveMemory || 8;
        const headroom = 2;  // GB reserved for system

        const effectiveAvailable = availableMemory - headroom;
        const usage = modelSize / effectiveAvailable;

        if (usage <= 0.7) {
            return 100;  // Plenty of room
        } else if (usage <= 0.85) {
            // Comfortable fit
            return 90 + (0.85 - usage) / 0.15 * 10;
        } else if (usage <= 1.0) {
            // Tight fit
            return 70 + (1.0 - usage) / 0.15 * 20;
        } else if (usage <= 1.2) {
            // May work with swapping (especially on Mac)
            return 50 - (usage - 1.0) * 100;
        } else {
            // Won't fit
            return 0;
        }
    }

    /**
     * Calculate Context score (C)
     * Based on context length capability vs target
     */
    calculateContextScore(variant, targetContext) {
        const contextLength = variant.context_length || variant.contextLength || 4096;

        if (contextLength >= targetContext * 2) {
            return 100;  // Much more than needed
        } else if (contextLength >= targetContext) {
            // Meets requirement
            return 85 + (contextLength - targetContext) / targetContext * 15;
        } else if (contextLength >= targetContext * 0.5) {
            // Partially meets requirement
            return 50 + (contextLength / targetContext) * 35;
        } else {
            // Inadequate
            return (contextLength / targetContext) * 50;
        }
    }

    /**
     * Estimate tokens per second
     *
     * Formula is based on:
     * - baseSpeed: realistic TPS for 7B Q4_K_M model on this hardware
     * - Model size scaling with diminishing returns
     * - Quantization adjustment
     * - MoE efficiency bonus
     */
    estimateTPS(variant, hardware) {
        const params = variant.params_b || variant.paramsB || 7;
        const quant = (variant.quant || 'Q4_K_M').toUpperCase();
        const isMoE = variant.is_moe || variant.isMoE || false;

        // Get backend speed coefficient (TPS for 7B Q4_K_M)
        const backendKey = this.getBackendKey(hardware);
        const baseSpeed = this.backendSpeed[backendKey] || this.backendSpeed.cpu_default;

        // Get quantization multiplier (relative to Q4_K_M = 1.0)
        const quantMult = this.quantSpeedMult[quant] || 1.0;

        // Model size scaling with diminishing returns
        // Small models don't get proportionally faster due to overhead
        // Large models don't slow proportionally due to batching efficiency
        let sizeRatio = 7 / params;

        // Apply diminishing returns curve
        // For small models (< 7B): cap the speedup factor
        // For large models (> 7B): slow down more gradually
        let sizeMult;
        if (params < 3) {
            // Very small models: limited by overhead, max ~2x baseline
            sizeMult = Math.min(2.0, 1 + (sizeRatio - 1) * 0.35);
        } else if (params < 7) {
            // Small models: some speedup but not linear (~1.4x for 3B)
            sizeMult = 1 + (sizeRatio - 1) * 0.35;
        } else if (params <= 14) {
            // Medium models: close to linear
            sizeMult = sizeRatio;
        } else if (params <= 32) {
            // Large models: slight efficiency boost
            sizeMult = sizeRatio * 1.1;
        } else {
            // Very large models: memory bandwidth limited, slower than linear
            sizeMult = sizeRatio * 0.85;
        }

        // Calculate base TPS
        let tps = baseSpeed * sizeMult * quantMult;

        // MoE models are faster because only ~1/3 of params are active
        // But communication overhead limits the speedup
        if (isMoE) {
            tps *= 1.8;  // ~1.8x speedup (not 3x due to routing overhead)
        }

        // Apply minimum floor (can't go below 1 TPS)
        return Math.max(1, Math.round(tps));
    }

    /**
     * Get backend speed key from hardware info
     */
    getBackendKey(hardware) {
        if (!hardware?.summary) return 'cpu_default';

        const backend = hardware.summary.bestBackend;
        const gpuModel = (hardware.summary.gpuModel || '').toLowerCase();

        if (backend === 'cuda') {
            if (gpuModel.includes('gb10') || gpuModel.includes('grace blackwell') || gpuModel.includes('dgx spark')) return 'cuda_gb10';
            if (gpuModel.includes('h100')) return 'cuda_h100';
            if (gpuModel.includes('a100')) return 'cuda_a100';
            if (gpuModel.includes('p100')) return 'cuda_p100';
            if (gpuModel.includes('4090')) return 'cuda_4090';
            if (gpuModel.includes('4080')) return 'cuda_4080';
            if (gpuModel.includes('3090')) return 'cuda_3090';
            if (gpuModel.includes('3080')) return 'cuda_3080';
            if (gpuModel.includes('3070')) return 'cuda_3070';
            if (gpuModel.includes('3060')) return 'cuda_3060';
            if (gpuModel.includes('2080')) return 'cuda_2080';
            return 'cuda_default';
        }

        if (backend === 'rocm') {
            if (gpuModel.includes('mi300')) return 'rocm_mi300';
            if (gpuModel.includes('mi250')) return 'rocm_mi250';
            if (gpuModel.includes('7900 xtx')) return 'rocm_7900xtx';
            if (gpuModel.includes('7900 xt')) return 'rocm_7900xt';
            if (gpuModel.includes('7800')) return 'rocm_7800xt';
            if (gpuModel.includes('6900')) return 'rocm_6900xt';
            return 'rocm_default';
        }

        if (backend === 'metal') {
            if (gpuModel.includes('m4 ultra')) return 'metal_m4_ultra';
            if (gpuModel.includes('m4 max')) return 'metal_m4_max';
            if (gpuModel.includes('m4 pro')) return 'metal_m4_pro';
            if (gpuModel.includes('m4')) return 'metal_m4';
            if (gpuModel.includes('m3 ultra')) return 'metal_m3_ultra';
            if (gpuModel.includes('m3 max')) return 'metal_m3_max';
            if (gpuModel.includes('m3 pro')) return 'metal_m3_pro';
            if (gpuModel.includes('m3')) return 'metal_m3';
            if (gpuModel.includes('m2 ultra')) return 'metal_m2_ultra';
            if (gpuModel.includes('m2 max')) return 'metal_m2_max';
            if (gpuModel.includes('m2 pro')) return 'metal_m2_pro';
            if (gpuModel.includes('m2')) return 'metal_m2';
            if (gpuModel.includes('m1 ultra')) return 'metal_m1_ultra';
            if (gpuModel.includes('m1 max')) return 'metal_m1_max';
            if (gpuModel.includes('m1 pro')) return 'metal_m1_pro';
            if (gpuModel.includes('m1')) return 'metal_m1';
            return 'metal_default';
        }

        if (backend === 'intel') {
            if (gpuModel.includes('a770')) return 'intel_arc_a770';
            if (gpuModel.includes('a750')) return 'intel_arc_a750';
            return 'intel_arc_default';
        }

        // CPU backend
        const cpu = hardware.cpu || hardware.backends?.cpu?.info;
        if (cpu?.capabilities) {
            if (cpu.capabilities.amx) return 'cpu_avx512_amx';
            if (cpu.capabilities.avx512) return 'cpu_avx512';
            if (cpu.capabilities.avx2) return 'cpu_avx2';
            if (cpu.capabilities.neon) return 'cpu_neon';
            if (cpu.capabilities.avx) return 'cpu_avx';
        }

        return 'cpu_default';
    }

    /**
     * Extract model family from model ID
     */
    extractFamily(modelId) {
        if (!modelId) return 'unknown';

        const id = modelId.toLowerCase();

        // Remove namespace if present (e.g., "library/qwen2.5" -> "qwen2.5")
        const name = id.includes('/') ? id.split('/').pop() : id;

        // Remove tag if present (e.g., "qwen2.5:7b-q4" -> "qwen2.5")
        const base = name.split(':')[0];

        // Match against known families
        for (const family of Object.keys(this.familyQuality).sort((a, b) => b.length - a.length)) {
            if (base.includes(family)) {
                return family;
            }
        }

        return base;
    }

    /**
     * Get family quality score
     */
    getFamilyScore(family) {
        // Direct match
        if (this.familyQuality[family]) {
            return this.familyQuality[family];
        }

        // Partial match
        for (const [key, score] of Object.entries(this.familyQuality)) {
            if (family.includes(key) || key.includes(family)) {
                return score;
            }
        }

        // Default for unknown families
        return 70;
    }

    /**
     * Get task-specific bonus
     */
    getTaskBonus(family, useCase) {
        const bonuses = this.taskBonuses[useCase] || {};

        // Direct match
        if (bonuses[family]) {
            return bonuses[family];
        }

        // Partial match
        for (const [key, bonus] of Object.entries(bonuses)) {
            if (family.includes(key) || key.includes(family)) {
                return bonus;
            }
        }

        return 0;
    }

    /**
     * Score multiple variants and return sorted by score
     */
    scoreAll(variants, hardware, options = {}) {
        const scored = variants.map(variant => ({
            variant,
            score: this.score(variant, hardware, options)
        }));

        // Sort by final score (descending)
        scored.sort((a, b) => b.score.final - a.score.final);

        return scored;
    }

    /**
     * Filter and score variants for hardware constraints
     */
    filterAndScore(variants, hardware, options = {}) {
        const maxSize = hardware?.summary?.effectiveMemory || 8;
        const headroom = options.headroom || 2;
        const effectiveMax = maxSize - headroom;

        // Filter variants that fit
        const fitting = variants.filter(v => {
            const size = this.getModelSize(v);

            // No size info - include but will get moderate fit score
            if (!size) return true;

            return size <= effectiveMax * 1.1;  // Allow 10% overflow
        });

        return this.scoreAll(fitting, hardware, options);
    }

    /**
     * Get recommendation categories
     */
    categorizeScores(scoredVariants) {
        const categories = {
            excellent: [],      // 85+
            recommended: [],    // 70-84
            acceptable: [],     // 55-69
            marginal: [],       // 40-54
            notRecommended: []  // <40
        };

        for (const item of scoredVariants) {
            const score = item.score.final;

            if (score >= 85) {
                categories.excellent.push(item);
            } else if (score >= 70) {
                categories.recommended.push(item);
            } else if (score >= 55) {
                categories.acceptable.push(item);
            } else if (score >= 40) {
                categories.marginal.push(item);
            } else {
                categories.notRecommended.push(item);
            }
        }

        return categories;
    }
}

module.exports = ScoringEngine;
