/**
 * Fine-tuning suitability helper.
 * Provides a simple hardware-aware estimate for Full FT / LoRA / QLoRA.
 */

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function parseModelParamsB(model = {}) {
    const directParams = toNumber(model?.paramsB || model?.meta?.paramsB);
    if (directParams > 0) return directParams;

    const candidates = [
        model?.size,
        model?.model_identifier,
        model?.identifier,
        model?.name,
        model?.meta?.model_identifier,
        model?.meta?.name
    ];

    for (const candidate of candidates) {
        const text = String(candidate || '');
        if (!text) continue;

        const billionMatch = text.match(/(\d+\.?\d*)\s*[bB]\b/);
        if (billionMatch) {
            return toNumber(billionMatch[1]);
        }

        const millionMatch = text.match(/(\d+\.?\d*)\s*[mM]\b/);
        if (millionMatch) {
            return toNumber(millionMatch[1]) / 1000;
        }

        const gbMatch = text.match(/(\d+\.?\d*)\s*[gG][bB]\b/);
        if (gbMatch) {
            // Q4-style rule-of-thumb: ~0.5GB per 1B params.
            return toNumber(gbMatch[1]) / 0.5;
        }
    }

    const reqRam = toNumber(model?.requirements?.ram);
    if (reqRam > 0) {
        // Heuristic fallback: many model entries use ~1.2-1.5x RAM multiplier.
        return Math.max(0, reqRam / 1.5);
    }

    return 0;
}

function getHardwareBudgetGB(hardware = {}) {
    const totalRam = toNumber(
        hardware?.memory?.total ||
        hardware?.memory?.totalGB ||
        hardware?.summary?.systemRAM ||
        hardware?.systemRAM
    );
    const totalVram = toNumber(
        hardware?.gpu?.vram ||
        hardware?.gpu?.vramGB ||
        hardware?.summary?.totalVRAM ||
        hardware?.totalVRAM
    );

    const gpuType = String(hardware?.gpu?.type || '').toLowerCase();
    const gpuModel = String(hardware?.gpu?.model || '').toLowerCase();
    const supportsMetal = Boolean(hardware?.acceleration?.supports_metal);

    const isAppleUnified = supportsMetal ||
        gpuType.includes('apple') ||
        gpuModel.includes('apple') ||
        /\bm[1-4]\b/.test(gpuModel);

    const hasDedicatedLikeGpu = Boolean(
        hardware?.gpu?.dedicated ||
        totalVram > 0 ||
        gpuType.includes('nvidia') ||
        gpuType.includes('amd')
    );

    if (hasDedicatedLikeGpu && totalVram > 0) {
        return {
            budgetGB: totalVram,
            accelerator: 'gpu'
        };
    }

    if (isAppleUnified && totalRam > 0) {
        // Keep headroom for OS and background apps.
        return {
            budgetGB: Math.max(0, Math.floor(totalRam * 0.7)),
            accelerator: 'unified'
        };
    }

    return {
        budgetGB: 0,
        accelerator: 'none'
    };
}

function estimateFineTuningMemoryGB(paramsB) {
    // Coarse practical estimates for local fine-tuning workflows.
    return {
        fullFineTuning: Math.ceil(paramsB * 8 + 4),
        lora: Math.ceil(paramsB * 1.8 + 3),
        qlora: Math.ceil(paramsB * 0.8 + 2)
    };
}

function evaluateFineTuningSupport(model = {}, hardware = {}) {
    const paramsB = parseModelParamsB(model);
    if (paramsB <= 0) {
        return {
            method: 'unknown',
            label: 'Unknown',
            shortLabel: 'Unknown',
            supports: {
                fullFineTuning: false,
                lora: false,
                qlora: false
            },
            requirementsGB: {
                fullFineTuning: 0,
                lora: 0,
                qlora: 0
            },
            paramsB: 0,
            budgetGB: 0,
            accelerator: 'none'
        };
    }

    const { budgetGB, accelerator } = getHardwareBudgetGB(hardware);
    const requirementsGB = estimateFineTuningMemoryGB(paramsB);

    const canFull = budgetGB >= requirementsGB.fullFineTuning;
    const canLoRA = budgetGB >= requirementsGB.lora;
    const canQLoRA = budgetGB >= requirementsGB.qlora;

    if (canFull) {
        return {
            method: 'full_ft',
            label: 'Full FT / LoRA / QLoRA',
            shortLabel: 'Full+LoRA+QLoRA',
            supports: {
                fullFineTuning: true,
                lora: true,
                qlora: true
            },
            requirementsGB,
            paramsB,
            budgetGB,
            accelerator
        };
    }

    if (canLoRA) {
        return {
            method: 'lora',
            label: 'LoRA / QLoRA',
            shortLabel: 'LoRA+QLoRA',
            supports: {
                fullFineTuning: false,
                lora: true,
                qlora: true
            },
            requirementsGB,
            paramsB,
            budgetGB,
            accelerator
        };
    }

    if (canQLoRA) {
        return {
            method: 'qlora',
            label: 'QLoRA only',
            shortLabel: 'QLoRA',
            supports: {
                fullFineTuning: false,
                lora: false,
                qlora: true
            },
            requirementsGB,
            paramsB,
            budgetGB,
            accelerator
        };
    }

    return {
        method: 'none',
        label: accelerator === 'none' ? 'No accelerator' : 'Not suitable',
        shortLabel: accelerator === 'none' ? 'No accel' : 'No FT',
        supports: {
            fullFineTuning: false,
            lora: false,
            qlora: false
        },
        requirementsGB,
        paramsB,
        budgetGB,
        accelerator
    };
}

module.exports = {
    parseModelParamsB,
    estimateFineTuningMemoryGB,
    evaluateFineTuningSupport
};
