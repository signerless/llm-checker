/**
 * Hugging Face registry metadata test
 * ===================================
 *   - Listings are requested per language task with `expand[]` metadata, and
 *     official publishers are swept by author.
 *   - Exact parameters, dtypes, GGUF context windows and lineage are stored.
 *   - A complete shard set is one artifact; companions and duplicate weight
 *     sets are not artifacts.
 *   - Repos without a pipeline tag (official Mistral releases) are kept unless
 *     tagged as another task.
 *   - Optional enrichment merges tree sizes and config.json facts and waits out
 *     a rate-limit response.
 */

const assert = require('assert');
const {
    RegistryIngestor,
    HUGGING_FACE_TASK_PLAN,
    normalizeHuggingFaceModel,
    isSupportedHuggingFaceModel,
    summarizeModelConfig,
    inferTasks,
    inferModalities
} = require('../src/data/registry-ingestors');
const { artifactToSelectorModel, groupWeightShards } = require('../src/data/registry-recommender');

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    };
}

async function testListingPlanAndPublishers() {
    const urls = [];
    const ingestor = new RegistryIngestor({
        database: {},
        huggingFaceToken: '',
        fetchImpl: async (url) => {
            urls.push(new URL(url));
            return jsonResponse([]);
        }
    });
    await ingestor.collectHuggingFace({ limit: 100, publishers: ['mistralai'], publisherLimit: 50 });

    const pipelines = urls.map((url) => url.searchParams.get('pipeline_tag')).filter(Boolean);
    assert.deepStrictEqual(pipelines, HUGGING_FACE_TASK_PLAN.map((entry) => entry.task),
        'one listing per language task');
    for (const url of urls) {
        const expand = url.searchParams.getAll('expand[]');
        for (const field of ['safetensors', 'gguf', 'baseModels', 'siblings', 'cardData']) {
            assert.ok(expand.includes(field), `${field} must be requested`);
        }
        assert.strictEqual(url.searchParams.get('full'), null, 'full=true omits exact metadata');
    }
    const textGeneration = urls.find((url) => url.searchParams.get('pipeline_tag') === 'text-generation');
    assert.strictEqual(textGeneration.searchParams.get('limit'), '70', 'limit is shared by task');
    assert.ok(urls.some((url) => url.searchParams.get('author') === 'mistralai'), 'publishers are swept by author');
}

function testExactMetadataAndLineage() {
    const collection = normalizeHuggingFaceModel({
        id: 'Qwen/Qwen3-8B',
        sha: 'abc',
        pipeline_tag: 'text-generation',
        library_name: 'transformers',
        tags: ['transformers', 'safetensors', 'qwen3', 'text-generation', 'license:apache-2.0'],
        safetensors: { parameters: { BF16: 8190735360 }, total: 8190735360 },
        baseModels: { relation: 'finetune', models: [{ id: 'Qwen/Qwen3-8B-Base' }] },
        config_info: { context_length: 40960 },
        siblings: [1, 2, 3].map((index) => ({
            rfilename: `model-0000${index}-of-00003.safetensors`,
            size: 5.5e9,
            lfs: { oid: 'a'.repeat(64), size: 5.5e9 }
        })).concat([
            { rfilename: 'pytorch_model-00001-of-00001.bin', size: 3e9 },
            { rfilename: 'original/consolidated.00.pth', size: 3e9 },
            { rfilename: 'openvino/openvino_model.bin', size: 3e9 }
        ])
    });
    assert.strictEqual(collection.artifacts.length, 1, 'one artifact for the shard set; duplicates dropped');
    const [artifact] = collection.artifacts;
    assert.strictEqual(artifact.parameter_count_b, 8.191, 'safetensors header gives exact parameters');
    assert.strictEqual(artifact.precision, 'BF16', 'dominant dtype gives the precision');
    assert.strictEqual(artifact.context_length, 40960);
    assert.strictEqual(artifact.size_bytes, 16.5e9, 'shard sizes are summed');
    assert.deepStrictEqual(artifact.metadata.shard_files, [
        'model-00001-of-00003.safetensors', 'model-00002-of-00003.safetensors', 'model-00003-of-00003.safetensors'
    ]);
    assert.strictEqual(artifact.install_command, 'hf download Qwen/Qwen3-8B', 'Transformers needs the whole repo');
    assert.strictEqual(collection.repos[0].metadata.base_model, 'Qwen/Qwen3-8B-Base');
    assert.strictEqual(collection.repos[0].metadata.official_publisher, true);
    assert.strictEqual(collection.repos[0].metadata.cardData, undefined, 'model cards are not stored');

    const [row] = groupWeightShards([{ ...artifact, size_gb: artifact.size_gb }]);
    const selectorModel = artifactToSelectorModel({ ...row, repo_metadata: collection.repos[0].metadata });
    assert.ok(selectorModel.sizeGB > 15.3 && selectorModel.sizeGB < 15.4, 'an ingested shard set supplies an observed size');
    assert.strictEqual(selectorModel.artifact.shard_files.length, 3);
}

function testGgufRepository() {
    const collection = normalizeHuggingFaceModel({
        id: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
        pipeline_tag: 'text-generation',
        tags: ['gguf', 'base_model:quantized:Qwen/Qwen3-Coder-30B-A3B-Instruct'],
        gguf: { total: 30532122624, architecture: 'qwen3moe', context_length: 262144 },
        siblings: [
            { rfilename: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf', size: 18556685856 },
            { rfilename: 'BF16/Qwen3-Coder-30B-A3B-Instruct-BF16-00001-of-00002.gguf', size: 49655154016 },
            { rfilename: 'BF16/Qwen3-Coder-30B-A3B-Instruct-BF16-00002-of-00002.gguf', size: 11440652032 },
            { rfilename: 'Q8_0/Qwen3-Coder-30B-A3B-Instruct-Q8_0-00001-of-00002.gguf', size: 1 },
            { rfilename: 'mmproj-F16.gguf', size: 900000000 },
            { rfilename: 'imatrix_unsloth.gguf', size: 1000000 }
        ]
    });
    const names = collection.artifacts.map((artifact) => artifact.artifact_name);
    assert.deepStrictEqual(names.sort(), [
        'BF16/Qwen3-Coder-30B-A3B-Instruct-BF16-00001-of-00002.gguf',
        'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf'
    ], 'incomplete shard sets, projectors and importance matrices are not artifacts');
    const q4 = collection.artifacts.find((artifact) => artifact.quantization === 'Q4_K_M');
    assert.strictEqual(q4.context_length, 262144, 'GGUF header context window');
    assert.strictEqual(q4.parameter_count_b, 30.532, 'GGUF header parameter count');
    const bf16 = collection.artifacts.find((artifact) => artifact.precision === 'BF16');
    assert.strictEqual(bf16.install_command,
        'hf download unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF --include "BF16/Qwen3-Coder-30B-A3B-Instruct-BF16-*-of-00002.gguf"');
    assert.ok(collection.repos[0].modalities.includes('vision'), 'a vision projector marks the repo multimodal');
    assert.strictEqual(collection.repos[0].metadata.gguf_architecture, 'qwen3moe');
}

function testZeroBasedShardsAndFloatFormats() {
    const collection = normalizeHuggingFaceModel({
        id: 'openai/gpt-oss-20b',
        pipeline_tag: 'text-generation',
        tags: ['transformers', 'safetensors', 'gpt_oss', '8-bit', 'mxfp4'],
        safetensors: { parameters: { BF16: 1.8e9, U8: 19.1e9 }, total: 20.9e9 },
        siblings: [0, 1, 2].map((index) => ({ rfilename: `model-0000${index}-of-00002.safetensors`, size: 4e9 }))
            .concat([{ rfilename: 'metal/model.bin', size: 13e9 }])
    });
    assert.strictEqual(collection.artifacts.length, 1, 'shards numbered from zero form one set; metal/ is skipped');
    assert.strictEqual(collection.artifacts[0].precision, 'FP4');
    assert.strictEqual(collection.artifacts[0].quantization, '', 'an 8-bit tag is not an INT8 quantization of an FP4 model');
    assert.strictEqual(collection.artifacts[0].metadata.quant_method, 'mxfp4');
}

function testFileSizesAndParameterCountsAgree() {
    const collection = normalizeHuggingFaceModel({
        id: 'cortexso/deepseek-r1',
        pipeline_tag: 'text-generation',
        tags: ['gguf'],
        gguf: { total: 70554000000, architecture: 'llama' },
        siblings: [
            { rfilename: 'deepseek-r1-distill-llama-8b-q4_k_m.gguf', size: 4.92e9 },
            { rfilename: 'deepseek-r1-distill-llama-70b-q4_k_m.gguf', size: 42.5e9 },
            { rfilename: 'unnamed-q4_k_m.gguf', size: 4.92e9 },
            { rfilename: 'mtp-deepseek-r1-q4_k_m.gguf', size: 1e9 },
            { rfilename: 'deepseek-r1.lora.gguf', size: 1e8 }
        ]
    });
    const byName = Object.fromEntries(collection.artifacts.map((artifact) => [artifact.artifact_name, artifact]));
    assert.strictEqual(byName['deepseek-r1-distill-llama-8b-q4_k_m.gguf'].parameter_count_b, 8,
        'the file name, not the largest model in the repo, gives the size');
    assert.strictEqual(byName['deepseek-r1-distill-llama-70b-q4_k_m.gguf'].parameter_count_b, 70.554,
        'an agreeing header count is kept');
    assert.ok(!byName['unnamed-q4_k_m.gguf'], '4.9 GB cannot hold 70B parameters at Q4');
    assert.ok(!byName['mtp-deepseek-r1-q4_k_m.gguf'], 'speculative-decoding heads are not models');
    assert.ok(!byName['deepseek-r1.lora.gguf'], 'LoRA adapters in GGUF are not models');

    const qwen = normalizeHuggingFaceModel({
        id: 'Qwen/Qwen2-1.5B-Instruct-GGUF',
        pipeline_tag: 'text-generation',
        gguf: { total: 1543714304 },
        siblings: [{ rfilename: 'qwen2-1_5b-instruct-q4_k_m.gguf', size: 986048768 }]
    });
    assert.strictEqual(qwen.artifacts[0].parameter_count_b, 1.544, '"1_5b" is 1.5B, not 5B');
}

function testRepositoriesWithoutPipelineTag() {
    assert.strictEqual(isSupportedHuggingFaceModel({
        id: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
        library_name: 'vllm',
        tags: ['vllm', 'safetensors', 'mistral3', 'mistral-common']
    }), true, 'official Mistral releases have no pipeline tag');
    assert.strictEqual(isSupportedHuggingFaceModel({
        id: 'mistralai/Voxtral-Mini-3B-2507',
        library_name: 'mistral-common',
        tags: ['mistral-common', 'automatic-speech-recognition']
    }), false, 'speech models stay excluded');
    assert.strictEqual(isSupportedHuggingFaceModel({ id: 'org/unknown-7B', tags: ['safetensors'] }), false);
}

function testBoundedTaskPatterns() {
    assert.ok(!inferModalities({ id: 'openai/gpt-oss-20b', tags: ['vllm'] }).includes('vision'), '`vllm` is not a vision tag');
    assert.ok(inferModalities({ id: 'Qwen/Qwen2.5-VL-7B-Instruct' }).includes('vision'));
    assert.ok(inferModalities({ id: 'org/model', pipeline_tag: 'image-text-to-text' }).includes('vision'));
    assert.ok(!inferTasks({ id: 'google/t5-encoder-large' }).includes('coding'), '`encoder` is not coding');
    assert.ok(inferTasks({ id: 'Qwen/Qwen2.5-Coder-7B-Instruct' }).includes('coding'));
    assert.ok(inferTasks({ id: 'infly/OpenCoder-8B-Instruct' }).includes('coding'));
    assert.ok(!inferTasks({ id: 'org/encoder-decoder-base' }).includes('coding'));
    assert.ok(!inferTasks({ id: 'nomic-ai/gpt4all-j' }).includes('embeddings'), 'a nomic-ai repo is not an embedding model');
    assert.ok(inferTasks({ id: 'intfloat/multilingual-e5-large' }).includes('embeddings'));
}

function testConfigSummary() {
    const summary = summarizeModelConfig({
        model_type: 'mistral3',
        torch_dtype: 'bfloat16',
        vision_config: { hidden_size: 1024 },
        text_config: { max_position_embeddings: 131072, num_local_experts: 8, num_experts_per_tok: 2 },
        quantization_config: { quant_method: 'AWQ', bits: 4 }
    });
    assert.deepStrictEqual(summary, {
        context_length: 131072,
        model_type: 'mistral3',
        torch_dtype: 'bf16',
        quant_method: 'awq',
        bits: 4,
        has_vision: true,
        num_experts: 8,
        experts_per_token: 2
    });
}

async function testEnrichmentAndRateLimit() {
    const sleeps = [];
    let treeCalls = 0;
    const ingestor = new RegistryIngestor({
        database: {},
        huggingFaceToken: 'hf_test',
        sleep: async (ms) => { sleeps.push(ms); },
        fetchImpl: async (url, init) => {
            assert.strictEqual(init.headers.Authorization, 'Bearer hf_test');
            const { pathname, searchParams } = new URL(url);
            if (pathname === '/api/models' && searchParams.get('pipeline_tag') === 'text-generation') {
                return jsonResponse([{
                    id: 'mistralai/Mistral-Small-3.1-24B-Instruct-2503',
                    sha: 'rev1',
                    library_name: 'vllm',
                    tags: ['vllm', 'mistral-common'],
                    siblings: [{ rfilename: 'config.json' }, { rfilename: 'model.safetensors' }]
                }]);
            }
            if (pathname === '/api/models') return jsonResponse([]);
            if (pathname.includes('/tree/')) {
                treeCalls += 1;
                if (treeCalls === 1) {
                    return jsonResponse({ error: 'rate limited' }, {
                        status: 429,
                        headers: { RateLimit: '"api";r=0;t=7' }
                    });
                }
                return jsonResponse([{ type: 'file', path: 'model.safetensors', size: 48e9, lfs: { oid: 'b'.repeat(64), size: 48e9 } }]);
            }
            if (pathname.endsWith('/resolve/rev1/config.json')) {
                return jsonResponse({ max_position_embeddings: 131072, vision_config: {} });
            }
            throw new Error(`unexpected request ${url}`);
        }
    });
    const [collection] = await ingestor.collectHuggingFace({ limit: 10, fileSizes: true, configs: true });
    const [artifact] = collection.artifacts;
    assert.deepStrictEqual(sleeps, [7000], 'waits for the advertised rate-limit window');
    assert.strictEqual(artifact.size_bytes, 48e9, 'tree size merged');
    assert.strictEqual(artifact.sha256, 'b'.repeat(64), 'LFS oid is the SHA-256');
    assert.strictEqual(artifact.context_length, 131072, 'config.json context window');
    assert.ok(artifact.modalities.includes('vision'), 'a vision tower in config.json marks a VLM');
}

async function run() {
    await testListingPlanAndPublishers();
    testExactMetadataAndLineage();
    testGgufRepository();
    testZeroBasedShardsAndFloatFormats();
    testFileSizesAndParameterCountsAgree();
    testRepositoriesWithoutPipelineTag();
    testBoundedTaskPatterns();
    testConfigSummary();
    await testEnrichmentAndRateLimit();
    console.log('registry-hf-metadata.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('registry-hf-metadata.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
