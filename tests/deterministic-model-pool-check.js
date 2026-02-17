const assert = require('assert');
const DeterministicModelSelector = require('../src/models/deterministic-selector');

function buildHighEndHardware() {
    return {
        cpu: { cores: 16, architecture: 'arm64' },
        gpu: { type: 'apple_silicon', unified: true, vramGB: 0 },
        memory: { totalGB: 96 },
        acceleration: { supports_metal: true, supports_cuda: false, supports_rocm: false },
        usableMemGB: 76.8
    };
}

function buildSyntheticOllamaModels() {
    return [
        {
            model_identifier: 'unitmega',
            model_name: 'unitmega',
            description: 'Synthetic high-capacity model family for test coverage',
            primary_category: 'chat',
            context_length: '64K',
            variants: [
                { tag: 'unitmega:8b', size: '8b', quantization: 'Q4_0', real_size_gb: 5, categories: ['chat'] },
                { tag: 'unitmega:70b', size: '70b', quantization: 'Q4_0', real_size_gb: 42, categories: ['chat'] },
                { tag: 'unitmega:405b', size: '405b', quantization: 'Q4_0', real_size_gb: 240, categories: ['chat'] }
            ],
            tags: ['unitmega:8b', 'unitmega:70b', 'unitmega:405b'],
            use_cases: ['chat']
        }
    ];
}

function buildRtx3090Hardware() {
    return {
        cpu: { cores: 24, architecture: 'x86_64' },
        gpu: { model: 'NVIDIA GeForce RTX 3090', vendor: 'NVIDIA', vram: 24, dedicated: true },
        memory: { total: 64 }
    };
}

function buildReasoningPoolForFitRegression() {
    return [
        {
            model_identifier: 'deepfit',
            model_name: 'deepfit',
            description: 'Synthetic reasoning family for fit regression',
            primary_category: 'reasoning',
            context_length: '8K',
            variants: [
                { tag: 'deepfit:8b', size: '8b', quantization: 'Q4_0', real_size_gb: 4.8, categories: ['reasoning'] },
                { tag: 'deepfit:70b', size: '70b', quantization: 'Q4_0', real_size_gb: 43, categories: ['reasoning'] }
            ],
            tags: ['deepfit:8b', 'deepfit:70b'],
            use_cases: ['reasoning']
        }
    ];
}

function buildOptimizationPool() {
    return [
        {
            model_identifier: 'duo',
            model_name: 'duo',
            description: 'Synthetic family to validate optimization profile weighting',
            primary_category: 'general',
            context_length: '8K',
            variants: [
                { tag: 'duo:7b', size: '7b', quantization: 'Q4_0', real_size_gb: 4.5, categories: ['general'], family: 'llama3.2' },
                { tag: 'duo:13b', size: '13b', quantization: 'Q4_0', real_size_gb: 8.2, categories: ['general'], family: 'qwen2.5' }
            ],
            tags: ['duo:7b', 'duo:13b'],
            use_cases: ['general']
        }
    ];
}

function buildThreeGpuHardwareAmbiguousVram() {
    return {
        cpu: { cores: 32, architecture: 'x86_64' },
        gpu: {
            model: 'NVIDIA Tesla V100',
            vendor: 'NVIDIA',
            vram: 12,           // ambiguous field (often per-GPU)
            vramPerGPU: 12,
            gpuCount: 3,
            isMultiGPU: true,
            all: [
                { model: 'NVIDIA Tesla V100', vram: 12, vendor: 'NVIDIA' },
                { model: 'NVIDIA Tesla P40', vram: 12, vendor: 'NVIDIA' },
                { model: 'NVIDIA Tesla M40', vram: 12, vendor: 'NVIDIA' }
            ]
        },
        memory: { total: 128 }
    };
}

function buildApple24GbUnifiedHardware() {
    return {
        cpu: { cores: 12, architecture: 'arm64' },
        gpu: { type: 'apple_silicon', unified: true, vramGB: 0 },
        memory: { totalGB: 24 },
        acceleration: { supports_metal: true, supports_cuda: false, supports_rocm: false },
        usableMemGB: 20.4
    };
}

function buildAppleM4ProHardware() {
    return {
        cpu: { cores: 14, architecture: 'arm64' },
        gpu: { type: 'apple_silicon', unified: true, vramGB: 0 },
        memory: { totalGB: 48 },
        acceleration: { supports_metal: true, supports_cuda: false, supports_rocm: false },
        usableMemGB: 40.8
    };
}

function buildDualGpu36GbHardware() {
    return {
        cpu: { cores: 24, architecture: 'x86_64' },
        gpu: {
            model: 'NVIDIA GeForce RTX 4090',
            vendor: 'NVIDIA',
            vram: 24,        // ambiguous field (often per-GPU)
            vramPerGPU: 24,
            gpuCount: 2,
            isMultiGPU: true,
            all: [
                { model: 'NVIDIA GeForce RTX 4090', vram: 24, vendor: 'NVIDIA' },
                { model: 'NVIDIA GeForce RTX 4070 Ti SUPER', vram: 12, vendor: 'NVIDIA' }
            ]
        },
        memory: { total: 96 }
    };
}

function buildFreshnessRegressionPool() {
    return [
        {
            model_identifier: 'legacychat',
            model_name: 'legacychat',
            description: 'deprecated legacy chat model',
            primary_category: 'chat',
            context_length: '8K',
            deprecated: true,
            last_updated: '2022-01-01T00:00:00.000Z',
            variants: [
                { tag: 'legacychat:8b', size: '8b', quantization: 'Q4_0', real_size_gb: 5.1, categories: ['chat'] }
            ],
            tags: ['legacychat:8b'],
            use_cases: ['chat']
        },
        {
            model_identifier: 'freshchat',
            model_name: 'freshchat',
            description: 'recent chat model',
            primary_category: 'chat',
            context_length: '8K',
            last_updated: '2026-01-20T00:00:00.000Z',
            variants: [
                { tag: 'freshchat:8b', size: '8b', quantization: 'Q4_0', real_size_gb: 5.1, categories: ['chat'] }
            ],
            tags: ['freshchat:8b'],
            use_cases: ['chat']
        }
    ];
}

function buildQuantizationRegressionPool() {
    return [
        {
            model_identifier: 'bigquant',
            model_name: 'bigquant',
            description: 'Large family with quantized variants',
            primary_category: 'chat',
            context_length: '8K',
            variants: [
                { tag: 'bigquant:120b-q4', size: '120b', quantization: 'Q4_0', real_size_gb: 82, categories: ['chat'] },
                { tag: 'bigquant:120b-q2', size: '120b', quantization: 'Q2_K', real_size_gb: 46, categories: ['chat'] }
            ],
            tags: ['bigquant:120b-q4', 'bigquant:120b-q2'],
            use_cases: ['chat']
        },
        {
            model_identifier: 'smallchat',
            model_name: 'smallchat',
            description: 'Small baseline chat model',
            primary_category: 'chat',
            context_length: '8K',
            variants: [
                { tag: 'smallchat:8b', size: '8b', quantization: 'Q4_0', real_size_gb: 5, categories: ['chat'] }
            ],
            tags: ['smallchat:8b'],
            use_cases: ['chat']
        }
    ];
}

function buildConservativeRegressionPool() {
    return [
        {
            model_identifier: 'snappychat',
            model_name: 'snappychat',
            description: 'Fast compact chat model',
            primary_category: 'chat',
            context_length: '8K',
            variants: [
                { tag: 'snappychat:3b', size: '3b', quantization: 'Q4_0', real_size_gb: 2.2, categories: ['chat'] },
                { tag: 'snappychat:8b', size: '8b', quantization: 'Q4_0', real_size_gb: 5.2, categories: ['chat'] }
            ],
            tags: ['snappychat:3b', 'snappychat:8b'],
            use_cases: ['chat']
        }
    ];
}

function buildMultiGpuHighCapacityCoveragePool() {
    return [
        {
            model_identifier: 'multisynth',
            model_name: 'multisynth',
            description: 'Synthetic family to validate 36GB multi-GPU capacity coverage',
            primary_category: 'general',
            context_length: '8K',
            variants: [
                { tag: 'multisynth:8b', size: '8b', quantization: 'Q4_0', real_size_gb: 5.2, categories: ['general'] },
                { tag: 'multisynth:14b', size: '14b', quantization: 'Q4_0', real_size_gb: 8.9, categories: ['general'] },
                { tag: 'multisynth:30b', size: '30b', quantization: 'Q4_0', real_size_gb: 18.8, categories: ['general'] }
            ],
            tags: ['multisynth:8b', 'multisynth:14b', 'multisynth:30b'],
            use_cases: ['general']
        }
    ];
}

function buildM4ProVisionPool() {
    return [
        {
            model_identifier: 'visionduo',
            model_name: 'visionduo',
            description: 'Multimodal family for regression checks',
            primary_category: 'multimodal',
            context_length: '8K',
            variants: [
                { tag: 'visionduo:3b-vl', size: '3b', quantization: 'Q4_0', real_size_gb: 2.4, categories: ['multimodal'] },
                { tag: 'visionduo:8b-vl', size: '8b', quantization: 'Q4_0', real_size_gb: 5.9, categories: ['multimodal'] }
            ],
            tags: ['visionduo:3b-vl', 'visionduo:8b-vl'],
            use_cases: ['multimodal']
        }
    ];
}

function buildMoERuntimeRegressionPool() {
    return [
        {
            model_identifier: 'mixbench',
            model_name: 'mixbench',
            description: 'MoE runtime regression family',
            primary_category: 'chat',
            context_length: '8K',
            variants: [
                {
                    tag: 'mixbench:46b',
                    size: '46b',
                    quantization: 'Q4_0',
                    real_size_gb: 26,
                    categories: ['chat'],
                    is_moe: true,
                    total_params_b: 46,
                    active_params_b: 12,
                    expert_count: 8,
                    experts_active_per_token: 2
                }
            ],
            tags: ['mixbench:46b'],
            use_cases: ['chat']
        }
    ];
}

async function runSelectModelsUsesProvidedPool() {
    const selector = new DeterministicModelSelector();
    const hardware = buildHighEndHardware();
    const pool = buildSyntheticOllamaModels();

    const result = await selector.selectModels('general', {
        hardware,
        installedModels: [],
        modelPool: pool,
        topN: 5,
        silent: true
    });

    const ids = result.candidates.map((c) => c.meta.model_identifier);
    assert.ok(ids.includes('unitmega:70b'), '70B variant should be selectable from provided pool');
    assert.ok(!ids.includes('unitmega:405b'), '405B variant should be filtered out by hardware budget');
}

async function runGetBestModelsForHardwareUsesAllModels() {
    const selector = new DeterministicModelSelector();
    const hardware = buildHighEndHardware();
    const allModels = buildSyntheticOllamaModels();

    // Keep test fully deterministic and independent of local Ollama state.
    selector.getInstalledModels = async () => [];
    selector.getHardware = async () => buildHighEndHardware();

    const recommendations = await selector.getBestModelsForHardware(hardware, allModels);
    const generalIds = (recommendations.general?.bestModels || []).map((m) => m.model_identifier);

    assert.ok(generalIds.length > 0, 'general recommendations should not be empty');
    assert.ok(generalIds.every((id) => id.startsWith('unitmega:')), 'recommendations should come from provided allModels pool');
    assert.ok(generalIds.includes('unitmega:70b'), '70B variant from provided allModels should be considered');
    assert.ok(!generalIds.includes('unitmega:405b'), '405B variant should still be excluded by fit checks');
}

async function runProvidedHardwareProfileIsHonored() {
    const selector = new DeterministicModelSelector();
    const providedHardware = buildRtx3090Hardware();
    const allModels = buildReasoningPoolForFitRegression();

    // Intentionally wrong fallback profile: if this is used, 70B may be selected.
    selector.getHardware = async () => ({
        cpu: { cores: 24, architecture: 'x86_64' },
        gpu: { type: 'cpu_only', vramGB: 0, unified: false },
        memory: { totalGB: 64 },
        acceleration: { supports_metal: false, supports_cuda: false, supports_rocm: false },
        usableMemGB: 50
    });
    selector.getInstalledModels = async () => [];

    const recommendations = await selector.getBestModelsForHardware(providedHardware, allModels);
    const generalIds = (recommendations.general?.bestModels || []).map((m) => m.model_identifier);

    assert.ok(generalIds.includes('deepfit:8b'), '8B variant should be recommended for 24GB VRAM');
    assert.ok(!generalIds.includes('deepfit:70b'), '70B variant should be rejected for 24GB VRAM fit');
}

async function runUndefinedHardwareFallsBackSafely() {
    const selector = new DeterministicModelSelector();
    const allModels = buildSyntheticOllamaModels();

    selector.getInstalledModels = async () => [];
    selector.getHardware = async () => buildHighEndHardware();

    const recommendations = await selector.getBestModelsForHardware(undefined, allModels);
    const generalIds = (recommendations.general?.bestModels || []).map((m) => m.model_identifier);

    assert.ok(generalIds.length > 0, 'general recommendations should be generated when hardware is omitted');
    assert.ok(generalIds.every((id) => id.startsWith('unitmega:')), 'fallback hardware path should still use provided allModels');
}

async function runOptimizationProfilesInfluenceRanking() {
    const selector = new DeterministicModelSelector();
    const hardware = buildRtx3090Hardware();
    const pool = buildOptimizationPool();

    const speedResult = await selector.selectModels('general', {
        hardware,
        installedModels: [],
        modelPool: pool,
        optimizeFor: 'speed',
        topN: 2,
        silent: true
    });
    const qualityResult = await selector.selectModels('general', {
        hardware,
        installedModels: [],
        modelPool: pool,
        optimizeFor: 'quality',
        topN: 2,
        silent: true
    });

    const speedTop = speedResult.candidates[0]?.meta?.model_identifier;
    const qualityTop = qualityResult.candidates[0]?.meta?.model_identifier;

    assert.strictEqual(speedTop, 'duo:7b', `Speed profile should prefer smaller/faster variant, got: ${speedTop}`);
    assert.strictEqual(qualityTop, 'duo:13b', `Quality profile should prefer larger/higher-quality variant, got: ${qualityTop}`);
}

async function runMultiGpuNormalizationUsesCombinedVram() {
    const selector = new DeterministicModelSelector();
    const hardware = buildThreeGpuHardwareAmbiguousVram();
    const allModels = buildReasoningPoolForFitRegression();

    selector.getInstalledModels = async () => [];

    const normalized = selector.normalizeHardwareProfile(hardware);
    assert.strictEqual(normalized.gpu.vramGB, 36, `Expected combined VRAM 36GB, got: ${normalized.gpu.vramGB}`);

    const recommendations = await selector.getBestModelsForHardware(hardware, allModels);
    const reasoningIds = (recommendations.reasoning?.bestModels || []).map((m) => m.model_identifier);
    assert.ok(reasoningIds.includes('deepfit:70b'), '70B reasoning variant should be viable with 36GB aggregate VRAM');
}

async function runMultiGpu36GbIncludesThirtyBWhenFeasible() {
    const selector = new DeterministicModelSelector();
    const hardware = buildDualGpu36GbHardware();
    const pool = buildMultiGpuHighCapacityCoveragePool();

    const normalized = selector.normalizeHardwareProfile(hardware);
    assert.strictEqual(normalized.gpu.vramGB, 36, `Expected dual-GPU combined VRAM 36GB, got: ${normalized.gpu.vramGB}`);

    const result = await selector.selectModels('general', {
        hardware,
        installedModels: [],
        modelPool: pool,
        topN: 1,
        silent: true
    });

    const topModel = result.candidates[0];
    const topParams = topModel?.meta?.paramsB || 0;
    assert.ok(
        topParams >= 30,
        `36GB multi-GPU profile should include >=30B candidate when feasible, got: ${topModel?.meta?.model_identifier || 'none'}`
    );
}

async function runFreshnessPenaltyPrefersRecentModel() {
    const selector = new DeterministicModelSelector();
    const hardware = buildHighEndHardware();
    const pool = buildFreshnessRegressionPool();

    const result = await selector.selectModels('general', {
        hardware,
        installedModels: [],
        modelPool: pool,
        topN: 2,
        silent: true
    });

    const ids = result.candidates.map((candidate) => candidate.meta.model_identifier);
    assert.ok(ids.includes('legacychat:8b'), 'Legacy model should still be considered as a candidate');
    assert.ok(ids.includes('freshchat:8b'), 'Fresh model should be considered as a candidate');
    assert.strictEqual(ids[0], 'freshchat:8b', `Fresh model should outrank deprecated equivalent, got: ${ids[0]}`);
}

async function runQuantizedLargeModelCanBeRecommended() {
    const selector = new DeterministicModelSelector();
    const hardware = buildHighEndHardware();
    const pool = buildQuantizationRegressionPool();

    const result = await selector.selectModels('general', {
        hardware,
        installedModels: [],
        modelPool: pool,
        topN: 6,
        silent: true
    });

    const largeCandidate = result.candidates.find((candidate) => candidate.meta.paramsB >= 100);
    assert.ok(largeCandidate, 'Large-parameter candidate should appear when quantized variant fits the hardware budget');
    assert.ok(['Q3_K', 'Q2_K'].includes(largeCandidate.quant), `Expected compressed quantization (Q3_K/Q2_K), got: ${largeCandidate.quant}`);
}

async function runUnified24GbIncludesMidTierWhenFeasible() {
    const selector = new DeterministicModelSelector();
    const hardware = buildApple24GbUnifiedHardware();
    const pool = buildConservativeRegressionPool();

    const result = await selector.selectModels('general', {
        hardware,
        installedModels: [],
        modelPool: pool,
        topN: 1,
        silent: true
    });

    const topModelParams = result.candidates[0]?.meta?.paramsB || 0;
    assert.ok(topModelParams >= 7, `24GB unified profile should surface at least one mid-tier option when feasible, got: ${topModelParams}B`);
}

async function runM4ProMultimodalIncludesMidTierWhenFeasible() {
    const selector = new DeterministicModelSelector();
    const hardware = buildAppleM4ProHardware();
    const pool = buildM4ProVisionPool();

    const result = await selector.selectModels('multimodal', {
        hardware,
        installedModels: [],
        modelPool: pool,
        topN: 1,
        silent: true
    });

    const topModelParams = result.candidates[0]?.meta?.paramsB || 0;
    assert.ok(topModelParams >= 7, `M4 Pro multimodal profile should include a mid-tier model when feasible, got: ${topModelParams}B`);
}

async function runDenseMemoryPathUsesDenseParams() {
    const selector = new DeterministicModelSelector();
    const denseModel = { paramsB: 46 };
    const breakdown = selector.estimateMemoryBreakdown(denseModel, 'Q4_K_M', 8192);

    assert.strictEqual(breakdown.parameterProfile.isMoE, false, 'Dense model should not be marked as MoE');
    assert.strictEqual(breakdown.parameterProfile.assumptionSource, 'dense_params', 'Dense estimator should use dense params path');
    assert.strictEqual(breakdown.parameterProfile.effectiveParamsB, 46, 'Dense estimator should use paramsB directly');
}

async function runConvertedVariantCarriesExplicitMoEMetadataSchemaFields() {
    const selector = new DeterministicModelSelector();
    const converted = selector.convertOllamaModelToDeterministicModels({
        model_identifier: 'mixtral-test',
        model_name: 'mixtral-test',
        variants: [{
            tag: 'mixtral-test:46b-q4_k_m',
            quantization: 'Q4_K_M',
            total_params_b: '46b',
            active_params_b: '12b',
            expert_count: 8,
            experts_active_per_token: 2
        }]
    });

    assert.ok(converted.length > 0, 'Expected at least one converted variant');
    const variant = converted[0];

    assert.strictEqual(variant.isMoE, true, 'Converted variant should be marked as MoE');
    assert.strictEqual(variant.is_moe, true, 'Converted variant should expose snake_case is_moe');
    assert.strictEqual(variant.total_params_b, 46, 'Converted variant should expose total_params_b metadata');
    assert.strictEqual(variant.active_params_b, 12, 'Converted variant should expose active_params_b metadata');
    assert.strictEqual(variant.expert_count, 8, 'Converted variant should expose expert_count metadata');
    assert.strictEqual(
        variant.experts_active_per_token,
        2,
        'Converted variant should expose experts_active_per_token metadata'
    );
}

async function runMoECompleteMetadataUsesActiveParams() {
    const selector = new DeterministicModelSelector();
    const denseEquivalent = { paramsB: 46 };
    const moeModel = {
        paramsB: 46,
        isMoE: true,
        totalParamsB: 46,
        activeParamsB: 12,
        expertCount: 8,
        expertsActivePerToken: 2
    };

    const denseRequired = selector.estimateMemoryBreakdown(denseEquivalent, 'Q4_K_M', 8192).requiredGB;
    const moeBreakdown = selector.estimateMemoryBreakdown(moeModel, 'Q4_K_M', 8192);

    assert.strictEqual(moeBreakdown.parameterProfile.assumptionSource, 'moe_active_metadata', 'Complete MoE metadata should use active-param path');
    assert.strictEqual(moeBreakdown.parameterProfile.effectiveParamsB, 12, 'Active params should drive MoE effective memory footprint');
    assert.ok(moeBreakdown.requiredGB < denseRequired, 'MoE active-param estimate should be smaller than dense equivalent');
}

async function runMoEActivePathOverridesObservedArtifactSize() {
    const selector = new DeterministicModelSelector();
    const denseEquivalent = {
        paramsB: 46,
        quant: 'Q4_K_M',
        sizeByQuant: { Q4_K_M: 27.2 }
    };
    const moeModel = {
        paramsB: 46,
        quant: 'Q4_K_M',
        sizeByQuant: { Q4_K_M: 27.2 },
        isMoE: true,
        totalParamsB: 46,
        activeParamsB: 12,
        expertCount: 8,
        expertsActivePerToken: 2
    };

    const denseBreakdown = selector.estimateMemoryBreakdown(denseEquivalent, 'Q4_K_M', 8192);
    const moeBreakdown = selector.estimateMemoryBreakdown(moeModel, 'Q4_K_M', 8192);

    assert.strictEqual(
        moeBreakdown.memorySource,
        'moe_sparse_inference_params',
        'Complete MoE metadata should prioritize sparse inference params over artifact-size fallback'
    );
    assert.ok(
        moeBreakdown.modelMemGB < denseBreakdown.modelMemGB,
        'MoE model memory should be lower than dense equivalent even when artifact size metadata exists'
    );
    assert.ok(
        moeBreakdown.requiredGB < denseBreakdown.requiredGB,
        'MoE required memory should remain below dense equivalent when active metadata is available'
    );
}

async function runMoEPartialMetadataFallsBackDeterministically() {
    const selector = new DeterministicModelSelector();

    const derivedModel = {
        paramsB: 46,
        isMoE: true,
        totalParamsB: 46,
        expertCount: 8,
        expertsActivePerToken: 2
    };
    const derivedBreakdown = selector.estimateMemoryBreakdown(derivedModel, 'Q4_K_M', 8192);
    assert.strictEqual(
        derivedBreakdown.parameterProfile.assumptionSource,
        'moe_derived_expert_ratio',
        'Partial MoE metadata with expert ratio should derive active params deterministically'
    );
    assert.strictEqual(
        Math.round(derivedBreakdown.parameterProfile.effectiveParamsB * 10) / 10,
        11.5,
        'Derived active params should be total * (experts_active / expert_count)'
    );

    const fallbackModel = {
        paramsB: 46,
        isMoE: true,
        totalParamsB: 46
    };
    const fallbackBreakdown = selector.estimateMemoryBreakdown(fallbackModel, 'Q4_K_M', 8192);
    assert.strictEqual(
        fallbackBreakdown.parameterProfile.assumptionSource,
        'moe_fallback_total_params',
        'When active metadata is missing, estimator should fall back to total params deterministically'
    );
    assert.strictEqual(
        fallbackBreakdown.parameterProfile.effectiveParamsB,
        46,
        'Fallback to total params should preserve deterministic effective params'
    );
}

async function runMoERuntimeProfilesChangeSpeedEstimate() {
    const selector = new DeterministicModelSelector();
    const hardware = buildHighEndHardware();
    const pool = buildMoERuntimeRegressionPool();

    const ollamaResult = await selector.selectModels('general', {
        hardware,
        installedModels: [],
        modelPool: pool,
        runtime: 'ollama',
        topN: 1,
        silent: true
    });
    const vllmResult = await selector.selectModels('general', {
        hardware,
        installedModels: [],
        modelPool: pool,
        runtime: 'vllm',
        topN: 1,
        silent: true
    });

    const ollamaTop = ollamaResult.candidates[0];
    const vllmTop = vllmResult.candidates[0];

    assert.ok(ollamaTop, 'Expected a candidate for ollama runtime');
    assert.ok(vllmTop, 'Expected a candidate for vLLM runtime');
    assert.strictEqual(ollamaTop.speed.runtime, 'ollama', 'Speed diagnostics should expose normalized ollama runtime');
    assert.strictEqual(vllmTop.speed.runtime, 'vllm', 'Speed diagnostics should expose normalized vLLM runtime');
    assert.strictEqual(ollamaTop.speed.moe.applied, true, 'MoE speed multiplier should be applied when metadata is present');
    assert.strictEqual(vllmTop.speed.moe.applied, true, 'MoE speed multiplier should be applied for vLLM runtime too');
    assert.ok(
        vllmTop.speed.estimatedTPS > ollamaTop.speed.estimatedTPS,
        `Expected vLLM MoE estimate (${vllmTop.speed.estimatedTPS}) to exceed ollama estimate (${ollamaTop.speed.estimatedTPS})`
    );
    assert.ok(
        /MoE speed x/i.test(vllmTop.rationale),
        'Rationale should include MoE speed assumption details'
    );
}

async function runRuntimePropagationInCategoryRecommendations() {
    const selector = new DeterministicModelSelector();
    const hardware = buildHighEndHardware();
    const pool = buildMoERuntimeRegressionPool();

    selector.getInstalledModels = async () => [];
    const recommendations = await selector.getBestModelsForHardware(hardware, pool, { runtime: 'vllm' });

    const general = recommendations.general;
    const top = general.bestModels[0];

    assert.ok(general, 'General recommendations should be present');
    assert.strictEqual(general.runtime, 'vllm', 'Category recommendations should preserve runtime context');
    assert.ok(top, 'General recommendations should include a top model');
    assert.strictEqual(top.runtime, 'vllm', 'Legacy mapped model should expose selected runtime');
    assert.strictEqual(top.speedAssumptions.runtime, 'vllm', 'Speed assumptions should preserve runtime backend');
}

async function runAll() {
    await runSelectModelsUsesProvidedPool();
    await runGetBestModelsForHardwareUsesAllModels();
    await runProvidedHardwareProfileIsHonored();
    await runUndefinedHardwareFallsBackSafely();
    await runOptimizationProfilesInfluenceRanking();
    await runMultiGpuNormalizationUsesCombinedVram();
    await runMultiGpu36GbIncludesThirtyBWhenFeasible();
    await runFreshnessPenaltyPrefersRecentModel();
    await runQuantizedLargeModelCanBeRecommended();
    await runUnified24GbIncludesMidTierWhenFeasible();
    await runM4ProMultimodalIncludesMidTierWhenFeasible();
    await runDenseMemoryPathUsesDenseParams();
    await runConvertedVariantCarriesExplicitMoEMetadataSchemaFields();
    await runMoECompleteMetadataUsesActiveParams();
    await runMoEActivePathOverridesObservedArtifactSize();
    await runMoEPartialMetadataFallsBackDeterministically();
    await runMoERuntimeProfilesChangeSpeedEstimate();
    await runRuntimePropagationInCategoryRecommendations();
    console.log('deterministic-model-pool-check: OK');
}

if (require.main === module) {
    runAll().catch((error) => {
        console.error('deterministic-model-pool-check: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { runAll };
