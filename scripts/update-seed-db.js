'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const rootDir = path.resolve(__dirname, '..');
const sourceDb = path.join(os.homedir(), '.llm-checker', 'models.db');
const seedDir = path.join(rootDir, 'src', 'data', 'seed');
const targetDb = path.join(seedDir, 'models.db');

if (!fs.existsSync(sourceDb)) {
    console.error(`Missing synced database at ${sourceDb}`);
    console.error('Run: node bin/cli.js sync --force');
    process.exit(1);
}

fs.mkdirSync(seedDir, { recursive: true });
fs.copyFileSync(sourceDb, targetDb);

console.log(`Seed database updated: ${path.relative(rootDir, targetDb)}`);
