const assert = require('assert');
const childProcess = require('child_process');
const os = require('os');

const rocmModulePath = require.resolve('../src/hardware/backends/rocm-detector');
const originalExecSync = childProcess.execSync;

const GENERIC_STRIX_HALO_LSPCI =
    '65:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Device 1586 [1002:1586]';

function loadLspciFixtureDetector(lspciLine = GENERIC_STRIX_HALO_LSPCI) {
    childProcess.execSync = (command) => {
        if (String(command).startsWith('lspci -nn')) {
            return lspciLine;
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
        assert.match(ROCmDetector.AMD_DEVICE_IDS['1586'].name, /Strix Halo/i);
        assert.doesNotMatch(
            ROCmDetector.AMD_DEVICE_IDS['1586'].name,
            /8050S|8060S/i,
            'PCI id 1586 alone must not invent a specific Strix Halo SKU'
        );
        const result = detector.detect();
        assert.ok(result);
        assert.strictEqual(result.gpus.length, 1);

        const gpu = result.gpus[0];
        assert.match(gpu.name, /Strix Halo/i);
        assert.doesNotMatch(gpu.name, /8050S|8060S/i);
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
                vram: 1024,
                vramDynamic: false
            }],
            displays: []
        },
        { total: 124 * 1024 ** 3 }
    );

    assert.match(gpu.model, /Strix Halo/i);
    assert.doesNotMatch(gpu.model, /8050S|8060S/i);
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

function testSpecificStrixHaloNamesArePreserved() {
    const HardwareDetector = require('../src/hardware/detector');
    const UnifiedDetector = require('../src/hardware/unified-detector');
    const variants = ['8050S', '8060S'];

    for (const variant of variants) {
        const reportedName = `AMD Radeon ${variant} Graphics`;
        const hardwareGpu = new HardwareDetector().processGPUInfo(
            {
                controllers: [{
                    model: reportedName,
                    vendor: 'AMD',
                    deviceId: '1002:1586',
                    vram: 1024,
                    vramDynamic: true
                }],
                displays: []
            },
            { total: 64 * 1024 ** 3 }
        );
        assert.strictEqual(hardwareGpu.model, reportedName);
        assert.strictEqual(hardwareGpu.dedicated, false);

        const unified = new UnifiedDetector();
        const parsed = unified.parseLinuxLspciGpus(
            `65:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Strix Halo [Radeon ${variant} Graphics] [1002:1586]`
        );
        assert.strictEqual(parsed.length, 1);
        assert.match(parsed[0].name, new RegExp(variant, 'i'));
        assert.strictEqual(parsed[0].type, 'integrated');

        const { detector } = loadLspciFixtureDetector(
            `65:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Strix Halo [Radeon ${variant} Graphics] [1002:1586]`
        );
        try {
            const rocm = detector.detect();
            assert.match(rocm.gpus[0].name, new RegExp(variant, 'i'));
            assert.strictEqual(rocm.gpus[0].type, 'integrated');
        } finally {
            restoreLspciFixture();
        }
    }
}

async function testUnifiedDetectionDedupesLinuxFallbackWithoutDeviceId() {
    const { detector } = loadLspciFixtureDetector();
    let rocmInfo;
    try {
        rocmInfo = detector.detect();
    } finally {
        restoreLspciFixture();
    }

    const si = require('systeminformation');
    const UnifiedDetector = require('../src/hardware/unified-detector');
    const originalGraphics = si.graphics;
    const originalMem = si.mem;

    si.graphics = async () => ({
        controllers: [{
            model: 'Advanced Micro Devices, Inc. [AMD/ATI] Device 1586',
            vendor: 'Advanced Micro Devices, Inc. [AMD/ATI]',
            vram: 1024,
            vramDynamic: false
        }],
        displays: []
    });
    si.mem = async () => ({ total: 124 * 1024 ** 3 });

    try {
        const unified = new UnifiedDetector();
        unified.backends.cpu.detect = () => ({
            brand: 'AMD Ryzen AI MAX+ 395',
            speedCoefficient: 160
        });
        unified.backends.cuda.checkAvailability = () => false;
        unified.backends.intel.checkAvailability = () => false;
        unified.backends.rocm.checkAvailability = () => true;
        unified.backends.rocm.detect = () => rocmInfo;
        unified.detectLinuxLspciGpus = () =>
            unified.parseLinuxLspciGpus(GENERIC_STRIX_HALO_LSPCI);

        const result = await unified.detect();

        assert.strictEqual(result.systemGpu.gpus.length, 1);
        assert.strictEqual(result.systemGpu.gpus[0].type, 'integrated');
        assert.match(result.systemGpu.gpus[0].name, /Strix Halo/i);
        assert.doesNotMatch(result.systemGpu.gpus[0].name, /8050S|8060S/i);
        assert.strictEqual(result.summary.gpuModels.length, 1, 'ROCm and systeminformation views must dedupe');
        assert.strictEqual(result.summary.hasIntegratedGPU, true);
        assert.strictEqual(result.summary.hasDedicatedGPU, false);
        assert.strictEqual(result.summary.dedicatedGpuCount, 0);
        assert.strictEqual(result.summary.effectiveMemory, 118);
        assert.notStrictEqual(result.summary.hardwareTier, 'ultra_low');
        assert.ok(unified.getMaxModelSize() > 100);
    } finally {
        si.graphics = originalGraphics;
        si.mem = originalMem;
    }
}

async function run() {
    const originalTotalmem = os.totalmem;
    os.totalmem = () => 124 * 1024 ** 3;
    try {
        testRocmDeviceIdAndUnifiedMemory();
        testSystemInformationFixtureAndCommandClassification();
        testSpecificStrixHaloNamesArePreserved();
        await testUnifiedDetectionDedupesLinuxFallbackWithoutDeviceId();
        console.log('strix-halo-unified-memory.test.js: OK');
    } finally { os.totalmem = originalTotalmem; }
}

if (require.main === module) {
    try {
        run().catch((error) => {
            console.error('strix-halo-unified-memory.test.js: FAILED');
            console.error(error);
            process.exit(1);
        });
    } catch (error) {
        console.error('strix-halo-unified-memory.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
