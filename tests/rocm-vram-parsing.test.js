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

function run() {
    testRocmMemoryNormalization();
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
