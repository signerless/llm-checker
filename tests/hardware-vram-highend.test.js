/**
 * High-End / Multi-GPU VRAM Detection Regression Tests (Issue #88)
 *
 * Root cause of issue #88: hardware detection under-reported high-end and
 * multi-GPU machines. A dual RTX PRO 6000 / 192GB box collapsed to ~16GB
 * because:
 *   - estimateVRAMFromModel / estimateFallbackVRAM had no entry for
 *     workstation/datacenter cards, so "RTX PRO 6000" hit the generic
 *     "rtx -> 8GB" fallback.
 *   - normalizeVRAM / normalizeFallbackVRAM silently returned 0 for legitimate
 *     GB-range integers (a GB "dead-zone"), so curated GB values were lost.
 *   - willModelFit divided totalVRAM by gpuCount with no zero guard, turning
 *     a zero-GPU summary into Infinity (any model "fit").
 *
 * These assertions exercise the real detection code (the actual classes /
 * methods, not reimplementations).
 */

const assert = require('assert');
const HardwareDetector = require('../src/hardware/detector');
const UnifiedDetector = require('../src/hardware/unified-detector');

/**
 * (a) Unknown high-VRAM workstation GPUs must resolve to their real VRAM, not
 *     the generic 8GB RTX fallback.
 */
function testWorkstationVramEstimatesAreNotGenericFallback() {
    const hw = new HardwareDetector();
    const unified = new UnifiedDetector();

    const rtxProDetector = hw.estimateVRAMFromModel('NVIDIA RTX PRO 6000');
    const rtxProUnified = unified.estimateFallbackVRAM('NVIDIA RTX PRO 6000');

    assert.strictEqual(rtxProDetector, 96,
        `RTX PRO 6000 should estimate ~96GB via detector, got ${rtxProDetector}`);
    assert.strictEqual(rtxProUnified, 96,
        `RTX PRO 6000 should estimate ~96GB via unified fallback, got ${rtxProUnified}`);
    assert.notStrictEqual(rtxProDetector, 8,
        'RTX PRO 6000 must NOT collapse to the generic 8GB RTX fallback');

    // A representative spread of the workstation / datacenter cards added in the fix.
    assert.strictEqual(hw.estimateVRAMFromModel('NVIDIA RTX 6000 Ada Generation'), 48,
        'RTX 6000 Ada should estimate 48GB');
    assert.strictEqual(hw.estimateVRAMFromModel('NVIDIA RTX A6000'), 48,
        'RTX A6000 should estimate 48GB');
    assert.strictEqual(hw.estimateVRAMFromModel('NVIDIA A100-SXM4-80GB'), 80,
        'A100 80GB should estimate 80GB');
    assert.strictEqual(hw.estimateVRAMFromModel('NVIDIA A100-PCIE-40GB'), 40,
        'A100 40GB variant should estimate 40GB');
    assert.strictEqual(hw.estimateVRAMFromModel('NVIDIA H100 80GB PCIe'), 80,
        'H100 should estimate 80GB');
    assert.strictEqual(hw.estimateVRAMFromModel('NVIDIA L40S'), 48,
        'L40S should estimate 48GB');

    // The same workstation cards must be recognised by the unified fallback path too.
    assert.strictEqual(unified.estimateFallbackVRAM('NVIDIA RTX 6000 Ada Generation'), 48,
        'RTX 6000 Ada should estimate 48GB via unified fallback');
    assert.strictEqual(unified.estimateFallbackVRAM('NVIDIA A100-SXM4-80GB'), 80,
        'A100 80GB should estimate 80GB via unified fallback');
    assert.strictEqual(unified.estimateFallbackVRAM('NVIDIA H100 80GB PCIe'), 80,
        'H100 should estimate 80GB via unified fallback');
    assert.strictEqual(unified.estimateFallbackVRAM('NVIDIA L40S'), 48,
        'L40S should estimate 48GB via unified fallback');
}

/**
 * (b) A simulated dual RTX PRO 6000 system (two dedicated GPUs, no numeric VRAM
 *     reported by nvidia-smi) must aggregate to a total near 192GB, NOT 16GB.
 *     Uses the real processGPUInfo aggregation seam.
 */
function testDualRtxPro6000AggregatesToFullVram() {
    const hw = new HardwareDetector();

    const gpu = hw.processGPUInfo(
        {
            controllers: [
                { model: 'NVIDIA RTX PRO 6000', vendor: 'NVIDIA', vram: 0 },
                { model: 'NVIDIA RTX PRO 6000', vendor: 'NVIDIA', vram: 0 }
            ],
            displays: []
        },
        // System RAM (192GB box) — irrelevant for dedicated VRAM but realistic.
        { total: 192 * 1024 ** 3 }
    );

    assert.strictEqual(gpu.dedicated, true, 'Dual RTX PRO 6000 should be treated as dedicated GPUs');
    assert.strictEqual(gpu.gpuCount, 2, `Should detect 2 GPUs, got ${gpu.gpuCount}`);
    assert.strictEqual(gpu.isMultiGPU, true, 'Should flag multi-GPU');
    assert.strictEqual(gpu.vram, 192,
        `Dual RTX PRO 6000 should aggregate to 192GB total VRAM, got ${gpu.vram}GB`);
    assert.ok(gpu.vram >= 180,
        `Total VRAM must be near 192GB (not the ~16GB regression), got ${gpu.vram}GB`);
    assert.notStrictEqual(gpu.vram, 16, 'Total VRAM must NOT collapse to the 16GB regression value');
}

/**
 * (c) Normalization must preserve plausible GB integers (no GB dead-zone), while
 *     still handling bytes and MB inputs, and stay consistent across both paths.
 */
function testNormalizationHasNoGbDeadZone() {
    const hw = new HardwareDetector();
    const unified = new UnifiedDetector();

    // The exact dead-zone values from issue #88.
    assert.strictEqual(hw.normalizeVRAM(96), 96, 'normalizeVRAM(96) must be 96, not 0');
    assert.strictEqual(unified.normalizeFallbackVRAM(192), 192, 'normalizeFallbackVRAM(192) must be 192, not 0');

    // Other plausible GB integers are preserved on both paths.
    assert.strictEqual(hw.normalizeVRAM(48), 48, 'normalizeVRAM(48) must be 48');
    assert.strictEqual(unified.normalizeFallbackVRAM(48), 48, 'normalizeFallbackVRAM(48) must be 48');
    assert.strictEqual(hw.normalizeVRAM(192), 192, 'normalizeVRAM(192) must be 192');
    assert.strictEqual(unified.normalizeFallbackVRAM(96), 96, 'normalizeFallbackVRAM(96) must be 96');

    // Bytes and MB inputs still normalize correctly (no regression).
    assert.strictEqual(hw.normalizeVRAM(16384), 16, 'normalizeVRAM(16384 MB) must be 16GB');
    assert.strictEqual(hw.normalizeVRAM(25769803776), 24, 'normalizeVRAM(24GB in bytes) must be 24GB');
    assert.strictEqual(unified.normalizeFallbackVRAM(16384), 16, 'normalizeFallbackVRAM(16384 MB) must be 16GB');
    assert.strictEqual(unified.normalizeFallbackVRAM(206158430208), 192,
        'normalizeFallbackVRAM(192GB in bytes) must be 192GB');

    // The two functions agree on representative inputs.
    for (const value of [48, 96, 192, 16384, 25769803776]) {
        assert.strictEqual(hw.normalizeVRAM(value), unified.normalizeFallbackVRAM(value),
            `normalizeVRAM and normalizeFallbackVRAM should agree for ${value}`);
    }
}

/**
 * (d) willModelFit must NOT divide-by-zero into a false "fits": a 50GB model on a
 *     summary with gpuCount 0 and totalVRAM 0 must return false.
 */
function testWillModelFitGuardsZeroGpuCount() {
    const unified = new UnifiedDetector();

    unified.cache = {
        summary: {
            bestBackend: 'cuda',
            totalVRAM: 0,
            gpuCount: 0,
            effectiveMemory: 0,
            hasIntegratedGPU: false,
            hasDedicatedGPU: true,
            integratedSharedMemory: 0
        }
    };

    assert.strictEqual(unified.willModelFit(50, false), false,
        'willModelFit(50, single-GPU) must be false when gpuCount=0 and totalVRAM=0 (no divide-by-zero Infinity)');
    assert.strictEqual(unified.willModelFit(50, true), false,
        'willModelFit(50, multi-GPU) must be false when totalVRAM=0');

    // Sanity: a genuinely large VRAM pool still fits a 50GB model.
    unified.cache = {
        summary: {
            bestBackend: 'cuda',
            totalVRAM: 192,
            gpuCount: 2,
            effectiveMemory: 192,
            hasIntegratedGPU: false,
            hasDedicatedGPU: true,
            integratedSharedMemory: 0
        }
    };
    assert.strictEqual(unified.willModelFit(50, true), true,
        'willModelFit(50) should be true on a 192GB multi-GPU pool');
}

function run() {
    testWorkstationVramEstimatesAreNotGenericFallback();
    testDualRtxPro6000AggregatesToFullVram();
    testNormalizationHasNoGbDeadZone();
    testWillModelFitGuardsZeroGpuCount();
    console.log('✅ hardware-vram-highend.test.js passed');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('❌ hardware-vram-highend.test.js failed');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
