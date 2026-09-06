const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Core, toCard } = require('../desktop/src/main/core');
const ModelDatabase = require('../src/data/model-database');
const { QualityEvals, SOURCES } = require('../src/data/quality-evals');

async function run() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ranking-desktop-'));
    const dbPath = path.join(directory, 'models.db');
    const db = new ModelDatabase({ dbPath, seedDbPath: path.join(directory, 'none'), disableRegistrySeedImport: true });
    try {
        await db.initialize();
        db.upsertModel({ id: 'test', name: 'test' });
        new QualityEvals(db).refreshCatalogCohort([{ name: 'test' }]);
        db.close();
        let scans = 0;
        let invalidations = 0;
        const requests = [];
        const core = new Core({
            dbPath,
            detectRuntimes: async () => [],
            fetchImpl: async url => { requests.push(url); return new Response('unavailable', { status: 503 }); },
            checkerFactory: () => ({
                intelligentRecommender: { invalidateQualityEvals() { invalidations++; } },
                async analyze() {
                    scans++;
                    return {
                        hardware: { cpu: { cores: 8 }, memory: { totalGB: 26 },
                            gpu: { unified: true, vramGB: 0.25 }, summary: { effectiveMemory: 13 } },
                        recommendations: { recommendations: { general: { bestModels: [{
                            model_name: 'test', model_identifier: 'test:7b', runtime: 'ollama',
                            estimatedRAM: 6, quantization: 'Q4_K_M', size: 7
                        }] } } }
                    };
                }
            })
        });
        const initial = await core.scan();
        assert.strictEqual(initial.phase, 'ready');
        assert.strictEqual(initial.budgetGB, 13);
        assert.strictEqual(initial.groups[0].models[0].fit, 'fits');
        assert.strictEqual(toCard({ estimatedRAM: 100 }, null).fit, 'unknown');
        const known = toCard({ estimatedRAM: 6, runtime: 'llama.cpp',
            model_identifier: 'model-Q4_K_M.gguf',
            artifact: { repo_id: 'author/model', filename: 'model-Q4_K_M.gguf' },
            memory: { budgetGB: 13 }, context: { effective: 2048, limited: true }
        }, 0.25, [{ id: 'ollama', installed: true }], {});
        assert.strictEqual(known.fit, 'fits');
        assert.strictEqual(known.runtime, 'llama.cpp', 'desktop must retain the scored runtime');
        assert.ok(known.commands.pull.includes('author/model/resolve/main/model-Q4_K_M.gguf'));
        assert.ok(known.commands.run.includes('--ctx-size 2048'));
        const refresh = await core.runAction('refresh-benchmarks');
        assert.deepStrictEqual(refresh.rows.map(row => row[0]), Object.keys(SOURCES));
        assert.ok(requests.length >= Object.keys(SOURCES).length);
        assert.ok(refresh.rows.every(row => row[2] !== 'ok'), 'source errors must remain visible');
        assert.strictEqual(invalidations, 1);
        assert.strictEqual(scans, 2, 'refresh must recalculate recommendations');
        assert.strictEqual(core.snapshot().phase, 'ready');
        await core.runAction('coverage');
        await Promise.all([core.scan(), core.scan()]);
        assert.strictEqual(scans, 4, 'scans must serialize without dropping work');
        console.log('desktop-core.test.js: OK');
    } finally {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
