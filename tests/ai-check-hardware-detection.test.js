const assert = require('assert');

const AICheckSelector = require('../src/models/ai-check-selector');

async function testAiCheckUsesCanonicalDiscreteGpuDetection() {
    const detectedHardware = {
        cpu: {
            brand: 'AMD Ryzen 7 9800X3D 8-Core Processor',
            architecture: 'x86_64',
            cores: 16,
            physicalCores: 8
        },
        memory: { total: 32 },
        gpu: {
            model: 'AMD Radeon RX 7900 XTX',
            vendor: 'AMD',
            vram: 24,
            vramPerGPU: 24,
            gpuCount: 1,
            dedicated: true,
            all: [
                {
                    model: 'AMD Radeon RX 7900 XTX',
                    vendor: 'AMD',
                    vram: 24
                }
            ]
        },
        summary: {
            bestBackend: 'cpu',
            runtimeBackend: 'cpu',
            totalVRAM: 24,
            hasDedicatedGPU: true,
            hasIntegratedGPU: false
        },
        os: { platform: 'win32' }
    };

    let detectorCalls = 0;
    const selector = new AICheckSelector({
        hardwareDetector: {
            async getSystemInfo() {
                detectorCalls += 1;
                return detectedHardware;
            }
        }
    });

    const hardware = await selector.getDetectedHardwareProfile();

    assert.strictEqual(detectorCalls, 1, 'AI Check should call the canonical hardware detector');
    assert.strictEqual(hardware.gpu.type, 'amd', 'the detected Radeon must not collapse to cpu_only');
    assert.strictEqual(hardware.gpu.vramGB, 24, 'the detected 24GB VRAM budget must be preserved');
    assert.strictEqual(hardware.gpu.gpuCount, 1, 'virtual adapters must not reappear as extra GPUs');
    assert.strictEqual(hardware.acceleration.supports_rocm, false, 'inventory detection must not claim an unconfirmed ROCm runtime');
}

async function testAiCheckPreservesConfirmedVulkanAssist() {
    const selector = new AICheckSelector({
        hardwareDetector: {
            async getSystemInfo() {
                return {
                    cpu: { brand: 'AMD Ryzen AI 9', architecture: 'x86_64', cores: 24 },
                    memory: { total: 64 },
                    gpu: {
                        model: 'AMD Radeon 890M Graphics',
                        vendor: 'AMD',
                        vram: 32,
                        sharedMemory: 32,
                        dedicated: false,
                        gpuCount: 1
                    },
                    summary: {
                        bestBackend: 'cpu',
                        runtimeBackend: 'vulkan',
                        hasIntegratedGPU: true,
                        hasDedicatedGPU: false
                    },
                    os: { platform: 'win32' }
                };
            }
        }
    });

    const hardware = await selector.getDetectedHardwareProfile();

    assert.strictEqual(hardware.gpu.type, 'amd');
    assert.strictEqual(hardware.acceleration.supports_vulkan, true);
    assert.strictEqual(hardware.acceleration.supports_rocm, false);
}

async function run() {
    await testAiCheckUsesCanonicalDiscreteGpuDetection();
    await testAiCheckPreservesConfirmedVulkanAssist();
    console.log('ai-check-hardware-detection.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('ai-check-hardware-detection.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
