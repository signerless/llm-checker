const assert = require('assert');
const MultiObjectiveSelector = require('../src/ai/multi-objective-selector');
const ExpandedModelsDatabase = require('../src/models/expanded_database');

async function testRtx5060AvoidsTinyLlamaTopPick() {
    const selector = new MultiObjectiveSelector();
    const database = new ExpandedModelsDatabase();
    const hardware = {
        cpu: {
            brand: 'Intel Core Ultra 7 255HX',
            cores: 20,
            physicalCores: 20,
            speed: 3.0,
            architecture: 'x64'
        },
        memory: { total: 15 },
        gpu: {
            model: 'NVIDIA GeForce RTX 5060 Laptop GPU',
            vendor: 'NVIDIA',
            vram: 8,
            dedicated: true
        },
        summary: {
            hasDedicatedGPU: true,
            hasIntegratedGPU: false,
            totalVRAM: 8
        },
        os: { platform: 'linux' }
    };

    assert.strictEqual(selector.getHardwareTier(hardware), 'medium');

    const result = await selector.selectBestModels(hardware, database.getAllModels(), 'general', 10);
    const top = result.compatible[0] || result.marginal[0];

    assert.ok(top, 'Expected at least one recommendation');
    assert.notStrictEqual(top.name, 'TinyLlama 1.1B', 'RTX 5060 should not recommend TinyLlama as top pick');
    assert.ok(
        selector.estimateModelParams(top) >= 6 && selector.estimateModelParams(top) <= 9,
        `Expected a 6B-9B top recommendation for RTX 5060, got ${top.name}`
    );
}

async function run() {
    await testRtx5060AvoidsTinyLlamaTopPick();
    console.log('multi-objective-selector-regression.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('multi-objective-selector-regression.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
