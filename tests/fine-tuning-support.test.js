const assert = require('assert');
const {
    parseModelParamsB,
    evaluateFineTuningSupport
} = require('../src/models/fine-tuning-support');

function testParamParsing() {
    assert.strictEqual(parseModelParamsB({ size: '7B' }), 7, 'Should parse size in billions');
    assert.strictEqual(parseModelParamsB({ model_identifier: 'qwen2.5:14b' }), 14, 'Should parse params from identifier');
    assert.strictEqual(parseModelParamsB({ meta: { paramsB: 3 } }), 3, 'Should use explicit paramsB when provided');
}

function testFineTuningSuitabilityBands() {
    const model = { size: '7B' };

    const fullFt = evaluateFineTuningSupport(model, {
        gpu: { dedicated: true, vram: 80 },
        memory: { total: 128 }
    });
    assert.strictEqual(fullFt.method, 'full_ft', '80GB VRAM should support full FT for 7B models');

    const loraOnly = evaluateFineTuningSupport(model, {
        gpu: { dedicated: true, vram: 24 },
        memory: { total: 64 }
    });
    assert.strictEqual(loraOnly.method, 'lora', '24GB VRAM should support LoRA for 7B models');

    const qloraOnly = evaluateFineTuningSupport(model, {
        gpu: { dedicated: true, vram: 8 },
        memory: { total: 32 }
    });
    assert.strictEqual(qloraOnly.method, 'qlora', '8GB VRAM should support QLoRA for 7B models');

    const unsupported = evaluateFineTuningSupport(model, {
        gpu: { dedicated: false, vram: 0, model: 'Intel UHD Graphics' },
        memory: { total: 16 }
    });
    assert.strictEqual(unsupported.method, 'none', 'No accelerator should not be marked as fine-tuning capable');
}

function run() {
    testParamParsing();
    testFineTuningSuitabilityBands();
    console.log('✅ fine-tuning-support.test.js passed');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('❌ fine-tuning-support.test.js failed');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
