class OllamaCapacityPlanner {
    constructor(options = {}) {
        this.minContext = options.minContext || 2048;
        this.maxParallelCap = options.maxParallelCap || 8;
        this.defaultReserveGB = options.defaultReserveGB || 2;
        this.kvFactorPer4k = options.kvFactorPer4k || 0.08; // GB per 1B params at 4k ctx
        this.modelOverheadGB = options.modelOverheadGB || 0.7;
    }

    toFiniteNumber(value, fallback = 0) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : fallback;
    }

    clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    normalizeObjective(objective) {
        const normalized = String(objective || 'balanced').toLowerCase();
        if (normalized === 'latency' || normalized === 'throughput' || normalized === 'balanced') {
            return normalized;
        }
        return 'balanced';
    }

    objectiveProfile(objective) {
        if (objective === 'latency') {
            return {
                parallelCap: 2,
                loadedCap: 1,
                keepAlive: '30m'
            };
        }

        if (objective === 'throughput') {
            return {
                parallelCap: 6,
                loadedCap: 3,
                keepAlive: '10m'
            };
        }

        return {
            parallelCap: 3,
            loadedCap: 2,
            keepAlive: '15m'
        };
    }

    estimateParamsB(model = {}) {
        const sizeMatch = String(model.size || '').match(/(\d+(?:\.\d+)?)\s*b/i);
        if (sizeMatch) {
            return this.toFiniteNumber(sizeMatch[1], 0);
        }

        const nameMatch = String(model.name || '').match(/(\d+(?:\.\d+)?)\s*b\b/i);
        if (nameMatch) {
            return this.toFiniteNumber(nameMatch[1], 0);
        }

        // Approximate from quantized model file size (Q4 ~0.65 GB per 1B params)
        const fileSizeGB = this.toFiniteNumber(model.fileSizeGB, 0);
        if (fileSizeGB > 0) {
            return fileSizeGB / 0.65;
        }

        return 7; // conservative fallback
    }

    estimateBaseMemoryGB(model = {}) {
        const fileSizeGB = this.toFiniteNumber(model.fileSizeGB, 0);
        if (fileSizeGB > 0) {
            return fileSizeGB + this.modelOverheadGB;
        }

        const paramsB = this.estimateParamsB(model);
        return paramsB * 0.65 + this.modelOverheadGB;
    }

    estimateKVCacheGB(paramsB, contextTokens) {
        const ctx = this.toFiniteNumber(contextTokens, this.minContext);
        return paramsB * this.kvFactorPer4k * (ctx / 4096);
    }

    normalizeModels(models = []) {
        const normalized = models
            .filter((model) => model && model.name)
            .map((model) => {
                const paramsB = this.estimateParamsB(model);
                const baseMemoryGB = this.estimateBaseMemoryGB(model);
                const fileSizeGB = this.toFiniteNumber(model.fileSizeGB, Math.max(0, baseMemoryGB - this.modelOverheadGB));
                return {
                    name: model.name,
                    size: model.size || `${Math.round(paramsB)}B`,
                    fileSizeGB: Math.round(fileSizeGB * 10) / 10,
                    paramsB: Math.round(paramsB * 10) / 10,
                    baseMemoryGB: Math.round(baseMemoryGB * 100) / 100
                };
            });

        // Heaviest first to keep planning conservative
        normalized.sort((a, b) => b.baseMemoryGB - a.baseMemoryGB);
        return normalized;
    }

    resolveHardwareBudget(hardware = {}, reserveGB = null) {
        const summary = hardware.summary || {};
        const reserve = this.toFiniteNumber(reserveGB, this.defaultReserveGB);

        const effectiveMemory = this.toFiniteNumber(summary.effectiveMemory, 0);
        const systemRAM = this.toFiniteNumber(summary.systemRAM, 0);
        const vram = this.toFiniteNumber(summary.totalVRAM, 0);
        const fallbackTotal = this.toFiniteNumber(hardware.memory?.total, 8);

        const rawCapacityGB = effectiveMemory || vram || (systemRAM > 0 ? systemRAM * 0.7 : 0) || fallbackTotal * 0.7;
        const memoryBudgetGB = Math.max(2, rawCapacityGB - reserve);

        return {
            backend: summary.bestBackend || 'cpu',
            backendName: summary.backendName || summary.bestBackend || 'CPU',
            rawCapacityGB: Math.round(rawCapacityGB * 10) / 10,
            reserveGB: Math.round(reserve * 10) / 10,
            memoryBudgetGB: Math.round(memoryBudgetGB * 10) / 10
        };
    }

    computeLoadState(models, contextTokens, loadedCount, budgetGB) {
        const activeModels = models.slice(0, loadedCount);
        const baseTotalGB = activeModels.reduce((sum, model) => sum + model.baseMemoryGB, 0);
        const maxParamsB = activeModels.reduce((max, model) => Math.max(max, model.paramsB), 0);
        const kvAtContextGB = this.estimateKVCacheGB(maxParamsB, contextTokens);
        const kvPerTokenGB = maxParamsB > 0 ? (maxParamsB * this.kvFactorPer4k) / 4096 : 0;
        const availableForKVGB = budgetGB - baseTotalGB;

        let maxParallelAtContext = 0;
        if (kvAtContextGB <= 0) {
            maxParallelAtContext = this.maxParallelCap;
        } else if (availableForKVGB > 0) {
            maxParallelAtContext = Math.floor(availableForKVGB / kvAtContextGB);
        }

        return {
            activeModels,
            baseTotalGB,
            maxParamsB,
            kvAtContextGB,
            kvPerTokenGB,
            availableForKVGB,
            maxParallelAtContext
        };
    }

    maxLoadedModelsFor(models, contextTokens, parallel, budgetGB, hardCap) {
        const cap = Math.max(1, Math.min(hardCap, models.length));
        let best = 1;
        for (let i = 1; i <= cap; i += 1) {
            const state = this.computeLoadState(models, contextTokens, i, budgetGB);
            const estimatedTotal = state.baseTotalGB + (state.kvAtContextGB * parallel);
            if (estimatedTotal <= budgetGB) {
                best = i;
            } else {
                break;
            }
        }
        return best;
    }

    calculateRiskLevel({
        budgetGB,
        requestedTotalGB,
        recommendedTotalGB,
        requestedFits
    }) {
        const safeBudget = Math.max(0.1, budgetGB);
        const requestedUtil = requestedTotalGB / safeBudget;
        const recommendedUtil = recommendedTotalGB / safeBudget;
        const overage = Math.max(0, requestedTotalGB - safeBudget) / safeBudget;

        const score = Math.min(
            100,
            Math.round((overage * 100) + (recommendedUtil * 55) + (requestedFits ? 0 : 20))
        );

        let level = 'low';
        if (score >= 75) level = 'critical';
        else if (score >= 55) level = 'high';
        else if (score >= 35) level = 'medium';

        return { level, score };
    }

    plan({
        hardware,
        models,
        targetContext = 8192,
        targetConcurrency = 2,
        objective = 'balanced',
        reserveGB = null
    }) {
        const normalizedObjective = this.normalizeObjective(objective);
        const profile = this.objectiveProfile(normalizedObjective);
        const modelPool = this.normalizeModels(models);

        if (modelPool.length === 0) {
            throw new Error('At least one model is required for planning.');
        }

        const requestedCtx = this.clamp(
            Math.round(this.toFiniteNumber(targetContext, 8192)),
            512,
            131072
        );
        const requestedConcurrency = this.clamp(
            Math.round(this.toFiniteNumber(targetConcurrency, 2)),
            1,
            64
        );

        const hardwareBudget = this.resolveHardwareBudget(hardware, reserveGB);
        const budgetGB = hardwareBudget.memoryBudgetGB;

        const desiredLoaded = Math.max(1, Math.min(profile.loadedCap, modelPool.length));
        let loadedModels = desiredLoaded;

        // Ensure the base model memory is feasible.
        while (loadedModels > 1) {
            const state = this.computeLoadState(modelPool, requestedCtx, loadedModels, budgetGB);
            if (state.availableForKVGB > 0) {
                break;
            }
            loadedModels -= 1;
        }

        let requestedState = this.computeLoadState(modelPool, requestedCtx, loadedModels, budgetGB);
        let recommendedCtx = requestedCtx;

        if (requestedState.maxParallelAtContext < 1) {
            const ctxFitAtParallel1 = requestedState.kvPerTokenGB > 0
                ? Math.floor(requestedState.availableForKVGB / requestedState.kvPerTokenGB)
                : requestedCtx;
            recommendedCtx = this.clamp(
                Math.max(this.minContext, Math.min(requestedCtx, ctxFitAtParallel1 || this.minContext)),
                this.minContext,
                requestedCtx
            );
        }

        let recommendedState = this.computeLoadState(modelPool, recommendedCtx, loadedModels, budgetGB);
        if (recommendedState.maxParallelAtContext < 1) {
            recommendedCtx = this.minContext;
            recommendedState = this.computeLoadState(modelPool, recommendedCtx, loadedModels, budgetGB);
        }

        let recommendedParallel = Math.max(
            1,
            Math.min(
                requestedConcurrency,
                profile.parallelCap,
                this.maxParallelCap,
                Math.max(1, recommendedState.maxParallelAtContext)
            )
        );

        let recommendedLoaded = this.maxLoadedModelsFor(
            modelPool,
            recommendedCtx,
            recommendedParallel,
            budgetGB,
            profile.loadedCap
        );

        // Recompute state after final loaded model selection.
        recommendedState = this.computeLoadState(modelPool, recommendedCtx, recommendedLoaded, budgetGB);

        const maxCtxParallel1 = recommendedState.kvPerTokenGB > 0
            ? Math.floor(recommendedState.availableForKVGB / recommendedState.kvPerTokenGB)
            : requestedCtx;
        const maxCtxAtRecommendedParallel = recommendedState.kvPerTokenGB > 0
            ? Math.floor(recommendedState.availableForKVGB / (recommendedState.kvPerTokenGB * recommendedParallel))
            : requestedCtx;

        if (maxCtxAtRecommendedParallel > 0) {
            recommendedCtx = this.clamp(
                Math.min(recommendedCtx, maxCtxAtRecommendedParallel),
                this.minContext,
                requestedCtx
            );
        }

        recommendedState = this.computeLoadState(modelPool, recommendedCtx, recommendedLoaded, budgetGB);
        const requestedTotalGB = requestedState.baseTotalGB + (requestedState.kvAtContextGB * requestedConcurrency);
        const recommendedTotalGB = recommendedState.baseTotalGB + (recommendedState.kvAtContextGB * recommendedParallel);
        const requestedFits = requestedTotalGB <= budgetGB;

        const risk = this.calculateRiskLevel({
            budgetGB,
            requestedTotalGB,
            recommendedTotalGB,
            requestedFits
        });

        const flashAttention = hardwareBudget.backend === 'cpu' ? '0' : '1';
        const maxQueue = Math.max(4, recommendedParallel * 4);

        const fallbackCtx = this.clamp(Math.min(4096, recommendedCtx), this.minContext, recommendedCtx);
        const fallbackState = this.computeLoadState(modelPool, fallbackCtx, 1, budgetGB);
        const fallbackTotalGB = fallbackState.baseTotalGB + fallbackState.kvAtContextGB;

        const notes = [];
        if (!requestedFits) {
            notes.push('Requested settings exceed available memory budget; reduced settings are recommended.');
        }
        if (recommendedCtx < requestedCtx) {
            notes.push(`Context reduced from ${requestedCtx} to ${recommendedCtx} to avoid memory pressure.`);
        }
        if (recommendedParallel < requestedConcurrency) {
            notes.push(`Parallelism reduced from ${requestedConcurrency} to ${recommendedParallel} to keep memory stable.`);
        }
        if (recommendedLoaded < desiredLoaded) {
            notes.push(`Loaded models capped at ${recommendedLoaded} for this objective and memory budget.`);
        }

        return {
            objective: normalizedObjective,
            inputs: {
                targetContext: requestedCtx,
                targetConcurrency: requestedConcurrency
            },
            hardware: hardwareBudget,
            models: recommendedState.activeModels.map((model) => ({
                name: model.name,
                size: model.size,
                fileSizeGB: model.fileSizeGB,
                paramsB: model.paramsB,
                estimatedBaseMemoryGB: Math.round(model.baseMemoryGB * 100) / 100
            })),
            envelope: {
                context: {
                    requested: requestedCtx,
                    recommended: recommendedCtx,
                    min_safe: this.minContext,
                    max_for_parallel_1: Math.max(0, maxCtxParallel1 || 0),
                    max_for_recommended_parallel: Math.max(0, maxCtxAtRecommendedParallel || 0)
                },
                parallel: {
                    requested: requestedConcurrency,
                    recommended: recommendedParallel,
                    max_at_requested_ctx: Math.max(0, requestedState.maxParallelAtContext)
                },
                loaded_models: {
                    requested: desiredLoaded,
                    recommended: recommendedLoaded,
                    max_at_recommended_settings: this.maxLoadedModelsFor(
                        modelPool,
                        recommendedCtx,
                        recommendedParallel,
                        budgetGB,
                        modelPool.length
                    )
                }
            },
            recommendation: {
                num_ctx: recommendedCtx,
                num_parallel: recommendedParallel,
                max_loaded_models: recommendedLoaded,
                max_queue: maxQueue,
                keep_alive: profile.keepAlive,
                flash_attention: flashAttention
            },
            memory: {
                budgetGB: Math.round(budgetGB * 100) / 100,
                requestedEstimatedGB: Math.round(requestedTotalGB * 100) / 100,
                recommendedEstimatedGB: Math.round(recommendedTotalGB * 100) / 100,
                utilizationPercent: Math.round((recommendedTotalGB / Math.max(0.1, budgetGB)) * 100)
            },
            risk,
            fallback: {
                num_ctx: fallbackCtx,
                num_parallel: 1,
                max_loaded_models: 1,
                estimated_memory_gb: Math.round(fallbackTotalGB * 100) / 100
            },
            shell: {
                env: {
                    OLLAMA_NUM_CTX: String(recommendedCtx),
                    OLLAMA_NUM_PARALLEL: String(recommendedParallel),
                    OLLAMA_MAX_LOADED_MODELS: String(recommendedLoaded),
                    OLLAMA_MAX_QUEUE: String(maxQueue),
                    OLLAMA_KEEP_ALIVE: profile.keepAlive,
                    OLLAMA_FLASH_ATTENTION: flashAttention
                }
            },
            notes
        };
    }
}

module.exports = OllamaCapacityPlanner;
