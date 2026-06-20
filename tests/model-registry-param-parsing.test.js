/**
 * Registry param-parsing + filter-escaping regression test (PR #99 review fixes)
 * ============================================================================
 * Covers the fixes applied during review:
 *   - MoE "NxMB" naming (Mixtral 8x7B) must size as experts * per-expert, not 7B.
 *   - Context-length tokens like "128k" must NOT be misread as ~0B params.
 *   - GPT4All entries whose name comes from a trailing-slash URL must not drop.
 *   - The runtime LIKE filter must escape `_`/`%` so it can't over-match.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseParamsB, normalizeGpt4AllEntry } = require('../src/data/registry-ingestors');
const { artifactToSelectorModel } = require('../src/data/registry-recommender');
const ModelDatabase = require('../src/data/model-database');

function testMoEParamParsing() {
    // Total memory footprint of an MoE = experts * per-expert (all experts resident).
    assert.strictEqual(parseParamsB('Mixtral-8x7B'), 56, '8x7B -> 8*7 = 56B total, not 7B');
    assert.strictEqual(parseParamsB('mixtral:8x22b'), 176, '8x22B -> 176B total');
    assert.ok(parseParamsB('Mixtral-8x7B') > 40, 'MoE total must be far above a single expert');

    // Non-MoE parsing is unchanged.
    assert.strictEqual(parseParamsB('Llama-3.1-8B'), 8, 'dense 8B unchanged');
    assert.strictEqual(parseParamsB('Qwen3-235B-A22B'), 235, 'dense total still parsed from 235B');
}

function testContextTokenNotMisreadAsParams() {
    // "128k" is a context length, not 0.000128B -> must not round to 0, must be null.
    assert.strictEqual(parseParamsB('model-128k-context'), null, '128k must not parse as params');
    assert.strictEqual(parseParamsB('qwen2.5-32k'), null, '32k must not parse as params');
    // A real param value elsewhere in the argument list still wins.
    assert.strictEqual(parseParamsB('128k-context', 'Qwen2.5-7B'), 7, 'real param still resolved');
}

function testRecommenderMoEParsing() {
    const model = artifactToSelectorModel({
        source_id: 'huggingface',
        source_name: 'Hugging Face Hub',
        repo_id: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
        canonical_model_id: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
        artifact_name: 'Mixtral-8x7B-Instruct-v0.1',
        size_gb: 26
    });
    assert.ok(model, 'MoE artifact should map to a selector model');
    assert.strictEqual(model.paramsB, 56, 'recommender should size 8x7B as 56B total');
    assert.strictEqual(model.isMoE, true, '8x7B should be flagged MoE');
    assert.strictEqual(model.totalParamsB, 56, 'totalParamsB carries the full MoE total');
}

function testRecommenderActiveParamTotalSizing() {
    // "397B-A17B" = 397B total / 17B active. Memory must be sized by the TOTAL.
    const model = artifactToSelectorModel({
        source_id: 'huggingface',
        repo_id: 'Qwen/Qwen3-397B-A17B',
        canonical_model_id: 'Qwen/Qwen3-397B-A17B',
        artifact_name: 'Qwen3-397B-A17B'
    });
    assert.ok(model, 'active-param MoE should map');
    assert.strictEqual(model.paramsB, 397, 'sizing param must be the 397B total, not the 17B active');
    assert.strictEqual(model.totalParamsB, 397, 'totalParamsB = 397');
    assert.strictEqual(model.isMoE, true, 'flagged MoE');
    // activeParamsB must NOT be set on the model: setting it would switch the
    // selector to sparse-inference memory and let a 397B model falsely "fit".
    assert.strictEqual(model.activeParamsB, undefined, 'activeParamsB must not drive memory sizing');

    // The critical guard: even when a STALE DB stored the active count (17) in
    // parameter_count_b, the name re-derivation must still size it as 397B.
    const stale = artifactToSelectorModel({
        source_id: 'huggingface',
        repo_id: 'Qwen/Qwen3-397B-A17B',
        canonical_model_id: 'Qwen/Qwen3-397B-A17B',
        artifact_name: 'Qwen3-397B-A17B',
        parameter_count_b: 17
    });
    assert.strictEqual(stale.paramsB, 397, 'stale active-param DB value must not shrink the model');
}

function testHugeMoEDoesNotFitSmallHardware() {
    // End-to-end memory guard: a 397B MoE must NOT be reported as fitting a 24GB Mac.
    const DeterministicModelSelector = require('../src/models/deterministic-selector');
    const selector = new DeterministicModelSelector();
    const model = artifactToSelectorModel({
        source_id: 'huggingface',
        repo_id: 'Qwen/Qwen3-397B-A17B',
        canonical_model_id: 'Qwen/Qwen3-397B-A17B',
        artifact_name: 'Qwen3-397B-A17B',
        parameter_count_b: 17,
        runtime_support: ['vllm']
    });
    const breakdown = selector.estimateMemoryBreakdown(model, 'Q4_K_M', 8192);
    // 397B at Q4 is hundreds of GB; it must be far above a 24GB budget.
    assert.ok(breakdown.requiredGB > 100,
        `397B MoE should require >100GB, got ${breakdown.requiredGB.toFixed(1)}GB (memory must use total params)`);
}

function testGpt4AllTrailingSlashName() {
    // Name must be recovered from the last non-empty URL segment, not dropped.
    const entry = normalizeGpt4AllEntry({ url: 'https://host/models/orca-mini-3b.gguf/' });
    assert.ok(entry, 'GPT4All entry whose name comes from a trailing-slash URL must not be dropped');
    assert.strictEqual(entry.repos[0].display_name, 'orca-mini-3b.gguf', 'name = last non-empty segment');
}

async function testRuntimeLikeEscape() {
    // Hermetic DB: no packaged seed copy, no registry snapshot import.
    const tmpDb = path.join(os.tmpdir(), `llmchk-like-${process.pid}-${Date.now()}.db`);
    const db = new ModelDatabase({
        dbPath: tmpDb,
        seedDbPath: path.join(os.tmpdir(), 'llmchk-no-such-seed.db'),
        disableRegistrySeedImport: true
    });
    try {
        await db.initialize();
        // searchModelArtifacts INNER-JOINs registry_sources + registry_repos,
        // so seed those before the artifact.
        db.upsertRegistrySource({ id: 'huggingface', name: 'Hugging Face Hub' });
        db.upsertRegistryRepo({ id: 'hf:repo', source_id: 'huggingface', repo_id: 'repo', display_name: 'repo' });
        db.upsertModelArtifact({
            id: 'hf|repo|art',
            source_id: 'huggingface',
            repo_key: 'hf:repo',
            repo_id: 'repo',
            artifact_name: 'art',
            filename: 'art.gguf',
            format: 'gguf',
            quantization: 'Q4_K_M',
            parameter_count_b: 7,
            size_gb: 4,
            runtime_support: ['llama.cpp'],
            downloads: 10
        });

        const exact = db.searchModelArtifacts('', { runtime: 'llama.cpp', localOnly: false, limit: 10 });
        const wildcard = db.searchModelArtifacts('', { runtime: 'lla_a.cpp', localOnly: false, limit: 10 });

        assert.strictEqual(exact.length, 1, 'exact runtime should match');
        assert.strictEqual(wildcard.length, 0, 'underscore must be escaped, not treated as a LIKE wildcard');
    } finally {
        db.close();
        try { fs.unlinkSync(tmpDb); } catch (_) { /* ignore */ }
    }
}

function testShardedFileSizeNotUsedAsModelSize() {
    // A single shard's size must NOT stand in for the whole model: a 56B model
    // whose shard is 4.66GB must be sized from params, not "fit" as 4.66GB.
    const model = artifactToSelectorModel({
        source_id: 'huggingface',
        repo_id: 'org/Big-56B',
        canonical_model_id: 'org/Big-56B',
        artifact_name: 'model-00001-of-00012.safetensors',
        filename: 'model-00001-of-00012.safetensors',
        parameter_count_b: 56,
        size_gb: 4.66
    });
    assert.ok(model, 'sharded artifact still maps');
    assert.strictEqual(model.paramsB, 56, 'keeps the full param count');
    assert.strictEqual(model.sizeGB, undefined, 'per-shard size must not become the model size');
    assert.deepStrictEqual(model.sizeByQuant, {}, 'no observed size from a shard');
}

async function run() {
    testMoEParamParsing();
    testContextTokenNotMisreadAsParams();
    testRecommenderMoEParsing();
    testRecommenderActiveParamTotalSizing();
    testHugeMoEDoesNotFitSmallHardware();
    testGpt4AllTrailingSlashName();
    testShardedFileSizeNotUsedAsModelSize();
    await testRuntimeLikeEscape();
    console.log('model-registry-param-parsing.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('model-registry-param-parsing.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
