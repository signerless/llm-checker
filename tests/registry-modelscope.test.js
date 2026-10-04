/**
 * ModelScope registry test
 * ========================
 *   - Listings are read per language task by downloads; each repo's files and
 *     config.json give exact sizes, hashes and context windows.
 *   - Artifacts keep Hugging Face's normalisation (shard sets, exclusions) but
 *     download from ModelScope with `modelscope download` commands.
 */

const assert = require('assert');
const { RegistryIngestor } = require('../src/data/registry-ingestors');
const { artifactToSelectorModel, groupWeightShards } = require('../src/data/registry-recommender');
const { getRuntimeCommandSet } = require('../src/runtime/runtime-support');

function response(body) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

async function run() {
    const requested = [];
    const ingestor = new RegistryIngestor({
        database: {},
        fetchImpl: async (url) => {
            requested.push(url);
            const { searchParams, pathname } = new URL(url);
            if (pathname === '/openapi/v1/models') {
                const page = Number(searchParams.get('page_number'));
                if (searchParams.get('filter.task') !== 'text-generation' || page > 1) return response({ data: { models: [] } });
                return response({ data: { models: [{
                    id: 'Qwen/Qwen3-8B', downloads: 7764112, likes: 10, license: 'apache-2.0', params: 8190735360,
                    tasks: ['text-generation'], tags: ['library:transformers', 'model_type:qwen3']
                }, {
                    id: 'someone/chunk-dump', downloads: 5000, tasks: ['text-generation'], tags: []
                }] } });
            }
            if (pathname.endsWith('/repo/files')) {
                if (pathname.includes('chunk-dump')) {
                    return response({ Data: { Files: [{ Path: 'chunks/chunk-000000.safetensors', Size: 1e9 }] } });
                }
                return response({ Data: { Files: [
                    { Path: 'config.json', Size: 726 },
                    { Path: 'model-00001-of-00002.safetensors', Size: 8e9, Sha256: 'a'.repeat(64) },
                    { Path: 'model-00002-of-00002.safetensors', Size: 8.4e9, Sha256: 'b'.repeat(64) }
                ] } });
            }
            if (pathname.endsWith('/resolve/master/config.json')) {
                return response({ max_position_embeddings: 40960, torch_dtype: 'bfloat16' });
            }
            throw new Error(`unexpected ${url}`);
        }
    });

    const collections = await ingestor.collectModelScope({ limit: 10 });
    assert.ok(requested.some((url) => /sort=downloads&filter\.task=text-generation/.test(url)));
    assert.strictEqual(collections.length, 1, 'a repo of loose chunk files has no artifacts');
    const [collection] = collections;
    assert.strictEqual(collection.source.id, 'modelscope');
    assert.strictEqual(collection.repos[0].url, 'https://www.modelscope.cn/models/Qwen/Qwen3-8B');
    assert.strictEqual(collection.repos[0].license, 'apache-2.0');
    const [artifact] = collection.artifacts;
    assert.strictEqual(artifact.source_id, 'modelscope');
    assert.strictEqual(artifact.parameter_count_b, 8.191);
    assert.strictEqual(artifact.size_bytes, 16.4e9);
    assert.strictEqual(artifact.context_length, 40960, 'config.json context window');
    assert.strictEqual(artifact.install_command, 'modelscope download --model Qwen/Qwen3-8B');
    assert.strictEqual(artifact.download_url,
        'https://www.modelscope.cn/models/Qwen/Qwen3-8B/resolve/master/model-00001-of-00002.safetensors');

    const [row] = groupWeightShards([{ ...artifact, repo_url: collection.repos[0].url }]);
    const model = artifactToSelectorModel({ ...row, repo_metadata: collection.repos[0].metadata });
    assert.strictEqual(model.installCommand, 'modelscope download --model Qwen/Qwen3-8B');
    const commands = getRuntimeCommandSet(model, 'vllm');
    assert.strictEqual(commands.pull, "modelscope download --model 'Qwen/Qwen3-8B'");
    assert.ok(commands.run.startsWith('VLLM_USE_MODELSCOPE=True '), 'vLLM resolves the repo on ModelScope');
    assert.strictEqual(getRuntimeCommandSet(model, 'transformers').pull, "modelscope download --model 'Qwen/Qwen3-8B'");

    console.log('registry-modelscope.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('registry-modelscope.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
