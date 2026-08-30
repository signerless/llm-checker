const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ModelDatabase = require('../src/data/model-database');

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
    await withTempDb((database) => {
        seedSpeedRow(database);
        const snapshot = database.snapshotSpeedBenchmarks();
        assert.strictEqual(snapshot.length, 1);

        database.clear();
        assert.strictEqual(database.get(`SELECT COUNT(*) as count FROM benchmarks`).count, 0);

        database.upsertModel({ id: 'llama3', name: 'llama3' });
        database.upsertVariant({ model_id: 'llama3', tag: '8b' });
        database.restoreSpeedBenchmarks(snapshot);
        database.restoreSpeedBenchmarks(snapshot);

        const restored = database.all(`SELECT tokens_per_second, hardware_fingerprint FROM benchmarks`);
        assert.strictEqual(restored.length, 1, 'restore must replace, not append');
        assert.strictEqual(restored[0].tokens_per_second, 42.5);
        assert.strictEqual(restored[0].hardware_fingerprint, 'hw-1');
        assert.strictEqual(database.snapshotSpeedBenchmarks().length, 1);
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
