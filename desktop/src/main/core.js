'use strict';

/** Bridge between the Electron main process and this checkout's ranking core. */

const path = require('path');
const { EventEmitter } = require('events');
const runtimes = require('./runtimes');

/**
 * In development the core sits one level up in the repo. In a packaged build
 * electron-builder copies it to resources/core (see extraResources), because
 * src/data/seed/models.db is 42 MB and needs to stay a real file on disk.
 */
function resolveCoreRoot() {
    const devRoot = path.resolve(__dirname, '..', '..', '..');
    if (require('fs').existsSync(path.join(devRoot, 'src', 'index.js'))) return devRoot;
    return path.join(process.resourcesPath ?? devRoot, 'core');
}

const REPO_ROOT = resolveCoreRoot();

/** Load the CLI core lazily so a require error surfaces as app state, not a crash. */
function loadChecker() {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const LLMChecker = require(path.join(REPO_ROOT, 'src', 'index.js'));
    return new LLMChecker();
}

const { RANKING_CONTRACT_VERSION, classifyFit, memoryBudgetGB } = require(path.join(REPO_ROOT, 'src/models/ranking-contract'));
const { getRuntimeCommandSet } = require(path.join(REPO_ROOT, 'src/runtime/runtime-support'));
const { SOURCES } = require(path.join(REPO_ROOT, 'src/data/quality-evals'));
if (RANKING_CONTRACT_VERSION !== 1) throw new Error('Desktop requires ranking contract version 1. Update the core and desktop together.');
const FIT = { GOOD: 'fits', TIGHT: 'tight', OVER: 'over', UNKNOWN: 'unknown' };

function num(...vals) {
    for (const v of vals) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

/**
 * The seven use cases the core ranks for, in the order they belong on a board.
 * `talking` and `reading` are the core's own keys — renamed here for people.
 */
const CATEGORIES = [
    { key: 'general',    label: 'General',      emoji: '⚡', colour: 'green' },
    { key: 'coding',     label: 'Coding',       emoji: '💻', colour: 'blue' },
    { key: 'reasoning',  label: 'Reasoning',    emoji: '🧠', colour: 'purple' },
    { key: 'multimodal', label: 'Vision',       emoji: '👁', colour: 'pink' },
    { key: 'creative',   label: 'Creative',     emoji: '✨', colour: 'orange' },
    { key: 'talking',    label: 'Chat',         emoji: '💬', colour: 'mint' },
    { key: 'reading',    label: 'Long context', emoji: '📖', colour: 'yellow' },
];

/** Turn "fits in 6.108751999999999/12GB, Q6_K, 7B is sweet spot" into prose. */
function tidyReason(text) {
    if (!text) return null;
    return String(text)
        .replace(/(\d+\.\d{2,})/g, (m) => Number(m).toFixed(1))
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Normalise one entry from `recommendations.recommendations[cat].bestModels`.
 *
 * The field names are not what they look like: `size` is a PARAMETER COUNT in
 * billions (7, 14, 70), not bytes, and the memory a model actually needs is
 * `estimatedRAM` in GB. Reading `size` as gigabytes puts every model in the
 * wrong column — which is exactly what the first cut of this did.
 */
function toCard(raw = {}, budgetGB, detected, hardware) {
    const name = raw.model_name ?? raw.name ?? raw.model ?? raw.modelName ?? 'unknown';
    const req = raw.requirements ?? {};
    const sizeGB = num(
        raw.memory?.requiredGB, raw.estimatedRAM, raw.sizeGB, raw.memoryGB, raw.estimatedMemoryGB,
        req.vram, req.recommended_vram, req.ram
    );
    const paramsB = num(raw.size, raw.parameters, raw.params);
    const format = String(raw.artifactFormat ?? raw.format ?? '').toLowerCase() || null;
    const chosen = raw.runtime ? { id: raw.runtime } : runtimes.chooseFor({ format }, detected, hardware);

    // model_identifier is the exact pull ref ("qwen2.5-coder:7b-base-q6_K").
    const ref =
        raw.model_identifier ??
        raw.installCommand?.replace(/^\S+\s+(pull|run)\s+/i, '') ??
        raw.tag ?? raw.ref ?? name;

    return {
        name,
        ref,
        params: paramsB ? `${paramsB}B` : (raw.parameterSize ?? null),
        purpose: tidyReason(raw.reasoning ?? raw.reason ?? raw.description ?? null),
        family: raw.family ?? null,
        sizeGB,
        quant: raw.quantization ?? raw.quant ?? null,
        tokensPerSec: num(raw.speed?.estimatedTPS, raw.speedAssumptions?.tokensPerSecond, raw.estimatedSpeed, raw.tokensPerSecond),
        pulls: num(raw.pulls, raw.downloads),
        score: num(raw.categoryScore, raw.score, raw.compatibilityScore),
        hardwareScore: num(raw.hardwareScore),
        category: raw.category ?? null,
        license: raw.license ?? null,
        format,
        // Whether the quality half of this score was measured or guessed.
        // Only 23% of the catalog has a real benchmark, so the UI must show
        // which kind of number it is rather than letting them look alike.
        quality: raw.qualitySource
            ? {
                measured: raw.qualitySource.kind === 'measured',
                metric: raw.qualitySource.metric ?? null,
                rawScore: raw.qualitySource.rawScore ?? null,
                source: raw.qualitySource.source ?? null,
                independent: raw.qualitySource.independent !== false,
                sizeUnknown: Boolean(raw.qualitySource.sizeUnknown),
                basis: raw.qualitySource.basis ?? null,
            }
            : { measured: false, basis: 'parameter count' },
        budgetGB: num(raw.memory?.budgetGB, budgetGB),
        context: raw.context || null,
        fit: classifyFit(sizeGB, num(raw.memory?.budgetGB, budgetGB)),
        runtime: chosen ? chosen.id : null,
        commands: chosen ? (chosen.id === 'lmstudio' ? runtimes.commandsFor(chosen.id, ref) :
            getRuntimeCommandSet({ ...raw, model_identifier: ref }, chosen.id)) : null,
    };
}

/**
 * The ranked models live at `analysis.recommendations.recommendations[cat]`,
 * two levels deep, each category holding a `bestModels` array plus the counts
 * behind it. Returns one group per category in board order.
 */
function harvestCategories(analysis = {}) {
    const root =
        analysis.recommendations?.recommendations ??
        analysis.intelligentRecommendations?.recommendations ??
        null;
    if (!root || typeof root !== 'object') return [];

    return CATEGORIES.map((spec) => {
        const node = root[spec.key];
        const best = Array.isArray(node?.bestModels) ? node.bestModels : [];
        return {
            ...spec,
            models: best,
            evaluated: num(node?.totalCandidates, node?.totalEvaluated) ?? null,
        };
    }).filter((g) => g.models.length);
}

/**
 * Flat, de-duplicated list across every bucket the core exposes. Used for the
 * fit tally in the sidebar; `incompatible` is included on purpose so the count
 * does not claim everything runs on this machine.
 */
function harvest(analysis = {}) {
    const buckets = [
        analysis.recommended, analysis.compatible,
        analysis.models, analysis.results, analysis.marginal, analysis.incompatible,
    ];
    const flat = [];
    for (const b of buckets) {
        if (Array.isArray(b)) flat.push(...b);
        else if (b && typeof b === 'object') flat.push(...Object.values(b).flat().filter(Boolean));
    }
    const seen = new Set();
    return flat.filter((m) => {
        const key = String(m?.model_name ?? m?.name ?? m?.model ?? '').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

class Core extends EventEmitter {
    constructor(options = {}) {
        super();
        this.checker = null;
        this.options = options;
        this.queue = Promise.resolve();
        this.checkerFactory = options.checkerFactory || loadChecker;
        this.detectRuntimes = options.detectRuntimes || runtimes.detectAll;
        this.state = {
            phase: 'idle',       // idle | hardware | runtimes | models | ready | error
            hardware: null,
            runtimes: [],
            groups: [],          // one per use case — the board columns
            models: [],          // flat list, drives the sidebar tallies
            tally: {},           // { fits, tight, over }
            budgetGB: null,
            error: null,
            timings: {},
        };
    }

    snapshot() {
        return JSON.parse(JSON.stringify(this.state));
    }

    #publish(patch) {
        Object.assign(this.state, patch);
        this.emit('state', this.snapshot());
    }

    /**
     * Full scan, published in phases. Safe to call again — a refresh reuses the
     * same long-lived LLMChecker instance and only re-runs detection.
     */
    #enqueue(work) {
        const result = this.queue.then(work, work);
        this.queue = result.catch(() => {});
        return result;
    }

    scan(options = {}) { return this.#enqueue(() => this.#scan(options)); }

    async #scan({ useCase = 'general' } = {}) {
        const t0 = Date.now();
        this.#publish({ phase: 'hardware', error: null });

        try {
            if (!this.checker) this.checker = this.checkerFactory();
        } catch (err) {
            this.#publish({ phase: 'error', error: `Could not load the analysis core: ${err.message}` });
            return this.snapshot();
        }

        let hardware = null;
        try {
            // analyze() detects hardware and scores in one pass; we surface the
            // hardware half as soon as it is available.
            const analysisPromise = this.checker.analyze({ useCase });

            // Runtime detection is independent of the model ranking, so it runs
            // alongside it instead of after — this is the parallelism the CLI
            // gives up by using spawnSync.
            //
            // Hardware is not known yet at this point, so probe permissively
            // (a placeholder accelerator keeps vLLM in the sweep) and apply the
            // real eligibility filter once the analysis lands. Gating first
            // would silently drop runtimes the machine can actually use.
            const runtimePromise = this.detectRuntimes({
                gpu: { vramGB: 1 },
                summary: { backend: 'unknown' },
            });

            const [analysis, probed] = await Promise.all([analysisPromise, runtimePromise]);

            hardware = this.#shapeHardware(analysis);

            const eligibleIds = new Set(
                runtimes.eligible(analysis.hardware ?? {}).map((r) => r.id)
            );
            const detected = probed.filter((r) => eligibleIds.has(r.id));
            const tHw = Date.now() - t0;
            this.#publish({ phase: 'runtimes', hardware, runtimes: detected, timings: { hardware: tHw } });

            const budgetGB = memoryBudgetGB(analysis.hardware ?? {});
            const hw = analysis.hardware ?? {};

            // Board columns: one per use case, ranked within.
            const groups = harvestCategories(analysis).map((g) => ({
                key: g.key,
                label: g.label,
                emoji: g.emoji,
                colour: g.colour,
                evaluated: g.evaluated,
                models: g.models
                    .map((m) => toCard(m, budgetGB, detected, hw))
                    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
            }));

            // Flat list drives the counts in the sidebar.
            const models = harvest(analysis).map((m) => toCard(m, budgetGB, detected, hw));
            const tally = models.reduce((acc, m) => {
                acc[m.fit] = (acc[m.fit] ?? 0) + 1;
                return acc;
            }, {});

            this.#publish({
                phase: 'ready',
                groups,
                models,
                tally,
                budgetGB,
                timings: { hardware: tHw, runtimes: tHw, models: Date.now() - t0, total: Date.now() - t0 },
            });
        } catch (err) {
            this.#publish({ phase: 'error', error: err?.message ?? String(err) });
        }

        return this.snapshot();
    }

    #shapeHardware(analysis = {}) {
        const hw = analysis.hardware ?? analysis.system ?? {};
        const gpu = hw.gpu ?? {};
        const cpu = hw.cpu ?? {};
        return {
            gpuModel: gpu.model ?? gpu.name ?? hw.summary?.gpu ?? null,
            vramGB: num(gpu.vramGB, gpu.vram, hw.summary?.totalVRAM),
            backend: hw.summary?.bestBackend ?? hw.summary?.backend ?? gpu.backend ?? null,
            cudaVersion: hw.cuda?.version ?? null,
            driver: hw.cuda?.driver ?? null,
            cpuModel: cpu.brand ?? cpu.model ?? null,
            cores: num(cpu.cores, cpu.threads),
            physicalCores: num(cpu.physicalCores),
            simd: cpu.simd ?? (cpu.avx512 ? 'AVX-512' : cpu.avx2 ? 'AVX2' : null),
            ramGB: num(hw.memory?.totalGB, hw.memory?.total, hw.summary?.systemRAM),
            tier: hw.summary?.tier ?? analysis.tier ?? null,
            maxModelGB: num(hw.summary?.maxModelSizeGB, analysis.maxModelSize),
            fingerprint: hw.fingerprint ?? hw.summary?.fingerprint ?? null,
            platform: process.platform,
            arch: process.arch,
        };
    }

    /** Commands for a card under a runtime the user picked explicitly. */
    commandsFor(runtimeId, ref) {
        return runtimes.commandsFor(runtimeId, ref);
    }

    /**
     * The CLI capabilities, exposed as in-app actions.
     *
     * These used to be rendered as a list of commands with a Copy button,
     * which defeats the point of shipping a desktop app. Each entry below runs
     * the real code in this process and returns structured output the UI
     * renders directly.
     *
     * `destructive` entries are the ones that write to the catalog; the UI
     * confirms those before running.
     */
    listActions() {
        return [
            {
                id: 'sync-catalog', label: 'Refresh model catalog',
                blurb: 'Re-scrape the Ollama library for new models',
                destructive: true, estimate: '~30 s',
            },
            {
                id: 'refresh-benchmarks', label: 'Update benchmark scores',
                blurb: `Refresh all ${Object.keys(SOURCES).length} public benchmark sources`,
                destructive: true, estimate: '~10 s',
            },
            {
                id: 'toolcheck', label: 'Check local AI tooling',
                blurb: 'Probe every runtime and report what is usable',
                destructive: false, estimate: 'instant',
            },
            {
                id: 'gpu-plan', label: 'Plan GPU offload',
                blurb: 'How many layers of a model fit in VRAM',
                destructive: false, estimate: 'instant',
            },
            {
                id: 'coverage', label: 'Benchmark coverage',
                blurb: 'Catalog families represented in public benchmarks',
                destructive: false, estimate: 'instant',
            },
        ];
    }

    runAction(id, args = {}) { return this.#enqueue(() => this.#runAction(id, args)); }

    async #runAction(id, args = {}) {
        switch (id) {
            case 'toolcheck': {
                const hw = this.state.hardware ?? {};
                const found = await runtimes.detectAll({
                    gpu: { vramGB: hw.vramGB }, summary: { backend: hw.backend },
                });
                this.#publish({ runtimes: found });
                return {
                    kind: 'table',
                    columns: ['Runtime', 'State', 'Version', 'Models'],
                    rows: found.map((r) => [
                        r.name,
                        r.serving ? 'Running' : r.installed ? 'Installed' : 'Not installed',
                        r.version ?? '—',
                        String(r.models?.length ?? 0),
                    ]),
                };
            }

            case 'coverage': {
                const { db, evals } = await this.#openEvals();
                if (!evals) return { kind: 'text', text: 'No benchmark database found.' };
                let cov, stats;
                try {
                    cov = evals.coverage(db.prepare('SELECT name FROM models').all());
                    stats = evals.stats();
                } finally { db.close(); }
                return {
                    kind: 'table',
                    columns: ['Metric', 'Value'],
                    rows: [
                        ['Catalog models', String(cov.total)],
                        ['Families with benchmark data', `${cov.measured} (${Math.round(cov.measured / cov.total * 100)}%)`],
                        ['Families without benchmark data', String(cov.total - cov.measured)],
                        ['Total eval rows', String(stats.evals)],
                        ...stats.byCategory.map((c) => [`  ${c.category}`, String(c.c)]),
                        ...stats.sources.map((s) => [`  ${s.display_name}`, `${s.row_count} rows`]),
                    ],
                };
            }

            case 'gpu-plan': {
                const hw = this.state.hardware ?? {};
                const budget = this.state.budgetGB;
                const rows = (this.state.models ?? [])
                    .filter((m) => Number.isFinite(m.sizeGB))
                    .sort((a, b) => a.sizeGB - b.sizeGB)
                    .slice(0, 25)
                    .map((m) => [
                        m.name,
                        `${m.sizeGB.toFixed(1)} GB`,
                        budget ? `${Math.round(m.sizeGB / budget * 100)}%` : '—',
                        m.fit === 'unknown' ? 'Unknown' : m.fit === 'over' ? 'Exceeds budget' : m.fit === 'tight' ? 'Limited headroom' : 'Within memory budget',
                    ]);
                return {
                    kind: 'table',
                    columns: ['Model', 'Estimated memory', `of ${budget ?? 'unknown'} GB`, 'Fit'],
                    rows,
                };
            }

            case 'refresh-benchmarks': {
                const { db, evals } = await this.#openEvals({ write: true });
                if (!evals) return { kind: 'text', text: 'No benchmark database found.' };
                const out = [];
                try {
                    for (const src of Object.keys(SOURCES)) {
                        try {
                            const r = await evals.ingest(src, this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {});
                            out.push([src, `${r.rows} rows`, 'ok']);
                        } catch (err) {
                            out.push([src, '—', err.message.slice(0, 60)]);
                        }
                    }
                    const catalog = db.prepare('SELECT name FROM models').all();
                    evals.refreshCatalogCohort(catalog);
                } finally { db.close(); }
                this.#invalidateQuality();
                await this.#scan();
                return { kind: 'table', columns: ['Source', 'Rows', 'Result'], rows: out };
            }

            case 'sync-catalog': {
                const before = await this.#catalogCount();
                await this.#runCli(['sync', '--force', '--quiet']);
                const after = await this.#catalogCount();
                // The cohort is derived from the catalog, so it must follow it.
                const { db, evals } = await this.#openEvals({ write: true });
                if (evals) {
                    try { evals.refreshCatalogCohort(db.prepare('SELECT name FROM models').all()); }
                    finally { db.close(); }
                }
                this.#invalidateQuality();
                await this.#scan();
                return {
                    kind: 'table',
                    columns: ['Metric', 'Value'],
                    rows: [
                        ['Models before', String(before)],
                        ['Models after', String(after)],
                        ['New', String(Math.max(0, after - before))],
                    ],
                };
            }

            default:
                throw new Error(`Unknown action: ${id}`);
        }
    }

    #invalidateQuality() {
        this.checker?.intelligentRecommender?.invalidateQualityEvals();
    }

    async #openEvals({ write = false } = {}) {
        const ModelDatabase = require(path.join(REPO_ROOT, 'src/data/model-database'));
        const { QualityEvals } = require(path.join(REPO_ROOT, 'src/data/quality-evals'));
        const dbPath = this.options.dbPath || path.join(require('os').homedir(), '.llm-checker', 'models.db');
        if (!write && !require('fs').existsSync(dbPath)) return { db: null, evals: null };
        const database = new ModelDatabase({ dbPath, readOnly: !write });
        try {
            await database.initialize();
            const evals = new QualityEvals(database, { readOnly: !write });
            // Keep the small query facade shared across native SQLite and WASM.
            return { db: { prepare: sql => ({ all: () => database.all(sql), get: () => database.get(sql) }),
                close: () => database.close() }, evals };
        } catch (error) {
            database.close();
            throw error;
        }
    }

    async #catalogCount() {
        const { db } = await this.#openEvals();
        if (!db) return 0;
        try { return db.prepare('SELECT COUNT(*) c FROM models').get().c; }
        finally { db.close(); }
    }

    #runCli(args) {
        return new Promise((resolve, reject) => {
            const { execFile } = require('child_process');
            execFile(process.execPath, [path.join(REPO_ROOT, 'bin', 'cli.js'), ...args],
                { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
                (err, stdout, stderr) => (err ? reject(err) : resolve(`${stdout}${stderr}`)));
        });
    }
}

module.exports = { Core, classifyFit, FIT, toCard, harvest, harvestCategories, CATEGORIES, tidyReason };
