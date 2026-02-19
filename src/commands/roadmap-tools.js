/**
 * Roadmap command helpers for issue #48:
 * - gpu-plan
 * - verify-context
 * - amd-guard
 * - toolcheck
 */

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

function parseModelSizeGB(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 0 ? value : null;
    }

    if (typeof value !== 'string' || !value.trim()) return null;

    const normalized = value.trim().toUpperCase();
    const match = normalized.match(/^(\d+\.?\d*)\s*(GB|G|B)?$/);
    if (!match) return null;

    const amount = parseFloat(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const unit = match[2] || 'B';
    if (unit === 'GB' || unit === 'G') return amount;

    // Parameters in billions -> rough Q4 memory footprint.
    return amount * 0.55;
}

function flattenGPUs(hardware = {}) {
    const gpus = [];
    const backends = hardware.backends || {};

    for (const [backend, data] of Object.entries(backends)) {
        if (!data || !data.available || !data.info) continue;

        if (Array.isArray(data.info.gpus) && data.info.gpus.length > 0) {
            for (const gpu of data.info.gpus) {
                gpus.push({
                    backend,
                    name: gpu.name || `${backend.toUpperCase()} GPU`,
                    vramGB: gpu.memory?.total || 0,
                    speedCoefficient: gpu.speedCoefficient || 0
                });
            }
            continue;
        }

        // Apple Metal detector reports a single GPU differently.
        if (backend === 'metal') {
            gpus.push({
                backend,
                name: data.info.chip || 'Apple Silicon GPU',
                vramGB: data.info.memory?.unified || 0,
                speedCoefficient: data.info.speedCoefficient || 0
            });
        }
    }

    return gpus;
}

function buildGpuPlan(hardware = {}, options = {}) {
    const modelSizeGB = parseModelSizeGB(options.modelSizeGB);
    const summary = hardware.summary || {};
    const gpus = flattenGPUs(hardware).sort((a, b) => {
        if (b.vramGB !== a.vramGB) return b.vramGB - a.vramGB;
        return b.speedCoefficient - a.speedCoefficient;
    });

    const gpuCount = gpus.length;
    const totalVRAM = round1(gpus.reduce((sum, gpu) => sum + gpu.vramGB, 0));
    const strongest = gpus[0] || null;
    const strongestVRAM = strongest ? strongest.vramGB : 0;
    const pooledMaxModelGB = clamp(totalVRAM - 2, 0, Number.MAX_SAFE_INTEGER);
    const singleMaxModelGB = clamp(strongestVRAM - 2, 0, Number.MAX_SAFE_INTEGER);
    const backend = summary.bestBackend || 'cpu';

    let strategy = 'cpu_fallback';
    let strategyReason = 'No compatible GPU backend detected.';

    if (gpuCount === 1) {
        strategy = 'single_gpu';
        strategyReason = `One ${backend.toUpperCase()} GPU detected; keep model weights on a single device.`;
    } else if (gpuCount > 1) {
        strategy = 'distributed';
        strategyReason = `${gpuCount} GPUs detected; use spread scheduling and keep one model shard per device class.`;
    }

    const recommendedParallel = gpuCount >= 4 ? 4 : gpuCount >= 2 ? 2 : 1;
    const maxLoadedModels = gpuCount >= 4 ? 3 : gpuCount >= 2 ? 2 : 1;
    const env = {
        OLLAMA_SCHED_SPREAD: strategy === 'distributed' ? '1' : '0',
        OLLAMA_NUM_PARALLEL: String(recommendedParallel),
        OLLAMA_MAX_LOADED_MODELS: String(maxLoadedModels)
    };

    const fit = modelSizeGB === null ? null : {
        modelSizeGB,
        fitsSingleGPU: modelSizeGB <= singleMaxModelGB,
        fitsPooled: modelSizeGB <= pooledMaxModelGB
    };

    const recommendations = [];
    if (gpuCount > 1) {
        recommendations.push(
            `Prefer model sizes <= ${round1(singleMaxModelGB)}GB for deterministic single-GPU residency.`,
            `Pooled envelope is ~${round1(pooledMaxModelGB)}GB if scheduling spreads the load.`
        );
    } else if (gpuCount === 1) {
        recommendations.push(`Keep model payload <= ${round1(singleMaxModelGB)}GB for stable inference.`);
    } else {
        recommendations.push('Use smaller quantized models and prioritize CPU-safe profiles.');
    }

    return {
        backend,
        gpuCount,
        gpus,
        totalVRAM,
        strongestGPU: strongest,
        singleMaxModelGB: round1(singleMaxModelGB),
        pooledMaxModelGB: round1(pooledMaxModelGB),
        strategy,
        strategyReason,
        env,
        fit,
        recommendations
    };
}

function extractContextWindow(showPayload = {}) {
    if (!showPayload || typeof showPayload !== 'object') return null;

    // Typical `/api/show` values in newer Ollama builds.
    const modelInfo = showPayload.model_info || {};
    for (const [key, value] of Object.entries(modelInfo)) {
        if (!key.toLowerCase().includes('context_length')) continue;
        const parsed = parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    // Older payloads often expose this in free-form parameters text.
    const paramsText = typeof showPayload.parameters === 'string' ? showPayload.parameters : '';
    const match = paramsText.match(/num_ctx\s+(\d+)/i);
    if (match) {
        const parsed = parseInt(match[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    return null;
}

function estimateKvCachePer1kTokensGB(modelSizeGB = 7) {
    // Practical approximation that scales with model size.
    // This keeps estimates conservative while avoiding huge over-allocation.
    return clamp(modelSizeGB / 90, 0.03, 0.45);
}

function buildContextVerification(input = {}) {
    const {
        modelName = 'unknown',
        targetTokens = 8192,
        declaredContext = null,
        modelSizeGB = 7,
        hardware = {}
    } = input;

    const summary = hardware.summary || {};
    const effectiveMemoryGB = summary.effectiveMemory || Math.round((summary.systemRAM || 8) * 0.7);
    const kvPer1k = estimateKvCachePer1kTokensGB(modelSizeGB);
    const kvBudgetGB = Math.max(0, effectiveMemoryGB - modelSizeGB - 2);
    const memoryLimitedContext = Math.max(1024, Math.floor((kvBudgetGB / kvPer1k) * 1000));

    let recommendedContext = memoryLimitedContext;
    if (declaredContext) recommendedContext = Math.min(recommendedContext, declaredContext);

    const checks = [];
    if (declaredContext) {
        checks.push({
            id: 'declared_context',
            status: targetTokens <= declaredContext ? 'pass' : 'fail',
            message: `Model-declared context window: ${declaredContext} tokens`
        });
    } else {
        checks.push({
            id: 'declared_context',
            status: 'warn',
            message: 'Model metadata does not expose an explicit context length.'
        });
    }

    checks.push({
        id: 'memory_budget',
        status: targetTokens <= memoryLimitedContext ? 'pass' : 'warn',
        message: `Estimated memory-safe context: ~${memoryLimitedContext} tokens on this hardware`
    });

    let status = 'pass';
    if (checks.some((item) => item.status === 'fail')) status = 'fail';
    else if (checks.some((item) => item.status === 'warn')) status = 'warn';

    const suggestions = [];
    if (status === 'fail') {
        suggestions.push(`Reduce target context to <= ${recommendedContext} tokens.`);
    } else if (status === 'warn') {
        suggestions.push(`Use ${recommendedContext} tokens as a safer runtime default.`);
    } else {
        suggestions.push(`Target context (${targetTokens}) is within estimated safe limits.`);
    }

    if (modelSizeGB > effectiveMemoryGB * 0.7) {
        suggestions.push('Consider a smaller quantization to preserve KV cache headroom.');
    }

    return {
        modelName,
        targetTokens,
        declaredContext,
        modelSizeGB: round1(modelSizeGB),
        effectiveMemoryGB: round1(effectiveMemoryGB),
        memoryLimitedContext,
        recommendedContext,
        status,
        checks,
        suggestions
    };
}

function buildAmdGuard(input = {}) {
    const {
        platform = process.platform,
        hardware = {},
        rocmAvailable = false,
        rocmDetectionMethod = null
    } = input;

    const backends = hardware.backends || {};
    const summary = hardware.summary || {};
    const hasRocmBackend = !!backends.rocm?.available;
    const hasAmdGPU = hasRocmBackend || !!rocmDetectionMethod || summary.bestBackend === 'rocm';

    const checks = [];

    checks.push({
        id: 'amd_presence',
        status: hasAmdGPU ? 'pass' : 'warn',
        message: hasAmdGPU ? 'AMD GPU path detected.' : 'No AMD GPU backend detected.'
    });

    if (platform === 'win32' && hasAmdGPU && !hasRocmBackend) {
        checks.push({
            id: 'windows_runtime',
            status: 'warn',
            message: 'Windows AMD path may fall back to CPU unless ROCm-equivalent stack is configured.'
        });
    } else if (platform === 'linux' && hasAmdGPU && !rocmAvailable) {
        checks.push({
            id: 'linux_runtime',
            status: 'warn',
            message: `AMD GPU detected via ${rocmDetectionMethod || 'fallback'} without ROCm userspace tools.`
        });
    } else if (hasAmdGPU) {
        checks.push({
            id: 'runtime_stack',
            status: 'pass',
            message: 'ROCm runtime path appears available.'
        });
    }

    if (summary.bestBackend === 'cpu' && hasAmdGPU) {
        checks.push({
            id: 'backend_selection',
            status: 'warn',
            message: 'Primary backend resolved to CPU despite AMD detection.'
        });
    } else if (summary.bestBackend === 'rocm') {
        checks.push({
            id: 'backend_selection',
            status: 'pass',
            message: 'ROCm selected as primary backend.'
        });
    }

    let status = 'pass';
    if (checks.some((item) => item.status === 'fail')) status = 'fail';
    else if (checks.some((item) => item.status === 'warn')) status = 'warn';

    const recommendations = [];
    if (platform === 'linux' && hasAmdGPU && !rocmAvailable) {
        recommendations.push('Install ROCm runtime packages and verify `rocm-smi` availability.');
    }
    if (platform === 'win32' && hasAmdGPU) {
        recommendations.push('On Windows, validate latest Adrenalin driver or use WSL2 for ROCm workloads.');
    }
    if (summary.bestBackend === 'cpu' && hasAmdGPU) {
        recommendations.push('Force a small model profile until GPU backend is consistently selected.');
    }
    if (recommendations.length === 0) {
        recommendations.push('AMD path looks healthy for local LLM inference.');
    }

    return {
        status,
        platform,
        rocmAvailable: !!rocmAvailable,
        rocmDetectionMethod: rocmDetectionMethod || 'none',
        primaryBackend: summary.bestBackend || 'cpu',
        checks,
        recommendations
    };
}

function evaluateToolCallingResult(chatPayload = null, error = null) {
    if (error) {
        return {
            status: 'unsupported',
            score: 0,
            reason: error.message || String(error),
            toolCalls: []
        };
    }

    const message = chatPayload?.message || {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length > 0) {
        return {
            status: 'supported',
            score: 100,
            reason: 'Model emitted structured tool_calls.',
            toolCalls
        };
    }

    const content = (message.content || '').toLowerCase();
    if (content.includes('5') || content.includes('add_numbers') || content.includes('tool')) {
        return {
            status: 'partial',
            score: 50,
            reason: 'Model responded but did not emit structured tool_calls.',
            toolCalls: []
        };
    }

    return {
        status: 'unsupported',
        score: 10,
        reason: 'No tool-calling markers found in response.',
        toolCalls: []
    };
}

module.exports = {
    buildAmdGuard,
    buildContextVerification,
    buildGpuPlan,
    evaluateToolCallingResult,
    extractContextWindow,
    parseModelSizeGB
};
