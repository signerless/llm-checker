const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ModelDatabase = require('../src/data/model-database');

async function run() {
    const seedDbPath = path.join(__dirname, '..', 'src', 'data', 'seed', 'models.db');
    const database = new ModelDatabase({
        dbPath: seedDbPath,
        seedDbPath: path.join(__dirname, 'missing-seed.db')
    });

    try {
        await database.initialize();

        const ollamaStats = database.getStats();
        const registryStats = database.getRegistryStats();

        assert.ok(ollamaStats.models >= 100, `Expected at least 100 Ollama models, got ${ollamaStats.models}`);
        assert.ok(ollamaStats.variants >= 1000, `Expected at least 1000 Ollama variants, got ${ollamaStats.variants}`);
        assert.ok(registryStats.sources >= 3, `Expected at least 3 registry sources, got ${registryStats.sources}`);
        assert.ok(registryStats.repos >= 2500, `Expected at least 2500 registry repos, got ${registryStats.repos}`);
        assert.ok(
            registryStats.artifacts >= 25000,
            `Expected at least 25000 registry artifacts, got ${registryStats.artifacts}`
        );

        const bySource = Object.fromEntries(
            registryStats.bySource.map((row) => [row.source_id, row.artifact_count])
        );
        assert.ok(bySource.ollama >= 1000, `Expected Ollama artifacts in registry, got ${bySource.ollama || 0}`);
        assert.ok(bySource.huggingface >= 20000, `Expected Hugging Face artifacts, got ${bySource.huggingface || 0}`);
        assert.ok(bySource.gpt4all >= 1, `Expected GPT4All artifacts, got ${bySource.gpt4all || 0}`);

        const rows = database.searchModelArtifacts('', { limit: 100 });
        assert.ok(rows.some((row) => row.download_url || row.install_command), 'Expected installable/downloadable artifacts');
        assert.ok(rows.some((row) => row.runtime_support.includes('ollama')), 'Expected Ollama-compatible artifacts');

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-registry-seed-import-'));
        try {
            const userDbPath = path.join(tempDir, 'models.db');
            const emptyDatabase = new ModelDatabase({
                dbPath: userDbPath,
                seedDbPath: path.join(tempDir, 'missing-seed.db'),
                disableRegistrySeedImport: true
            });
            await emptyDatabase.initialize();
            assert.strictEqual(emptyDatabase.getRegistryStats().artifacts, 0);
            emptyDatabase.close();

            const userDatabase = new ModelDatabase({
                dbPath: userDbPath,
                seedDbPath
            });
            await userDatabase.initialize();
            const importedStats = userDatabase.getRegistryStats();
            assert.ok(
                importedStats.artifacts >= 25000,
                `Expected existing user DB to import packaged registry, got ${importedStats.artifacts}`
            );
            userDatabase.close();
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }

        console.log('[OK] model-registry-seed.test.js passed');
    } finally {
        database.close();
    }
}

if (require.main === module) {
    run().catch((error) => {
        console.error('[FAIL] model-registry-seed.test.js failed');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
