const assert = require('assert');
const childProcess = require('child_process');

const rocmModulePath = require.resolve('../src/hardware/backends/rocm-detector');
const originalExecSync = childProcess.execSync;

function loadLspciFixtureDetector() {
    childProcess.execSync = (command) => {
        if (String(command).startsWith('lspci -nn')) {
            return [
                '65:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Device 1586 [1002:1586]'
            ].join('\n');
        }
        throw new Error(`fixture command unavailable: ${command}`);
    };
    delete require.cache[rocmModulePath];
    const ROCmDetector = require(rocmModulePath);
    const detector = new ROCmDetector();
    detector.isAvailable = true;
    detector.detectionMethod = 'lspci';
    detector._getVRAMFromSysfsForDevice = () => 1;
    detector.getIntegratedMemoryProfile = () => ({ dedicated: 1, shared: 118 });
    return { detector, ROCmDetector };
}

function restoreLspciFixture() {
    childProcess.execSync = originalExecSync;
    delete require.cache[rocmModulePath];
}

function testRocmDeviceIdAndUnifiedMemory() {
    const { detector, ROCmDetector } = loadLspciFixtureDetector();
    try {
        assert.match(ROCmDetector.AMD_DEVICE_IDS['1586'].name, /Radeon 8060S|Strix Halo/i);
        const result = detector.detect();
        assert.ok(result);
        assert.strictEqual(result.gpus.length, 1);

        const gpu = result.gpus[0];
        assert.match(gpu.name, /Radeon 8060S|Strix Halo/i);
        assert.strictEqual(gpu.type, 'integrated');
        assert.strictEqual(gpu.memory.dedicated, 1);
        assert.strictEqual(gpu.memory.shared, 118);
        assert.strictEqual(gpu.unifiedMemory, 118);
        assert.strictEqual(result.totalVRAM, 1);
        assert.strictEqual(result.totalSharedMemory, 118);
        assert.ok(gpu.memory.total > 0, 'usable accelerator memory must be positive');
    } finally {
        restoreLspciFixture();
    }
}

function testSystemInformationFixtureAndCommandClassification() {
    const HardwareDetector = require('../src/hardware/detector');
    const UnifiedDetector = require('../src/hardware/unified-detector');
    const LLMChecker = require('../src/index');
    const DeterministicModelSelector = require('../src/models/deterministic-selector');

    const detector = new HardwareDetector();
    const gpu = detector.processGPUInfo(
        {
            controllers: [{
                model: 'Advanced Micro Devices, Inc. [AMD/ATI] Device 1586',
                vendor: 'Advanced Micro Devices, Inc. [AMD/ATI]',
                deviceId: '1002:1586',
                vram: 1024,
                vramDynamic: true
            }],
            displays: []
        },
        { total: 124 * 1024 ** 3 }
    );

    assert.match(gpu.model, /Radeon 8060S|Strix Halo/i);
    assert.strictEqual(gpu.dedicated, false);
    assert.strictEqual(gpu.dedicatedMemory, 1);
    assert.ok(gpu.sharedMemory > 0);
    assert.ok(gpu.vram > 0);

    const unified = new UnifiedDetector();
    const summary = unified.buildSummary({
        cpu: { brand: 'AMD Ryzen AI MAX+ 395', speedCoefficient: 160 },
        primary: {
            type: 'rocm',
            name: 'AMD ROCm',
            info: {
                gpus: [{
                    name: gpu.model,
                    type: 'integrated',
                    memory: { total: gpu.sharedMemory },
                    dedicatedMemory: gpu.dedicatedMemory,
                    sharedMemory: gpu.sharedMemory,
                    unifiedMemory: gpu.sharedMemory
                }],
                totalVRAM: gpu.dedicatedMemory,
                totalSharedMemory: gpu.sharedMemory,
                isMultiGPU: false,
                speedCoefficient: 160
            }
        }
    });

    assert.strictEqual(summary.hasIntegratedGPU, true);
    assert.strictEqual(summary.hasDedicatedGPU, false);
    assert.ok(summary.effectiveMemory > 0);
    assert.notStrictEqual(summary.hardwareTier, 'ultra_low');

    unified.cache = { summary };
    assert.ok(unified.getMaxModelSize() > 0, 'maximum model size must be positive');

    const hardware = {
        cpu: { brand: 'AMD Ryzen AI MAX+ 395' },
        memory: { total: 124 },
        gpu,
        summary
    };
    const checkTier = new LLMChecker({ verbose: false }).getHardwareTier(hardware);
    const selectorTier = new DeterministicModelSelector().mapHardwareTier(hardware);
    assert.strictEqual(checkTier, summary.hardwareTier);
    assert.strictEqual(selectorTier, summary.hardwareTier);
}

function run() {
    testRocmDeviceIdAndUnifiedMemory();
    testSystemInformationFixtureAndCommandClassification();
    console.log('strix-halo-unified-memory.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('strix-halo-unified-memory.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
