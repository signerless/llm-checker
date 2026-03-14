/**
 * CUDA Jetson Detection Regression Tests
 * Verifies Jetson fallback works when nvidia-smi is unavailable.
 */

const assert = require('assert');
const fs = require('fs');
const CUDADetector = require('../src/hardware/backends/cuda-detector');

function testNvidiaSmiBannerParsingDoesNotRequireHead() {
    const detector = new CUDADetector();
    const commands = [];

    detector.execCommand = (command) => {
        commands.push(command);

        if (command === 'nvidia-smi --query-gpu=driver_version --format=csv,noheader,nounits') {
            return '555.85.02\n';
        }

        if (command === 'nvidia-smi') {
            return [
                'Fri Mar 14 12:00:00 2026',
                '| NVIDIA-SMI 555.85.02    Driver Version: 555.85.02    CUDA Version: 12.6 |',
                '|-------------------------------+----------------------+----------------------|'
            ].join('\n');
        }

        if (command.includes('--query-gpu=index,name,uuid')) {
            throw new Error('force simple query fallback');
        }

        if (command === 'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits') {
            return 'NVIDIA GeForce RTX 4060 Laptop GPU, 8188\n';
        }

        throw new Error(`Unexpected command: ${command}`);
    };

    const info = detector.getGPUInfo();

    assert.ok(info, 'nvidia-smi parsing should still produce GPU info');
    assert.strictEqual(info.driver, '555.85.02', 'Driver version should come from nvidia-smi query');
    assert.strictEqual(info.cuda, '12.6', 'CUDA version should be parsed from nvidia-smi banner');
    assert.strictEqual(info.gpus.length, 1, 'Fallback query should expose one GPU');
    assert.strictEqual(info.gpus[0].memory.total, 8, 'Fallback memory query should normalize MB to GB');
    assert.ok(
        commands.every((command) => !/\bhead\b/.test(command)),
        `Windows-safe nvidia-smi flow must not use shell-only head command, got: ${commands.join(' | ')}`
    );
}

function testJetsonFallbackWithoutNvidiaSMI() {
    const detector = new CUDADetector();

    detector.hasNvidiaSMI = () => false;
    detector.isJetsonPlatform = () => true;
    detector.hasJetsonCudaSupport = () => true;
    detector.getJetsonGPUInfo = () => ({
        gpus: [
            {
                index: 0,
                name: 'NVIDIA Jetson Orin Nano',
                memory: { total: 7, free: 6, used: 1 },
                capabilities: {
                    architecture: 'Ampere',
                    computeCapability: '8.7'
                },
                speedCoefficient: 65
            }
        ],
        driver: '535.104.05',
        cuda: '12.2',
        totalVRAM: 7,
        backend: 'cuda',
        isMultiGPU: false,
        speedCoefficient: 65
    });

    assert.strictEqual(detector.checkAvailability(), true, 'Jetson fallback should mark CUDA as available');

    const info = detector.detect();
    assert.ok(info, 'Jetson fallback should return GPU info');
    assert.strictEqual(info.backend, 'cuda', 'Backend should stay CUDA');
    assert.strictEqual(info.gpus.length, 1, 'Jetson should expose single integrated NVIDIA GPU');
    assert.ok(info.gpus[0].name.toLowerCase().includes('jetson'), 'GPU name should preserve Jetson identity');
}

function testNoFalsePositiveWithoutJetsonHints() {
    const detector = new CUDADetector();

    detector.hasNvidiaSMI = () => false;
    detector.isJetsonPlatform = () => false;
    detector.hasJetsonCudaSupport = () => false;

    assert.strictEqual(detector.checkAvailability(), false, 'Non-Jetson hosts should not report CUDA without nvidia-smi');
    assert.strictEqual(detector.detect(), null, 'detect() should return null when CUDA is unavailable');
}

function testJetsonPlatformMarkerFromNvTegraRelease() {
    if (process.platform !== 'linux') {
        return;
    }

    const detector = new CUDADetector();

    detector.readFileIfExists = (path) => (
        path === '/etc/nv_tegra_release' ? '# R35 (release), REVISION: 4.1' : null
    );

    assert.strictEqual(
        detector.isJetsonPlatform(),
        true,
        'Jetson platform should be detected via /etc/nv_tegra_release marker'
    );
}

function testJetsonCudaSupportMarkerFromNvTegraRelease() {
    const detector = new CUDADetector();
    const originalExistsSync = fs.existsSync;

    try {
        fs.existsSync = (path) => path === '/etc/nv_tegra_release';
        assert.strictEqual(
            detector.hasJetsonCudaSupport(),
            true,
            'Jetson CUDA support should be detected via /etc/nv_tegra_release marker'
        );
    } finally {
        fs.existsSync = originalExistsSync;
    }
}

function testJetsonDriverFallbackToUnknown() {
    const detector = new CUDADetector();

    detector.readJetsonModel = () => 'NVIDIA Jetson Orin Nano Developer Kit';
    detector.detectJetsonCudaVersion = () => '12.2';
    detector.detectJetsonDriverVersion = () => null;
    detector.getJetsonCapabilities = () => ({
        tensorCores: true,
        fp16: true,
        bf16: true,
        int8: true,
        fp8: false,
        nvlink: false,
        computeCapability: '8.7',
        architecture: 'Ampere'
    });
    detector.getJetsonSpeedCoefficient = () => 65;

    const info = detector.getJetsonGPUInfo();
    assert.strictEqual(info.driver, 'unknown', 'Jetson driver should default to "unknown" when unavailable');
}

function testJetsonFingerprintIsSanitized() {
    const detector = new CUDADetector();

    detector.detect = () => ({
        gpus: [
            {
                index: 0,
                name: 'NVIDIA Jetson Orin Nano',
                memory: { total: 6 }
            }
        ],
        totalVRAM: 6,
        isMultiGPU: false
    });

    detector.getPrimaryGPU = () => ({
        name: 'NVIDIA Jetson Orin Nano',
        memory: { total: 6 }
    });

    const fingerprint = detector.getFingerprint();
    assert.strictEqual(fingerprint, 'cuda-jetson-orin-nano-6gb', 'Fingerprint should not include double hyphens');
    assert.strictEqual(fingerprint.includes('--'), false, 'Fingerprint must not contain consecutive hyphens');
}

function run() {
    testNvidiaSmiBannerParsingDoesNotRequireHead();
    testJetsonFallbackWithoutNvidiaSMI();
    testNoFalsePositiveWithoutJetsonHints();
    testJetsonPlatformMarkerFromNvTegraRelease();
    testJetsonCudaSupportMarkerFromNvTegraRelease();
    testJetsonDriverFallbackToUnknown();
    testJetsonFingerprintIsSanitized();
    console.log('✅ cuda-jetson-detection.test.js passed');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('❌ cuda-jetson-detection.test.js failed');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
