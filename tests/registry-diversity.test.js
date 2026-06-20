/**
 * Registry recommendation diversity test
 * ======================================
 * Covers two fixes for "I only ever see Ollama in the registry recommendations":
 *   - collapseToDistinctModels: quant/shard/tag variants of one model collapse to
 *     a single best-scoring entry (no more 12 copies of qwen2.5-coder:7b).
 *   - applySourceDiversity: a source that scores close to the top (Hugging Face /
 *     GPT4All) is guaranteed a slot, but a clearly worse one is not promoted.
 */

const assert = require('assert');
const {
    collapseToDistinctModels,
    applySourceDiversity,
    modelDiversityKey
} = require('../src/data/registry-recommender');

function cand(name, source, score, paramsB = 7, runtime = source) {
    return { score, runtime, meta: { name, source, paramsB } };
}

function testCollapseVariants() {
    const input = [
        cand('qwen2.5-coder', 'ollama', 81.3),   // best variant
        cand('qwen2.5-coder', 'ollama', 80.9),
        cand('qwen2.5-coder', 'ollama', 80.8),
        cand('codellama', 'ollama', 75.0),
        cand('codellama', 'ollama', 74.0)
    ];
    const out = collapseToDistinctModels(input);
    assert.strictEqual(out.length, 2, 'two distinct models after collapse');
    assert.strictEqual(out[0].meta.name, 'qwen2.5-coder', 'highest-scoring model first');
    assert.strictEqual(out[0].score, 81.3, 'keeps the best-scoring variant');
    assert.strictEqual(out[1].meta.name, 'codellama');
}

function testDiversityKeyIgnoresTagAndQuant() {
    const a = modelDiversityKey({ meta: { name: 'qwen2.5-coder', paramsB: 7 } });
    const b = modelDiversityKey({ meta: { name: 'qwen2.5-coder:7b-instruct-q4_K_M', paramsB: 7 } });
    assert.strictEqual(a, b, 'tag/quant suffix must not split a model');
    const c = modelDiversityKey({ meta: { name: 'qwen2.5-coder', paramsB: 14 } });
    assert.notStrictEqual(a, c, 'different param sizes are different models');
}

function testSourceDiversitySurfacesCloseSource() {
    const distinct = [
        cand('qwen2.5-coder', 'ollama', 81.3),
        cand('deepseek-coder', 'ollama', 79.7),
        cand('granite-code', 'ollama', 78.1),
        cand('deepseek-ai/deepseek-coder-7b', 'huggingface', 77.8, 7, 'vllm'),
        cand('orca-mini', 'gpt4all', 50.0)
    ];
    const out = applySourceDiversity(distinct, 3);
    assert.strictEqual(out.length, 3, 'trims to the requested limit');
    const sources = out.map((c) => c.meta.source);
    assert.ok(sources.includes('huggingface'), 'HF scores within margin -> guaranteed a slot');
    assert.ok(!sources.includes('gpt4all'), 'GPT4All is below the floor -> not promoted');
    // The genuine #1 is never displaced.
    assert.strictEqual(out[0].meta.name, 'qwen2.5-coder');
}

function testDiversityDoesNotPromoteFarBehindSource() {
    const distinct = [
        cand('a', 'ollama', 90),
        cand('b', 'ollama', 88),
        cand('c', 'huggingface', 60)   // 30 points behind top -> outside the 15 margin
    ];
    const out = applySourceDiversity(distinct, 2);
    assert.deepStrictEqual(out.map((c) => c.meta.name), ['a', 'b'], 'far-behind source not forced in');
}

function run() {
    testCollapseVariants();
    testDiversityKeyIgnoresTagAndQuant();
    testSourceDiversitySurfacesCloseSource();
    testDiversityDoesNotPromoteFarBehindSource();
    console.log('registry-diversity.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('registry-diversity.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
