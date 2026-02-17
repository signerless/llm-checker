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

async function runAll() {
    await runSelectModelsUsesProvidedPool();
    await runGetBestModelsForHardwareUsesAllModels();
    await runProvidedHardwareProfileIsHonored();
    await runUndefinedHardwareFallsBackSafely();
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
