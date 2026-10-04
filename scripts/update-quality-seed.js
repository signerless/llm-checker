#!/usr/bin/env node
'use strict';

/**
 * Refresh the benchmark tables inside the packaged snapshot so a fresh install
 * ranks by measured quality. A source that cannot be fetched keeps the scores
 * the snapshot already holds; the build fails only when no source has data.
 */

const path = require('path');

const ModelDatabase = require('../src/data/model-database');
const { QualityEvals, SOURCES } = require('../src/data/quality-evals');

const rootDir = path.resolve(__dirname, '..');
const seedDbPath = path.join(rootDir, 'src', 'data', 'seed', 'models.db');

async function main() {
    const database = new ModelDatabase({
        dbPath: seedDbPath,
        seedDbPath: path.join(rootDir, 'missing-seed.db'),
        disableRegistrySeedImport: true
    });
    await database.initialize();
    try {
        const quality = new QualityEvals(database);
        for (const source of Object.keys(SOURCES)) {
            try {
                const report = await quality.ingest(source);
                console.log(`[quality-seed] ${source}: ${report.rows} scores`);
            } catch (error) {
                console.log(`[quality-seed] ${source}: kept previous scores (${error.message})`);
            }
        }
        const catalog = database.all('SELECT name FROM models');
        quality.refreshCatalogCohort(catalog);
        const stats = quality.stats();
        const coverage = quality.coverage(catalog);
        console.log(`[quality-seed] ${stats.evals} scores from ${stats.sources.length} sources; ` +
            `${coverage.measured}/${coverage.total} catalog families measured`);
        if (stats.evals === 0) throw new Error('No benchmark source returned data');
        database.vacuum();
    } finally {
        database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
