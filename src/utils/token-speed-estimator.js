function toNumber(value, fallback = 0) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return fallback;
}

function normalizeModelSizeB(rawModelSizeB) {
    const value = toNumber(rawModelSizeB, 1);
    return Math.max(0.7, value);
}

function detectAppleSilicon(architecture, cpuModel, gpuModel) {
    const signal = `${architecture} ${cpuModel} ${gpuModel}`.toLowerCase();
    return (
        signal.includes('apple silicon') ||
        /(^|\s)m[1-4](\s|$)/.test(signal) ||
        signal.includes('apple m1') ||
        signal.includes('apple m2') ||
        signal.includes('apple m3') ||
        signal.includes('apple m4')
    );
}

function isIntegratedGPU(gpuModel = '') {
    return /iris.*xe|iris.*graphics|uhd.*graphics|vega.*integrated|radeon.*graphics|intel.*integrated|integrated/i.test(gpuModel);
}

function getAppleSiliconBaseline(cpuModel, gpuModel) {
    const signal = `${cpuModel} ${gpuModel}`.toLowerCase();
    const profiles = [
        { pattern: /m4 ultra/, tps7b: 95 },
        { pattern: /m4 max/, tps7b: 65 },
        { pattern: /m4 pro/, tps7b: 43 },
        { pattern: /m4/, tps7b: 30 },
        { pattern: /m3 ultra/, tps7b: 88 },
        { pattern: /m3 max/, tps7b: 58 },
        { pattern: /m3 pro/, tps7b: 34 },
        { pattern: /m3/, tps7b: 27 },
        { pattern: /m2 ultra/, tps7b: 80 },
        { pattern: /m2 max/, tps7b: 52 },
        { pattern: /m2 pro/, tps7b: 32 },
        { pattern: /m2/, tps7b: 24 },
        { pattern: /m1 ultra/, tps7b: 72 },
        { pattern: /m1 max/, tps7b: 48 },
        { pattern: /m1 pro/, tps7b: 30 },
        { pattern: /m1/, tps7b: 22 }
    ];

    for (const profile of profiles) {
        if (profile.pattern.test(signal)) {
            return profile.tps7b;
        }
    }
    return 24;
}

function getDedicatedGPUBaseline(gpuModel, vramGB) {
    const signal = (gpuModel || '').toLowerCase();
    const profiles = [
        { pattern: /h100/, tps7b: 170 },
        { pattern: /a100/, tps7b: 130 },
        { pattern: /rtx 50|rtx50|blackwell/, tps7b: 105 },
        { pattern: /rtx 4090/, tps7b: 80 },
        { pattern: /rtx 4080/, tps7b: 65 },
        { pattern: /rtx 3090/, tps7b: 62 },
        { pattern: /rtx 3080/, tps7b: 50 },
        { pattern: /rtx 3070/, tps7b: 42 },
        { pattern: /rtx 3060/, tps7b: 34 },
        { pattern: /rtx 20/, tps7b: 26 },
        { pattern: /rx 79|7900|7800/, tps7b: 52 },
        { pattern: /rx 69|6800/, tps7b: 42 }
    ];

    for (const profile of profiles) {
        if (profile.pattern.test(signal)) {
            return profile.tps7b;
        }
    }

    if (vramGB >= 24) return 60;
    if (vramGB >= 16) return 48;
    if (vramGB >= 12) return 40;
    if (vramGB >= 8) return 30;
    if (vramGB >= 4) return 18;
    return 14;
}

function hasAVX512(cpuModel = '') {
    const signal = cpuModel.toLowerCase();
    return signal.includes('avx512') ||
        (signal.includes('intel') &&
            (signal.includes('12th') || signal.includes('13th') || signal.includes('14th')));
}

function hasAVX2(cpuModel = '') {
    const signal = cpuModel.toLowerCase();
    return signal.includes('avx2') || signal.includes('intel') || signal.includes('amd');
}

function getCPUBaseline(cpuModel, cores, baseSpeedGHz, integratedGpuAssist) {
    let baseline = 4 + (cores * 0.6) + ((Math.max(1.5, baseSpeedGHz) - 2.0) * 2.5);

    if (hasAVX512(cpuModel)) baseline += 3;
    else if (hasAVX2(cpuModel)) baseline += 1.5;

    if (integratedGpuAssist) baseline += 1;

    const maxBaseline = integratedGpuAssist ? 22 : 18;
    return Math.max(3, Math.min(maxBaseline, baseline));
}

function calculateSizeScale(modelSizeB) {
    const scale = Math.pow(7 / modelSizeB, 0.72);
    return Math.max(0.18, Math.min(2.2, scale));
}

function calculateMemoryFactor(modelSizeB, availableInferenceMemoryGB) {
    const estimatedWorkingSetGB = (modelSizeB * 0.75) + 2;
    const ratio = availableInferenceMemoryGB / Math.max(1, estimatedWorkingSetGB);

    if (ratio >= 1.2) return 1.05;
    if (ratio >= 1.0) return 1.0;
    if (ratio >= 0.75) return 0.85;
    if (ratio >= 0.6) return 0.65;
    return 0.45;
}

function estimateTokenSpeedFromHardware(hardware = {}, options = {}) {
    const cpuModel = String(hardware.cpu?.brand || hardware.cpu?.model || '');
    const gpuModel = String(hardware.gpu?.model || '');
    const architecture = String(hardware.cpu?.architecture || '');

    const modelSizeB = normalizeModelSizeB(options.modelSizeB);
    const cores = Math.max(1, toNumber(hardware.cpu?.physicalCores || hardware.cpu?.cores, 1));
    const baseSpeedGHz = Math.max(1.5, toNumber(hardware.cpu?.speed || hardware.cpu?.speedMax, 2.4));

    const memoryTotalGB = Math.max(
        2,
        toNumber(
            hardware.memory?.total ||
            hardware.memory?.totalGB ||
            hardware.memory_gb,
            8
        )
    );

    const vramGB = Math.max(
        0,
        toNumber(
            hardware.gpu?.vram ||
            hardware.gpu?.vramGB ||
            hardware.gpu?.totalVRAM ||
            hardware.gpu?.memory?.total,
            0
        )
    );

    const appleSilicon = detectAppleSilicon(architecture, cpuModel, gpuModel);
    const integrated = isIntegratedGPU(gpuModel);
    const dedicatedGPU = vramGB > 0 && !integrated && !appleSilicon;

    let baselineTPS7B;
    let backend;
    let availableInferenceMemoryGB;

    if (appleSilicon) {
        backend = 'metal';
        baselineTPS7B = getAppleSiliconBaseline(cpuModel, gpuModel);
        availableInferenceMemoryGB = memoryTotalGB * 0.82;
    } else if (dedicatedGPU) {
        backend = 'gpu';
        baselineTPS7B = getDedicatedGPUBaseline(gpuModel, vramGB);
        availableInferenceMemoryGB = vramGB + Math.min(memoryTotalGB * 0.15, 8);
    } else {
        backend = integrated ? 'integrated' : 'cpu';
        baselineTPS7B = getCPUBaseline(cpuModel, cores, baseSpeedGHz, integrated);
        availableInferenceMemoryGB = memoryTotalGB * 0.65;
    }

    const sizeScale = calculateSizeScale(modelSizeB);
    const memoryFactor = calculateMemoryFactor(modelSizeB, availableInferenceMemoryGB);

    const maxTPS = backend === 'metal' ? 140 : backend === 'gpu' ? 220 : 35;
    const minTPS = backend === 'cpu' ? 1 : 2;

    const estimated = baselineTPS7B * sizeScale * memoryFactor;
    const tokensPerSecond = Math.max(minTPS, Math.min(maxTPS, Math.round(estimated)));

    return {
        tokensPerSecond,
        backend,
        baselineTPS7B: Math.round(baselineTPS7B * 10) / 10,
        sizeScale: Math.round(sizeScale * 1000) / 1000,
        memoryFactor: Math.round(memoryFactor * 1000) / 1000,
        modelSizeB
    };
}

module.exports = {
    estimateTokenSpeedFromHardware
};
