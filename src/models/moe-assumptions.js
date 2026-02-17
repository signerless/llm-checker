/**
 * Canonical MoE helpers shared across recommendation/scoring paths.
 *
 * Centralizes:
 * - MoE feature detection/normalization
 * - Active-vs-total parameter fallback logic
 * - Runtime-aware routing/offload overhead profiles for speed estimation
 */

const MOE_RUNTIME_PROFILES = Object.freeze({
    ollama: Object.freeze({
        runtime: 'ollama',
        routingOverhead: 0.18,
        communicationOverhead: 0.13,
        offloadOverhead: 0.08,
        maxEffectiveGain: 2.35,
        notes: ['generic router path', 'mixed expert communication', 'partial offload risk']
    }),
    vllm: Object.freeze({
        runtime: 'vllm',
        routingOverhead: 0.12,
        communicationOverhead: 0.08,
        offloadOverhead: 0.04,
        maxEffectiveGain: 2.65,
        notes: ['optimized scheduler', 'better expert batching', 'lower offload pressure']
    }),
    mlx: Object.freeze({
        runtime: 'mlx',
        routingOverhead: 0.16,
        communicationOverhead: 0.10,
        offloadOverhead: 0.05,
        maxEffectiveGain: 2.45,
        notes: ['apple-unified memory path', 'metal expert routing', 'reduced copy overhead']
    }),
    'llama.cpp': Object.freeze({
        runtime: 'llama.cpp',
        routingOverhead: 0.20,
        communicationOverhead: 0.14,
        offloadOverhead: 0.09,
        maxEffectiveGain: 2.30,
        notes: ['portable backend path', 'higher routing overhead', 'manual offload tuning']
    })
});

const RUNTIME_ALIASES = Object.freeze({
    ollama: 'ollama',
    vllm: 'vllm',
    mlx: 'mlx',
    'mlx-lm': 'mlx',
    mlx_lm: 'mlx',
    'llama.cpp': 'llama.cpp',
    llamacpp: 'llama.cpp',
    llama_cpp: 'llama.cpp'
});

function parseBillionsValue(rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') return null;

    if (typeof rawValue === 'number') {
        return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : null;
    }

    if (typeof rawValue !== 'string') return null;

    const normalized = rawValue.trim().toLowerCase();
    if (!normalized) return null;

    const match = normalized.match(/(\d+\.?\d*)\s*([bm])?/i);
    if (!match) return null;

    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return null;

    const suffix = (match[2] || 'b').toLowerCase();
    return suffix === 'm' ? value / 1000 : value;
}

function parsePositiveNumber(rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') return null;
    const candidate = Number(rawValue);
    if (!Number.isFinite(candidate) || candidate <= 0) return null;
    return candidate;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeMoERuntime(runtime = 'ollama') {
    const normalized = String(runtime || 'ollama').trim().toLowerCase();
    return RUNTIME_ALIASES[normalized] || 'ollama';
}

function getMoERuntimeProfile(runtime = 'ollama') {
    const normalizedRuntime = normalizeMoERuntime(runtime);
    const profile = MOE_RUNTIME_PROFILES[normalizedRuntime] || MOE_RUNTIME_PROFILES.ollama;

    const routingMultiplier = 1 - profile.routingOverhead;
    const communicationMultiplier = 1 - profile.communicationOverhead;
    const offloadMultiplier = 1 - profile.offloadOverhead;
    const overheadMultiplier = routingMultiplier * communicationMultiplier * offloadMultiplier;

    return {
        ...profile,
        runtime: normalizedRuntime,
        routingMultiplier,
        communicationMultiplier,
        offloadMultiplier,
        overheadMultiplier
    };
}

function extractMoEMetadata({ model = {}, variant = {}, paramsB = null, baseText = '' } = {}) {
    const totalParamsB = [
        variant.total_params_b,
        variant.totalParamsB,
        variant.total_params,
        variant.totalParams,
        model.total_params_b,
        model.totalParamsB,
        model.total_params,
        model.totalParams
    ]
        .map((value) => parseBillionsValue(value))
        .find((value) => Number.isFinite(value));

    const activeParamsB = [
        variant.active_params_b,
        variant.activeParamsB,
        variant.active_params,
        variant.activeParams,
        model.active_params_b,
        model.activeParamsB,
        model.active_params,
        model.activeParams
    ]
        .map((value) => parseBillionsValue(value))
        .find((value) => Number.isFinite(value));

    const expertCount = [
        variant.expert_count,
        variant.expertCount,
        model.expert_count,
        model.expertCount
    ]
        .map((value) => parsePositiveNumber(value))
        .find((value) => Number.isFinite(value));

    const expertsActivePerToken = [
        variant.experts_active_per_token,
        variant.expertsActivePerToken,
        variant.active_experts,
        variant.activeExperts,
        model.experts_active_per_token,
        model.expertsActivePerToken,
        model.active_experts,
        model.activeExperts
    ]
        .map((value) => parsePositiveNumber(value))
        .find((value) => Number.isFinite(value));

    const text = String(baseText || '').toLowerCase();
    const isMoE = Boolean(
        variant.is_moe ||
            variant.isMoE ||
            model.is_moe ||
            model.isMoE ||
            Number.isFinite(totalParamsB) ||
            Number.isFinite(activeParamsB) ||
            (Number.isFinite(expertCount) && Number.isFinite(expertsActivePerToken)) ||
            text.includes('moe') ||
            text.includes('mixtral')
    );

    return {
        isMoE,
        totalParamsB: Number.isFinite(totalParamsB) ? totalParamsB : null,
        activeParamsB: Number.isFinite(activeParamsB) ? activeParamsB : null,
        expertCount: Number.isFinite(expertCount) ? expertCount : null,
        expertsActivePerToken: Number.isFinite(expertsActivePerToken) ? expertsActivePerToken : null,
        paramsB: parseBillionsValue(paramsB)
    };
}

function resolveMoEParameterProfile(model = {}) {
    const denseParamsB = parseBillionsValue(model.paramsB);
    const totalParamsB = parseBillionsValue(model.totalParamsB ?? model.total_params_b ?? model.total_params);
    const activeParamsBRaw = parseBillionsValue(model.activeParamsB ?? model.active_params_b ?? model.active_params);
    const expertCount = parsePositiveNumber(model.expertCount ?? model.expert_count);
    const expertsActivePerToken = parsePositiveNumber(
        model.expertsActivePerToken ??
            model.experts_active_per_token ??
            model.activeExperts ??
            model.active_experts
    );

    const normalizedTotalParamsB = Number.isFinite(totalParamsB) ? totalParamsB : null;
    const normalizedActiveParamsB =
        Number.isFinite(activeParamsBRaw) && Number.isFinite(normalizedTotalParamsB)
            ? Math.min(activeParamsBRaw, normalizedTotalParamsB)
            : Number.isFinite(activeParamsBRaw)
              ? activeParamsBRaw
              : null;

    const hasMetadataSignal =
        Number.isFinite(normalizedTotalParamsB) ||
        Number.isFinite(normalizedActiveParamsB) ||
        Number.isFinite(expertCount) ||
        Number.isFinite(expertsActivePerToken);
    const isMoE = Boolean(model.isMoE || model.is_moe || hasMetadataSignal);

    let effectiveParamsB = Number.isFinite(denseParamsB) ? denseParamsB : 1;
    let assumptionSource = 'dense_params';

    if (isMoE) {
        if (Number.isFinite(normalizedActiveParamsB)) {
            effectiveParamsB = normalizedActiveParamsB;
            assumptionSource = 'moe_active_metadata';
        } else if (
            Number.isFinite(normalizedTotalParamsB) &&
            Number.isFinite(expertCount) &&
            Number.isFinite(expertsActivePerToken) &&
            expertCount > 0
        ) {
            const activeRatio = Math.min(1, expertsActivePerToken / expertCount);
            effectiveParamsB = Math.max(0.1, normalizedTotalParamsB * activeRatio);
            assumptionSource = 'moe_derived_expert_ratio';
        } else if (Number.isFinite(normalizedTotalParamsB)) {
            effectiveParamsB = normalizedTotalParamsB;
            assumptionSource = 'moe_fallback_total_params';
        } else if (Number.isFinite(denseParamsB)) {
            effectiveParamsB = denseParamsB;
            assumptionSource = 'moe_fallback_model_params';
        } else {
            effectiveParamsB = 1;
            assumptionSource = 'moe_fallback_default';
        }
    }

    const normalizedEffective = Number.isFinite(effectiveParamsB) && effectiveParamsB > 0 ? effectiveParamsB : 1;

    return {
        isMoE,
        totalParamsB: normalizedTotalParamsB,
        activeParamsB: normalizedActiveParamsB,
        expertCount: Number.isFinite(expertCount) ? expertCount : null,
        expertsActivePerToken: Number.isFinite(expertsActivePerToken) ? expertsActivePerToken : null,
        effectiveParamsB: normalizedEffective,
        assumptionSource
    };
}

function estimateMoESpeedMultiplier({
    model = {},
    runtime = 'ollama',
    denseParamsB = null,
    parameterProfile = null
} = {}) {
    const profile = parameterProfile || resolveMoEParameterProfile(model);
    const runtimeProfile = getMoERuntimeProfile(runtime);

    const denseParams =
        parseBillionsValue(denseParamsB) ??
        parseBillionsValue(model.paramsB) ??
        profile.totalParamsB ??
        profile.effectiveParamsB ??
        1;
    const activeParams = profile.effectiveParamsB || denseParams;

    if (!profile.isMoE) {
        return {
            applied: false,
            runtime: runtimeProfile.runtime,
            runtimeProfile,
            denseParamsB: denseParams,
            activeParamsB: activeParams,
            theoreticalSpeedup: 1,
            overheadMultiplier: 1,
            multiplier: 1,
            assumptionSource: profile.assumptionSource
        };
    }

    const theoreticalSpeedup = clamp(denseParams / Math.max(activeParams, 0.1), 1, 4);
    const overheadMultiplier = runtimeProfile.overheadMultiplier;
    const rawMultiplier = theoreticalSpeedup * overheadMultiplier;
    const multiplier = clamp(rawMultiplier, 1, runtimeProfile.maxEffectiveGain || 2.5);

    return {
        applied: true,
        runtime: runtimeProfile.runtime,
        runtimeProfile,
        denseParamsB: denseParams,
        activeParamsB: activeParams,
        theoreticalSpeedup,
        overheadMultiplier,
        multiplier,
        assumptionSource: profile.assumptionSource
    };
}

module.exports = {
    MOE_RUNTIME_PROFILES,
    parseBillionsValue,
    parsePositiveNumber,
    normalizeMoERuntime,
    getMoERuntimeProfile,
    extractMoEMetadata,
    resolveMoEParameterProfile,
    estimateMoESpeedMultiplier
};
