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
    assert.strictEqual(normalizeRuntime('unknown-runtime'), 'ollama');

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
