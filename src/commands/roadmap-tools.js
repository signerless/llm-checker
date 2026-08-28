/**
 * Roadmap command helpers for issue #48:
 * - gpu-plan
 * - verify-context
 * - amd-guard
 * - toolcheck
 */

const {
    applyCpuOnlyOverride,
    getCpuOnlyMaxModelSize,
    resolveCpuOnlyMode
} = require('../hardware/cpu-only');

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

function inferGPUInventoryType(gpu = {}, backend = '') {
    const explicitType = String(gpu.type || '').toLowerCase();
    if (explicitType === 'integrated' || explicitType === 'dedicated') return explicitType;
    if (backend === 'metal') return 'integrated';

    const name = String(gpu.name || gpu.model || '').toLowerCase();
    const dedicatedPattern = /(geforce|\brtx\b|\bgtx\b|radeon\s*(?:\(tm\))?\s*rx|\brx\s?\d|quadro|tesla|instinct|\barc\s*a\d|a\d{3,}|h100|h200|l40)/i;
    if (dedicatedPattern.test(name)) return 'dedicated';

    const integratedPattern = /(intel|iris|uhd|hd graphics|radeon.*graphics|\b\d{3,4}m\b|vega|apple|tegra|jetson)/i;
    return integratedPattern.test(name) ? 'integrated' : 'dedicated';
}

function getGPUModelMatchKey(name) {
    const lower = String(name || '').toLowerCase();
    if (!lower) return '';

    // Dedicated backends and systeminformation often describe the same card
    // differently (for example "RTX 3090" vs "GA102 [GeForce RTX 3090]").
    const familyMatch = lower.match(/\b(rtx|gtx|rx|arc)\s*[- ]?([a-z]?\d{3,4})\b/);
    if (familyMatch) return `${familyMatch[1]}${familyMatch[2]}`;

    const acceleratorMatch = lower.match(/\b(a\d{3,4}|h\d{3,4}|l\d{2}s?|mi\d{2,4}x?)\b/);
    if (acceleratorMatch) return acceleratorMatch[1];

    const bracketPciId = lower.match(/\[[0-9a-f]{4}:([0-9a-f]{4})\]/);
    if (bracketPciId) return `pci:${bracketPciId[1]}`;
    const barePciId = lower.match(/\bdevice\s+([0-9a-f]{4})\b/);
    if (barePciId) return `pci:${barePciId[1]}`;

    return lower
        .replace(/nvidia|amd|ati|intel|corporation|geforce|radeon|graphics/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getGPUCrossBackendKeys(gpu = {}, backend = '') {
    const keys = new Set();
    const type = inferGPUInventoryType(gpu, backend);

    for (const uuid of [gpu.uuid, gpu.gpuUuid, gpu.gpuUUID]) {
        const normalized = String(uuid || '').trim().toLowerCase();
        if (normalized) keys.add(`uuid:${normalized}`);
    }

    for (const address of [gpu.pciBus, gpu.busAddress, gpu.pcie?.busId, gpu.pcie?.busAddress]) {
        const raw = String(address || '').trim().toLowerCase();
        const normalized = raw.match(/([0-9a-f]{2}:[0-9a-f]{2}\.[0-7])$/)?.[1] || raw;
        if (normalized) keys.add(`pci-bus:${normalized}`);
    }

    const modelKey = getGPUModelMatchKey(gpu.name || gpu.model);
    if (modelKey) keys.add(`model:${modelKey}|${type}`);

    return keys;
}

function getBackendGPUEntries(backend, data) {
    if (!data || !data.available || !data.info) return [];

    if (Array.isArray(data.info.gpus) && data.info.gpus.length > 0) {
        return data.info.gpus.map((gpu) => ({
            backend,
            source: gpu,
            flattened: {
                backend,
                name: gpu.name || `${backend.toUpperCase()} GPU`,
                vramGB: gpu.memory?.total || 0,
                speedCoefficient: gpu.speedCoefficient || 0
            }
        }));
    }

    // Apple Metal detector reports a single GPU differently.
    if (backend === 'metal') {
        const source = {
            name: data.info.chip || 'Apple Silicon GPU',
            type: 'integrated',
            memory: { total: data.info.memory?.unified || 0 }
        };
        return [{
            backend,
            source,
            flattened: {
                backend,
                name: source.name,
                vramGB: source.memory.total,
                speedCoefficient: data.info.speedCoefficient || 0
            }
        }];
    }

    return [];
}

function flattenGPUs(hardware = {}) {
    const backends = hardware.backends || {};
    const entries = Object.entries(backends)
        .flatMap(([backend, data]) => getBackendGPUEntries(backend, data));
    const specializedKeys = new Set();

    // Dedicated detector output is authoritative. Preserve every entry inside
    // each specialized backend so two real, identical GPUs remain two devices;
    // use those identities only to suppress duplicate generic inventory views.
    for (const entry of entries) {
        if (entry.backend === 'generic') continue;
        for (const key of getGPUCrossBackendKeys(entry.source, entry.backend)) {
            specializedKeys.add(key);
        }
    }

    const gpus = [];
    for (const entry of entries) {
        if (entry.backend === 'generic') {
            const isDuplicate = Array.from(getGPUCrossBackendKeys(entry.source, entry.backend))
                .some((key) => specializedKeys.has(key));
            if (isDuplicate) continue;
        }

        gpus.push(entry.flattened);
    }

    return gpus;
}

function buildGpuPlan(hardware = {}, options = {}) {
    const modelSizeGB = parseModelSizeGB(options.modelSizeGB);
    const cpuOnly = Boolean(hardware.cpuOnly) || resolveCpuOnlyMode(
        Object.prototype.hasOwnProperty.call(options, 'cpuOnly') ? options.cpuOnly : undefined
    );
    const effectiveHardware = cpuOnly
        ? applyCpuOnlyOverride(hardware, { cpuOnly: true, source: 'gpu-plan' })
        : hardware;
    const summary = effectiveHardware.summary || {};
    const gpus = (cpuOnly ? [] : flattenGPUs(effectiveHardware)).sort((a, b) => {
        if (b.vramGB !== a.vramGB) return b.vramGB - a.vramGB;
        return b.speedCoefficient - a.speedCoefficient;
    });

    const gpuCount = gpus.length;
    const totalVRAM = round1(gpus.reduce((sum, gpu) => sum + gpu.vramGB, 0));
    const strongest = gpus[0] || null;
    const strongestVRAM = strongest ? strongest.vramGB : 0;
    const pooledMaxModelGB = clamp(totalVRAM - 2, 0, Number.MAX_SAFE_INTEGER);
    const singleMaxModelGB = clamp(strongestVRAM - 2, 0, Number.MAX_SAFE_INTEGER);
    const cpuMaxModelGB = cpuOnly ? getCpuOnlyMaxModelSize(effectiveHardware) : 0;
    const backend = summary.bestBackend || 'cpu';

    let strategy = 'cpu_fallback';
    let strategyReason = 'No compatible GPU backend detected.';

    if (cpuOnly) {
        strategy = 'cpu_only';
        strategyReason = 'CPU-only override active; detected GPU inventory is ignored and model fit uses system RAM.';
    } else if (gpuCount === 1) {
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
        fitsPooled: modelSizeGB <= pooledMaxModelGB,
        ...(cpuOnly ? { fitsCPU: modelSizeGB <= cpuMaxModelGB } : {})
    };

    const recommendations = [];
    if (cpuOnly) {
        recommendations.push(
            `Keep model payload <= ${round1(cpuMaxModelGB)}GB for the active CPU/RAM budget.`,
            'Detected GPUs are diagnostic only while CPU-only mode is active.'
        );
    } else if (gpuCount > 1) {
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
        cpuOnly,
        memoryType: cpuOnly ? 'system_ram' : 'vram',
        memoryBudgetGB: cpuOnly ? round1(summary.effectiveMemory || 0) : totalVRAM,
        gpuCount,
        gpus,
        totalVRAM,
        strongestGPU: strongest,
        singleMaxModelGB: round1(singleMaxModelGB),
        pooledMaxModelGB: round1(pooledMaxModelGB),
        cpuMaxModelGB: round1(cpuMaxModelGB),
        strategy,
        strategyReason,
        env,
        fit,
        recommendations,
        detectedGpu: cpuOnly ? effectiveHardware.detectedGpu : undefined
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
