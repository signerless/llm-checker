/**
 * Deterministic selector memory/sizing regression tests
 * =====================================================
 * Covers bug fixes that prevented FALSE "fits":
 *   - MoE weight memory uses the TOTAL params (and a real observed artifact size
 *     always wins), so a big MoE can't shrink to its active footprint.
 *   - Multi-GPU VRAM is not double-counted (a 2x24=48GB box stays 48GB).
 *   - filterByCategory tolerates malformed pool rows instead of throwing.
 *   - A size-unknown Ollama variant (`:latest`) can't poison a sibling's size map
 *     by inheriting model_sizes[0].
 */

const assert = require('assert');
const DeterministicModelSelector = require('../src/models/deterministic-selector');

function testMoEObservedSizeWins() {
    const s = new DeterministicModelSelector();
    // 236B-total / 21B-active MoE with a REAL observed Q4 size of 133GB.
    const moe = {
        paramsB: 236, quant: 'Q4_K_M', sizeByQuant: { Q4_K_M: 133 },
        isMoE: true, totalParamsB: 236, activeParamsB: 21
    };
    const b = s.estimateMemoryBreakdown(moe, 'Q4_K_M', 8192);
    assert.strictEqual(b.memorySource, 'observed_artifact_size', 'observed size must win');
    assert.ok(b.requiredGB > 130, `236B MoE must require >130GB, got ${b.requiredGB.toFixed(1)}`);
}

function testMoEModeledUsesTotalParams() {
    const s = new DeterministicModelSelector();
    // No observed size -> must model weights from TOTAL params, not active.
    const moe = { paramsB: 236, quant: 'Q4_K_M', isMoE: true, totalParamsB: 236, activeParamsB: 21 };
    const b = s.estimateMemoryBreakdown(moe, 'Q4_K_M', 8192);
    assert.ok(b.requiredGB > 100, `modeled 236B MoE must require >100GB, got ${b.requiredGB.toFixed(1)}`);
    assert.notStrictEqual(b.memorySource, 'moe_sparse_inference_params', 'sparse-inference sizing must be gone');
}

function testMultiGpuVramNotDoubled() {
    const s = new DeterministicModelSelector();
    // 2x24=48GB reported as a single total `vramGB:48`; must NOT become 96.
    const norm = s.normalizeHardwareProfile({
        gpu: { type: 'nvidia', vramGB: 48, gpuCount: 2, isMultiGPU: true }, memory: { totalGB: 64 }
    });
    assert.strictEqual(norm.gpu.vramGB, 48, 'a total VRAM figure must not be multiplied by gpuCount');

    // Explicit per-GPU memory IS scaled up.
    const perGpu = s.normalizeHardwareProfile({
        gpu: { type: 'nvidia', vramPerGPU: 24, gpuCount: 2, isMultiGPU: true }, memory: { totalGB: 64 }
    });
    assert.strictEqual(perGpu.gpu.vramGB, 48, 'per-GPU memory should scale to the box total');
}

function testFilterByCategoryToleratesMalformedRows() {
    const s = new DeterministicModelSelector();
    // Missing tags/modalities/name must not throw.
    assert.doesNotThrow(() => s.filterByCategory([{ model_identifier: 'x' }], 'coding'));
    assert.doesNotThrow(() => s.filterByCategory([{ model_identifier: 'x' }], 'multimodal'));
    const general = s.filterByCategory([{ model_identifier: 'x' }], 'general');
    assert.strictEqual(general.length, 1, 'a malformed row still passes the general category');
}

function testLatestVariantDoesNotPoisonSiblingSize() {
    const s = new DeterministicModelSelector();
    const model = {
        model_identifier: 'qwen3', model_name: 'qwen3',
        model_sizes: ['30b', '235b'],
        variants: [
            { tag: 'qwen3:30b', quantization: 'Q4_K_M', real_size_gb: 19, size: '19GB' },
            { tag: 'qwen3:latest', quantization: 'Q4_K_M', real_size_gb: 5.2, size: 'unknown' }
        ]
    };
    const conv = s.convertOllamaModelToDeterministicModels(model);
    const v30 = conv.find((c) => c.model_identifier === 'qwen3:30b');
    const vlatest = conv.find((c) => c.model_identifier === 'qwen3:latest');

    assert.strictEqual(v30.paramsB, 30, 'qwen3:30b keeps its 30B param count');
    assert.strictEqual(v30.sizeByQuant.Q4_K_M, 19, 'qwen3:30b Q4 size must stay 19GB (not poisoned to 5.2)');
    assert.ok(vlatest.paramsB < 15, `qwen3:latest must be sized small (~9B), not 30B; got ${vlatest.paramsB}`);

    const mem = s.estimateMemoryBreakdown(v30, 'Q4_K_M', 8192);
    assert.ok(mem.requiredGB > 18, `qwen3:30b must require >18GB (not ~6); got ${mem.requiredGB.toFixed(1)}`);
}

function run() {
    testMoEObservedSizeWins();
    testMoEModeledUsesTotalParams();
    testMultiGpuVramNotDoubled();
    testFilterByCategoryToleratesMalformedRows();
    testLatestVariantDoesNotPoisonSiblingSize();
    console.log('selector-memory-sizing.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('selector-memory-sizing.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
