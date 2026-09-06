/**
 * Hardware probe parallelism
 * Independent backends must overlap via detectAsync + execFile,
 * while the unified detect() result shape stays the same.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const UnifiedDetector = require('../src/hardware/unified-detector');
const { execFileAsync, filterLspciDisplayLines } = require('../src/hardware/probe-exec');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testIndependentBackendsOverlap() {
    const detector = new UnifiedDetector();
    const started = [];
    const finished = [];

    const slow = (label, value, ms) => async () => {
        started.push({ label, t: Date.now() });
        await delay(ms);
        finished.push({ label, t: Date.now() });
        return value;
    };

    detector.backends.cpu.detectAsync = slow('cpu', {
        brand: 'Test CPU',
        speedCoefficient: 10
    }, 80);
    detector.backends.cuda.detectAsync = slow('cuda', {
        gpus: [{ name: 'NVIDIA Test', memory: { total: 8 }, speedCoefficient: 90 }],
        totalVRAM: 8,
        backend: 'cuda',
        isMultiGPU: false,
        speedCoefficient: 90
    }, 80);
    detector.backends.rocm.detectAsync = slow('rocm', null, 80);
    detector.backends.intel.detectAsync = slow('intel', null, 80);
    detector.detectLinuxLspciGpus = async () => [];
    detector.detectSystemGpuFallback = async () => ({
        available: false,
        source: 'test',
        gpus: [],
        totalVRAM: 0,
        isMultiGPU: false,
        hasDedicated: false
    });

    const result = await detector.detect();

    assert.ok(result.backends.cpu?.available, 'CPU backend should remain available');
    assert.strictEqual(result.backends.cuda?.available, true, 'CUDA backend should remain available');
    assert.strictEqual(result.primary?.type, 'cuda', 'Primary backend selection must be unchanged');
    assert.strictEqual(result.summary.bestBackend, 'cuda', 'Summary contract must stay cuda-first');
    assert.ok(typeof result.fingerprint === 'string' && result.fingerprint.length > 0, 'Fingerprint must still be produced');

    assert.ok(Math.max(...started.map((s) => s.t)) <= Math.min(...finished.map((s) => s.t)),
        'every independent probe must start before the first probe completes');
}

async function testOverriddenSyncDetectStillWorks() {
    const detector = new UnifiedDetector();
    detector.backends.cpu.detect = () => ({
        brand: 'Stub CPU',
        vendor: 'Test',
        cores: { physical: 8, logical: 16, performance: 8, efficiency: 0 },
        frequency: { base: 3000, max: 4000 },
        cache: { l1d: 32, l1i: 32, l2: 1, l3: 16 },
        capabilities: { bestSimd: 'AVX2', avx2: true },
        architecture: 'x64',
        backend: 'cpu',
        speedCoefficient: 5
    });
    detector.backends.cuda.checkAvailability = () => false;
    detector.backends.rocm.checkAvailability = () => false;
    detector.backends.intel.checkAvailability = () => false;
    detector.detectLinuxLspciGpus = async () => [];
    detector.detectSystemGpuFallback = async () => ({
        available: false,
        gpus: [],
        totalVRAM: 0,
        isMultiGPU: false,
        hasDedicated: false
    });

    const result = await detector.detect();
    assert.strictEqual(result.cpu.brand, 'Stub CPU');
    assert.strictEqual(result.backends.cpu.info.brand, 'Stub CPU');
    assert.ok(!result.backends.cuda?.available, 'CUDA should stay unavailable when checkAvailability is stubbed false');
}

async function testExecFileAndLspciFilter() {
    const out = await execFileAsync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
        encoding: 'utf8',
        timeout: 5000
    });
    assert.strictEqual(String(out).trim(), 'ok');

    const filtered = filterLspciDisplayLines([
        '00:00.0 Host bridge: Intel',
        '01:00.0 VGA compatible controller [0300]: NVIDIA',
        '02:00.0 Audio device: NVIDIA'
    ].join('\n'));
    assert.ok(filtered.includes('VGA'));
    assert.ok(!filtered.includes('Host bridge'));
    assert.ok(!filtered.includes('Audio device'));
}

async function main() {
    await testIndependentBackendsOverlap();
    await testOverriddenSyncDetectStillWorks();
    await testExecFileAndLspciFilter();
    // Real child processes rendezvous through files: serial execution cannot
    // finish, because the first child waits for the other two to start.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-probe-'));
    try {
        const child = `const fs = require('fs'); const path = require('path');
            fs.writeFileSync(path.join(process.argv[1], process.argv[2]), 'ready');
            const timer = setInterval(() => {
                if (fs.readdirSync(process.argv[1]).length === 3) {
                    clearInterval(timer); process.stdout.write('overlapped');
                }
            }, 10);`;
        const results = await Promise.all([0, 1, 2].map((id) => execFileAsync(process.execPath,
            ['-e', child, dir, String(id)], { timeout: 5000 })));
        assert.deepStrictEqual(results, ['overlapped', 'overlapped', 'overlapped']);
        await assert.rejects(execFileAsync(process.execPath,
            ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 }),
        (error) => error.killed === true, 'stalled probes must be killed at their deadline');
        await assert.rejects(execFileAsync(path.join(dir, 'missing-probe')), /ENOENT/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    console.log('hardware-parallel-probes: ok');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
