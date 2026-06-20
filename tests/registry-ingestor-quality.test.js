/**
 * Registry ingestor data-quality test
 * ===================================
 *   - LoRA/PEFT adapters and optimizer/training files are NOT ingested as models;
 *     Mistral-style consolidated weights ARE.
 *   - F16/FP16/BF16 are precisions, not quantizations.
 *   - GPT4All comma-formatted sizes parse, and an HF-backed download adopts the HF
 *     repo id as the canonical model id (cross-source alignment).
 */

const assert = require('assert');
const {
    isModelArtifactFile,
    inferQuantization,
    normalizeGpt4AllEntry
} = require('../src/data/registry-ingestors');

function testArtifactFileFiltering() {
    // Real model weights -> included
    assert.strictEqual(isModelArtifactFile('model-00001-of-00005.safetensors'), true, 'shard is a model file');
    assert.strictEqual(isModelArtifactFile('model.gguf'), true);
    assert.strictEqual(isModelArtifactFile('pytorch_model.bin'), true);
    assert.strictEqual(isModelArtifactFile('consolidated.00.pth'), true, 'consolidated weights must be kept');
    // Non-model files -> excluded
    assert.strictEqual(isModelArtifactFile('adapter_model.safetensors'), false, 'LoRA adapter is NOT a model');
    assert.strictEqual(isModelArtifactFile('adapter_config.json'), false);
    assert.strictEqual(isModelArtifactFile('optimizer.pt'), false, 'optimizer state is not a model');
    assert.strictEqual(isModelArtifactFile('training_args.bin'), false);
    assert.strictEqual(isModelArtifactFile('tokenizer.json'), false);
}

function testPrecisionNotTreatedAsQuantization() {
    assert.strictEqual(inferQuantization('model-bf16.safetensors'), '', 'bf16 is a precision, not a quant');
    assert.strictEqual(inferQuantization('model-fp16.safetensors'), '', 'fp16 is a precision, not a quant');
    assert.strictEqual(inferQuantization('model-Q4_K_M.gguf'), 'Q4_K_M', 'real quant still detected');
    assert.strictEqual(inferQuantization('model-Q8_0.gguf'), 'Q8_0');
}

function testGpt4AllCommaSizeParses() {
    const entry = normalizeGpt4AllEntry({
        name: 'orca-mini-3b.gguf',
        url: 'https://gpt4all.io/models/gguf/orca-mini-3b.gguf',
        filesize: '8,000,000,000'
    });
    assert.ok(entry, 'entry maps');
    const size = entry.artifacts[0].size_gb;
    assert.ok(size && size > 7 && size < 9, `comma size must parse to ~8GB, got ${size}`);
}

function testGpt4AllCanonicalFromHfRepo() {
    const entry = normalizeGpt4AllEntry({
        name: 'Mistral Instruct',
        url: 'https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.1-GGUF/resolve/main/mistral-7b-instruct-v0.1.Q4_0.gguf'
    });
    assert.ok(entry, 'entry maps');
    assert.strictEqual(
        entry.artifacts[0].canonical_model_id,
        'TheBloke/Mistral-7B-Instruct-v0.1-GGUF',
        'HF-backed GPT4All entry adopts the HF repo id as canonical model id'
    );
}

function run() {
    testArtifactFileFiltering();
    testPrecisionNotTreatedAsQuantization();
    testGpt4AllCommaSizeParses();
    testGpt4AllCanonicalFromHfRepo();
    console.log('registry-ingestor-quality.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('registry-ingestor-quality.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
