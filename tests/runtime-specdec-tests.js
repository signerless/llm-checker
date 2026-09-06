const assert = require('assert');
const {
    normalizeRuntime,
    getRuntimeCommandSet,
    runtimeSupportedOnHardware
} = require('../src/runtime/runtime-support');
const SpeculativeDecodingEstimator = require('../src/models/speculative-decoding-estimator');

function runRuntimeCommandTests() {
    const model = {
        name: 'Qwen 2.5 7B',
        model_identifier: 'qwen2.5:7b',
        ollamaTag: 'qwen2.5:7b'
    };

    assert.strictEqual(normalizeRuntime('VLLM'), 'vllm');
    assert.strictEqual(normalizeRuntime('mlx'), 'mlx');
    assert.strictEqual(normalizeRuntime('unknown-runtime'), null);
    assert.strictEqual(normalizeRuntime('auto'), 'auto');
    assert.strictEqual(normalizeRuntime('llama.cpp'), 'llama.cpp');
    assert.strictEqual(normalizeRuntime('HF'), 'transformers');
    assert.strictEqual(runtimeSupportedOnHardware('typo'), false);
    const invalid = getRuntimeCommandSet(model, 'unknown-runtime');
    assert.strictEqual(invalid.runtime, null);
    assert.strictEqual(invalid.pull, null);
    assert.strictEqual(invalid.run, null);

    const gguf = { hfId: 'ggml-org/models', filename: 'tinyllamas/stories260K.gguf' };
    const cpp = getRuntimeCommandSet(gguf, 'llama.cpp');
    assert.ok(cpp.install.includes('llama.cpp'));
    assert.ok(cpp.pull.includes('curl --fail --location'));
    assert.ok(cpp.pull.includes('/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf'));
    assert.ok(cpp.run.includes("llama-cli --model './stories260K.gguf'"));
    assert.deepStrictEqual(getRuntimeCommandSet(gguf, 'auto'), cpp);
    assert.strictEqual(getRuntimeCommandSet(model, 'llama.cpp').run, null, 'an Ollama tag is not a GGUF file');
    const transformers = getRuntimeCommandSet({ hfId: 'HuggingFaceTB/SmolLM2-135M' }, 'transformers');
    assert.ok(transformers.install.includes('transformers torch'));
    assert.ok(transformers.pull.includes("hf download 'HuggingFaceTB/SmolLM2-135M'"));
    assert.ok(transformers.run.includes('from transformers import pipeline'));
    assert.strictEqual(getRuntimeCommandSet({ hfId: 'HuggingFaceTB/SmolLM2-135M' }, 'auto').runtime, 'transformers');
    assert.strictEqual(getRuntimeCommandSet(model, 'auto').runtime, 'ollama');
    const { spawnSync } = require('child_process');
    const path = require('path');
    const invalidCli = spawnSync(process.execPath, [path.join(__dirname, '../bin/enhanced_cli.js'),
        'check', '--simulate', 'rtx4090', '--runtime', 'unknown-runtime', '--no-verbose'], { encoding: 'utf8' });
    assert.notStrictEqual(invalidCli.status, 0);
    assert.match(invalidCli.stdout + invalidCli.stderr, /Invalid --runtime/);
    assert.doesNotMatch(invalidCli.stdout + invalidCli.stderr, /Falling back to Ollama/);

    const ollamaCmds = getRuntimeCommandSet(model, 'ollama');
    assert.ok(ollamaCmds.pull.includes('ollama pull'));
    assert.ok(ollamaCmds.run.includes('ollama run'));

    const vllmCmds = getRuntimeCommandSet(model, 'vllm');
    assert.ok(vllmCmds.install.includes('vllm'));
    assert.ok(vllmCmds.run.includes('vllm.entrypoints.openai.api_server'));

    const mlxCmds = getRuntimeCommandSet(model, 'mlx');
    assert.ok(mlxCmds.install.includes('mlx-lm'));
    assert.ok(mlxCmds.run.includes('mlx_lm.generate'));

    const appleHardware = { os: { platform: 'darwin' }, cpu: { architecture: 'Apple Silicon' } };
    const linuxHardware = { os: { platform: 'linux' }, cpu: { architecture: 'x86_64' } };
    const linuxArmHardware = { os: { platform: 'linux' }, cpu: { architecture: 'arm64' } };
    assert.strictEqual(runtimeSupportedOnHardware('mlx', appleHardware), true);
    assert.strictEqual(runtimeSupportedOnHardware('mlx', linuxHardware), false);
    assert.strictEqual(runtimeSupportedOnHardware('mlx', linuxArmHardware), false);
}

function runSpeculativeDecodingTests() {
    const estimator = new SpeculativeDecodingEstimator();
    const target = { name: 'Llama 3.1 70B', params_b: 70, model_identifier: 'llama3.1:70b' };
    const draft = { name: 'Llama 3.1 8B', params_b: 8, model_identifier: 'llama3.1:8b' };
    const unrelated = { name: 'Mistral 7B', params_b: 7, model_identifier: 'mistral:7b' };

    const estimate = estimator.estimate({
        model: target,
        candidates: [target, draft, unrelated],
        runtime: 'vllm',
        hardware: { cpu: { architecture: 'x86_64' } }
    });

    assert.ok(estimate);
    assert.strictEqual(estimate.enabled, true);
    assert.strictEqual(estimate.runtime, 'vllm');
    assert.ok(estimate.estimatedSpeedup > 1);
    assert.ok(estimate.estimatedThroughputGainPct > 0);
    assert.ok(String(estimate.draftModel).toLowerCase().includes('llama'));

    const ollamaEstimate = estimator.estimate({
        model: target,
        candidates: [draft],
        runtime: 'ollama'
    });
    assert.strictEqual(ollamaEstimate, null);
}

function runAll() {
    runRuntimeCommandTests();
    runSpeculativeDecodingTests();
    console.log('runtime-specdec-tests: OK');
}

if (require.main === module) {
    runAll();
}

module.exports = { runAll };
