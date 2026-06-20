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

async function run() {
    testMoEParamParsing();
    testContextTokenNotMisreadAsParams();
    testRecommenderMoEParsing();
    testGpt4AllTrailingSlashName();
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
