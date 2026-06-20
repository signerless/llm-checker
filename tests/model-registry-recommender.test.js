const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ModelDatabase = require('../src/data/model-database');
const {
    RegistryIngestor,
    normalizeHuggingFaceModel,
    normalizeOllamaRows
} = require('../src/data/registry-ingestors');
const {
    RegistryRecommender,
    artifactToSelectorModel,
    normalizeHardwareForSelector
} = require('../src/data/registry-recommender');

function buildHardware() {
    return {
        cpu: { architecture: 'arm64', cores: 10 },
        gpu: { type: 'apple_silicon', unified: true, vramGB: 0 },
        memory: { totalGB: 32 },
        acceleration: { supports_metal: true, supports_cuda: false }
    };
}

async function run() {
    const adaptedHardware = normalizeHardwareForSelector({
        cpu: { architecture: 'arm64', cores: { logical: 12 }, brand: 'Apple M4 Pro' },
        summary: {
            bestBackend: 'metal',
            totalVRAM: 24,
            effectiveMemory: 17,
            systemRAM: 24,
            gpuCount: 1,
            gpuModel: 'Apple M4 Pro'
        }
    });
    assert.strictEqual(adaptedHardware.acceleration.supports_metal, true);
    assert.strictEqual(adaptedHardware.gpu.unified, true);
    assert.strictEqual(adaptedHardware.usableMemGB, 17);

    const shardedModel = artifactToSelectorModel({
        source_id: 'huggingface',
        source_name: 'Hugging Face Hub',
        repo_id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        repo_url: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        canonical_model_id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        artifact_name: 'model-00001-of-000002.safetensors',
        filename: 'model-00001-of-000002.safetensors',
        format: 'safetensors',
        parameter_count_b: 7,
        runtime_support: ['transformers', 'vllm'],
        tasks: ['text-generation'],
        modalities: ['text']
    });
    assert.strictEqual(
        shardedModel.installCommand,
        'hf download deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        'HF sharded files should recommend repo-level download commands'
    );

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-registry-recommend-'));
    const database = new ModelDatabase({
        dbPath: path.join(tempDir, 'models.db'),
        seedDbPath: path.join(tempDir, 'missing-seed.db')
    });

    try {
        await database.initialize();
        const ingestor = new RegistryIngestor({ database });

        ingestor.storeCollections([
            normalizeOllamaRows(
                {
                    id: 'qwen2.5-coder',
                    name: 'qwen2.5-coder',
                    capabilities: '["coding","chat"]',
                    namespace: 'library',
                    pulls: 5000000
                },
                {
                    tag: 'qwen2.5-coder:7b-instruct-q4_K_M',
                    params_b: 7,
                    quant: 'Q4_K_M',
                    size_gb: 4.4,
                    context_length: 32768
                }
            ),
            normalizeOllamaRows(
                {
                    id: 'tinyllama',
                    name: 'tinyllama',
                    capabilities: '["chat"]',
                    namespace: 'library',
                    pulls: 100000
                },
                {
                    tag: 'tinyllama:1.1b-chat-q4_K_M',
                    params_b: 1.1,
                    quant: 'Q4_K_M',
                    size_gb: 0.8,
                    context_length: 2048
                }
            ),
            normalizeHuggingFaceModel(
                {
                    id: 'example/CodeTiny-7B',
                    modelId: 'example/CodeTiny-7B',
                    sha: 'abc123',
                    downloads: 250000,
                    tags: ['safetensors', 'text-generation', 'code', 'license:apache-2.0'],
                    pipeline_tag: 'text-generation',
                    cardData: { license: 'apache-2.0' },
                    siblings: [
                        {
                            rfilename: 'model.safetensors',
                            size: 4294967296
                        }
                    ]
                }
            )
        ]);

        const recommender = new RegistryRecommender({ database });
        const result = await recommender.recommend({
            category: 'coding',
            runtime: 'ollama',
            limit: 2,
            hardware: buildHardware()
        });

        assert.ok(result.total_artifacts >= 2);
        assert.ok(result.total_candidates >= 2);
        assert.ok(result.recommendations.length > 0);
        assert.strictEqual(result.recommendations[0].source, 'ollama');
        assert.ok(result.recommendations[0].install_command.startsWith('ollama pull '));
        assert.ok(result.recommendations.some((item) => item.artifact.includes('qwen2.5-coder')));

        const hfResult = await recommender.recommend({
            category: 'coding',
            runtime: 'auto',
            source: 'huggingface',
            limit: 1,
            hardware: buildHardware()
        });

        assert.strictEqual(hfResult.runtime, 'auto');
        assert.strictEqual(hfResult.recommendations.length, 1);
        assert.strictEqual(hfResult.recommendations[0].source, 'huggingface');
        assert.ok(['vllm', 'transformers'].includes(hfResult.recommendations[0].runtime));
        assert.ok(hfResult.recommendations[0].download_url.includes('huggingface.co/example/CodeTiny-7B'));

        console.log('[OK] model-registry-recommender.test.js passed');
    } finally {
        database.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    run().catch((error) => {
        console.error('[FAIL] model-registry-recommender.test.js failed');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
