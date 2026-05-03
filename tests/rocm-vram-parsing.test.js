const assert = require('assert');
const ROCmDetector = require('../src/hardware/backends/rocm-detector');

function testRocmMemoryNormalization() {
    const detector = new ROCmDetector();

    assert.strictEqual(
        detector.normalizeRocmMemoryToGB(137438953472, 'B'),
        128,
        'Byte-based rocm-smi values must be converted to GB'
    );

    assert.strictEqual(
        detector.normalizeRocmMemoryToGB(24576, 'MiB'),
        24,
        'MiB-based rocm-smi values must be converted to GB'
    );

    assert.strictEqual(
        detector.normalizeRocmMemoryToGB(17179869184, ''),
        16,
        'Unit-less large values should be treated as bytes'
    );
}

function testRocmInfoParsingDedupesGpuAgents() {
    const detector = new ROCmDetector();
    const sample = [
        'Agent 1:',
        '  Name: AMD Ryzen 7 6800H',
        '  Marketing Name: AMD Ryzen 7 6800H with Radeon Graphics',
        '  Device Type: CPU',
        '',
        'Agent 2:',
        '  Name: gfx1151',
        '  Marketing Name: AMD Radeon 890M',
        '  Device Type: GPU',
        '  Name: gfx1151',
        '',
        'Agent 3:',
        '  Name: gfx1151',
        '  Marketing Name: AMD Radeon 890M',
        '  Device Type: GPU'
    ].join('\n');

    const parsed = detector.parseRocmInfoGpuAgents(sample);

    assert.strictEqual(parsed.length, 1, 'Duplicate GPU agents should be deduplicated');
    assert.strictEqual(parsed[0].name, 'AMD Radeon 890M', 'Marketing name should be preferred');
}

function testIntegratedApertureHeuristic() {
    const detector = new ROCmDetector();
    const corrected = detector.applyIntegratedVramHeuristic('gfx1151', 2);

    assert.ok(corrected >= 8, 'Integrated tiny aperture values should be corrected to a practical floor');
}

function testRocmSmiProductNameAnchorsCardSeries() {
    const detector = new ROCmDetector();
    const sample = [
        'GPU[0]\t\t: Card Series: \t\tAMD Radeon RX 9060 XT',
        'GPU[0]\t\t: Card Model: \t\t0x7590',
        'GPU[0]\t\t: GFX Version: \t\tgfx1200'
    ].join('\n');

    const parsed = detector.parseRocmSmiProductNames(sample);

    assert.strictEqual(
        parsed[0],
        'AMD Radeon RX 9060 XT',
        'Card Series should not be overwritten by later GFX Version lines'
    );
}

function testRocmSmiVramParserSkipsUsedMemory() {
    const detector = new ROCmDetector();
    const sample = [
        'GPU[0]\t\t: VRAM Total Memory (B): 17095983104',
        'GPU[0]\t\t: VRAM Total Used Memory (B): 1729613824'
    ].join('\n');

    const parsed = detector.parseRocmSmiMemoryInfo(sample);

    assert.strictEqual(parsed[0], 16, 'VRAM total should remain 16GB and not be overwritten by used memory');
}

function testRdna4Rx9060Capabilities() {
    const detector = new ROCmDetector();
    const capabilities = detector.getGPUCapabilities('AMD Radeon RX 9060 XT');

    assert.strictEqual(detector.estimateVRAMFromModel('AMD Radeon RX 9060 XT'), 16);
    assert.strictEqual(detector.calculateSpeedCoefficient('AMD Radeon RX 9060 XT', 16), 170);
    assert.strictEqual(capabilities.architecture, 'RDNA 4');
    assert.strictEqual(capabilities.gfxVersion, 'gfx1200');
}

function testRocmInfoDedupeByGfxAlias() {
    const detector = new ROCmDetector();
    const sample = [
        'Agent 1:',
        '  Name: gfx1035',
        '  Marketing Name: AMD Radeon Graphics',
        '  Device Type: GPU',
        '',
        'Agent 2:',
        '  Name: amdgcn-amd-amdhsa--gfx1035',
        '  Marketing Name: AMD',
        '  Device Type: GPU'
    ].join('\n');

    const parsed = detector.parseRocmInfoGpuAgents(sample);

    assert.strictEqual(parsed.length, 1, 'Aliases for the same gfx target should not be counted as separate GPUs');
    assert.strictEqual(parsed[0].name, 'AMD Radeon Graphics');
}

function testIntegratedSharedMemoryProfile() {
    const detector = new ROCmDetector();
    detector.getIntegratedMemoryProfile = () => ({ dedicated: 1, shared: 112 });

    const profile = detector.resolveGpuMemoryProfile('AMD Radeon 8060S (gfx1151)', 1);

    assert.strictEqual(profile.type, 'integrated');
    assert.strictEqual(profile.dedicated, 1);
    assert.strictEqual(profile.shared, 112);
    assert.strictEqual(profile.total, 112);
}

function run() {
    testRocmMemoryNormalization();
    testRocmInfoParsingDedupesGpuAgents();
    testIntegratedApertureHeuristic();
    testRocmSmiProductNameAnchorsCardSeries();
    testRocmSmiVramParserSkipsUsedMemory();
    testRdna4Rx9060Capabilities();
    testRocmInfoDedupeByGfxAlias();
    testIntegratedSharedMemoryProfile();
    console.log('✅ rocm-vram-parsing.test.js passed');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('❌ rocm-vram-parsing.test.js failed');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
