'use strict';

const CPU_ONLY_ENV = 'LLM_CHECKER_CPU_ONLY';
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function parseBooleanOptIn(value) {
    if (typeof value === 'boolean') return value;
    if (value === null || value === undefined) return false;
    return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

function resolveCpuOnlyMode(explicit, env = process.env) {
    if (explicit !== undefined && explicit !== null) {
        return parseBooleanOptIn(explicit);
    }
    return parseBooleanOptIn(env?.[CPU_ONLY_ENV]);
}

function toFiniteNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function getSystemRAMGB(hardware = {}) {
    const candidates = [
        hardware.summary?.systemRAM,
        hardware.memory?.totalGB,
        hardware.memory?.total,
        hardware.total_ram_gb,
        hardware.memoryGB,
        hardware.ramGB
    ];

    for (const candidate of candidates) {
        const value = toFiniteNumber(candidate);
        if (value !== null && value > 0) return value;
    }

    return 8;
}

function getCpuSpeedCoefficient(hardware = {}) {
    const candidates = [
        hardware.cpu?.speedCoefficient,
        hardware.backends?.cpu?.info?.speedCoefficient,
        hardware.cpu?.score,
        hardware.summary?.bestBackend === 'cpu' ? hardware.summary?.speedCoefficient : null
    ];

    for (const candidate of candidates) {
        const value = toFiniteNumber(candidate);
        if (value !== null && value >= 0) return value;
    }

    return 30;
}

function getCpuOnlyEffectiveMemoryGB(hardware = {}) {
    const totalRAM = getSystemRAMGB(hardware);
    return Math.max(1, Math.round(totalRAM * 0.7));
}

function classifyCpuOnlyTier(effectiveMemory, speedCoefficient) {
    const effectiveMem = Number(effectiveMemory) || 0;
    const speed = Number(speedCoefficient) || 0;

    if (effectiveMem >= 80 && speed >= 300) return 'ultra_high';
    if (effectiveMem >= 48 && speed >= 200) return 'very_high';
    if (effectiveMem >= 24 && speed >= 150) return 'high';
    if (effectiveMem >= 16 && speed >= 100) return 'medium_high';
    if (effectiveMem >= 12 && speed >= 80) return 'medium';
    if (effectiveMem >= 8 && speed >= 50) return 'medium_low';
    if (effectiveMem >= 6 && speed >= 30) return 'low';
    return 'ultra_low';
}

function normalizeGpuInventoryEntry(entry) {
    if (typeof entry === 'string') {
        const name = entry.trim();
        return name ? { name, count: 1 } : null;
    }
    if (!entry || typeof entry !== 'object') return null;

    const name = String(entry.name || entry.model || '').trim();
    if (!name || /^(?:no gpu detected|none|unknown|disabled by cpu-only mode)$/i.test(name)) {
        return null;
    }
    const parsedCount = toFiniteNumber(entry.count);
    return {
        name,
        count: parsedCount !== null && parsedCount > 0 ? parsedCount : 1
    };
}

function collapseGpuInventory(entries = []) {
    const counts = new Map();
    for (const entry of entries) {
        const normalized = normalizeGpuInventoryEntry(entry);
        if (!normalized) continue;
        counts.set(normalized.name, (counts.get(normalized.name) || 0) + normalized.count);
    }
    return Array.from(counts, ([name, count]) => ({ name, count }));
}

function inferGpuInventories(hardware = {}) {
    const summary = hardware.summary || {};
    const gpu = hardware.gpu || {};
    const existingDedicated = Array.isArray(summary.dedicatedGpuModels)
        ? summary.dedicatedGpuModels
        : gpu.dedicatedGpuModels;
    const existingIntegrated = Array.isArray(summary.integratedGpuModels)
        ? summary.integratedGpuModels
        : gpu.integratedGpuModels;

    let dedicatedGpuModels = collapseGpuInventory(existingDedicated);
    let integratedGpuModels = collapseGpuInventory(existingIntegrated);
    if (dedicatedGpuModels.length && integratedGpuModels.length) {
        return { dedicatedGpuModels, integratedGpuModels };
    }

    let candidates = Array.isArray(gpu.all) ? gpu.all : [];
    if (candidates.length === 0 && Array.isArray(summary.gpuModels)) {
        candidates = summary.gpuModels;
    }
    if (candidates.length === 0) {
        const model = summary.gpuModel || gpu.model;
        if (model) candidates = [{ model }];
    }

    const inferredDedicated = [];
    const inferredIntegrated = [];
    for (const candidate of candidates) {
        const normalized = normalizeGpuInventoryEntry(candidate);
        if (!normalized) continue;

        const candidateDetails = typeof candidate === 'object' && candidate ? candidate : {};
        const unified = candidateDetails.unified === true || gpu.unified === true;
        const dedicated = candidateDetails.dedicated !== undefined
            ? candidateDetails.dedicated === true
            : (gpu.dedicated !== undefined
                ? gpu.dedicated === true
                : Boolean(summary.hasDedicatedGPU && !summary.hasIntegratedGPU));
        (unified || !dedicated ? inferredIntegrated : inferredDedicated).push(normalized);
    }

    if (dedicatedGpuModels.length === 0) {
        dedicatedGpuModels = collapseGpuInventory(inferredDedicated);
    }
    if (integratedGpuModels.length === 0) {
        integratedGpuModels = collapseGpuInventory(inferredIntegrated);
    }
    return { dedicatedGpuModels, integratedGpuModels };
}

function buildDetectedGpuDiagnostic(hardware = {}) {
    if (hardware.detectedGpu) return hardware.detectedGpu;

    const summary = hardware.summary || {};
    const gpu = hardware.gpu || null;
    const { dedicatedGpuModels, integratedGpuModels } = inferGpuInventories(hardware);
    const canonicalGpuModels = collapseGpuInventory(summary.gpuModels);
    const gpuModels = canonicalGpuModels.length > 0
        ? canonicalGpuModels
        : collapseGpuInventory([...dedicatedGpuModels, ...integratedGpuModels]);
    const availableBackends = Object.entries(hardware.backends || {})
        .filter(([backend, info]) => backend !== 'cpu' && info?.available)
        .map(([backend]) => backend);

    return {
        primary: hardware.primary ? {
            type: hardware.primary.type || null,
            name: hardware.primary.name || null
        } : null,
        backend: summary.bestBackend || hardware.primary?.type || gpu?.backend || null,
        runtimeBackend: summary.runtimeBackend || null,
        model: summary.gpuModel || gpu?.model || null,
        inventory: summary.gpuInventory || gpu?.gpuInventory || null,
        models: gpuModels,
        dedicatedGpuModels,
        integratedGpuModels,
        totalVRAM: toFiniteNumber(summary.totalVRAM) ??
            toFiniteNumber(gpu?.totalVRAM) ??
            toFiniteNumber(gpu?.vramGB) ??
            toFiniteNumber(gpu?.vram) ??
            0,
        gpuCount: toFiniteNumber(summary.gpuCount) ??
            toFiniteNumber(gpu?.gpuCount) ??
            (Array.isArray(gpu?.all) ? gpu.all.length : 0),
        isMultiGPU: Boolean(summary.isMultiGPU || gpu?.isMultiGPU),
        hasDedicatedGPU: dedicatedGpuModels.length > 0 ||
            Boolean(summary.hasDedicatedGPU || gpu?.hasDedicatedGPU || gpu?.dedicated),
        hasIntegratedGPU: integratedGpuModels.length > 0 ||
            Boolean(summary.hasIntegratedGPU || gpu?.hasIntegratedGPU || gpu?.unified),
        availableBackends,
        gpu: gpu ? { ...gpu } : null
    };
}

function applyCpuOnlyOverride(hardware = {}, options = {}) {
    if (!hardware || typeof hardware !== 'object') return hardware;

    const hasExplicitOption = Object.prototype.hasOwnProperty.call(options, 'cpuOnly');
    const hasHardwareMode = Object.prototype.hasOwnProperty.call(hardware, 'cpuOnly');
    const enabled = hardware.cpuOnly === true || resolveCpuOnlyMode(
        hasExplicitOption
            ? options.cpuOnly
            : (hasHardwareMode ? hardware.cpuOnly : undefined),
        options.env || process.env
    );
    if (!enabled) return hardware;

    const summary = hardware.summary || {};
    const totalRAM = getSystemRAMGB(hardware);
    const effectiveMemory = getCpuOnlyEffectiveMemoryGB(hardware);
    const speedCoefficient = getCpuSpeedCoefficient(hardware);
    const cpuInfo = hardware.cpu || hardware.backends?.cpu?.info || null;
    const detectedGpu = buildDetectedGpuDiagnostic(hardware);
    const source = hardware.cpuOnlySource || options.source || (
        hasExplicitOption ? 'explicit' : 'environment'
    );

    return {
        ...hardware,
        cpuOnly: true,
        cpuOnlySource: source,
        executionMode: 'cpu_only',
        backend: 'cpu',
        totalVRAM: 0,
        gpuCount: 0,
        usableMemGB: effectiveMemory,
        primary: {
            type: 'cpu',
            name: 'CPU (forced)',
            info: cpuInfo
        },
        summary: {
            ...summary,
            cpuOnly: true,
            bestBackend: 'cpu',
            backendName: 'CPU (forced)',
            bestBackendLabel: 'CPU (forced)',
            runtimeBackend: 'cpu',
            runtimeBackendName: 'CPU',
            hasRuntimeAssist: false,
            totalVRAM: 0,
            effectiveMemory,
            systemRAM: totalRAM,
            speedCoefficient,
            isMultiGPU: false,
            gpuCount: 0,
            gpuModel: null,
            gpuInventory: null,
            gpuModels: [],
            hasHeterogeneousGPU: false,
            hasIntegratedGPU: false,
            hasDedicatedGPU: false,
            integratedGpuCount: 0,
            dedicatedGpuCount: 0,
            integratedGpuModels: [],
            dedicatedGpuModels: [],
            integratedSharedMemory: 0,
            hardwareTier: classifyCpuOnlyTier(effectiveMemory, speedCoefficient)
        },
        gpu: {
            ...(hardware.gpu || {}),
            type: 'cpu_only',
            model: 'Disabled by CPU-only mode',
            vendor: '',
            backend: 'cpu',
            vram: 0,
            vramGB: 0,
            vramPerGPU: 0,
            totalVRAM: 0,
            sharedMemory: 0,
            dedicatedMemory: 0,
            dedicated: false,
            unified: false,
            gpuCount: 0,
            isMultiGPU: false,
            hasIntegratedGPU: false,
            hasDedicatedGPU: false,
            integratedGpuCount: 0,
            dedicatedGpuCount: 0,
            integratedGpuModels: [],
            dedicatedGpuModels: [],
            gpuInventory: null,
            all: [],
            score: 0
        },
        acceleration: {
            ...(hardware.acceleration || {}),
            supports_metal: false,
            supports_cuda: false,
            supports_rocm: false,
            supports_vulkan: false
        },
        detectedGpu
    };
}

function getCpuOnlyMaxModelSize(hardware = {}, headroomGB = 2) {
    const effectiveMemory = hardware.cpuOnly
        ? (toFiniteNumber(hardware.summary?.effectiveMemory) ?? getCpuOnlyEffectiveMemoryGB(hardware))
        : getCpuOnlyEffectiveMemoryGB(hardware);
    return Math.max(0, effectiveMemory - Math.max(0, Number(headroomGB) || 0));
}

module.exports = {
    CPU_ONLY_ENV,
    applyCpuOnlyOverride,
    classifyCpuOnlyTier,
    getCpuOnlyEffectiveMemoryGB,
    getCpuOnlyMaxModelSize,
    getSystemRAMGB,
    parseBooleanOptIn,
    resolveCpuOnlyMode
};
