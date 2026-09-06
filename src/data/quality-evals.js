'use strict';
const { checkpointIdentity, sameCheckpoint } = require('./checkpoint-identity');

/**
 * Public benchmark scores for model QUALITY.
 *
 * Why this exists: the selector's notion of "quality" was
 * `getBaseQuality(paramsB)` — a lookup table on parameter count — plus a
 * hand-written family bump and a `name.includes('code')` string match. Nothing
 * measured anything. Four of the seven categories (reasoning, creative,
 * talking, reading) had no task signal at all and degenerated into
 * "biggest model wins", which is how a coding model came to rank first for
 * "Creative".
 *
 * Why NOT the existing `benchmarks` table: it is per-machine SPEED telemetry
 * (tokens_per_second, hardware_fingerprint), and `ModelDatabase.clear()`
 * is keyed to a machine and runtime rather than a public evaluation. The
 * quality tables here remain independent of catalog and speed refreshes.
 *
 * Measurements join by checkpoint, role, revision and declared size. Family keys
 * only define comparison cohorts; a quantized repo needs a verified base-model
 * alias to inherit another provider's checkpoint measurements.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quality_sources (
    id            TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    data_url      TEXT NOT NULL,
    homepage_url  TEXT,
    independent   INTEGER NOT NULL DEFAULT 1,
    fetched_at    TEXT,
    row_count     INTEGER,
    payload_sha256 TEXT
);

CREATE TABLE IF NOT EXISTS quality_evals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id     TEXT NOT NULL REFERENCES quality_sources(id) ON DELETE CASCADE,
    bench_model_name TEXT NOT NULL,
    bench_model_url  TEXT,
    family_key    TEXT NOT NULL,
    params_b      REAL,
    active_params_b REAL,
    is_moe        INTEGER NOT NULL DEFAULT 0,
    variant_role  TEXT NOT NULL DEFAULT 'instruct',
    metric        TEXT NOT NULL,
    category      TEXT NOT NULL,
    raw_score     REAL NOT NULL,
    raw_scale_max REAL NOT NULL DEFAULT 100,
    eval_precision TEXT NOT NULL DEFAULT 'fp16',
    fetched_at    TEXT,
    UNIQUE(source_id, bench_model_name, metric)
);

CREATE INDEX IF NOT EXISTS idx_quality_family ON quality_evals(family_key, params_b);
CREATE INDEX IF NOT EXISTS idx_quality_category ON quality_evals(category);
CREATE TABLE IF NOT EXISTS catalog_families (family_key TEXT PRIMARY KEY);
`;

/**
 * Where each metric counts. A metric only feeds the categories it actually
 * measures — HumanEval says nothing about vision, so it is not borrowed for it.
 */
const SOURCES = {
    hf_open_llm: {
        displayName: 'Hugging Face Open LLM Leaderboard',
        homepage: 'https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard',
        // The contents snapshot works independently of datasets-server's
        // broken results dataset and includes the Official Providers flag.
        url: 'https://huggingface.co/datasets/open-llm-leaderboard/contents/resolve/main/data/train-00000-of-00001.parquet',
        format: 'parquet',
        independent: true,
        parse(rows) {
            const metrics = {
                'MMLU-PRO': ['hf_mmlu_pro', 'general'],
                BBH: ['hf_bbh', 'reasoning'],
                GPQA: ['hf_gpqa', 'reasoning'],
                MUSR: ['hf_musr', 'reasoning'],
                'MATH Lvl 5': ['hf_math_lvl5', 'reasoning'],
                IFEval: ['hf_ifeval', 'talking'],
            };
            const out = new Map();
            for (const row of rows) {
                if (row['Official Providers'] !== true || row.Flagged || row.Merged ||
                    row['Available on the hub'] !== true || row['Weight type'] !== 'Original') continue;
                const name = row.fullname;
                if (typeof name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(name)) continue;
                for (const [label, [metric, category]] of Object.entries(metrics)) {
                    // Raw is accuracy in [0, 1]; the displayed columns can
                    // instead be chance-adjusted scores. Never mix the two.
                    const value = finiteNumber(row[`${label} Raw`]);
                    if (value == null || value < 0 || value > 1) continue;
                    const result = {
                        benchModelName: name,
                        benchModelUrl: `https://huggingface.co/${name}`,
                        paramsB: numOrNull(row['#Params (B)']),
                        isMoe: row.MoE ? 1 : 0,
                        variantRole: /pretrained/i.test(row.Type || '') ? 'base' : 'instruct',
                        metric, category,
                        rawScore: value * 100,
                        rawScaleMax: 100,
                        evalPrecision: row.Precision || 'not published',
                    };
                    const key = `${name}::${metric}`;
                    const previous = out.get(key);
                    // Prefer a full-precision run over a quantized duplicate.
                    if (!previous || /^(bfloat16|float16|float32)$/.test(result.evalPrecision)) out.set(key, result);
                }
            }
            return [...out.values()];
        },
    },

    lmarena: {
        displayName: 'LMArena (human preference Elo)',
        // The publisher distributes these ratings under CC-BY-4.0. Preserve
        // its attribution URL in the source and recommendation provenance.
        homepage: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
        url: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/text/latest-00000-of-00001.parquet',
        format: 'parquet',
        independent: true,
        parse(rows) {
            const latest = new Map();
            for (const row of rows) {
                const score = finiteNumber(row.rating);
                if (row.category !== 'overall' || typeof row.model_name !== 'string' ||
                    !row.model_name.trim() || score == null || score <= 0 || !(finiteNumber(row.vote_count) > 0)) continue;
                const previous = latest.get(row.model_name);
                if (!previous || String(row.leaderboard_publish_date) > String(previous.leaderboard_publish_date)) {
                    latest.set(row.model_name, row);
                }
            }
            return [...latest.values()].flatMap((row) => ['general', 'talking'].map((category) => ({
                benchModelName: row.model_name,
                benchModelUrl: this.homepage,
                paramsB: null,
                isMoe: 0,
                variantRole: 'instruct',
                metric: category === 'general' ? 'lmarena_general' : 'lmarena_chat',
                category,
                rawScore: Number(row.rating),
                // Elo has no fixed maximum. Zero records an unbounded scale;
                // it is ranked within the catalog cohort, never divided by 100.
                rawScaleMax: 0,
                evalPrecision: 'not published',
            })));
        },
    },

    bigcodebench: {
        displayName: 'BigCodeBench',
        homepage: 'https://bigcode-bench.github.io',
        url: 'https://bigcode-bench.github.io/results.json',
        independent: true,
        parse(json) {
            const out = [];
            for (const [name, row] of Object.entries(json)) {
                const p = row?.['pass@1'] ?? {};
                // "complete" is the base-checkpoint prompt mode, "instruct" the
                // chat one; a model has one or the other, sometimes both.
                for (const [mode, score] of Object.entries(p)) {
                    if (typeof score !== 'number') continue;
                    out.push({
                        benchModelName: name,
                        benchModelUrl: row.link ?? null,
                        paramsB: numOrNull(row.size),
                        activeParamsB: numOrNull(row.act_param ?? row.size),
                        isMoe: row.moe ? 1 : 0,
                        variantRole: mode === 'instruct' ? 'instruct' : 'base',
                        metric: `bcb_${mode}`,
                        category: 'coding',
                        rawScore: score,
                        rawScaleMax: 100,
                    });
                }
            }
            return out;
        },
    },

    evalplus: {
        displayName: 'EvalPlus (HumanEval+ / MBPP+)',
        homepage: 'https://evalplus.github.io',
        url: 'https://evalplus.github.io/results.json',
        independent: true,
        parse(json) {
            const out = [];
            // The "+" variants add held-out tests and are the harder, less
            // saturated numbers; both are stored so the UI can show either.
            const METRICS = {
                'humaneval+': 'humaneval_plus',
                'mbpp+': 'mbpp_plus',
                humaneval: 'humaneval',
                mbpp: 'mbpp',
            };
            for (const [name, row] of Object.entries(json)) {
                const p = row?.['pass@1'] ?? {};
                for (const [key, metric] of Object.entries(METRICS)) {
                    const score = p[key];
                    if (typeof score !== 'number') continue;
                    out.push({
                        benchModelName: name,
                        benchModelUrl: row.link ?? null,
                        paramsB: numOrNull(row.size),
                        activeParamsB: numOrNull(row.size),
                        isMoe: 0,
                        variantRole: row.prompted === false ? 'base' : 'instruct',
                        metric,
                        category: 'coding',
                        rawScore: score,
                        rawScaleMax: 100,
                    });
                }
            }
            return out;
        },
    },

    livebench: {
        displayName: 'LiveBench (contamination-free)',
        homepage: 'https://livebench.ai',
        // The site fetches `./table_${release}.csv`, and — the detail that
        // makes hand-built URLs 404 — it first does replaceAll('-','_'), so
        // the 2026-06-25 release lives at table_2026_06_25.csv.
        url: 'https://livebench.ai/table_2026_06_25.csv',
        independent: true,
        // Several releases are merged because each one only re-runs a subset
        // of models; the union covers far more of our catalog than the latest
        // alone, and newer releases win on conflict.
        releases: ['2025_04_25', '2025_05_30', '2025_11_25', '2025_12_23', '2026_01_08', '2026_06_25'],
        // Authoritative task -> category map, from categories_<release>.json.
        categories: {
            Reasoning: ['theory_of_mind', 'zebra_puzzle', 'spatial', 'logic_with_navigation'],
            Coding: ['code_generation', 'code_completion'],
            'Agentic Coding': ['javascript', 'typescript', 'python'],
            Mathematics: ['AMPS_Hard', 'integrals_with_game', 'math_comp', 'olympiad'],
            'Data Analysis': ['consecutive_events', 'tablejoin', 'tablereformat'],
            Language: ['connections', 'plot_unscrambling', 'typos'],
            IF: ['paraphrase', 'simplify', 'story_generation', 'summarize'],
        },
        // Which app category each LiveBench group feeds.
        appCategory: {
            Reasoning: 'reasoning',
            Coding: 'coding',
            'Agentic Coding': 'coding',
            Mathematics: 'reasoning',
            'Data Analysis': 'general',
            Language: 'creative',
            IF: 'talking',
        },
        parseCsv(text, release) {
            const lines = text.trim().split('\n');
            if (lines.length < 2) return [];
            const head = lines[0].split(',').map((h) => h.trim());
            const out = [];
            for (const line of lines.slice(1)) {
                const cells = line.split(',');
                const name = cells[0]?.trim();
                if (!name) continue;
                const byTask = {};
                head.forEach((h, i) => {
                    const v = finiteNumber(cells[i]);
                    if (i > 0 && v != null) byTask[h] = v;
                });
                for (const [group, tasks] of Object.entries(this.categories)) {
                    const vals = tasks.map((t) => byTask[t]).filter(Number.isFinite);
                    if (!vals.length) continue;
                    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
                    out.push({
                        benchModelName: name,
                        benchModelUrl: null,
                        paramsB: null,          // LiveBench does not publish sizes
                        activeParamsB: null,
                        isMoe: 0,
                        variantRole: 'instruct',
                        metric: `livebench_${group.toLowerCase().replace(/\s+/g, '_')}`,
                        category: this.appCategory[group],
                        rawScore: mean,
                        rawScaleMax: 100,
                        release,
                    });
                }
            }
            return out;
        },
    },

    mmmu: {
        displayName: 'MMMU (multimodal understanding)',
        homepage: 'https://mmmu-benchmark.github.io',
        url: 'https://mmmu-benchmark.github.io/leaderboard_data.json',
        // MMMU's board is largely vendor self-reported rather than
        // independently re-run, so the UI labels it as such.
        independent: false,
        parse(json) {
            // Shape: { leaderboardData: [ { info:{name,size,date,type},
            //          validation:{overall,...}, test:{...}, pro:{overall,...} } ] }
            const rows = Array.isArray(json?.leaderboardData) ? json.leaderboardData
                : Array.isArray(json) ? json
                    : Array.isArray(json?.data) ? json.data : [];
            const out = [];
            for (const row of rows) {
                const info = row?.info ?? row;
                const name = info?.name ?? row?.model;
                // Human and random baselines are reference lines, not models.
                if (!name || /human|random choice|frequent choice/i.test(name)) continue;

                // 'size' is a display string like '8B' or '-' rather than a number.
                const sizeStr = String(info?.size ?? '');
                const sm = sizeStr.match(/(\d+(?:\.\d+)?)\s*b/i);
                const paramsB = sm ? Number(sm[1]) : null;

                for (const [split, metric] of [['validation', 'mmmu_val'], ['pro', 'mmmu_pro']]) {
                    // MMMU-Pro runs ~20-30 points below val and is NOT comparable
                    // to it, so the two are stored as separate metrics.
                    const raw = row?.[split]?.overall;
                    const val = finiteNumber(raw);
                    if (val == null) continue;
                    out.push({
                        benchModelName: String(name),
                        benchModelUrl: info?.link ?? row?.url ?? null,
                        paramsB,
                        activeParamsB: paramsB,
                        isMoe: 0,
                        variantRole: 'vision',
                        metric,
                        category: 'multimodal',
                        rawScore: val,
                        rawScaleMax: 100,
                    });
                }
            }
            return out;
        },
    },
};

const numOrNull = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

function finiteNumber(value) {
    if (value == null || value === '' || typeof value === 'boolean' ||
        (typeof value === 'string' && !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function pickNumber(row, keys) {
    for (const k of keys) {
        const n = finiteNumber(row?.[k]);
        if (n != null) return n;
    }
    return null;
}

/**
 * Reduce a leaderboard model name to a family signature comparable with an
 * Ollama catalog name.
 *
 *   'Qwen2.5-Coder-32B-Instruct'  -> { family: 'qwen2.5-coder', paramsB: 32 }
 *   'DeepSeek-V2.5-1210'          -> { family: 'deepseek-v2.5',  paramsB: null }
 *
 * Size, role and date suffixes are stripped because the catalog entry is a
 * family ('qwen2.5-coder') that spans many sizes; the size travels separately
 * as the second half of the join key.
 */
function familyKey(name) {
    let s = String(name).toLowerCase();
    s = s.replace(/^[^/]+\//, '');                       // drop the HF org prefix
    const size = s.match(/(\d+(?:\.\d+)?)\s*x?\s*(\d+(?:\.\d+)?)?\s*b\b/);
    let paramsB = null;
    if (size) {
        // "8x7b" is a mixture: the second number is the expert size.
        paramsB = size[2] ? Number(size[1]) * Number(size[2]) : Number(size[1]);
    }
    s = s
        .replace(/\b\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?\s*b\b/g, ' ')
        .replace(/\b\d+(?:\.\d+)?\s*b\b/g, ' ')
        .replace(/\b(instruct|chat|it|base|preview|thinking|reasoner|distill|turbo|latest|hf|gguf|awq|gptq|fp8|fp16|bf16|int4|int8)\b/g, ' ')
        .replace(/\b(20\d{2}|\d{4}|v\d+\.\d+(?:\.\d+)?)\b/g, (m) => (/^v/.test(m) ? m : ' '))
        .replace(/[^a-z0-9.+-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        // Leaderboards write 'Llama-3.1' where the Ollama library writes
        // 'llama3.1'. Collapse a hyphen only when a digit follows it, so a
        // version marker joins the family name while real word boundaries
        // ('qwen2.5-coder', 'deepseek-coder-v2') survive untouched.
        .replace(/-(?=\d)/g, '');

    // LiveBench embeds the vendor in the name ('meta-llama-3.1-8b-instruct'),
    // which the catalog does not ('llama3.1'). Only strip a vendor when
    // something is left after it, so a family that IS the vendor name
    // ('deepseek-r1', 'granite4') is never truncated to nothing.
    const stripped = s.replace(/^(meta|google|microsoft|mistralai|alibaba|nvidia|ibm|openai|anthropic)-/, '');
    if (stripped) s = stripped;

    return { family: s, paramsB };
}

/** How close two parameter counts must be to be the same checkpoint. */
const sizeMatches = (a, b) => {
    if (a == null || b == null) return false;
    return Math.abs(a - b) / Math.max(a, b) <= 0.15;
};

class QualityEvals {
    constructor(db, { readOnly = false } = {}) {
        // Accept both a raw node:sqlite handle (desktop) and ModelDatabase
        // (CLI, including its Node 18/20 sql.js fallback).
        this.modelDatabase = typeof db.beginBatch === 'function' ? db : null;
        this.db = this.modelDatabase ? {
            exec: (sql) => db.db.exec(sql),
            prepare: (sql) => ({
                run: (...args) => db.run(sql, args),
                all: (...args) => db.all(sql, args),
                get: (...args) => db.get(sql, args),
            }),
        } : db;
        if (!readOnly) {
            this.db.exec(SCHEMA);
            this.modelDatabase?.saveToFile();
        }
    }

    transaction(write) {
        this.modelDatabase?.beginBatch();
        try {
            this.db.exec('SAVEPOINT quality_update');
            try {
                const result = write();
                this.db.exec('RELEASE quality_update');
                return result;
            } catch (error) {
                this.db.exec('ROLLBACK TO quality_update');
                this.db.exec('RELEASE quality_update');
                throw error;
            }
        } finally {
            this.modelDatabase?.endBatch();
        }
    }

    /** Fetch one source and replace its rows. Returns a small report. */
    async ingest(sourceId, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
        const spec = SOURCES[sourceId];
        if (!spec) throw new Error(`Unknown quality source: ${sourceId}`);

        let rows = [];
        let payload = '';
        const request = (url) => fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });

        if (Array.isArray(spec.releases)) {
            // Merge releases oldest-first so a newer re-run of the same model
            // overwrites the older score rather than duplicating it.
            const seen = new Map();
            for (const release of spec.releases) {
                const url = `https://livebench.ai/table_${release}.csv`;
                let body;
                try {
                    const r = await request(url);
                    if (!r.ok) continue;
                    body = await r.text();
                } catch { continue; }
                payload += body;
                for (const row of spec.parseCsv(body, release)) {
                    seen.set(`${row.benchModelName}::${row.metric}`, row);
                }
            }
            rows = [...seen.values()];
            if (!rows.length) throw new Error(`${sourceId}: no release returned usable rows`);
        } else {
            const res = await request(spec.url);
            if (!res.ok) throw new Error(`${sourceId}: HTTP ${res.status}`);
            try {
                if (spec.format === 'parquet') {
                    const file = await res.arrayBuffer();
                    payload = Buffer.from(file);
                    const { parquetReadObjects } = await import('hyparquet');
                    rows = spec.parse(await parquetReadObjects({ file }));
                } else {
                    payload = await res.text();
                    rows = spec.parse(JSON.parse(payload));
                }
            } catch (err) {
                throw new Error(`${sourceId}: could not parse — ${err.message}`);
            }
        }

        if (!rows.length || rows.some((row) => !row.benchModelName || !Number.isFinite(row.rawScore))) {
            throw new Error(`${sourceId}: no valid replacement data; cached scores retained`);
        }

        const now = new Date().toISOString();
        const sha = require('crypto').createHash('sha256').update(payload).digest('hex');

        this.transaction(() => {
            this.db.prepare(`
                INSERT INTO quality_sources (id, display_name, data_url, homepage_url, independent, fetched_at, row_count, payload_sha256)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  display_name = excluded.display_name,
                  data_url = excluded.data_url,
                  homepage_url = excluded.homepage_url,
                  independent = excluded.independent,
                  fetched_at = excluded.fetched_at,
                  row_count  = excluded.row_count,
                  payload_sha256 = excluded.payload_sha256
            `).run(sourceId, spec.displayName, spec.url, spec.homepage ?? null,
                spec.independent ? 1 : 0, now, rows.length, sha);

            this.db.prepare('DELETE FROM quality_evals WHERE source_id = ?').run(sourceId);

            const ins = this.db.prepare(`
                INSERT OR REPLACE INTO quality_evals
                  (source_id, bench_model_name, bench_model_url, family_key, params_b,
                   active_params_b, is_moe, variant_role, metric, category,
                   raw_score, raw_scale_max, eval_precision, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const r of rows) {
                const fk = familyKey(r.benchModelName);
                ins.run(
                    sourceId, r.benchModelName, r.benchModelUrl ?? null,
                    fk.family, r.paramsB ?? fk.paramsB, r.activeParamsB ?? r.paramsB ?? fk.paramsB,
                    r.isMoe, r.variantRole, r.metric, r.category,
                    r.rawScore, r.rawScaleMax, r.evalPrecision || 'fp16', now
                );
            }
        });
        this._pctCache = new Map();
        this._identityRows = null;

        return { source: sourceId, rows: rows.length, fetchedAt: now };
    }

    /**
     * Scores for one catalog model at one size.
     *
     * Returns null when nothing was measured — the caller MUST treat that as
     * "unknown" and say so, rather than substituting an estimate and
     * presenting it as a measurement.
     */
    lookup(catalogName, paramsB, category = null, model = {}) {
        const identity = checkpointIdentity(catalogName, paramsB, model);
        const fk = familyKey(model.artifact?.repo_id || catalogName);
        if (!this._identityRows) {
            this._identityRows = this.db.prepare(`
                SELECT q.*, s.display_name AS source_name, s.homepage_url, s.independent
                FROM quality_evals q JOIN quality_sources s ON s.id = q.source_id
            `).all().map(row => ({ row, identity: checkpointIdentity(row.bench_model_name, row.params_b) }));
        }
        const wanted = this._identityRows.filter(({ row, identity: measured }) =>
            (!category || row.category === category) && sameCheckpoint(identity, measured)
        ).map(({ row }) => row);
        if (!wanted.length) return null;

        return {
            family: fk.family,
            paramsB,
            // Retained for output compatibility; family-only hits are ineligible.
            sizeUnknown: false,
            match: 'checkpoint',
            evals: wanted.map((r) => ({
                source: r.source_id,
                sourceName: r.source_name,
                independent: Boolean(r.independent),
                metric: r.metric,
                category: r.category,
                score: r.raw_score,
                scaleMax: r.raw_scale_max || null,
                scoreUnit: r.raw_scale_max === 0 ? 'elo' : 'percent',
                benchModel: r.bench_model_name,
                benchParamsB: r.params_b,
                url: r.bench_model_url,
                sourceUrl: r.homepage_url,
                precision: r.eval_precision,
            })),
        };
    }

    /**
     * Percentile rank of a score within its own metric's distribution.
     *
     * A fixed ceiling per metric is the wrong normalisation here. LiveBench's
     * reasoning board has a median of 70.8 because it is dominated by 2026
     * frontier hosted models; a strong open 72B lands at 35.1 and would be
     * scored as terrible against a fixed ceiling of 95 — worse than an
     * unmeasured 4B falling back to the size estimate. Ranking within the
     * board's own distribution keeps measured and estimated scores on a
     * comparable 0-100 axis.
     */
    percentile(metric, score) {
        if (!this._pctCache) this._pctCache = new Map();
        let dist = this._pctCache.get(metric);
        if (!dist) {
            // The cohort is restricted to benchmark rows that correspond to a
            // model in our catalog — i.e. something the user could actually
            // run locally. Ranking against the full board instead puts every
            // open model in the bottom percentile, because LiveBench is
            // dominated by frontier hosted models: a strong open 72B scored
            // 5.7 that way, below an unmeasured 4B falling back to the size
            // estimate. That would make the ranking worse than no benchmark
            // at all.
            dist = this.db.prepare(`
                SELECT q.raw_score s
                FROM quality_evals q
                WHERE q.metric = ?
                  AND q.family_key IN (SELECT DISTINCT family_key FROM catalog_families)
                ORDER BY q.raw_score
            `).all(metric).map((r) => r.s);
            this._pctCache.set(metric, dist);
        }
        if (dist.length < 5) return null;   // too few points to rank against
        let lo = 0;
        while (lo < dist.length && dist[lo] < score) lo += 1;
        return (lo / dist.length) * 100;
    }

    /**
     * Materialise the set of family keys present in the local catalog. This is
     * what defines the "could actually run it" cohort used by percentile().
     * Cheap enough to rebuild whenever the catalog changes.
     */
    refreshCatalogCohort(catalogRows) {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS catalog_families (family_key TEXT PRIMARY KEY);
        `);
        this.transaction(() => {
            this.db.prepare('DELETE FROM catalog_families').run();
            const ins = this.db.prepare(
                'INSERT OR IGNORE INTO catalog_families (family_key) VALUES (?)'
            );
            for (const m of catalogRows) ins.run(familyKey(m.name).family);
        });
        this._pctCache = new Map();
        return this.db.prepare('SELECT COUNT(*) c FROM catalog_families').get().c;
    }

    /** Coverage report: how many catalog models we can actually speak to. */
    coverage(catalogRows) {
        let measured = 0;
        const missing = [];
        for (const m of catalogRows) {
            const hit = this.db.prepare(
                'SELECT COUNT(*) c FROM quality_evals WHERE family_key = ?'
            ).get(familyKey(m.name).family);
            if (hit.c > 0) measured += 1;
            else missing.push(m.name);
        }
        return { total: catalogRows.length, measured, missing };
    }

    stats() {
        return {
            sources: this.db.prepare('SELECT * FROM quality_sources').all(),
            evals: this.db.prepare('SELECT COUNT(*) c FROM quality_evals').get().c,
            byCategory: this.db.prepare(
                'SELECT category, COUNT(*) c FROM quality_evals GROUP BY category'
            ).all(),
        };
    }
}

module.exports = { QualityEvals, SOURCES, SCHEMA, familyKey, sizeMatches };
