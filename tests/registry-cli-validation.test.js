/**
 * Registry CLI validation + empty-pool guard test
 * ===============================================
 *   - registry-search / registry-recommend reject invalid enum options with a
 *     clear error (exit 1 / JSON {error}) instead of silently returning "no
 *     results" or falling back to the built-in catalog.
 *   - When no registry artifacts match the filters, selectCategory returns an
 *     empty result rather than letting the deterministic selector substitute its
 *     internal catalog (which would mislabel non-registry rows as "registry").
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const { RegistryRecommender } = require('../src/data/registry-recommender');

const CLI = path.join(__dirname, '..', 'bin', 'enhanced_cli.js');

function runCli(args) {
    const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function testInvalidSourceRejected() {
    const { status, stdout } = runCli(['registry-search', 'llama', '--source', 'bogus', '--json']);
    assert.strictEqual(status, 1, 'invalid --source must exit non-zero');
    const payload = JSON.parse(stdout);
    assert.ok(/Invalid --source/.test(payload.error), 'must report an invalid-source error');
}

function testInvalidRuntimeRejected() {
    const { status, stdout } = runCli(['registry-recommend', '--runtime', 'garbage', '--json']);
    assert.strictEqual(status, 1, 'invalid --runtime must exit non-zero');
    const payload = JSON.parse(stdout);
    assert.ok(/Invalid --runtime/.test(payload.error), 'must report an invalid-runtime error');
}

function testValidSourceAccepted() {
    const { status, stdout } = runCli(['registry-search', 'bert', '--source', 'huggingface', '--json', '--limit', '1']);
    assert.strictEqual(status, 0, 'valid --source must exit 0');
    const payload = JSON.parse(stdout);
    assert.ok(!('error' in payload), 'valid filters must not produce an error');
}

async function testEmptyPoolDoesNotFallBackToInternalCatalog() {
    // Fake DB that matches zero artifacts; fake selector whose selectModels MUST
    // NOT be called (calling it would load the built-in catalog).
    const fakeDatabase = {
        async initialize() {},
        searchModelArtifacts() { return []; },
        getRegistryStats() { return { sources: 0, repos: 0, artifacts: 0 }; },
        close() {}
    };
    const fakeSelector = {
        normalizeOptimizationObjective(v) { return v || 'balanced'; },
        async selectModels() { throw new Error('selectModels must not run when the registry pool is empty'); }
    };
    const rec = new RegistryRecommender({ database: fakeDatabase, selector: fakeSelector });
    await rec.initialize();
    const out = await rec.recommend({ category: 'coding', runtime: 'mlx' });
    assert.strictEqual(out.total_artifacts, 0, 'no artifacts matched');
    assert.deepStrictEqual(out.recommendations, [], 'empty pool yields no recommendations (not internal-catalog rows)');
}

async function run() {
    testInvalidSourceRejected();
    testInvalidRuntimeRejected();
    testValidSourceAccepted();
    await testEmptyPoolDoesNotFallBackToInternalCatalog();
    console.log('registry-cli-validation.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('registry-cli-validation.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
