const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ModelDatabase = require('../src/data/model-database');
const {
    RegistryIngestor,
    normalizeHuggingFaceModel,
    normalizeGpt4AllEntry,
    normalizeOllamaRows
} = require('../src/data/registry-ingestors');

function buildHuggingFaceFixture() {
    return {
        id: 'TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF',
        modelId: 'TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF',
        sha: 'deadbeefcafebabe',
        downloads: 12345,
        likes: 67,
        tags: ['gguf', 'text-generation', 'license:apache-2.0'],
        pipeline_tag: 'text-generation',
        cardData: {
            license: 'apache-2.0',
            context_length: 4096
        },
        siblings: [
            {
                rfilename: 'tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf',
                size: 1234567890,
                lfs: {
                    sha256: 'abc123',
                    oid: 'etag123'
                }
            },
            {
                rfilename: 'README.md',
                size: 1000
            }
        ]
    };
}

function testNormalizeHuggingFaceModel() {
    const collection = normalizeHuggingFaceModel(buildHuggingFaceFixture());

    assert.ok(collection, 'Hugging Face fixture should normalize');
    assert.strictEqual(collection.source.id, 'huggingface');
    assert.strictEqual(collection.repos.length, 1);
    assert.strictEqual(collection.artifacts.length, 1, 'Only model artifact files should be included');

    const artifact = collection.artifacts[0];
    assert.strictEqual(artifact.format, 'gguf');
    assert.strictEqual(artifact.quantization, 'Q4_K_M');
    assert.strictEqual(artifact.parameter_count_b, 1.1);
    assert.strictEqual(artifact.context_length, 4096);
    assert.ok(artifact.runtime_support.includes('llama.cpp'));
    assert.ok(artifact.runtime_support.includes('ollama'));
    assert.strictEqual(
        artifact.download_url,
        'https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/deadbeefcafebabe/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf'
    );
}

function testHuggingFaceDoesNotParseLayerCountAsParams() {
    const collection = normalizeHuggingFaceModel({
        id: 'sentence-transformers/all-MiniLM-L6-v2',
        modelId: 'sentence-transformers/all-MiniLM-L6-v2',
        sha: 'abc123',
        tags: ['sentence-transformers', 'safetensors'],
        pipeline_tag: 'sentence-similarity',
        siblings: [
            {
                rfilename: 'model.safetensors',
                size: 90888992
            }
        ]
    });

    assert.ok(collection, 'MiniLM fixture should normalize');
    assert.strictEqual(collection.artifacts.length, 1);
    assert.strictEqual(collection.artifacts[0].parameter_count_b, null);
}

function testNormalizeGpt4AllEntry() {
    const collection = normalizeGpt4AllEntry({
        name: 'orca-mini-3b-q4_0.gguf',
        url: 'https://gpt4all.io/models/gguf/orca-mini-3b-q4_0.gguf',
        filesize: 1932735283,
        parameters: '3B',
        quant: 'q4_0',
        type: 'chat',
        license: 'apache-2.0',
        ramrequired: 4
    });

    assert.ok(collection, 'GPT4All fixture should normalize');
    assert.strictEqual(collection.source.id, 'gpt4all');
    assert.strictEqual(collection.artifacts.length, 1);

    const artifact = collection.artifacts[0];
    assert.strictEqual(artifact.format, 'gguf');
    assert.strictEqual(artifact.quantization, 'Q4_0');
    assert.strictEqual(artifact.parameter_count_b, 3);
    assert.ok(artifact.runtime_support.includes('llama.cpp'));
    assert.strictEqual(artifact.download_url, 'https://gpt4all.io/models/gguf/orca-mini-3b-q4_0.gguf');
}

async function testRegistryPersistenceAndSearch() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-registry-'));
    const database = new ModelDatabase({
        dbPath: path.join(tempDir, 'models.db'),
        seedDbPath: path.join(tempDir, 'missing-seed.db')
    });

    try {
        await database.initialize();

        const huggingFaceCollection = normalizeHuggingFaceModel(buildHuggingFaceFixture());
        const gpt4AllCollection = normalizeGpt4AllEntry({
            name: 'orca-mini-3b-q4_0.gguf',
            url: 'https://gpt4all.io/models/gguf/orca-mini-3b-q4_0.gguf',
            filesize: 1932735283,
            parameters: '3B',
            quant: 'q4_0',
            type: 'chat',
            license: 'apache-2.0'
        });
        const ollamaCollection = normalizeOllamaRows(
            {
                id: 'llama3.2',
                name: 'Llama 3.2',
                capabilities: '["chat","reasoning"]',
                namespace: 'library',
                pulls: 999
            },
            {
                tag: 'llama3.2:3b-instruct-q4_K_M',
                params_b: 3,
                quant: 'Q4_K_M',
                size_gb: 2.1,
                context_length: 8192
            }
        );

        const ingestor = new RegistryIngestor({ database });
        ingestor.storeCollections([huggingFaceCollection, gpt4AllCollection, ollamaCollection]);

        const stats = database.getRegistryStats();
        assert.strictEqual(stats.sources, 3);
        assert.strictEqual(stats.repos, 3);
        assert.strictEqual(stats.artifacts, 3);

        const ollamaRuntimeRows = database.searchModelArtifacts('tinyllama', {
            runtime: 'ollama',
            localOnly: true,
            limit: 10
        });
        assert.strictEqual(ollamaRuntimeRows.length, 1);
        assert.strictEqual(ollamaRuntimeRows[0].format, 'gguf');
        assert.deepStrictEqual(ollamaRuntimeRows[0].modalities, ['text']);

        const gpt4AllRows = database.searchModelArtifacts('', {
            source: 'gpt4all',
            maxSizeGB: 2,
            limit: 10
        });
        assert.strictEqual(gpt4AllRows.length, 1);
        assert.strictEqual(gpt4AllRows[0].source_id, 'gpt4all');
    } finally {
        database.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function run() {
    testNormalizeHuggingFaceModel();
    testHuggingFaceDoesNotParseLayerCountAsParams();
    testNormalizeGpt4AllEntry();
    await testRegistryPersistenceAndSearch();
    console.log('[OK] model-registry-ingestors.test.js passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('[FAIL] model-registry-ingestors.test.js failed');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
