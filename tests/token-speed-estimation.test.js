const assert = require('assert');
const HardwareDetector = require('../src/hardware/detector');
const PerformanceAnalyzer = require('../analyzer/performance');
const ExpandedModelsDatabase = require('../src/models/expanded_database');
const { estimateTokenSpeedFromHardware } = require('../src/utils/token-speed-estimator');

function isM4ProMac(hardware) {
    const cpuBrand = String(hardware?.cpu?.brand || '').toLowerCase();
    const gpuModel = String(hardware?.gpu?.model || '').toLowerCase();
    return (
        String(hardware?.os?.platform || '').toLowerCase() === 'darwin' &&
        String(hardware?.cpu?.architecture || '').toLowerCase().includes('apple') &&
        (cpuBrand.includes('m4 pro') || gpuModel.includes('m4 pro'))
    );
}

async function run() {
    const detector = new HardwareDetector();
    const hardware = await detector.getSystemInfo(true);

    assert.strictEqual(
        String(hardware.os?.platform || '').toLowerCase(),
        'darwin',
        `Expected macOS platform, got ${hardware.os?.platform}`
    );
    assert(
        String(hardware.cpu?.architecture || '').toLowerCase().includes('apple'),
        `Expected Apple Silicon architecture, got ${hardware.cpu?.architecture}`
    );
    assert(
        Number(hardware.memory?.total) >= 16,
        `Expected at least 16GB RAM on reference Mac, got ${hardware.memory?.total}GB`
    );

    const speed3B = estimateTokenSpeedFromHardware(hardware, { modelSizeB: 3, modelName: 'llama3.2:3b' });
    const speed8B = estimateTokenSpeedFromHardware(hardware, { modelSizeB: 8, modelName: 'llama3.1:8b' });
    const speed13B = estimateTokenSpeedFromHardware(hardware, { modelSizeB: 13, modelName: 'llama3.1:13b' });

    assert.strictEqual(speed3B.backend, 'metal', `Expected metal backend on Apple Silicon, got ${speed3B.backend}`);
    assert(
        speed3B.tokensPerSecond > speed8B.tokensPerSecond && speed8B.tokensPerSecond > speed13B.tokensPerSecond,
        `Expected monotonic scaling 3B > 8B > 13B, got ${speed3B.tokensPerSecond} > ${speed8B.tokensPerSecond} > ${speed13B.tokensPerSecond}`
    );
    assert(speed8B.tokensPerSecond > 0, `Expected positive TPS for 8B, got ${speed8B.tokensPerSecond}`);

    if (isM4ProMac(hardware)) {
        assert(
            speed8B.tokensPerSecond >= 30 && speed8B.tokensPerSecond <= 70,
            `M4 Pro 8B estimate out of expected band (30-70 t/s), got ${speed8B.tokensPerSecond}`
        );
    }

    const analyzer = new PerformanceAnalyzer();
    const parsedSizeFromGB = analyzer.parseModelSize('4.9GB');
    assert(
        parsedSizeFromGB >= 7 && parsedSizeFromGB <= 9.5,
        `parseModelSize should infer params from GB notation, got ${parsedSizeFromGB}`
    );

    const perfEstimate = analyzer.calculateRealisticPerformance(
        { name: 'llama3.1:8b', size: '8B', requirements: { ram: 10 } },
        hardware
    );
    assert.strictEqual(
        perfEstimate.estimatedTokensPerSecond,
        speed8B.tokensPerSecond,
        `Performance analyzer should use shared estimator (expected ${speed8B.tokensPerSecond}, got ${perfEstimate.estimatedTokensPerSecond})`
    );

    const database = new ExpandedModelsDatabase();
    const dbSpeed = database.calculateRealisticTokensPerSecond(
        { name: 'llama3.1:8b', size: '8B' },
        hardware
    );
    assert.strictEqual(
        dbSpeed,
        speed8B.tokensPerSecond,
        `Expanded database estimator should align with shared estimator (expected ${speed8B.tokensPerSecond}, got ${dbSpeed})`
    );

    const tinyParams = database.extractModelParams({ name: 'all-minilm:22m', size: '22M' });
    assert(
        tinyParams > 0 && tinyParams < 0.1,
        `extractModelParams should convert M suffix to billions, got ${tinyParams}`
    );

    console.log('token-speed-estimation.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('token-speed-estimation.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
