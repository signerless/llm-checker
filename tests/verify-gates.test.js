const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'enhanced_cli.js');
const {
    parseModelName,
    resolveModelBlobs,
    verifyOllamaModel
} = require('../src/security/ollama-blobs');

function stripAnsi(text = '') {
    return String(text).replace(/\[[0-9;]*m/g, '');
}

// Isolate HOME so the spawned CLI resolves its model DB (and the default
// ~/.ollama/models root) under a throwaway dir.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-home-'));
const OLLAMA_ROOT = path.join(TEST_HOME, '.ollama', 'models');

const DIGEST_OK = 'aa'.repeat(32);
const DIGEST_BAD = 'bb'.repeat(32);
const DIGEST_GONE = 'cc'.repeat(32);
const DIGEST_HUGE = 'ee'.repeat(32);
const TOO_LARGE_BYTES = (3 * 1024 * 1024 * 1024) + 1;

function buildGguf({ version = 3 } = {}) {
    const buf = Buffer.alloc(24);
    buf.write('GGUF', 0, 'ascii');
    buf.writeUInt32LE(version, 4);
    buf.writeBigUInt64LE(0n, 8);
    buf.writeBigUInt64LE(0n, 16);
    return buf;
}

function writeManifest(name, tag, digest, size = 24) {
    const manifestDir = path.join(OLLAMA_ROOT, 'manifests', 'registry.ollama.ai', 'library', name);
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        layers: [
            { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${digest}`, size },
            { mediaType: 'application/vnd.ollama.image.license', digest: `sha256:${'dd'.repeat(32)}`, size: 10 }
        ]
    };
    fs.writeFileSync(path.join(manifestDir, tag), JSON.stringify(manifest));
}

function writeBlob(digest, contents) {
    const blobDir = path.join(OLLAMA_ROOT, 'blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    fs.writeFileSync(path.join(blobDir, `sha256-${digest}`), contents);
}

function writeSparseBlob(digest, size) {
    const blobDir = path.join(OLLAMA_ROOT, 'blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    const blobPath = path.join(blobDir, `sha256-${digest}`);
    const fd = fs.openSync(blobPath, 'w');
    try {
        fs.ftruncateSync(fd, size);
    } finally {
        fs.closeSync(fd);
    }
}

function buildFakeOllamaTree() {
    writeManifest('tinyok', 'latest', DIGEST_OK);
    writeBlob(DIGEST_OK, buildGguf({ version: 3 }));
    writeManifest('tinybad', 'latest', DIGEST_BAD);
    writeBlob(DIGEST_BAD, buildGguf({ version: 99 }));
    // Manifest exists but the blob was never written (partial install).
    writeManifest('tinygone', 'latest', DIGEST_GONE);
    // Sparse file exercises the verifier's 3 GiB wasm32 guard without using
    // 3 GiB of physical disk space or reading the contents into memory.
    writeManifest('tinyhuge', 'latest', DIGEST_HUGE, TOO_LARGE_BYTES);
    writeSparseBlob(DIGEST_HUGE, TOO_LARGE_BYTES);
}

// Pre-seed the Ollama registry scraper cache so checker.analyze() (called by
// `installed`) reads the cache instead of scraping ollama.com over the network.
function seedScraperCache() {
    const cacheDir = path.join(TEST_HOME, '.llm-checker', 'cache', 'ollama');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
        path.join(cacheDir, 'ollama-detailed-models.json'),
        JSON.stringify({
            models: [],
            total_count: 0,
            cached_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
        })
    );
}

// Minimal fake Ollama server (/api/version + /api/tags only). It must run in
// a SEPARATE process: spawnSync blocks this process's event loop, so an
// in-process server could never answer the CLI's requests.
const FAKE_SERVER_SCRIPT = `
const http = require('http');
const models = [
    { name: 'tinyok:latest', size: 24, details: { family: 'tinyok', parameter_size: '1B', quantization_level: 'Q4_0', format: 'gguf' } },
    { name: 'tinybad:latest', size: 24, details: { family: 'tinybad', parameter_size: '1B', quantization_level: 'Q4_0', format: 'gguf' } },
    { name: 'tinygone:latest', size: 24, details: { family: 'tinygone', parameter_size: '1B', quantization_level: 'Q4_0', format: 'gguf' } },
    { name: 'tinyhuge:latest', size: ${TOO_LARGE_BYTES}, details: { family: 'tinyhuge', parameter_size: '7B', quantization_level: 'Q4_0', format: 'gguf' } }
];
const server = http.createServer((req, res) => {
    if (req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.0.0-test' }));
    } else if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models }));
    } else {
        res.writeHead(404);
        res.end('not found');
    }
});
server.listen(0, '127.0.0.1', () => {
    process.stdout.write('PORT ' + server.address().port + '\\n');
});
`;

function startFakeOllamaServer(workDir) {
    const scriptPath = path.join(workDir, 'fake-ollama-server.js');
    fs.writeFileSync(scriptPath, FAKE_SERVER_SCRIPT);
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    return new Promise((resolve, reject) => {
        let buffer = '';
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            const match = buffer.match(/PORT (\d+)/);
            if (match) {
                resolve({ child, host: `http://127.0.0.1:${match[1]}` });
            }
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`fake ollama server exited early (${code})`)));
    });
}

// Fake `ollama` binary so ai-run's `which ollama` preflight passes.
function buildFakeOllamaBin() {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-bin-'));
    const binPath = path.join(binDir, 'ollama');
    fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return binDir;
}

function runCli(args, extraEnv = {}) {
    return spawnSync(process.execPath, [BIN_PATH, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            NO_COLOR: '1',
            HOME: TEST_HOME,
            USERPROFILE: TEST_HOME,
            ...extraEnv
        }
    });
}

async function run() {
    buildFakeOllamaTree();
    seedScraperCache();
    const fakeBinDir = buildFakeOllamaBin();
    const server = await startFakeOllamaServer(TEST_HOME);
    const ollamaHost = server.host;

    try {
        // --- Unit: name parsing ---
        assert.deepStrictEqual(parseModelName('llama3.2:3b'), { segments: ['registry.ollama.ai', 'library', 'llama3.2'], tag: '3b' });
        assert.deepStrictEqual(parseModelName('llama3.2'), { segments: ['registry.ollama.ai', 'library', 'llama3.2'], tag: 'latest' });
        assert.deepStrictEqual(parseModelName('hf.co/user/repo:tag'), { segments: ['hf.co', 'user', 'repo'], tag: 'tag' });
        assert.deepStrictEqual(parseModelName('user/llama3.2'), { segments: ['registry.ollama.ai', 'user', 'llama3.2'], tag: 'latest' });
        assert.strictEqual(parseModelName(''), null);

        // --- Unit: blob resolution against the fake tree (via OLLAMA_MODELS) ---
        process.env.OLLAMA_MODELS = OLLAMA_ROOT;
        try {
            const resolved = resolveModelBlobs('tinyok:latest');
            assert.strictEqual(resolved.status, 'resolved');
            assert.strictEqual(resolved.blobs.length, 1);
            assert.strictEqual(resolved.blobs[0].path, path.join(OLLAMA_ROOT, 'blobs', `sha256-${DIGEST_OK}`));

            const missingBlob = resolveModelBlobs('tinygone:latest');
            assert.strictEqual(missingBlob.status, 'skipped');
            assert.ok(missingBlob.reason.includes('blob file missing'), missingBlob.reason);

            const missingManifest = resolveModelBlobs('nope:latest');
            assert.strictEqual(missingManifest.status, 'skipped');
            assert.ok(missingManifest.reason.includes('no local manifest'), missingManifest.reason);

            // --- Unit: verifyOllamaModel composition ---
            const verified = await verifyOllamaModel('tinyok:latest');
            assert.strictEqual(verified.status, 'verified');
            assert.strictEqual(verified.report.accepted, true);
            assert.strictEqual(verified.report.violationName, 'NONE');

            const rejected = await verifyOllamaModel('tinybad:latest');
            assert.strictEqual(rejected.status, 'rejected');
            assert.strictEqual(rejected.report.violationName, 'VERSION_UNSUPPORTED');

            const skipped = await verifyOllamaModel('tinygone:latest');
            assert.strictEqual(skipped.status, 'skipped');

            const tooLarge = await verifyOllamaModel('tinyhuge:latest');
            assert.strictEqual(tooLarge.status, 'skipped');
            assert.strictEqual(tooLarge.code, 'MODELVET_FILE_TOO_LARGE');
            assert.ok(tooLarge.reason.includes('limited to 3 GiB'), tooLarge.reason);
        } finally {
            delete process.env.OLLAMA_MODELS;
        }

        // --- CLI: installed --verify --json (fake server + fake blob tree) ---
        const cliEnv = { OLLAMA_HOST: ollamaHost };
        const jsonResult = runCli(['installed', '--verify', '--json'], cliEnv);
        assert.strictEqual(jsonResult.status, 1,
            `rejected model should make installed --verify exit 1; stderr: ${jsonResult.stderr}`);
        const payload = JSON.parse(jsonResult.stdout);
        assert.strictEqual(payload.length, 4, 'expected 4 installed models in JSON output');
        const byName = Object.fromEntries(payload.map((m) => [m.name, m]));

        assert.strictEqual(byName['tinyok:latest'].verification.status, 'verified');
        assert.strictEqual(byName['tinyok:latest'].verification.report.verdict, 'accept');

        assert.strictEqual(byName['tinybad:latest'].verification.status, 'rejected');
        assert.strictEqual(byName['tinybad:latest'].verification.report.violationName, 'VERSION_UNSUPPORTED');

        assert.strictEqual(byName['tinygone:latest'].verification.status, 'skipped');
        assert.ok(byName['tinygone:latest'].verification.reason.length > 0);

        assert.strictEqual(byName['tinyhuge:latest'].verification.status, 'skipped');
        assert.strictEqual(byName['tinyhuge:latest'].verification.code, 'MODELVET_FILE_TOO_LARGE');

        // --- CLI: installed --json without --verify stays unchanged ---
        const plainResult = runCli(['installed', '--json'], cliEnv);
        assert.strictEqual(plainResult.status, 0, `stderr: ${plainResult.stderr}`);
        const plainPayload = JSON.parse(plainResult.stdout);
        assert.ok(plainPayload.every((m) => !('verification' in m)),
            'verification field must not appear without --verify');

        // --- CLI: installed --verify human output ---
        const humanResult = runCli(['installed', '--verify'], cliEnv);
        assert.strictEqual(humanResult.status, 1, `stderr: ${humanResult.stderr}`);
        const humanOut = stripAnsi(humanResult.stdout);
        assert.ok(humanOut.includes('VERSION_UNSUPPORTED'), 'human output should show the violation name');
        assert.ok(humanOut.includes('skipped:'), 'human output should show skipped entries');
        assert.ok(humanOut.includes('structural only'), 'human output should keep the ACCEPT caveat');

        // --- CLI: ai-run --verify gate (fake ollama binary + fake server) ---
        const aiEnv = {
            OLLAMA_HOST: ollamaHost,
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`
        };

        const invalidOverride = runCli(['ai-run', '--allow-unverified', '--reference-only'], aiEnv);
        assert.strictEqual(invalidOverride.status, 1, '--allow-unverified without --verify must be rejected');
        assert.ok(
            stripAnsi(`${invalidOverride.stdout}\n${invalidOverride.stderr}`).includes(
                '--allow-unverified requires --verify'
            ),
            'invalid override use should explain the required verification flag'
        );

        const aiReject = runCli(['ai-run', '-m', 'tinybad:latest', '--verify', '--reference-only'], aiEnv);
        assert.strictEqual(aiReject.status, 1,
            `ai-run must refuse to run a REJECTED model; stdout: ${aiReject.stdout}\nstderr: ${aiReject.stderr}`);
        // ora writes spinner results to stderr; check the combined output.
        const aiRejectOut = stripAnsi(`${aiReject.stdout}\n${aiReject.stderr}`);
        assert.ok(aiRejectOut.includes('REJECTED'), 'ai-run should print the rejection');
        assert.ok(aiRejectOut.includes('VERSION_UNSUPPORTED'), 'ai-run should print the violation name');
        assert.ok(aiRejectOut.includes('Refusing to run'), 'ai-run should explain the refusal');

        const aiRejectOverride = runCli([
            'ai-run', '-m', 'tinybad:latest', '--verify', '--allow-unverified', '--reference-only'
        ], aiEnv);
        assert.strictEqual(aiRejectOverride.status, 1,
            `--allow-unverified must never bypass REJECT; stdout: ${aiRejectOverride.stdout}\nstderr: ${aiRejectOverride.stderr}`);
        const aiRejectOverrideOut = stripAnsi(`${aiRejectOverride.stdout}\n${aiRejectOverride.stderr}`);
        assert.ok(aiRejectOverrideOut.includes('REJECTED'), 'override attempt should still report REJECT');
        assert.ok(aiRejectOverrideOut.includes('Refusing to run'), 'override attempt should still refuse to run');

        const aiAccept = runCli(['ai-run', '-m', 'tinyok:latest', '--verify', '--reference-only'], aiEnv);
        assert.strictEqual(aiAccept.status, 0,
            `ai-run should continue on ACCEPT; stdout: ${aiAccept.stdout}\nstderr: ${aiAccept.stderr}`);
        const aiAcceptOut = stripAnsi(`${aiAccept.stdout}\n${aiAccept.stderr}`);
        assert.ok(aiAcceptOut.includes('ACCEPT'), 'ai-run should report the ACCEPT verdict');

        const aiSkip = runCli(['ai-run', '-m', 'tinygone:latest', '--verify', '--reference-only'], aiEnv);
        assert.strictEqual(aiSkip.status, 2,
            `ai-run must fail closed when verification is unavailable; stdout: ${aiSkip.stdout}\nstderr: ${aiSkip.stderr}`);
        const aiSkipOut = stripAnsi(`${aiSkip.stdout}\n${aiSkip.stderr}`);
        assert.ok(aiSkipOut.includes('Verification unavailable'),
            'ai-run should explain that verification is unavailable');
        assert.ok(aiSkipOut.includes('fail-closed'),
            'ai-run should explain its fail-closed default');

        const aiHuge = runCli(['ai-run', '-m', 'tinyhuge:latest', '--verify', '--reference-only'], aiEnv);
        assert.strictEqual(aiHuge.status, 2,
            `ai-run must fail closed above the 3 GiB WASM limit; stdout: ${aiHuge.stdout}\nstderr: ${aiHuge.stderr}`);
        const aiHugeOut = stripAnsi(`${aiHuge.stdout}\n${aiHuge.stderr}`);
        assert.ok(aiHugeOut.includes('limited to 3 GiB'), '3 GiB failure should explain the WASM limit');
        assert.ok(aiHugeOut.includes('--allow-unverified'), 'failure should name the explicit override');

        const aiHugeOverride = runCli([
            'ai-run', '-m', 'tinyhuge:latest', '--verify', '--allow-unverified', '--reference-only'
        ], aiEnv);
        assert.strictEqual(aiHugeOverride.status, 0,
            `explicit override should continue on an unverifiable model; stdout: ${aiHugeOverride.stdout}\nstderr: ${aiHugeOverride.stderr}`);
        const aiHugeOverrideOut = stripAnsi(`${aiHugeOverride.stdout}\n${aiHugeOverride.stderr}`);
        assert.ok(aiHugeOverrideOut.includes('Continuing without verification'),
            'override continuation should be explicit in output');

        console.log('verify-gates.test.js: OK');
    } finally {
        server.child.kill();
        fs.rmSync(TEST_HOME, { recursive: true, force: true });
        fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('verify-gates.test.js: FAILED');
    console.error(error);
    process.exit(1);
});
