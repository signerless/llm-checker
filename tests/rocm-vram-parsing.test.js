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

function run() {
    testRocmMemoryNormalization();
    testRocmInfoParsingDedupesGpuAgents();
    testIntegratedApertureHeuristic();
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
