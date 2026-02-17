/**
 * Hardware Detector Regression Tests
 * Covers:
 * - Vendor-less GPU entries (common in passthrough/proxmox setups)
 * - Unified detector fallback for check/recommend path consistency
 * - GB10 / Grace Blackwell and Tesla P100 compatibility mappings
 */

const assert = require('assert');
const HardwareDetector = require('../src/hardware/detector');
const UnifiedDetector = require('../src/hardware/unified-detector');

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

function testDeviceIdFallbackMappings() {
    const detector = new HardwareDetector();

    const nvidiaFallback = detector.processGPUInfo({
        controllers: [
            {
                model: 'NVIDIA Corporation Device 1b82',
                vendor: 'NVIDIA Corporation',
                deviceId: '0x1B82',
                vram: 0
            }
        ],
        displays: []
    });

    assert.ok(
        nvidiaFallback.model.toLowerCase().includes('1070 ti'),
        `Expected GTX 1070 Ti mapping, got: ${nvidiaFallback.model}`
    );
    assert.strictEqual(nvidiaFallback.vram, 8, 'GTX 1070 Ti should map to 8GB VRAM');
    assert.strictEqual(nvidiaFallback.dedicated, true, 'GTX 1070 Ti should be treated as dedicated');

    const amdFallback = detector.processGPUInfo({
        controllers: [
            {
                model: 'Unknown',
                vendor: '',
                deviceId: '0x744c',
                vram: 0
            }
        ],
        displays: []
    });

    assert.ok(
        amdFallback.model.toLowerCase().includes('7900 xtx'),
        `Expected RX 7900 XTX mapping, got: ${amdFallback.model}`
    );
    assert.strictEqual(amdFallback.vram, 24, 'RX 7900 XTX fallback should map to 24GB');
    assert.strictEqual(amdFallback.dedicated, true, 'RX 7900 XTX should be treated as dedicated');
}

function testHeterogeneousGpuSummaryPreserved() {
    const detector = new UnifiedDetector();
    const summary = detector.buildSummary({
        cpu: { brand: 'AMD EPYC 7742' },
        primary: {
            type: 'cuda',
            name: 'NVIDIA CUDA',
            info: {
                totalVRAM: 120,
                isMultiGPU: true,
                speedCoefficient: 180,
                gpus: [
                    { name: 'NVIDIA Tesla V100' },
                    { name: 'NVIDIA Tesla V100' },
                    { name: 'NVIDIA Tesla P40' },
                    { name: 'NVIDIA Tesla P40' },
                    { name: 'NVIDIA Tesla M40' }
                ]
            }
        }
    });

    assert.strictEqual(
        summary.gpuInventory,
        '2x NVIDIA Tesla V100 + 2x NVIDIA Tesla P40 + NVIDIA Tesla M40',
        'Mixed GPU inventory should preserve individual model counts'
    );
    assert.strictEqual(summary.hasHeterogeneousGPU, true, 'Heterogeneous GPU flag should be true');

    detector.cache = { summary };
    const description = detector.getHardwareDescription();
    assert.ok(
        description.includes('2x NVIDIA Tesla V100 + 2x NVIDIA Tesla P40 + NVIDIA Tesla M40'),
        `Hardware description should include mixed inventory, got: ${description}`
    );
}

async function run() {
    await testVendorlessTeslaDetection();
    await testUnifiedFallbackEnrichment();
    testGb10AndP100Mappings();
    testDeviceIdFallbackMappings();
    testHeterogeneousGpuSummaryPreserved();
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
