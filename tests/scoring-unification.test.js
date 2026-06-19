/**
 * Scoring Unification Integration Test (GitHub issue #88)
 * ======================================================
 *
 * Proves the root-cause fix: the three recommendation surfaces
 * (`check`, `recommend`, `smart-recommend`) now derive their ranking from ONE
 * canonical scoring core (DeterministicModelSelector via scoring-core), so:
 *
 *   a. CONSISTENCY: all three agree on the top pick's size class for the same
 *      logical (model pool, hardware) input.
 *   b. HIGH-CAPACITY FLOOR EVERYWHERE: on a 192GB dual-RTX-PRO-6000 profile none
 *      of the three paths returns a sub-30B model as its #1 pick for
 *      general/coding/reasoning.
 *   c. SMALL-HARDWARE SANITY: on an 8GB CPU-only profile every path still
 *      prefers a small (<30B, and in practice <=8B) model — i.e. the fix did
 *      not just force "always big".
 *
 * Each command consumes a DIFFERENT model shape, so we build the SAME logical
 * models in each path's native shape and call each path's selection entrypoint
 * directly (no live Ollama / sql.js dependency).
 */

const assert = require('assert');

const MultiObjectiveSelector = require('../src/ai/multi-objective-selector');
const DeterministicModelSelector = require('../src/models/deterministic-selector');
const IntelligentSelector = require('../src/models/intelligent-selector');

// ---------------------------------------------------------------------------
// Hardware profiles
// ---------------------------------------------------------------------------

// The dual RTX PRO 6000 / ~192GB VRAM case from issue #88.
function buildHighCapacityHardware() {
    return {
        cpu: { brand: 'AMD Threadripper PRO', cores: 32, physicalCores: 32, speed: 4.0, architecture: 'x86_64' },
        gpu: {
            model: 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition',
            vendor: 'NVIDIA',
            type: 'nvidia',
            vram: 192,
            vramPerGPU: 96,
            gpuCount: 2,
            isMultiGPU: true,
            dedicated: true
        },
        memory: { total: 192, totalGB: 192 },
        acceleration: { supports_metal: false, supports_cuda: true, supports_rocm: false },
        os: { platform: 'linux' },
        summary: {
            bestBackend: 'cuda',
            gpuModel: 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition',
            effectiveMemory: 180,
            systemRAM: 192,
            totalVRAM: 192,
            isMultiGPU: true,
            gpuCount: 2,
            hasDedicatedGPU: true,
            hasIntegratedGPU: false,
            hardwareTier: 'very_high',
            speedCoefficient: 320
        }
    };
}

// A small laptop: 8GB RAM, CPU-only.
function buildSmallHardware() {
    return {
        cpu: { brand: 'Intel Core i5-1135G7', cores: 4, physicalCores: 4, speed: 2.4, architecture: 'x86_64' },
        gpu: { model: '', vram: 0, dedicated: false },
        memory: { total: 8, totalGB: 8 },
        acceleration: { supports_metal: false, supports_cuda: false, supports_rocm: false },
        os: { platform: 'linux' },
        summary: {
            bestBackend: 'cpu',
            gpuModel: '',
            effectiveMemory: 8,
            systemRAM: 8,
            totalVRAM: 0,
            hasDedicatedGPU: false,
            hasIntegratedGPU: false,
            hardwareTier: 'low',
            speedCoefficient: 40
        }
    };
}

// ---------------------------------------------------------------------------
// Representative model pool (same logical models, three native shapes).
// Each category has a small (<=8B) and a large (>=30B) member so every path is
// forced to make a real size choice.
// ---------------------------------------------------------------------------

// `check` shape: ExpandedModelsDatabase-style rows.
function buildCheckPool() {
    const mk = (name, sizeB, gb, ctx, cat, quant = ['Q4_K_M']) => ({
        name,
        size: `${sizeB}B`,
        type: 'local',
        category: cat,
        requirements: { ram: Math.ceil(gb + 2), vram: 0, cpu_cores: 2, storage: gb },
        frameworks: ['ollama'],
        quantization: quant,
        performance: { context_length: ctx },
        specialization: cat,
        installation: { ollama: `ollama pull ${name}` },
        // size_gb hint so memory math is realistic regardless of param parsing.
        size_gb: gb
    });
    return [
        mk('uni-chat 8B', 8, 5.0, 65536, 'general'),
        mk('uni-chat 70B', 70, 42, 65536, 'general'),
        mk('uni-coder 8B', 8, 5.0, 32768, 'coding'),
        mk('uni-coder 34B', 34, 20.5, 32768, 'coding'),
        mk('uni-reason 7B', 7, 4.8, 65536, 'reasoning'),
        mk('uni-reason 70B', 70, 43, 65536, 'reasoning')
    ];
}

// `recommend` shape: Ollama scrape-style models with variants.
function buildRecommendPool() {
    return [
        {
            model_identifier: 'uni-chat',
            model_name: 'uni-chat',
            primary_category: 'chat',
            context_length: '64K',
            variants: [
                { tag: 'uni-chat:8b', size: '8b', quantization: 'Q4_0', real_size_gb: 5.0, categories: ['chat'] },
                { tag: 'uni-chat:70b', size: '70b', quantization: 'Q4_0', real_size_gb: 42, categories: ['chat'] }
            ],
            tags: ['uni-chat:8b', 'uni-chat:70b'],
            use_cases: ['chat']
        },
        {
            model_identifier: 'uni-coder',
            model_name: 'uni-coder',
            primary_category: 'coding',
            context_length: '32K',
            variants: [
                { tag: 'uni-coder:8b', size: '8b', quantization: 'Q4_0', real_size_gb: 5.0, categories: ['coding'] },
                { tag: 'uni-coder:34b', size: '34b', quantization: 'Q4_0', real_size_gb: 20.5, categories: ['coding'] }
            ],
            tags: ['uni-coder:8b', 'uni-coder:34b'],
            use_cases: ['coding', 'programming']
        },
        {
            model_identifier: 'uni-reason',
            model_name: 'uni-reason',
            primary_category: 'reasoning',
            context_length: '64K',
            variants: [
                { tag: 'uni-reason:7b', size: '7b', quantization: 'Q4_0', real_size_gb: 4.8, categories: ['reasoning'] },
                { tag: 'uni-reason:70b', size: '70b', quantization: 'Q4_0', real_size_gb: 43, categories: ['reasoning'] }
            ],
            tags: ['uni-reason:7b', 'uni-reason:70b'],
            use_cases: ['reasoning', 'math']
        }
    ];
}

// `smart-recommend` shape: sql.js variant rows.
function buildSmartVariants() {
    return [
        { model_id: 'uni-chat', tag: 'uni-chat:8b', params_b: 8, size_gb: 5.0, quant: 'Q4_K_M', context_length: 65536, capabilities: 'chat', family: 'llama3.2', pulls: 5000000 },
        { model_id: 'uni-chat', tag: 'uni-chat:70b', params_b: 70, size_gb: 42, quant: 'Q4_K_M', context_length: 65536, capabilities: 'chat', family: 'llama3.3', pulls: 5000000 },
        { model_id: 'uni-coder', tag: 'uni-coder:8b', params_b: 8, size_gb: 5.0, quant: 'Q4_K_M', context_length: 32768, capabilities: 'coding', family: 'qwen2.5-coder', pulls: 5000000 },
        { model_id: 'uni-coder', tag: 'uni-coder:34b', params_b: 34, size_gb: 20.5, quant: 'Q4_K_M', context_length: 32768, capabilities: 'coding', family: 'qwen2.5-coder', pulls: 5000000 },
        { model_id: 'uni-reason', tag: 'uni-reason:7b', params_b: 7, size_gb: 4.8, quant: 'Q4_K_M', context_length: 65536, capabilities: 'reasoning', family: 'deepseek-r1', pulls: 5000000 },
        { model_id: 'uni-reason', tag: 'uni-reason:70b', params_b: 70, size_gb: 43, quant: 'Q4_K_M', context_length: 65536, capabilities: 'reasoning', family: 'deepseek-r1', pulls: 5000000 }
    ];
}

// ---------------------------------------------------------------------------
// Per-path top-pick params extraction
// ---------------------------------------------------------------------------

function parseParamsB(text) {
    const match = String(text || '').match(/(\d+(?:\.\d+)?)\s*b\b/i);
    return match ? parseFloat(match[1]) : null;
}

async function checkTopParamsB(hardware, category) {
    const selector = new MultiObjectiveSelector();
    const result = await selector.selectBestModels(hardware, buildCheckPool(), category, 20);
    const top = result.compatible[0] || result.marginal[0];
    assert.ok(top, `check should return a ranked model for category ${category}`);
    // ExpandedModelsDatabase rows keep their name/size; derive params from them.
    const params = selector.estimateModelParams(top) || parseParamsB(top.size) || parseParamsB(top.name);
    return { params, label: top.name };
}

async function recommendTopParamsB(hardware, category) {
    const selector = new DeterministicModelSelector();
    selector.getInstalledModels = async () => [];
    const recommendations = await selector.getBestModelsForHardware(hardware, buildRecommendPool(), { runtime: 'ollama' });
    const top = recommendations[category] && recommendations[category].bestModels[0];
    assert.ok(top, `recommend should return a ranked model for category ${category}`);
    const params = Number(top.size) || parseParamsB(top.model_identifier);
    return { params, label: top.model_identifier };
}

function makeStubDetector(hardware) {
    return {
        detect: async () => hardware,
        getHardwareDescription: () => 'unit-test hardware',
        getHardwareTier: () => (hardware.summary && hardware.summary.hardwareTier) || 'medium',
        getMaxModelSize: () => (hardware.summary && hardware.summary.effectiveMemory) || 8
    };
}

async function smartTopParamsB(hardware, useCase) {
    const selector = new IntelligentSelector({ detector: makeStubDetector(hardware) });
    const recommendations = await selector.recommend(buildSmartVariants(), {
        useCase,
        limit: 10,
        policyFile: null
    });
    const top = recommendations.topPicks.best;
    assert.ok(top && top.variant, `smart-recommend should return a top pick for use case ${useCase}`);
    const params = top.variant.params_b || parseParamsB(top.variant.tag);
    return { params, label: top.variant.tag };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const HIGH_CAPACITY_CATEGORIES = ['general', 'coding', 'reasoning'];

async function testHighCapacityFloorEverywhere() {
    const hardware = buildHighCapacityHardware();

    for (const category of HIGH_CAPACITY_CATEGORIES) {
        const check = await checkTopParamsB(hardware, category);
        const recommend = await recommendTopParamsB(hardware, category);
        const smart = await smartTopParamsB(hardware, category);

        assert.ok(
            check.params >= 30,
            `[check] ${category}: top pick should be >=30B on 192GB hardware, got ${check.label} (${check.params}B)`
        );
        assert.ok(
            recommend.params >= 30,
            `[recommend] ${category}: top pick should be >=30B on 192GB hardware, got ${recommend.label} (${recommend.params}B)`
        );
        assert.ok(
            smart.params >= 30,
            `[smart-recommend] ${category}: top pick should be >=30B on 192GB hardware, got ${smart.label} (${smart.params}B)`
        );
    }
}

async function testConsistencyAcrossPaths() {
    const hardware = buildHighCapacityHardware();

    for (const category of HIGH_CAPACITY_CATEGORIES) {
        const check = await checkTopParamsB(hardware, category);
        const recommend = await recommendTopParamsB(hardware, category);
        const smart = await smartTopParamsB(hardware, category);

        const sizeClass = (p) => (p >= 30 ? 'large' : 'small');
        const checkClass = sizeClass(check.params);
        const recommendClass = sizeClass(recommend.params);
        const smartClass = sizeClass(smart.params);

        assert.strictEqual(
            checkClass,
            recommendClass,
            `[${category}] check (${check.label} ${check.params}B) and recommend (${recommend.label} ${recommend.params}B) should agree on size class`
        );
        assert.strictEqual(
            recommendClass,
            smartClass,
            `[${category}] recommend (${recommend.label} ${recommend.params}B) and smart-recommend (${smart.label} ${smart.params}B) should agree on size class`
        );
    }
}

async function testSmallHardwarePrefersSmallEverywhere() {
    const hardware = buildSmallHardware();

    for (const category of HIGH_CAPACITY_CATEGORIES) {
        const check = await checkTopParamsB(hardware, category);
        const recommend = await recommendTopParamsB(hardware, category);
        const smart = await smartTopParamsB(hardware, category);

        assert.ok(
            check.params < 30,
            `[check] ${category}: small hardware should prefer a small model, got ${check.label} (${check.params}B)`
        );
        assert.ok(
            recommend.params < 30,
            `[recommend] ${category}: small hardware should prefer a small model, got ${recommend.label} (${recommend.params}B)`
        );
        assert.ok(
            smart.params < 30,
            `[smart-recommend] ${category}: small hardware should prefer a small model, got ${smart.label} (${smart.params}B)`
        );
    }
}

async function run() {
    await testHighCapacityFloorEverywhere();
    await testConsistencyAcrossPaths();
    await testSmallHardwarePrefersSmallEverywhere();
    console.log('scoring-unification.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('scoring-unification.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
