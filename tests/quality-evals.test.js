'use strict';

/**
 * Quality-eval ingestion and matching.
 *
 * The fragile part is name matching: a leaderboard writes
 * 'Meta-Llama-3.1-8B-Instruct' where the Ollama catalog writes 'llama3.1', and
 * attributing a 70B score to a 7B build would be fabricated data. These tests
 * pin the normalisation and the refusal cases.
 */

const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { QualityEvals, familyKey, sizeMatches, SOURCES } = require('../src/data/quality-evals');

let pass = 0;
let fail = 0;
const log = [];

function test(name, fn) {
    try {
        fn();
        pass += 1;
        log.push(`  ok   ${name}`);
    } catch (err) {
        fail += 1;
        log.push(`  FAIL ${name}\n       ${err.message}`);
    }
}

/* ---------------- family normalisation ---------------- */

test('leaderboard names reduce to the catalog family plus a size', () => {
    assert.deepStrictEqual(familyKey('Qwen2.5-Coder-32B-Instruct'), { family: 'qwen2.5-coder', paramsB: 32 });
    assert.deepStrictEqual(familyKey('Llama-3.1-70B-Instruct'), { family: 'llama3.1', paramsB: 70 });
    assert.deepStrictEqual(familyKey('Gemma-2-9B-Instruct'), { family: 'gemma2', paramsB: 9 });
});

test('the hyphen before a version digit collapses, real word boundaries do not', () => {
    // 'Llama-3.1' must become 'llama3.1' to match the catalog, while
    // 'qwen2.5-coder' and 'deepseek-coder-v2' must keep their hyphens.
    assert.strictEqual(familyKey('Llama-3.1-8B').family, 'llama3.1');
    assert.strictEqual(familyKey('Qwen2.5-Coder-7B').family, 'qwen2.5-coder');
    assert.strictEqual(familyKey('DeepSeek-Coder-V2-Instruct').family, 'deepseek-coder-v2');
});

test('a vendor prefix is stripped only when something remains after it', () => {
    // LiveBench writes 'meta-llama-3.1-8b-instruct'; the catalog says 'llama3.1'.
    assert.strictEqual(familyKey('meta-llama-3.1-8b-instruct').family, 'llama3.1');
    assert.strictEqual(familyKey('google/gemma-3-27b-it').family, 'gemma3');
    // 'deepseek' is the family itself here, not a vendor to strip away.
    assert.strictEqual(familyKey('deepseek-r1').family, 'deepseek-r1');
});

test('the HF org prefix is dropped', () => {
    assert.strictEqual(familyKey('Qwen/Qwen2.5-Coder-7B-Instruct').family, 'qwen2.5-coder');
});

test('a mixture-of-experts name multiplies out to total parameters', () => {
    assert.strictEqual(familyKey('Mixtral-8x7B-Instruct').paramsB, 56);
});

test('a name with no published size yields a null size, not a guess', () => {
    assert.strictEqual(familyKey('deepseek-r1').paramsB, null);
});

/* ---------------- size tolerance ---------------- */

test('sizes within 15% are the same checkpoint', () => {
    assert.ok(sizeMatches(7, 7));
    assert.ok(sizeMatches(6.7, 7));
    assert.ok(sizeMatches(14.7, 14));
});

test('clearly different sizes never match', () => {
    assert.ok(!sizeMatches(7, 70));
    assert.ok(!sizeMatches(3, 8));
});

test('an unknown size never matches by accident', () => {
    assert.ok(!sizeMatches(null, 7));
    assert.ok(!sizeMatches(7, null));
});

/* ---------------- source parsers ---------------- */

test('BigCodeBench yields one row per prompt mode', () => {
    const rows = SOURCES.bigcodebench.parse({
        'Qwen2.5-Coder-32B-Instruct': {
            link: 'https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct',
            'pass@1': { instruct: 49.0, complete: 58.0 },
            size: 32, act_param: 32, moe: false,
        },
    });
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every((r) => r.category === 'coding'));
    assert.deepStrictEqual(rows.map((r) => r.metric).sort(), ['bcb_complete', 'bcb_instruct']);
    assert.strictEqual(rows[0].paramsB, 32);
});

test('EvalPlus keeps the plus variants as separate metrics', () => {
    const rows = SOURCES.evalplus.parse({
        'OpenCoder-8B-Instruct': {
            'pass@1': { humaneval: 81.7, 'humaneval+': 77.4, mbpp: 82.0, 'mbpp+': 71.4 },
            size: 8.0,
        },
    });
    const metrics = rows.map((r) => r.metric).sort();
    assert.deepStrictEqual(metrics, ['humaneval', 'humaneval_plus', 'mbpp', 'mbpp_plus']);
});

test('MMMU stores val and pro apart, and drops the human baseline', () => {
    // MMMU-Pro runs 20-30 points below val; averaging them would be meaningless.
    const rows = SOURCES.mmmu.parse({
        leaderboardData: [
            { info: { name: 'Human Expert (High)', size: '-' }, validation: { overall: '88.6' } },
            { info: { name: 'Qwen2.5-VL 7B', size: '7B' }, validation: { overall: '58.0' }, pro: { overall: '38.3' } },
        ],
    });
    assert.strictEqual(rows.length, 2, 'the human baseline must be excluded');
    assert.ok(rows.every((r) => r.benchModelName === 'Qwen2.5-VL 7B'));
    assert.deepStrictEqual(rows.map((r) => r.metric).sort(), ['mmmu_pro', 'mmmu_val']);
    assert.strictEqual(rows[0].paramsB, 7);
});

test('LiveBench averages each task group into its app category', () => {
    const rows = SOURCES.livebench.parseCsv(
        'model,code_generation,code_completion,theory_of_mind,zebra_puzzle,spatial,logic_with_navigation\n'
        + 'qwen2.5-72b-instruct,50,60,30,40,20,10\n',
        '2026_06_25',
    );
    const coding = rows.find((r) => r.metric === 'livebench_coding');
    const reasoning = rows.find((r) => r.metric === 'livebench_reasoning');
    assert.strictEqual(coding.rawScore, 55);            // (50+60)/2
    assert.strictEqual(coding.category, 'coding');
    assert.strictEqual(reasoning.rawScore, 25);         // (30+40+20+10)/4
    assert.strictEqual(reasoning.category, 'reasoning');
});

test('LiveBench skips a task group with no data instead of scoring it zero', () => {
    const rows = SOURCES.livebench.parseCsv('model,code_generation\nfoo,50\n', '2026_06_25');
    assert.deepStrictEqual(rows.map((r) => r.metric), ['livebench_coding']);
});

/* ---------------- lookup against a real database ---------------- */

function seed() {
    const db = new DatabaseSync(':memory:');
    const q = new QualityEvals(db);
    db.prepare(
        'INSERT INTO quality_sources (id, display_name, data_url, independent) VALUES (?,?,?,?)'
    ).run('test', 'Test Board', 'https://example.invalid', 1);
    const ins = db.prepare(`
        INSERT INTO quality_evals
          (source_id, bench_model_name, family_key, params_b, variant_role, metric, category, raw_score, raw_scale_max)
        VALUES (?,?,?,?,?,?,?,?,?)
    `);
    // Same family at two very different sizes, plus one row with no size.
    ins.run('test', 'Qwen2.5-Coder-7B', 'qwen2.5-coder', 7, 'instruct', 'bcb_instruct', 'coding', 40.4, 100);
    ins.run('test', 'Qwen2.5-Coder-32B', 'qwen2.5-coder', 32, 'instruct', 'bcb_instruct', 'coding', 49.0, 100);
    ins.run('test', 'deepseek-r1', 'deepseek-r1', null, 'instruct', 'livebench_reasoning', 'reasoning', 88.6, 100);
    return { db, q };
}

test('lookup returns the row matching the size being scored', () => {
    const { q } = seed();
    assert.strictEqual(q.lookup('qwen2.5-coder', 7, 'coding').evals[0].score, 40.4);
    assert.strictEqual(q.lookup('qwen2.5-coder', 32, 'coding').evals[0].score, 49.0);
});

test('a size the board did publish and disagrees with is refused', () => {
    // This is the fabrication guard: a 7B build must never inherit a 32B score.
    const { q } = seed();
    assert.strictEqual(q.lookup('qwen2.5-coder', 70, 'coding'), null);
});

test('a row with no published size matches the family and says so', () => {
    // LiveBench publishes 'deepseek-r1' with no size. Refusing it loses a real
    // measurement, so it is admitted and flagged instead.
    const { q } = seed();
    const hit = q.lookup('deepseek-r1', 14, 'reasoning');
    assert.ok(hit, 'an unsized row should still match its family');
    assert.strictEqual(hit.sizeUnknown, true);
    assert.strictEqual(hit.evals[0].score, 88.6);
});

test('a size-matched hit is not flagged as family-only', () => {
    const { q } = seed();
    assert.strictEqual(q.lookup('qwen2.5-coder', 7, 'coding').sizeUnknown, false);
});

test('a metric is never borrowed for a category it does not measure', () => {
    const { q } = seed();
    assert.strictEqual(q.lookup('qwen2.5-coder', 7, 'multimodal'), null);
});

test('an unknown model returns null rather than a nearest guess', () => {
    const { q } = seed();
    assert.strictEqual(q.lookup('not-a-real-model', 7, 'coding'), null);
});

/* ---------------- cohort percentile ---------------- */

test('the percentile cohort is the local catalog, not the whole board', () => {
    // Ranking an open model against frontier hosted ones puts every one of them
    // in the bottom percentile, which is what made measured models score below
    // unmeasured ones. Only catalog families may form the cohort.
    const { db, q } = seed();
    const ins = db.prepare(`
        INSERT INTO quality_evals
          (source_id, bench_model_name, family_key, params_b, variant_role, metric, category, raw_score, raw_scale_max)
        VALUES (?,?,?,?,?,?,?,?,?)
    `);
    // Six locally-runnable families, all scoring below the model under test.
    const local = ['mistral', 'gemma2', 'phi4', 'llama3.1', 'qwen2', 'codellama'];
    local.forEach((name, i) => {
        ins.run('test', name, name, 7, 'instruct', 'bcb_instruct', 'coding', 10 + i, 100);
    });
    // Frontier hosted models that score far higher and must NOT dilute the rank.
    for (let i = 0; i < 20; i += 1) {
        ins.run('test', `frontier-${i}`, `frontier-${i}`, 7, 'instruct', 'bcb_instruct', 'coding', 90 + i * 0.1, 100);
    }

    q.refreshCatalogCohort([{ name: 'qwen2.5-coder' }, ...local.map((name) => ({ name }))]);
    const pct = q.percentile('bcb_instruct', 49.0);

    assert.ok(pct !== null, 'the catalog cohort should be large enough to rank against');
    // 49.0 is the highest of the 8 cohort rows, and the rank counts strictly
    // lower scores, so the top of an 8-point cohort is 7/8.
    assert.ok(
        pct >= 80,
        `49.0 beats every catalog model here, so it should rank at the top; got ${pct}`,
    );
});

test('frontier rows outside the catalog are excluded from the cohort', () => {
    const { db, q } = seed();
    const ins = db.prepare(`
        INSERT INTO quality_evals
          (source_id, bench_model_name, family_key, params_b, variant_role, metric, category, raw_score, raw_scale_max)
        VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const local = ['mistral', 'gemma2', 'phi4', 'llama3.1', 'qwen2'];
    local.forEach((name, i) => {
        ins.run('test', name, name, 7, 'instruct', 'bcb_instruct', 'coding', 10 + i, 100);
    });
    for (let i = 0; i < 50; i += 1) {
        ins.run('test', `hosted-${i}`, `hosted-${i}`, 7, 'instruct', 'bcb_instruct', 'coding', 95, 100);
    }
    q.refreshCatalogCohort(local.map((name) => ({ name })));

    // With the hosted rows counted the cohort would be 55; only the 5 catalog
    // ones may take part, so a score above all of them is the 100th percentile.
    assert.strictEqual(q.percentile('bcb_instruct', 99), 100);
});

test('percentile declines to rank against too few points', () => {
    const { q } = seed();
    q.refreshCatalogCohort([{ name: 'deepseek-r1' }]);
    assert.strictEqual(q.percentile('livebench_reasoning', 88.6), null);
});

test('refreshCatalogCohort reports how many families it indexed', () => {
    const { q } = seed();
    assert.strictEqual(q.refreshCatalogCohort([{ name: 'qwen2.5-coder' }, { name: 'llama3.1' }]), 2);
});

/* ---------------- coverage ---------------- */

test('coverage separates measured from unmeasured honestly', () => {
    const { q } = seed();
    const cov = q.coverage([{ name: 'qwen2.5-coder' }, { name: 'gemma3' }, { name: 'phi4' }]);
    assert.strictEqual(cov.total, 3);
    assert.strictEqual(cov.measured, 1);
    assert.deepStrictEqual(cov.missing.sort(), ['gemma3', 'phi4']);
});

console.log('\nquality evals\n');
log.forEach((l) => console.log(l));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
