const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ModelDatabase = require('../src/data/model-database');
const SyncManager = require('../src/data/sync-manager');

async function withTempDb(fn) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-speed-restore-'));
    const database = new ModelDatabase({
        dbPath: path.join(tempDir, 'models.db'),
        seedDbPath: path.join(tempDir, 'missing-seed.db'),
        disableRegistrySeedImport: true
    });
    try {
        await database.initialize();
        await fn(database);
    } finally {
        database.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function seedSpeedRow(database) {
    database.upsertModel({ id: 'llama3', name: 'llama3' });
    database.upsertVariant({ model_id: 'llama3', tag: '8b' });
    const variant = database.get(`SELECT id FROM variants WHERE model_id = ? AND tag = ?`, ['llama3', '8b']);
    database.addBenchmark({
        variant_id: variant.id,
        hardware_fingerprint: 'hw-1',
        tokens_per_second: 42.5,
        time_to_first_token: 0.2,
        memory_used_gb: 5.1,
        backend: 'cpu'
    });
    return variant;
}

async function run() {
    for (const foreignKeys of [false, true]) {
        await withTempDb(async (database) => {
            database.run(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
            const oldVariant = seedSpeedRow(database);
            const original = database.all('SELECT * FROM benchmarks')[0];
            const scraper = { scrapeAll: async (onModel) => {
                onModel({ id: 'llama3', name: 'llama3' }, [{ model_id: 'llama3', tag: '8b' }]);
            } };
            const sync = new SyncManager({ database, scraper, onProgress() {} });
            await sync.fullSync();
            const variant = database.get("SELECT id FROM variants WHERE model_id = 'llama3'");
            assert.notStrictEqual(variant.id, oldVariant.id, 'variant ids change during a rebuild');
            assert.deepStrictEqual(database.getBenchmarks(variant.id)[0], { ...original, variant_id: variant.id });
            database.reattachSpeedBenchmarks();
            assert.strictEqual(database.all('SELECT * FROM benchmarks').length, 1, 'reattachment never duplicates measurements');

            const beforeFailure = database.all('SELECT * FROM benchmarks');
            scraper.scrapeAll = async () => { throw new Error('network unavailable'); };
            await assert.rejects(sync.fullSync(), /network unavailable/);
            assert.deepStrictEqual(database.all('SELECT * FROM benchmarks'), beforeFailure);
            assert.strictEqual(database.getVariantCount(), 1, 'failed sync rolls the catalog back too');

            scraper.scrapeAll = async () => {};
            await sync.fullSync();
            assert.strictEqual(database.all('SELECT * FROM benchmarks').length, 1, 'missing model keeps telemetry');
            assert.strictEqual(database.all('SELECT * FROM benchmarks')[0].variant_id, null);
            // Persistence matters: an in-memory snapshot is insufficient across restarts.
            database.close(); database.db = null; database.initialized = false;
            await database.initialize();
            scraper.scrapeAll = async (onModel) => {
                onModel({ id: 'llama3', name: 'llama3' }, [{ model_id: 'llama3', tag: '8b' }]);
            };
            await sync.fullSync();
            const returned = database.get("SELECT id FROM variants WHERE model_id = 'llama3'");
            assert.deepStrictEqual(database.getBenchmarks(returned.id)[0], { ...original, variant_id: returned.id });
        });
    }

    await withTempDb((database) => {
        const variant = seedSpeedRow(database);
        // Recreate the shipped pre-migration schema, with real historical data.
        database.db.exec(`
            DROP TABLE benchmarks;
            CREATE TABLE benchmarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT, variant_id INTEGER NOT NULL,
                hardware_fingerprint TEXT NOT NULL, tokens_per_second REAL,
                time_to_first_token REAL, memory_used_gb REAL, backend TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (variant_id) REFERENCES variants(id) ON DELETE CASCADE
            );
            INSERT INTO benchmarks VALUES (17, ${variant.id}, 'legacy-hw', 42.5, 0.2, 5.1, 'cpu', '2026-01-01');
        `);
        database.migrateSpeedBenchmarks();
        database.migrateSpeedBenchmarks();
        const migrated = database.all('SELECT * FROM benchmarks')[0];
        assert.strictEqual(migrated.model_id, 'llama3');
        assert.strictEqual(migrated.tag, '8b');
        assert.strictEqual(migrated.id, 17);
        assert.strictEqual(migrated.created_at, '2026-01-01');
        database.clear();
        assert.strictEqual(database.all('SELECT * FROM benchmarks').length, 1);
    });

    console.log('[OK] speed-benchmark-sync-restore.test.js passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('[FAIL] speed-benchmark-sync-restore.test.js failed');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
