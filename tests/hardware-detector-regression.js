/**
 * Hardware Detector Regression Tests
 * Covers:
 * - Vendor-less GPU entries (common in passthrough/proxmox setups)
 * - Unified detector fallback for check/recommend path consistency
 * - GB10 / Grace Blackwell and Tesla P100 compatibility mappings
 */

const assert = require('assert');
const HardwareDetector = require('../src/hardware/detector');

async function testVendorlessTeslaDetection() {
    const detector = new HardwareDetector();
    const gpu = detector.processGPUInfo({
        controllers: [
            {
                model: 'Tesla P100-PCIE-16GB',
                vendor: '',
                vram: 16384
            }
        ],
        displays: []
    });

    assert.ok(gpu.model.toLowerCase().includes('p100'), 'Tesla P100 model should be preserved');
    assert.strictEqual(gpu.vram, 16, 'Tesla P100 VRAM should normalize to 16GB');
    assert.strictEqual(gpu.dedicated, true, 'Tesla P100 should be treated as dedicated GPU');
}

async function testUnifiedFallbackEnrichment() {
    const detector = new HardwareDetector();
    detector.unifiedDetector = {
        detect: async () => ({
            primary: { type: 'cuda' },
            summary: {
                bestBackend: 'cuda',
                gpuModel: 'NVIDIA Tesla P100',
                totalVRAM: 64,
                gpuCount: 4,
                isMultiGPU: true
            },
            backends: {
                cuda: {
                    info: {
                        driver: '550.120',
                        gpus: [{ memory: { total: 16 } }]
                    }
                }
            }
        })
    };

    const systemInfo = {
        cpu: {},
        memory: {},
        gpu: {
            model: 'No GPU detected',
            vendor: 'Unknown',
            vram: 0,
            vramPerGPU: 0,
            dedicated: false,
            gpuCount: 0,
            isMultiGPU: false
        },
        system: {},
        os: {}
    };

    await detector.enrichWithUnifiedHardware(systemInfo);

    assert.strictEqual(systemInfo.gpu.model, 'NVIDIA Tesla P100', 'Unified detector model should override');
    assert.strictEqual(systemInfo.gpu.vram, 64, 'Total VRAM should be taken from unified detector');
    assert.strictEqual(systemInfo.gpu.gpuCount, 4, 'GPU count should match unified detector');
    assert.strictEqual(systemInfo.gpu.isMultiGPU, true, 'Multi-GPU flag should be preserved');
    assert.strictEqual(systemInfo.gpu.dedicated, true, 'CUDA backend should be treated as dedicated');
}

function testGb10AndP100Mappings() {
    const detector = new HardwareDetector();

    assert.strictEqual(
        detector.estimateVRAMFromModel('NVIDIA GB10 Grace Blackwell'),
        96,
        'GB10/Grace Blackwell should map to 96GB class memory'
    );
    assert.ok(
        detector.getGPUTier('NVIDIA GB10 Grace Blackwell') >= 95,
        'GB10 should be classified as flagship-tier GPU'
    );
    assert.strictEqual(
        detector.estimateVRAMFromModel('NVIDIA Tesla P100-PCIE-16GB'),
        16,
        'Tesla P100 should map to 16GB'
    );
}

async function run() {
    await testVendorlessTeslaDetection();
    await testUnifiedFallbackEnrichment();
    testGb10AndP100Mappings();
    console.log('✅ hardware-detector-regression.js passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('❌ hardware-detector-regression.js failed');
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    run
};
