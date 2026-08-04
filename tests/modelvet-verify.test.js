const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'enhanced_cli.js');
const modelvet = require('../src/security/modelvet-verifier');

// Isolate HOME so the spawned CLI resolves its model DB under a throwaway dir.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-home-'));

function runCli(args) {
    return spawnSync(process.execPath, [BIN_PATH, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            NO_COLOR: '1',
            HOME: TEST_HOME,
            USERPROFILE: TEST_HOME
        }
    });
}

function buildGguf({ version = 3, tensors = 0n, kvs = 0n } = {}) {
    const buf = Buffer.alloc(24);
    buf.write('GGUF', 0, 'ascii');
    buf.writeUInt32LE(version, 4);
    buf.writeBigUInt64LE(tensors, 8);
    buf.writeBigUInt64LE(kvs, 16);
    return buf;
}

function buildSafetensors({ shape = [1], bytes = 4 } = {}) {
    const end = shape.reduce((a, b) => a * b, 1) * 4;
    const header = Buffer.from(
        JSON.stringify({ x: { dtype: 'F32', shape, data_offsets: [0, end] } }),
        'utf8'
    );
    const buf = Buffer.alloc(8 + header.length + bytes);
    buf.writeBigUInt64LE(BigInt(header.length), 0);
    header.copy(buf, 8);
    return buf;
}

async function run() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-modelvet-'));

    try {
        assert.strictEqual(modelvet.isAvailable(), true, 'modelvet.wasm artifact should exist');

        // Valid empty GGUF v3 -> ACCEPT.
        const ggufOk = await modelvet.verifyBuffer(buildGguf());
        assert.strictEqual(ggufOk.format, 'gguf');
        assert.strictEqual(ggufOk.accepted, true);
        assert.strictEqual(ggufOk.violation, 0);
        assert.strictEqual(ggufOk.violationName, 'NONE');

        // Unsupported GGUF version -> REJECT with exact code and offset.
        const ggufBad = await modelvet.verifyBuffer(buildGguf({ version: 99 }));
        assert.strictEqual(ggufBad.accepted, false);
        assert.strictEqual(ggufBad.violation, 101);
        assert.strictEqual(ggufBad.violationName, 'VERSION_UNSUPPORTED');
        assert.strictEqual(ggufBad.offset, 4);
        assert.deepStrictEqual(ggufBad.detail, [99, 3]);

        // Valid safetensors -> ACCEPT.
        const stOk = await modelvet.verifyBuffer(buildSafetensors());
        assert.strictEqual(stOk.format, 'safetensors');
        assert.strictEqual(stOk.accepted, true);

        // safetensors whose declared extent runs past the buffer -> REJECT.
        const stBad = await modelvet.verifyBuffer(buildSafetensors({ shape: [2], bytes: 4 }));
        assert.strictEqual(stBad.accepted, false);
        assert.strictEqual(stBad.violationName, 'ST_DATA_EXTENT');

        // Truncated input -> REJECT (never an exception).
        const trunc = await modelvet.verifyBuffer(Buffer.from('GG'));
        assert.strictEqual(trunc.accepted, false);
        assert.strictEqual(trunc.violation, 1);
        assert.strictEqual(trunc.violationName, 'TRUNCATED');

        // verifyFile round-trip on real files.
        const okPath = path.join(tempDir, 'ok.gguf');
        const badPath = path.join(tempDir, 'bad.gguf');
        fs.writeFileSync(okPath, buildGguf());
        fs.writeFileSync(badPath, buildGguf({ version: 99 }));

        const fileOk = await modelvet.verifyFile(okPath);
        assert.strictEqual(fileOk.accepted, true);
        assert.strictEqual(fileOk.file, okPath);
        assert.strictEqual(fileOk.sizeBytes, 24);

        // CLI: ACCEPT -> exit 0.
        const cliOk = runCli(['verify', '--json', okPath]);
        assert.strictEqual(cliOk.status, 0, `expected exit 0, stderr: ${cliOk.stderr}`);
        const parsed = JSON.parse(cliOk.stdout);
        assert.strictEqual(parsed.verdict, 'accept');
        assert.strictEqual(parsed.format, 'gguf');

        // CLI: REJECT -> exit 1.
        const cliBad = runCli(['verify', '--json', badPath]);
        assert.strictEqual(cliBad.status, 1, `expected exit 1, stderr: ${cliBad.stderr}`);
        const parsedBad = JSON.parse(cliBad.stdout);
        assert.strictEqual(parsedBad.verdict, 'reject');
        assert.strictEqual(parsedBad.violationName, 'VERSION_UNSUPPORTED');

        // CLI: unreadable file -> exit 2 (no verdict).
        const cliMissing = runCli(['verify', path.join(tempDir, 'missing.gguf')]);
        assert.strictEqual(cliMissing.status, 2, `expected exit 2, got ${cliMissing.status}`);

        console.log('modelvet-verify tests: OK');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(TEST_HOME, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('modelvet-verify tests: FAILED');
    console.error(error);
    process.exit(1);
});
