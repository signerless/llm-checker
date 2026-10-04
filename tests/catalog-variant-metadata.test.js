/**
 * Catalog variant metadata test
 * =============================
 *   - Older databases gain the digest / size_bytes / blob_sha256 columns.
 *   - An unknown context window is stored as unknown, not as 4096.
 *   - The registry copy of an Ollama tag keeps exact bytes, the blob hash and
 *     the per-tag image input.
 *   - The selector reads each tag's own context window and inputs.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ModelDatabase = require('../src/data/model-database');
const { RegistryIngestor } = require('../src/data/registry-ingestors');
const DeterministicModelSelector = require('../src/models/deterministic-selector');

async function openDatabase(dbPath) {
    const database = new ModelDatabase({ dbPath, seedDbPath: path.join(path.dirname(dbPath), 'missing-seed.db') });
    await database.initialize();
    return database;
}

async function testMigrationAndStorage() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-variant-meta-'));
    const dbPath = path.join(tempDir, 'models.db');
    try {
        let database = await openDatabase(dbPath);
        for (const column of ['digest', 'size_bytes', 'blob_sha256']) {
            database.run(`ALTER TABLE variants DROP COLUMN ${column}`);
        }
        database.close();

        database = await openDatabase(dbPath);
        const columns = database.all('PRAGMA table_info(variants)').map((column) => column.name);
        for (const column of ['digest', 'size_bytes', 'blob_sha256']) {
            assert.ok(columns.includes(column), `${column} is added to an older database`);
        }

        database.upsertModel({ id: 'gemma3', name: 'gemma3', capabilities: ['multimodal'], pulls: 10 });
        database.upsertVariant({ model_id: 'gemma3', tag: 'gemma3:unknown' });
        database.upsertVariant({
            model_id: 'gemma3',
            tag: 'gemma3:4b',
            params_b: 4.3,
            quant: 'Q4_K_M',
            size_gb: 3.539,
            size_bytes: 3_800_000_000,
            context_length: 131072,
            input_types: ['text', 'image'],
            digest: 'a2af6cc3eb7f',
            blob_digest: `sha256:${'d'.repeat(64)}`,
            license: 'gemma'
        });
        database.upsertVariant({
            model_id: 'gemma3', tag: 'gemma3:1b', params_b: 1, quant: 'Q4_K_M', size_gb: 0.759,
            context_length: 32768, input_types: ['text']
        });

        assert.strictEqual(database.get(`SELECT context_length FROM variants WHERE tag = 'gemma3:unknown'`).context_length, null,
            'an unknown window is not recorded as 4096');

        const [model] = database.getAllModelsWithVariants();
        const fourB = model.variants.find((variant) => variant.tag === 'gemma3:4b');
        assert.strictEqual(fourB.digest, 'a2af6cc3eb7f');
        assert.strictEqual(fourB.size_bytes, 3_800_000_000);

        const [collection] = new RegistryIngestor({ database }).collectOllamaFromDatabase({ limit: 10 })
            .filter((entry) => entry.artifacts[0].artifact_name === 'gemma3:4b');
        const [artifact] = collection.artifacts;
        assert.strictEqual(artifact.size_bytes, 3_800_000_000);
        assert.strictEqual(artifact.sha256, 'd'.repeat(64));
        assert.strictEqual(artifact.etag, 'a2af6cc3eb7f');
        assert.strictEqual(artifact.license, 'gemma', 'the tag license reaches the registry');
        assert.strictEqual(collection.repos[0].license, 'gemma', 'the model takes its most common tag license');
        assert.strictEqual(fourB.license, 'gemma');
        assert.strictEqual(model.license, 'gemma');
        assert.ok(artifact.modalities.includes('vision'), 'the tag accepts images');

        database.upsertVariant({
            model_id: 'gemma3', tag: 'gemma3:latest', params_b: 4.3, quant: 'Q4_K_M', size_gb: 3.539,
            context_length: 131072, input_types: ['text', 'image'], digest: 'a2af6cc3eb7f'
        });
        database.upsertVariant({
            model_id: 'gemma3', tag: 'gemma3:4b-it-q4_K_M', params_b: 4.3, quant: 'Q4_K_M', size_gb: 3.539,
            context_length: 131072, input_types: ['text', 'image'], digest: 'a2af6cc3eb7f'
        });
        const artifacts = new RegistryIngestor({ database }).collectOllamaFromDatabase({ limit: 10 })
            .map((entry) => entry.artifacts[0]);
        const sameDigest = artifacts.filter((entry) => entry.etag === 'a2af6cc3eb7f');
        assert.strictEqual(sameDigest.length, 1, 'aliases of one download are one artifact');
        assert.strictEqual(sameDigest[0].artifact_name, 'gemma3:4b', 'the short explicit tag is kept');
        assert.deepStrictEqual(sameDigest[0].metadata.aliases, ['gemma3:4b-it-q4_K_M', 'gemma3:latest']);
        assert.strictEqual(sameDigest[0].parameter_count_b, 4.3, 'the exact count beats the nominal 4b');
        database.close();
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function testPretrainedVariantsRankBelowInstructBuilds() {
    const selector = new DeterministicModelSelector();
    // Compare the estimates only; the local catalog may hold measured scores.
    selector.qualityEvals = null;
    const model = (tag) => ({
        model_identifier: tag, name: tag, paramsB: 7, family: 'qwen2.5', tags: ['coder'], pulls: 0,
        capabilities: ['coding']
    });
    const base = selector.calculateQualityPrior(model('qwen2.5-coder:7b-base-q4_K_M'), 'Q4_K_M', 'coding');
    const instruct = selector.calculateQualityPrior(model('qwen2.5-coder:7b-instruct-q4_K_M'), 'Q4_K_M', 'coding');
    assert.strictEqual(instruct - base, 15, 'a base coder checkpoint is not an assistant');
    assert.strictEqual(selector.isPretrainedVariant({ model_identifier: 'nomic-embed-text', capabilities: ['embeddings'] }), false,
        'embedding models are not base checkpoints');
}

function testSelectorReadsPerTagMetadata() {
    const selector = new DeterministicModelSelector();
    const models = selector.convertOllamaModelToDeterministicModels({
        model_identifier: 'gemma3',
        model_name: 'gemma3',
        description: 'A high-level model family',
        capabilities: ['multimodal'],
        categories: ['multimodal'],
        primary_category: 'multimodal',
        variants: [
            { tag: 'gemma3:1b', params_b: 1, quant: 'Q4_K_M', size_gb: 0.759, context_length: 32768, input_types: ['text'] },
            { tag: 'gemma3:4b', params_b: 4.3, quant: 'Q4_K_M', size_gb: 3.539, context_length: 131072, input_types: ['text', 'image'] }
        ]
    });
    const byTag = Object.fromEntries(models.map((model) => [model.model_identifier, model]));
    assert.strictEqual(byTag['gemma3:1b'].ctxMax, 32768, 'each tag keeps its own context window');
    assert.strictEqual(byTag['gemma3:4b'].ctxMax, 131072);
    assert.deepStrictEqual(byTag['gemma3:1b'].modalities, ['text'], 'a text-only tag of a vision family');
    assert.deepStrictEqual(byTag['gemma3:4b'].modalities, ['text', 'vision']);
}

function testLegacyCommandsReadCatalogFacts() {
    const catalogModel = {
        model_identifier: 'gemma3', model_name: 'gemma3',
        variants: [{ tag: 'gemma3:latest', params_b: 4.3, quant: 'Q4_K_M', size_gb: 3.1, context_length: 131072,
            input_types: ['text', 'image'], digest: 'a2af6cc3eb7f' }]
    };

    const LLMChecker = require('../src/index');
    const checkModel = new LLMChecker({ verbose: false }).createModelFromOllamaData(catalogModel);
    assert.strictEqual(checkModel.size, '4.3B', 'check uses the tag parameter count, not a family guess of 7B');
    assert.strictEqual(checkModel.requirements.storage, 3.1);

    const AICheckSelector = require('../src/models/ai-check-selector');
    const aiCheckModel = new AICheckSelector().convertOllamaModelToDeterministicFormat(catalogModel);
    assert.deepStrictEqual(
        [aiCheckModel.paramsB, aiCheckModel.sizeGB, aiCheckModel.ctxMax, aiCheckModel.modalities],
        [4.3, 3.1, 131072, ['text', 'vision']], 'ai-check reads the default tag'
    );

    const IntelligentSelector = require('../src/ai/intelligent-selector');
    const Selector = IntelligentSelector.IntelligentModelSelector || IntelligentSelector;
    const selector = new Selector();
    selector.setCatalogFacts(new Map([['gemma3:latest', { params_b: 4.3, size_gb: 3.1, context_length: 131072, quant: 'Q4_K_M' }]]));
    const aiRunModel = selector.getModelInfo('gemma3');
    assert.deepStrictEqual([aiRunModel.parameters, aiRunModel.size_gb, aiRunModel.context_length, aiRunModel.source],
        [4.3, 3.1, 131072, 'catalog'], 'ai-run reads the catalog instead of estimating 7B');
}

async function run() {
    testLegacyCommandsReadCatalogFacts();
    await testMigrationAndStorage();
    testSelectorReadsPerTagMetadata();
    testPretrainedVariantsRankBelowInstructBuilds();
    console.log('catalog-variant-metadata.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('catalog-variant-metadata.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
