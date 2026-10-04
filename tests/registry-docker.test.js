/**
 * Docker Model Runner registry test
 * =================================
 *   - Docker Hub `ai/` listings are read in both name orders (anonymous reads
 *     stop at offset 100) and non-language repos are skipped.
 *   - Tags sharing a digest are one artifact; re-pushed capitalisations keep
 *     the newest push; sizes are exact and the engine follows the format.
 *   - The `docker` runtime produces pull/run commands and only runs MLX tags
 *     on Apple Silicon and vLLM tags on NVIDIA GPUs.
 */

const assert = require('assert');
const { RegistryIngestor, normalizeDockerTag } = require('../src/data/registry-ingestors');
const {
    normalizeRuntime,
    runtimeSupportedOnHardware,
    getRuntimeCommandSet
} = require('../src/runtime/runtime-support');
const { artifactToSelectorModel } = require('../src/data/registry-recommender');

function jsonResponse(body, status = 200) {
    return { ok: status === 200, status, headers: { get: () => null }, json: async () => body };
}

async function testCollectDocker() {
    const requests = [];
    const repositories = [
        { name: 'gemma3', pull_count: 900, description: 'Gemma 3' },
        { name: 'stable-diffusion', pull_count: 800 },
        { name: 'qwen3-vllm', pull_count: 100 }
    ];
    const tags = {
        gemma3: [
            { name: 'latest', full_size: 3_112_000_000, digest: 'sha256:a', last_updated: '2026-01-01' },
            { name: '4b', full_size: 3_112_000_000, digest: 'sha256:a', last_updated: '2026-01-01' },
            { name: '4b-q4_K_M', full_size: 3_112_000_000, digest: 'sha256:a', last_updated: '2026-01-01' },
            { name: '4B-Q4_K_M', full_size: 3_150_000_000, digest: 'sha256:b', last_updated: '2026-06-01' },
            { name: '4b-mlx-bf16', full_size: 9_297_000_000, digest: 'sha256:c', last_updated: '2026-01-01' },
            { name: 'broken', full_size: 0, digest: 'sha256:d' }
        ],
        'qwen3-vllm': [{ name: '8B-safetensors', full_size: 16_400_000_000, digest: 'sha256:e' }]
    };
    const ingestor = new RegistryIngestor({
        database: {},
        fetchImpl: async (url) => {
            requests.push(url);
            const tagMatch = url.match(/\/ai\/([^/]+)\/tags\?/);
            if (tagMatch) return jsonResponse({ count: tags[tagMatch[1]].length, results: tags[tagMatch[1]] });
            return jsonResponse({ count: 110, results: repositories });
        }
    });
    const collections = await ingestor.collectDocker();
    assert.ok(requests.some((url) => /ai\/\?page_size=100&ordering=name$/.test(url)));
    assert.ok(requests.some((url) => /ai\/\?page_size=100&ordering=-name$/.test(url)),
        'a namespace above 100 repos is read in both orders');
    const artifacts = collections.map((collection) => collection.artifacts[0]);
    const byName = Object.fromEntries(artifacts.map((artifact) => [artifact.artifact_name, artifact]));
    assert.ok(!artifacts.some((artifact) => artifact.repo_id === 'ai/stable-diffusion'), 'image models are skipped');
    assert.deepStrictEqual(Object.keys(byName).sort(), ['ai/gemma3:4B-Q4_K_M', 'ai/gemma3:4b-mlx-bf16', 'ai/qwen3-vllm:8B-safetensors']);
    const q4 = byName['ai/gemma3:4B-Q4_K_M'];
    assert.deepStrictEqual(q4.metadata.aliases, ['4b', 'latest'], 'the older push of the same name becomes an alias');
    assert.strictEqual(q4.size_bytes, 3_150_000_000);
    assert.strictEqual(q4.quantization, 'Q4_K_M');
    assert.strictEqual(q4.parameter_count_b, 4);
    assert.strictEqual(q4.install_command, 'docker model pull ai/gemma3:4B-Q4_K_M');
    assert.deepStrictEqual(q4.runtime_support, ['docker']);
    assert.strictEqual(byName['ai/gemma3:4b-mlx-bf16'].format, 'mlx');
    assert.strictEqual(byName['ai/gemma3:4b-mlx-bf16'].precision, 'BF16');
    assert.strictEqual(byName['ai/qwen3-vllm:8B-safetensors'].format, 'safetensors');
}

function testDockerRuntime() {
    assert.strictEqual(normalizeRuntime('docker-model-runner'), 'docker');
    const apple = { os: { platform: 'darwin' }, cpu: { architecture: 'arm64' } };
    const nvidia = { gpu: { type: 'nvidia' }, acceleration: { supports_cuda: true } };
    const cpu = { cpuOnly: true };
    assert.strictEqual(runtimeSupportedOnHardware('docker', cpu, { format: 'gguf' }), true, 'GGUF runs everywhere');
    assert.strictEqual(runtimeSupportedOnHardware('docker', nvidia, { format: 'mlx' }), false);
    assert.strictEqual(runtimeSupportedOnHardware('docker', apple, { format: 'mlx' }), true);
    assert.strictEqual(runtimeSupportedOnHardware('docker', apple, { format: 'safetensors' }), false, 'vLLM needs NVIDIA');
    assert.strictEqual(runtimeSupportedOnHardware('docker', nvidia, { format: 'safetensors' }), true);

    const collection = normalizeDockerTag(
        { name: 'qwen3', pull_count: 10 },
        { name: '8B-Q4_K_M', full_size: 5_027_784_512, digest: 'sha256:f' }
    );
    const model = artifactToSelectorModel({
        ...collection.artifacts[0],
        repo_metadata: collection.repos[0].metadata,
        source_name: 'Docker Hub AI models'
    });
    assert.strictEqual(model.preferredRuntime, 'docker');
    const commands = getRuntimeCommandSet(model, 'docker');
    assert.strictEqual(commands.displayName, 'Docker Model Runner');
    assert.strictEqual(commands.pull, "docker model pull 'ai/qwen3:8B-Q4_K_M'");
    assert.strictEqual(commands.run, "docker model run 'ai/qwen3:8B-Q4_K_M' \"Hello\"");
    assert.strictEqual(getRuntimeCommandSet({ artifact: { source_id: 'huggingface', repo_id: 'org/x' } }, 'docker').pull, null,
        'a Hugging Face repo is not a Docker Hub reference');
}

async function run() {
    await testCollectDocker();
    testDockerRuntime();
    console.log('registry-docker.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('registry-docker.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
