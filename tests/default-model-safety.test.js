const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const DeterministicModelSelector = require('../src/models/deterministic-selector');
const IntelligentSelector = require('../src/models/intelligent-selector');
const AICheckSelector = require('../src/models/ai-check-selector');
const AIModelSelector = require('../src/ai/model-selector');
const MultiObjectiveSelector = require('../src/ai/multi-objective-selector');
const LLMChecker = require('../src/index');
const ModelDatabase = require('../src/data/model-database');
const { RegistryRecommender, artifactToSelectorModel } = require('../src/data/registry-recommender');
const {
    classifyModelSafety,
    isUncensoredModel
} = require('../src/models/model-safety');

const hardware = {
    cpu: { brand: 'Test CPU', cores: 20, architecture: 'arm64' },
    gpu: { type: 'nvidia', model: 'NVIDIA GB10', unified: true, vramGB: 64, vram: 64 },
    memory: { totalGB: 122, total: 122 },
    acceleration: { supports_metal: false, supports_cuda: true, supports_rocm: false },
    usableMemGB: 83,
    summary: {
        bestBackend: 'cuda',
        runtimeBackend: 'cuda',
        effectiveMemory: 83,
        systemRAM: 122,
        totalVRAM: 64,
        hardwareTier: 'very_high',
        hasDedicatedGPU: true,
        hasIntegratedGPU: false,
        speedCoefficient: 160
    }
};

const safeModel = {
    model_identifier: 'qwen-coder-safe:8b',
    model_name: 'Qwen Coder Safe',
    name: 'Qwen Coder Safe',
    description: 'General aligned coding assistant',
    paramsB: 8,
    ctxMax: 8192,
    contextLength: 8192,
    tags: ['coder', 'instruct'],
    modalities: ['text'],
    availableQuantizations: ['Q4_K_M']
};

function makeRestrictedModel(marker) {
    return {
        ...safeModel,
        model_identifier: `qwen-coder-${marker}:8b`,
        model_name: `Qwen Coder ${marker}`,
        name: `Qwen Coder ${marker}`,
        description: 'Coding model'
    };
}

function makeRawOllamaModel(id, description) {
    return {
        model_identifier: id,
        model_name: id,
        description,
        primary_category: 'coding',
        context_length: '32K',
        variants: [{
            tag: `${id}:8b-q4_K_M`,
            size: '8b',
            quantization: 'Q4_K_M',
            real_size_gb: 5,
            categories: ['coding']
        }],
        use_cases: ['coding']
    };
}

function makeSmartVariant(id) {
    return {
        model_id: id,
        tag: `${id}:8b`,
        params_b: 8,
        size_gb: 5,
        quant: 'Q4_K_M',
        context_length: 32768,
        capabilities: 'coding',
        family: 'qwen2.5-coder',
        pulls: 1000000
    };
}

function makeStubDetector() {
    return {
        detect: async () => hardware,
        getHardwareDescription: () => 'unit-test hardware',
        getHardwareTier: () => 'very_high',
        getMaxModelSize: () => 83
    };
}

function testClassifier() {
    for (const marker of ['uncensored', 'abliterated', 'heretic']) {
        const classification = classifyModelSafety(makeRestrictedModel(marker));
        assert.strictEqual(classification.restricted, true, `${marker} must be restricted independently`);
        assert.deepStrictEqual(classification.markers, [marker]);
    }

    assert.strictEqual(isUncensoredModel({ tags: ['Heretic'] }), true, 'tags are authoritative');
    assert.strictEqual(
        isUncensoredModel({ name: 'dolphin-safe', description: 'An uncensored Dolphin fine-tune' }),
        true,
        'description-only labels must be detected'
    );
    assert.strictEqual(
        isUncensoredModel({ name: 'aligned-model', description: 'This model is not uncensored.' }),
        false,
        'an explicitly negated description must not be a false positive'
    );
    assert.strictEqual(
        isUncensoredModel({ name: 'aligned-model', description: 'This model is not an abliterated model.' }),
        false,
        'negation with an article must be ignored'
    );
    assert.strictEqual(
        isUncensoredModel({
            name: 'aligned-model',
            description: 'This model is neither uncensored, abliterated, nor heretic.'
        }),
        false,
        'a negated list of markers must not be a false positive'
    );
    assert.strictEqual(
        isUncensoredModel({ name: 'aligned-model', description: 'It does not support uncensored output.' }),
        false,
        'a directly negated capability statement must not be a false positive'
    );
    assert.strictEqual(isUncensoredModel({ name: 'censored-model' }), false);
    assert.strictEqual(isUncensoredModel({ name: 'heretical-essays-classifier' }), false);
}

async function testDeterministicSelector() {
    const selector = new DeterministicModelSelector();
    const restrictedModels = ['uncensored', 'abliterated', 'heretic'].map(makeRestrictedModel);
    const common = {
        hardware,
        installedModels: [],
        modelPool: [...restrictedModels, safeModel],
        topN: 10,
        silent: true
    };

    const defaultResult = await selector.selectModels('coding', common);
    assert.deepStrictEqual(
        defaultResult.candidates.map((candidate) => candidate.meta.model_identifier),
        [safeModel.model_identifier]
    );
    assert.strictEqual(defaultResult.total_evaluated, 1);

    const descriptionOnlyReference = makeRawOllamaModel(
        'dolphin-description-only',
        'An uncensored coding fine-tune'
    );
    const installedWithoutDescription = {
        ...safeModel,
        name: 'dolphin-description-only:latest',
        model_name: 'dolphin-description-only:latest',
        model_identifier: 'dolphin-description-only:latest',
        description: '',
        installed: true
    };
    const installedResult = await selector.selectModels('coding', {
        hardware,
        installedModels: [installedWithoutDescription],
        modelPool: [descriptionOnlyReference, safeModel],
        topN: 10,
        silent: true
    });
    assert.ok(
        installedResult.candidates.every((candidate) => !candidate.meta.model_identifier.startsWith('dolphin-description-only:')),
        'catalog metadata must keep a description-only restricted local model out of recommendations'
    );

    const explicitResult = await selector.selectModels('coding', {
        ...common,
        includeUncensored: true
    });
    const explicitIds = explicitResult.candidates.map((candidate) => candidate.meta.model_identifier);
    for (const model of restrictedModels) {
        assert.ok(explicitIds.includes(model.model_identifier), `opt-in must restore ${model.model_identifier}`);
    }
    assert.strictEqual(explicitResult.total_evaluated, 4);
}

async function testOllamaDescriptionOnlyModel() {
    const selector = new DeterministicModelSelector();
    const rawUnsafe = makeRawOllamaModel(
        'dolphin-description-only',
        'An uncensored coding model whose identifier does not carry the safety label'
    );
    const rawSafe = makeRawOllamaModel('safe-description-model', 'Aligned coding model');
    const normalizedUnsafe = selector.normalizeExternalModels([rawUnsafe]);

    assert.ok(normalizedUnsafe.length > 0);
    assert.match(normalizedUnsafe[0].description, /uncensored/i, 'normalization must preserve description');
    assert.strictEqual(selector.isUncensoredModel(normalizedUnsafe[0]), true);

    const defaultResult = await selector.selectModels('coding', {
        hardware,
        installedModels: [],
        modelPool: [rawUnsafe, rawSafe],
        topN: 10,
        silent: true
    });
    assert.deepStrictEqual(
        defaultResult.candidates.map((candidate) => candidate.meta.model_identifier),
        ['safe-description-model:8b-q4_K_M']
    );

    const explicitResult = await selector.selectModels('coding', {
        hardware,
        installedModels: [],
        modelPool: [rawUnsafe, rawSafe],
        includeUncensored: true,
        topN: 10,
        silent: true
    });
    assert.ok(
        explicitResult.candidates.some((candidate) => candidate.meta.model_identifier.startsWith('dolphin-description-only:'))
    );
}

async function testPackagedSeedDescriptionOnlyModel() {
    const seedDbPath = path.join(__dirname, '..', 'src', 'data', 'seed', 'models.db');
    const database = new ModelDatabase({
        dbPath: seedDbPath,
        seedDbPath: path.join(__dirname, 'missing-seed.db'),
        disableRegistrySeedImport: true
    });

    try {
        await database.initialize();
        const rows = database.searchModelArtifacts('dolphin-mixtral', {
            source: 'ollama',
            localOnly: true,
            limit: 100
        });
        assert.ok(rows.length > 0, 'packaged seed should contain dolphin-mixtral artifacts');
        assert.ok(rows.every((row) => /uncensored/i.test(row.repo_description || '')));

        const smartRows = database.getVariantsForHardware(100, { limit: 10000 });
        const smartSeedVariant = smartRows.find((row) => row.model_id === 'dolphin-mixtral');
        assert.ok(smartSeedVariant, 'smart-recommend pool should contain the seed model before policy filtering');
        assert.match(
            smartSeedVariant.description || '',
            /uncensored/i,
            'smart-recommend database rows must preserve model descriptions'
        );

        const adapted = rows.map(artifactToSelectorModel).find(Boolean);
        assert.ok(adapted, 'at least one seed artifact should be selectable');
        assert.match(adapted.description, /uncensored/i, 'registry adapter must preserve repo description');
        assert.strictEqual(isUncensoredModel(adapted), true);

        const recommender = new RegistryRecommender({ database });
        const defaultResult = await recommender.recommend({
            query: 'dolphin-mixtral',
            category: 'general',
            runtime: 'auto',
            hardware,
            localOnly: true,
            limit: 10
        });
        assert.deepStrictEqual(defaultResult.recommendations, []);
        assert.strictEqual(defaultResult.total_evaluated, 0);

        const explicitResult = await recommender.recommend({
            query: 'dolphin-mixtral',
            category: 'general',
            runtime: 'auto',
            hardware,
            localOnly: true,
            includeUncensored: true,
            limit: 10
        });
        assert.ok(explicitResult.total_evaluated > 0);
        assert.ok(explicitResult.recommendations.some((item) => item.model === 'dolphin-mixtral'));
    } finally {
        database.close();
    }
}

async function testSmartRecommendDoesNotReintroduceFilteredModels() {
    const selector = new IntelligentSelector({ detector: makeStubDetector() });
    const safe = makeSmartVariant('safe-coder');
    const unsafe = makeSmartVariant('rogue-heretic-uncensored');
    const descriptionOnlyUnsafe = {
        ...makeSmartVariant('dolphin-description-only'),
        description: 'An abliterated coding fine-tune'
    };

    const defaultResult = await selector.recommend([safe, unsafe, descriptionOnlyUnsafe], {
        useCase: 'coding',
        limit: 10,
        policyFile: null
    });
    assert.deepStrictEqual(defaultResult.all.map((item) => item.variant.tag), [safe.tag]);
    for (const pick of Object.values(defaultResult.topPicks)) {
        if (pick) assert.strictEqual(isUncensoredModel(pick.variant), false);
    }

    const explicitResult = await selector.recommend([safe, unsafe, descriptionOnlyUnsafe], {
        useCase: 'coding',
        limit: 10,
        policyFile: null,
        includeUncensored: true
    });
    assert.ok(explicitResult.all.some((item) => item.variant.tag === unsafe.tag));
    assert.ok(explicitResult.all.some((item) => item.variant.tag === descriptionOnlyUnsafe.tag));
}

async function testCheckFallbackDoesNotReintroduceFilteredModels() {
    const selector = new MultiObjectiveSelector({
        rankModels: async () => {
            throw new Error('forced unified scorer failure');
        }
    });
    const safe = {
        name: 'Safe Coder',
        model_identifier: 'safe-coder:3b',
        size: '3B',
        context: 4096,
        architecture: 'transformer'
    };
    const unsafe = {
        ...safe,
        name: 'Dolphin Coder',
        model_identifier: 'dolphin-coder:3b',
        description: 'A heretic coding fine-tune'
    };
    const flatten = (result) => [
        ...result.compatible,
        ...result.marginal,
        ...result.incompatible
    ];

    const defaultResult = await selector.selectBestModels(hardware, [safe, unsafe], 'coding', 10);
    assert.ok(flatten(defaultResult).every((model) => model.model_identifier !== unsafe.model_identifier));

    const explicitResult = await selector.selectBestModels(
        hardware,
        [safe, unsafe],
        'coding',
        10,
        { includeUncensored: true }
    );
    assert.ok(flatten(explicitResult).some((model) => model.model_identifier === unsafe.model_identifier));
}

async function testOuterCheckFallbackUsesEligiblePools() {
    const checker = new LLMChecker({ verbose: false });
    checker.logger = { info() {}, warn() {}, error() {} };
    checker.loadOllamaModelData = async () => {
        throw new Error('forced outer mathematical fallback');
    };
    let analyzedPool = null;
    checker.compatibilityAnalyzer.analyzeCompatibility = (_hardware, models) => {
        analyzedPool = [...models];
        return { compatible: [...models], marginal: [], incompatible: [] };
    };

    const safe = { name: 'Safe Static', model_identifier: 'safe-static', description: 'Aligned model' };
    const unsafe = {
        name: 'Dolphin Static',
        model_identifier: 'dolphin-static',
        description: 'An uncensored model'
    };
    const localSafe = {
        name: 'safe-local:latest',
        matchedModel: safe,
        canRun: true,
        compatibilityScore: 80,
        issues: [],
        notes: []
    };
    const localUnsafe = {
        name: 'dolphin-local:latest',
        matchedModel: {
            name: 'Dolphin Local',
            model_identifier: 'dolphin-local',
            description: 'A heretic local fine-tune'
        },
        canRun: true,
        compatibilityScore: 90,
        issues: [],
        notes: []
    };
    const result = await checker.analyzeWithMathematicalHeuristics(
        hardware,
        [safe, unsafe],
        { compatibleOllamaModels: [localSafe, localUnsafe], recommendedPulls: [] },
        {}
    );

    assert.deepStrictEqual(analyzedPool.map((model) => model.model_identifier), [safe.model_identifier]);
    assert.ok(result.compatible.every((model) => !isUncensoredModel(model)));
    assert.ok(result.marginal.every((model) => !isUncensoredModel(model)));
}

async function testAiCheckDefaultAndOptIn() {
    const selector = new AICheckSelector({
        hardwareDetector: { getSystemInfo: async () => hardware }
    });
    const unsafe = {
        model_identifier: 'rogue-heretic-uncensored-coder:8b',
        model_name: 'Rogue Heretic Uncensored Coder',
        primary_category: 'coding'
    };
    selector.loadModelDatabase = async () => ({ models: [unsafe] });
    selector.pickEvaluatorModel = async () => null;

    const originalLog = console.log;
    console.log = () => {};
    try {
        const defaultResult = await selector.aiCheck({ category: 'coding', top: 5, silent: true });
        assert.deepStrictEqual(defaultResult.results.candidates, []);

        const explicitResult = await selector.aiCheck({
            category: 'coding',
            top: 5,
            silent: true,
            includeUncensored: true
        });
        assert.strictEqual(explicitResult.results.candidates.length, 1);
        assert.strictEqual(explicitResult.results.candidates[0].meta.model_identifier, unsafe.model_identifier);
    } finally {
        console.log = originalLog;
    }

    const evaluatorSelector = new AICheckSelector();
    const installedDescriptionOnly = {
        model_identifier: 'dolphin-evaluator:8b',
        name: 'dolphin-evaluator:8b',
        paramsB: 8,
        ctxMax: 8192,
        sizeGB: 5,
        quant: 'Q4_K_M',
        modalities: ['text'],
        tags: []
    };
    evaluatorSelector.deterministicSelector.getInstalledModels = async () => [installedDescriptionOnly];
    const evaluatorCatalog = [{
        model_identifier: 'dolphin-evaluator',
        description: 'A heretic evaluator fine-tune'
    }];
    assert.strictEqual(
        await evaluatorSelector.pickEvaluatorModel(hardware, { catalogModels: evaluatorCatalog }),
        null,
        'automatic evaluator selection must use catalog safety metadata'
    );
    assert.strictEqual(
        await evaluatorSelector.pickEvaluatorModel(hardware, {
            catalogModels: evaluatorCatalog,
            includeUncensored: true
        }),
        installedDescriptionOnly.model_identifier
    );
}

async function testAiRunDefaultAndOptIn() {
    const selector = new AIModelSelector();
    const unsafeId = 'dolphin-local:8b';
    const safeId = 'safe-coder:8b';
    const seenPools = [];
    selector.loadModelDatabase = async () => ({
        models: [
            {
                model_identifier: 'dolphin-local',
                model_name: 'Dolphin Local',
                description: 'Abliterated coding model'
            },
            { model_identifier: safeId, model_name: safeId, description: 'Aligned coding model' }
        ]
    });
    selector.intelligentSelector.selectBestModels = (_hardware, ids) => {
        seenPools.push([...ids]);
        const modelId = ids[0];
        return {
            best_model: {
                modelId,
                confidence: 0.9,
                score: 90,
                reasoning: 'unit-test selection'
            },
            recommendations: ids.map((id) => ({
                modelId: id,
                confidence: 0.9,
                reasoning: 'unit-test selection'
            })),
            hardware_analysis: {}
        };
    };
    const specs = { cpu_cores: 16, total_ram_gb: 32, gpu_vram_gb: 0 };

    const defaultResult = await selector.selectBestModel([unsafeId, safeId], specs, 'coding', { silent: true });
    assert.strictEqual(defaultResult.bestModel, safeId);
    assert.deepStrictEqual(seenPools[0], [safeId]);

    const explicitResult = await selector.selectBestModel([unsafeId, safeId], specs, 'coding', {
        silent: true,
        includeUncensored: true
    });
    assert.strictEqual(explicitResult.bestModel, 'dolphin-local');
    assert.ok(seenPools[1].includes('dolphin-local'));

    await assert.rejects(
        selector.selectBestModel([unsafeId], specs, 'coding', { silent: true }),
        /No eligible models remain/
    );
}

function testCliOptInSurface() {
    const cli = path.join(__dirname, '..', 'bin', 'enhanced_cli.js');
    const commands = [
        ['recommend', '--help'],
        ['registry-recommend', '--help'],
        ['registry-search', '--help'],
        ['search', '--help'],
        ['list-models', '--help'],
        ['smart-recommend', '--help'],
        ['check', '--help'],
        ['simulate', '--help'],
        ['ai-check', '--help'],
        ['ai-run', '--help'],
        ['audit', 'export', '--help']
    ];

    for (const args of commands) {
        const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
        assert.strictEqual(result.status, 0, `${args.join(' ')} should render help`);
        assert.match(result.stdout, /--include-uncensored/, `${args.join(' ')} must expose the opt-in`);
    }
}

async function run() {
    testClassifier();
    await testDeterministicSelector();
    await testOllamaDescriptionOnlyModel();
    await testPackagedSeedDescriptionOnlyModel();
    await testSmartRecommendDoesNotReintroduceFilteredModels();
    await testCheckFallbackDoesNotReintroduceFilteredModels();
    await testOuterCheckFallbackUsesEligiblePools();
    await testAiCheckDefaultAndOptIn();
    await testAiRunDefaultAndOptIn();
    testCliOptInSurface();
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
