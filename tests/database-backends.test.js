const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ModelDatabase = require('../src/data/model-database');

async function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-sqlite-'));
    let nativeAvailable = false;
    try { nativeAvailable = Boolean(require('node:sqlite').DatabaseSync); } catch {}
    const modes = nativeAvailable ? ['wasm', 'native'] : ['wasm'];
    const outputs = [];
    try {
        for (const sqliteBackend of modes) {
            const options = { dbPath: path.join(dir, `${sqliteBackend}.db`), sqliteBackend };
            const db = new ModelDatabase(options);
            try {
                await db.initialize();
                assert.strictEqual(db.useNativeSqlite, sqliteBackend === 'native');
                outputs.push(db.all('SELECT * FROM model_artifacts ORDER BY id'));
                assert.strictEqual(db.get('SELECT id FROM models WHERE id = ?', ['missing-model']), null);
                db.beginBatch(); db.beginBatch();
                db.upsertModel({ id: 'test-model', name: "Quoted ' model", description: 'Unicode: café 日本語' });
                db.upsertVariant({ model_id: 'test-model', tag: 'test-model:1b', params_b: 1, size_gb: 0.5 });
                db.endBatch(); db.endBatch();
                db.close();
                await db.initialize();
                assert.strictEqual(db.get('SELECT description FROM models WHERE id = ?', ['test-model']).description, 'Unicode: café 日本語');
                assert.strictEqual(db.get('SELECT params_b FROM variants WHERE model_id = ?', ['test-model']).params_b, 1);
                assert.throws(() => db.all('SELECT missing_column FROM models'));
                assert.strictEqual(db.get('SELECT 1 AS n').n, 1, 'query errors leave the connection usable');
            } finally { db.close(); }
        }
        if (outputs.length === 2) assert.deepStrictEqual(outputs[1], outputs[0], 'native and WASM return the same full catalog');

        // Auto mode must work when Node has no built-in SQLite. Conversely,
        // supported Node versions must never require the optional WASM package.
        const originalLoad = Module._load;
        for (const block of nativeAvailable ? ['node:sqlite', 'sql.js'] : ['node:sqlite']) {
            const db = new ModelDatabase({ dbPath: path.join(dir, `auto-${block.replace(/\W/g, '-')}.db`) });
            Module._load = function(id, ...args) {
                if (id === block) {
                    const error = new Error(`Unavailable: ${id}`);
                    error.code = 'MODULE_NOT_FOUND';
                    throw error;
                }
                return originalLoad.call(this, id, ...args);
            };
            try {
                await db.initialize();
                assert.strictEqual(db.useNativeSqlite, block === 'sql.js');
                assert.ok(db.getModelCount() > 100);
            } finally { Module._load = originalLoad; db.close(); }
        }
        console.log(`database-backends.test.js: OK (${modes.join(', ')})`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
