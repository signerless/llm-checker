const assert = require('assert');
const os = require('os');
const si = require('systeminformation');
const HardwareDetector = require('../src/hardware/detector');
const UnifiedDetector = require('../src/hardware/unified-detector');
const ROCmDetector = require('../src/hardware/backends/rocm-detector');

async function run() {
    const controller = { model: 'AMD Radeon Graphics', vendor: 'AMD', vram: 256, vramDynamic: false };
    const memory = { total: 26 * 1024 ** 3 };
    const classic = new HardwareDetector();
    const gpu = classic.processGPUInfo({ controllers: [controller], displays: [] }, memory);
    assert.strictEqual(gpu.vram, 13, '256 MB is an aperture; the estimated shared pool is half of RAM');
    assert.strictEqual(gpu.all[0].dedicatedMemory, 0.25);
    assert.strictEqual(classic.estimateIntegratedSharedMemory({ ...controller, sharedMemory: 256 }, memory), 25);
    assert.strictEqual(classic.normalizeVRAM(192), 192, 'explicit GB values remain supported');

    const originalGraphics = si.graphics, originalMem = si.mem, originalTotalmem = os.totalmem;
    si.graphics = async () => ({ controllers: [controller] });
    si.mem = async () => memory;
    os.totalmem = () => memory.total;
    try {
        const rocm = new ROCmDetector();
        rocm.getIntegratedMemoryProfile = () => ({ dedicated: 0.25, shared: 8 });
        assert.ok(rocm.resolveGpuMemoryProfile('AMD Radeon 680M', 256).total <= 26,
            'a malformed backend value cannot invent memory beyond RAM');
        const detector = new UnifiedDetector();
        detector.backends.cpu.detect = () => ({ brand: 'Ryzen 9 6900HX with Radeon Graphics', speedCoefficient: 100 });
        detector.backends.cuda.detect = () => null;
        detector.backends.intel.detect = () => null;
        detector.backends.rocm.detect = () => ({
            backend: 'rocm', speedCoefficient: 60, totalVRAM: 0.25,
            gpus: [{ name: 'AMD Radeon 680M', type: 'integrated', memory: { total: 8, shared: 8 }, speedCoefficient: 60 }]
        });
        detector.detectLinuxLspciGpus = async () => [];
        const result = await detector.detect();
        assert.strictEqual(result.systemGpu.gpus[0].memory.total, 13);
        assert.strictEqual(result.summary.integratedSharedMemory, 13);
        assert.strictEqual(result.summary.effectiveMemory, 13);
        assert.strictEqual(detector.willModelFit(100), false);
        assert.strictEqual(result.summary.hasDedicatedGPU, false);
        assert.strictEqual(detector.estimateIntegratedFallbackMemory({ ...controller, sharedMemory: 256 }, memory), 25);
        // Discrete cards have their own memory and must not be capped by RAM.
        si.graphics = async () => ({ controllers: [{ model: 'NVIDIA H100', vram: 81920 }] });
        const dedicated = await detector.detectSystemGpuFallback();
        assert.strictEqual(dedicated.totalVRAM, 80);
    } finally { si.graphics = originalGraphics; si.mem = originalMem; os.totalmem = originalTotalmem; }
    console.log('hardware-integrated-memory-units.test.js: OK');
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
