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

function testQuantizationsOfOneBaseCollapse() {
    const { artifactToSelectorModel } = require('../src/data/registry-recommender');
    const quantized = (repo) => artifactToSelectorModel({
        source_id: 'huggingface', repo_id: repo, canonical_model_id: repo, artifact_name: 'model-Q4_K_M.gguf',
        format: 'gguf', parameter_count_b: 7.6, tasks: ['text-generation'],
        repo_metadata: { pipeline_tag: 'text-generation', base_model: 'Qwen/Qwen2.5-Coder-7B-Instruct', base_relation: 'quantized' }
    });
    const bartowski = quantized('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF');
    const unsloth = quantized('unsloth/Qwen2.5-Coder-7B-Instruct-GGUF');
    assert.strictEqual(modelDiversityKey({ meta: bartowski }), modelDiversityKey({ meta: unsloth }),
        'two publishers of one quantized base are one model');
    const out = collapseToDistinctModels([
        { score: 80, meta: bartowski }, { score: 79, meta: unsloth }, cand('codellama', 'ollama', 70)
    ]);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].meta, bartowski, 'the better-scoring publisher is kept');
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

function testDiversityKeepsGenuineTopUnderRareSourceFlood() {
    // 3 strong ollama models + 9 distinct rare sources all within the margin.
    // Diversity must NOT drop both runners-up to seed obscure sources.
    const distinct = [
        cand('o0', 'ollama', 100),
        cand('o1', 'ollama', 99),
        cand('o2', 'ollama', 98)
    ];
    for (let i = 0; i < 9; i++) distinct.push(cand('r' + i, 'src' + i, 86));
    const out = applySourceDiversity(distinct, 3);
    const names = out.map((c) => c.meta.name);
    assert.strictEqual(out.length, 3, 'returns exactly the limit');
    assert.ok(names.includes('o0') && names.includes('o1'), 'genuine top-2 ollama picks are preserved');
    const rareCount = out.filter((c) => c.meta.source.startsWith('src')).length;
    assert.ok(rareCount <= 1, `at most one diversity seed, got ${rareCount}`);
}

function testCollapseKeepsDistinctUnknownParamModels() {
    // Two genuinely different models with no params must NOT collapse to one.
    const out = collapseToDistinctModels([
        { score: 90, meta: { name: 'some-embed', paramsB: null, source: 'ollama', model_identifier: 'some-embed:a' } },
        { score: 85, meta: { name: 'some-embed', paramsB: 0, source: 'huggingface', model_identifier: 'org/some-embed' } }
    ]);
    assert.strictEqual(out.length, 2, 'distinct unknown-param models stay distinct (no "na" collision)');
}

function run() {
    testCollapseVariants();
    testDiversityKeyIgnoresTagAndQuant();
    testQuantizationsOfOneBaseCollapse();
    testSourceDiversitySurfacesCloseSource();
    testDiversityDoesNotPromoteFarBehindSource();
    testDiversityKeepsGenuineTopUnderRareSourceFlood();
    testCollapseKeepsDistinctUnknownParamModels();
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
