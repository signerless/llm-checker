#!/usr/bin/env node
'use strict';

const path = require('path');

const ModelDatabase = require('../src/data/model-database');
const { RegistryIngestor } = require('../src/data/registry-ingestors');

const rootDir = path.resolve(__dirname, '..');
const seedDbPath = path.join(rootDir, 'src', 'data', 'seed', 'models.db');

function readOption(name, fallback) {
    const prefix = `--${name}=`;
    const exactIndex = process.argv.indexOf(`--${name}`);
    if (exactIndex !== -1 && process.argv[exactIndex + 1]) {
        return process.argv[exactIndex + 1];
    }

    const inline = process.argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);

    const envName = `LLM_CHECKER_${name.replace(/-/g, '_').toUpperCase()}`;
    return process.env[envName] || fallback;
}

function toPositiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function main() {
    const sources = readOption('sources', 'ollama,huggingface,gpt4all');
    const hfLimit = toPositiveInt(readOption('hf-limit', '3000'), 3000);
    const gpt4AllLimit = toPositiveInt(readOption('gpt4all-limit', '1000'), 1000);
    const ollamaLimit = toPositiveInt(readOption('ollama-limit', '10000'), 10000);
    const minRepos = toPositiveInt(readOption('min-repos', '2500'), 2500);
    const minArtifacts = toPositiveInt(readOption('min-artifacts', '25000'), 25000);

    const database = new ModelDatabase({
        dbPath: seedDbPath,
        seedDbPath: path.join(rootDir, 'missing-seed.db')
    });

    await database.initialize();

    const selectedSources = sources
        .split(',')
        .map((source) => source.trim().toLowerCase())
        .filter(Boolean);

    database.beginBatch();
    try {
        for (const source of selectedSources) {
            const normalized = source === 'hf' ? 'huggingface' : source;
            database.clearRegistrySource(normalized);
        }
    } finally {
        database.endBatch();
    }

    const ingestor = new RegistryIngestor({
        database,
        onProgress: (info) => {
            if (info.message) {
                console.log(`[registry-seed] ${info.message}`);
            }
        }
    });

    const collections = [];
    for (const source of selectedSources) {
        if (source === 'huggingface' || source === 'hf') {
            collections.push(...await ingestor.collectHuggingFace({ limit: hfLimit }));
        } else if (source === 'gpt4all') {
            collections.push(...await ingestor.collectGpt4All({ limit: gpt4AllLimit }));
        } else if (source === 'ollama') {
            collections.push(...ingestor.collectOllamaFromDatabase({ limit: ollamaLimit }));
        } else {
            throw new Error(`Unsupported registry source: ${source}`);
        }
    }

    ingestor.storeCollections(collections);

    const stats = database.getRegistryStats();
    database.close();

    console.log(`Registry seed updated: ${path.relative(rootDir, seedDbPath)}`);
    console.log(`Sources: ${stats.sources}`);
    console.log(`Repositories: ${stats.repos}`);
    console.log(`Artifacts: ${stats.artifacts}`);
    console.log(`By source: ${stats.bySource.map((row) => `${row.source_id}=${row.artifact_count}`).join(', ')}`);

    if (stats.repos < minRepos || stats.artifacts < minArtifacts) {
        throw new Error(
            `Registry seed looks incomplete: ${stats.repos} repos, ${stats.artifacts} artifacts ` +
            `(minimum ${minRepos} repos, ${minArtifacts} artifacts)`
        );
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
