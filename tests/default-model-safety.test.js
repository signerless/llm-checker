const assert = require('assert');
const DeterministicModelSelector = require('../src/models/deterministic-selector');

const hardware = {
    cpu: { cores: 16, architecture: 'arm64' },
    gpu: { type: 'apple_silicon', unified: true, vramGB: 0 },
    memory: { totalGB: 32 },
    acceleration: { supports_metal: true, supports_cuda: false, supports_rocm: false },
    usableMemGB: 27.2
};

const safeModel = {
    model_identifier: 'qwen-coder-safe:8b',
    model_name: 'Qwen Coder Safe',
    name: 'Qwen Coder Safe',
    description: 'General coding assistant',
    paramsB: 8,
    contextLength: 8192,
    tags: ['coder', 'instruct'],
    modalities: ['text'],
    availableQuantizations: ['Q4_K_M']
};

const uncensoredModel = {
    ...safeModel,
    model_identifier: 'qwen-coder-heretic-uncensored:8b',
    model_name: 'Qwen Coder Heretic Uncensored',
    name: 'Qwen Coder Heretic Uncensored',
    description: 'Abliterated coding model'
};

async function run() {
    const selector = new DeterministicModelSelector();
    const common = {
        hardware,
        installedModels: [],
        modelPool: [uncensoredModel, safeModel],
        topN: 5,
        silent: true
    };

    const defaultResult = await selector.selectModels('coding', common);
    const defaultIds = defaultResult.candidates.map((candidate) => candidate.meta.model_identifier);
    assert.deepStrictEqual(defaultIds, [safeModel.model_identifier]);
    assert.strictEqual(defaultResult.total_evaluated, 1);

    const explicitResult = await selector.selectModels('coding', {
        ...common,
        includeUncensored: true
    });
    const explicitIds = explicitResult.candidates.map((candidate) => candidate.meta.model_identifier);
    assert.ok(explicitIds.includes(uncensoredModel.model_identifier));
    assert.strictEqual(explicitResult.total_evaluated, 2);

    console.log('default-model-safety.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('default-model-safety.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
