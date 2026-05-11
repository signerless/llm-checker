const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BANNER_PATH = path.resolve(__dirname, '..', 'src', 'ui', 'banner-profesional-v2.txt');
const CANONICAL_BANNER_SHA256 = 'ddbc9788510a1577b6b584b46e4eb60409e46f8708305e6cbd6ec61e847f87f3';

function run() {
    const raw = fs.readFileSync(BANNER_PATH, 'utf8');
    const normalized = raw.replace(/\r\n/g, '\n');
    const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');

    assert.ok(
        normalized.includes('[ INTELLIGENT OLLAMA MODEL SELECTOR ]'),
        'canonical banner header marker is missing'
    );
    assert.ok(
        normalized.includes('[200+ DYNAMIC MODELS]'),
        'canonical banner features marker is missing'
    );
    assert.strictEqual(
        digest,
        CANONICAL_BANNER_SHA256,
        'startup banner changed: this file is treated as canonical product identity and must not be modified without explicit approval'
    );

    console.log('banner-canonical.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('banner-canonical.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
