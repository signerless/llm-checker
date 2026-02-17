/**
 * CUDA Jetson Detection Regression Tests
 * Verifies Jetson fallback works when nvidia-smi is unavailable.
 */

const assert = require('assert');
const CUDADetector = require('../src/hardware/backends/cuda-detector');

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

function run() {
    testJetsonFallbackWithoutNvidiaSMI();
    testNoFalsePositiveWithoutJetsonHints();
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
