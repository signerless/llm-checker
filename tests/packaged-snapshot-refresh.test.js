/**
 * Packaged snapshot refresh test
 * ==============================
 *   - An existing user database adopts a newer packaged snapshot per part
 *     (Ollama catalog, each registry source) and keeps speed measurements.
 *   - A part the user refreshed after the snapshot was built is kept.
 *   - An unchanged snapshot is not imported twice.
 *   - A catalog sync rebuilds the registry's Ollama rows instead of leaving
 *     registry recommendations without Ollama models.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ModelDatabase = require('../src/data/model-database');
const SyncManager = require('../src/data/sync-manager');

async function buildDatabase(dbPath, { lastSync, hfIngestedAt, modelId, hfRepo }) {
    const database = new ModelDatabase({
        dbPath,
        seedDbPath: path.join(path.dirname(dbPath), 'missing-seed.db'),
        disableRegistrySeedImport: true
    });
    await database.initialize();
    database.upsertModel({ id: modelId, name: modelId, capabilities: ['chat'], pulls: 5 });
    database.upsertVariant({ model_id: modelId, tag: `${modelId}:8b`, params_b: 8, quant: 'Q4_K_M', size_gb: 4.6, context_length: 131072 });
    database.setLastSync(lastSync);
    database.upsertRegistrySource({ id: 'huggingface', name: 'Hugging Face Hub', last_ingested_at: hfIngestedAt });
    database.upsertRegistryRepo({ id: `huggingface:${hfRepo}`, source_id: 'huggingface', repo_id: hfRepo });
    database.upsertModelArtifact({
        id: `huggingface:${hfRepo}:model.gguf`, source_id: 'huggingface', repo_key: `huggingface:${hfRepo}`,
        repo_id: hfRepo, artifact_name: 'model.gguf', format: 'gguf', parameter_count_b: 8
    });
    database.rebuildOllamaRegistry();
    return database;
}

async function run() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-snapshot-refresh-'));
    try {
        const seedPath = path.join(tempDir, 'seed.db');
        const seedDatabase = await buildDatabase(seedPath, {
            lastSync: '2026-09-01T00:00:00.000Z', hfIngestedAt: '2026-09-01T00:00:00.000Z',
            modelId: 'qwen3', hfRepo: 'org/new-model-GGUF'
        });
        const { QualityEvals } = require('../src/data/quality-evals');
        const seedQuality = new QualityEvals(seedDatabase);
        seedQuality.db.prepare(`INSERT INTO quality_sources (id, display_name, data_url, independent, fetched_at, row_count)
            VALUES ('livebench', 'LiveBench', 'https://livebench.ai', 1, '2026-09-01T00:00:00.000Z', 1)`).run();
        seedQuality.db.prepare(`INSERT INTO quality_evals (source_id, bench_model_name, family_key, params_b, variant_role,
            metric, category, raw_score, raw_scale_max) VALUES ('livebench', 'qwen3-8b', 'qwen3', 8, 'instruct',
            'livebench_coding', 'coding', 61.5, 100)`).run();
        seedDatabase.close();

        const userPath = path.join(tempDir, 'user.db');
        const user = await buildDatabase(userPath, {
            lastSync: '2026-05-01T00:00:00.000Z', hfIngestedAt: '2026-05-01T00:00:00.000Z',
            modelId: 'llama3.1', hfRepo: 'org/old-model-GGUF'
        });
        const variantId = user.get(`SELECT id FROM variants WHERE tag = 'llama3.1:8b'`).id;
        user.addBenchmark({
            variant_id: variantId, hardware_fingerprint: 'hw', tokens_per_second: 42,
            time_to_first_token: 0.2, memory_used_gb: 5, backend: 'cuda'
        });
        user.close();

        const upgraded = new ModelDatabase({ dbPath: userPath, seedDbPath: seedPath });
        await upgraded.initialize();
        assert.deepStrictEqual(upgraded.all('SELECT id FROM models').map((row) => row.id), ['qwen3'], 'newer catalog adopted');
        assert.strictEqual(upgraded.getLastSync(), '2026-09-01T00:00:00.000Z');
        assert.deepStrictEqual(upgraded.all(`SELECT repo_id FROM model_artifacts WHERE source_id = 'huggingface'`)
            .map((row) => row.repo_id), ['org/new-model-GGUF'], 'newer registry source adopted');
        assert.deepStrictEqual(upgraded.all(`SELECT artifact_name FROM model_artifacts WHERE source_id = 'ollama'`)
            .map((row) => row.artifact_name), ['qwen3:8b'], 'Ollama registry rows follow the catalog');
        assert.deepStrictEqual(upgraded.all('SELECT bench_model_name, raw_score FROM quality_evals').map((row) => ({ ...row })),
            [{ bench_model_name: 'qwen3-8b', raw_score: 61.5 }], 'benchmark scores ship with the snapshot');
        assert.deepStrictEqual(upgraded.all('SELECT family_key FROM catalog_families').map((row) => row.family_key), ['qwen3'],
            'the cohort follows the imported catalog');
        const benchmark = upgraded.get('SELECT model_id, tag, tokens_per_second FROM benchmarks');
        assert.deepStrictEqual({ ...benchmark }, { model_id: 'llama3.1', tag: 'llama3.1:8b', tokens_per_second: 42 },
            'speed measurements survive');
        upgraded.close();

        const reopened = new ModelDatabase({ dbPath: userPath, seedDbPath: seedPath });
        await reopened.initialize();
        assert.strictEqual(await reopened.seedRegistryFromPackagedSnapshotIfNeeded(), false, 'an unchanged snapshot is not reimported');
        reopened.close();

        const freshPath = path.join(tempDir, 'fresh.db');
        const fresh = await buildDatabase(freshPath, {
            lastSync: '2026-10-01T00:00:00.000Z', hfIngestedAt: '2026-10-01T00:00:00.000Z',
            modelId: 'gemma3', hfRepo: 'org/user-synced-GGUF'
        });
        fresh.close();
        const kept = new ModelDatabase({ dbPath: freshPath, seedDbPath: seedPath });
        await kept.initialize();
        assert.deepStrictEqual(kept.all('SELECT id FROM models').map((row) => row.id), ['gemma3'], 'a newer local sync wins');
        assert.deepStrictEqual(kept.all(`SELECT repo_id FROM model_artifacts WHERE source_id = 'huggingface'`)
            .map((row) => row.repo_id), ['org/user-synced-GGUF'], 'a newer local registry-sync wins');

        const syncManager = new SyncManager({
            database: kept,
            onProgress: () => {},
            onError: (message) => { throw new Error(message); },
            scraper: {
                scrapeAll: async (onModel) => onModel(
                    { id: 'phi4', name: 'phi4', capabilities: ['chat'], pulls: 1 },
                    [{ model_id: 'phi4', tag: 'phi4:14b', params_b: 14.7, quant: 'Q4_K_M', size_gb: 8.4, context_length: 16384 }]
                )
            }
        });
        await syncManager.fullSync();
        assert.deepStrictEqual(kept.all(`SELECT artifact_name FROM model_artifacts WHERE source_id = 'ollama'`)
            .map((row) => row.artifact_name), ['phi4:14b'], 'a full sync rebuilds the Ollama registry rows');
        kept.close();

        console.log('packaged-snapshot-refresh.test.js: OK');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    run().catch((error) => {
        console.error('packaged-snapshot-refresh.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
