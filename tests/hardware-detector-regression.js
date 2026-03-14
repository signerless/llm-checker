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
const MultiObjectiveSelector = require('../src/ai/multi-objective-selector');

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

function testIntegratedGpuSharedMemoryHeuristic() {
    const detector = new HardwareDetector();
    const gpu = detector.processGPUInfo(
        {
            controllers: [
                {
                    model: 'AMD Radeon(TM) Graphics',
                    vendor: 'AMD',
                    vram: 1024,
                    vramDynamic: true
                }
            ],
            displays: []
        },
        {
            total: 24 * 1024 ** 3
        }
    );

    assert.strictEqual(gpu.model, 'AMD Radeon(TM) Graphics', 'Integrated GPU model should be preserved');
    assert.strictEqual(gpu.vram, 12, 'Integrated GPU should expose estimated shared memory instead of 1GB aperture');
    assert.strictEqual(gpu.sharedMemory, 12, 'Integrated GPU shared memory should reflect system-RAM heuristic');
    assert.strictEqual(gpu.dedicatedMemory, 1, 'Dedicated aperture should remain visible separately');
    assert.strictEqual(gpu.dedicated, false, 'Integrated GPU must remain non-dedicated');
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

function testIntegratedSummaryReportsSharedMemory() {
    const detector = new UnifiedDetector();
    const summary = detector.buildSummary({
        cpu: { brand: 'AMD Ryzen 7 8840HS', speedCoefficient: 100 },
        primary: { type: 'cpu', name: 'CPU', info: { speedCoefficient: 100 } },
        systemGpu: {
            available: true,
            hasDedicated: false,
            gpus: [
                {
                    name: 'AMD Radeon(TM) Graphics',
                    type: 'integrated',
                    memory: { total: 12 }
                }
            ],
            totalVRAM: 0,
            isMultiGPU: false
        }
    });

    assert.strictEqual(summary.hasIntegratedGPU, true, 'Integrated-only summary should preserve integrated GPU signal');
    assert.strictEqual(summary.hasDedicatedGPU, false, 'Integrated-only summary should not invent dedicated VRAM');
    assert.strictEqual(summary.integratedSharedMemory, 12, 'Summary should surface integrated shared memory');

    detector.cache = { summary };
    const description = detector.getHardwareDescription();
    assert.ok(
        description.includes('12GB shared memory'),
        `Integrated-only description should mention shared memory, got: ${description}`
    );
}

async function testUnifiedWindowsFallbackGpuDetection() {
    const detector = new UnifiedDetector();
    const si = require('systeminformation');
    const originalGraphics = si.graphics;

    si.graphics = async () => ({
        controllers: [
            {
                model: 'AMD Radeon(TM) Graphics',
                vendor: 'AMD',
                vram: 512
            },
            {
                model: 'AMD Radeon RX 7800 XT',
                vendor: 'AMD',
                vram: 16368
            }
        ],
        displays: []
    });

    try {
        const fallback = await detector.detectSystemGpuFallback();

        assert.strictEqual(fallback.available, true, 'Fallback GPU detection should be available');
        assert.strictEqual(fallback.hasDedicated, true, 'Fallback should detect dedicated GPU');
        assert.strictEqual(fallback.totalVRAM, 16, 'RX 7800 XT fallback should normalize to 16GB');
        assert.ok(
            fallback.gpus.some((gpu) => gpu.name.toLowerCase().includes('rx 7800 xt')),
            'Fallback GPU list should include RX 7800 XT'
        );

        const summary = detector.buildSummary({
            cpu: { brand: 'AMD Ryzen 9 7900X', speedCoefficient: 120 },
            primary: { type: 'cpu', name: 'CPU', info: { speedCoefficient: 120 } },
            systemGpu: fallback
        });

        assert.strictEqual(summary.bestBackend, 'cpu', 'Fallback GPU should not override CPU backend selection');
        assert.strictEqual(summary.totalVRAM, 16, 'Summary should include dedicated VRAM from fallback GPU');
        assert.ok(
            (summary.gpuInventory || '').toLowerCase().includes('rx 7800 xt'),
            `Expected fallback inventory to include RX 7800 XT, got: ${summary.gpuInventory}`
        );

        detector.cache = { summary };
        const description = detector.getHardwareDescription();
        assert.ok(
            description.toLowerCase().includes('rx 7800 xt'),
            `CPU fallback description should include discrete GPU model, got: ${description}`
        );
    } finally {
        si.graphics = originalGraphics;
    }
}

function testUnifiedLinuxLspciHybridParsing() {
    const detector = new UnifiedDetector();
    const parsed = detector.parseLinuxLspciGpus(`
01:00.0 VGA compatible controller [0300]: NVIDIA Corporation AD107M [GeForce RTX 4060 Max-Q / Mobile] [10de:28a0] (rev a1)
05:00.0 Display controller [0380]: Advanced Micro Devices, Inc. [AMD/ATI] Phoenix3 [Radeon 780M] [1002:15bf]
`);

    assert.ok(Array.isArray(parsed), 'parseLinuxLspciGpus should return an array');
    assert.ok(
        parsed.some((gpu) => gpu.name.toLowerCase().includes('rtx 4060') && gpu.type === 'dedicated'),
        'Hybrid parser should include discrete RTX 4060 as dedicated'
    );
    assert.ok(
        parsed.some((gpu) => gpu.name.toLowerCase().includes('780m') && gpu.type === 'integrated'),
        'Hybrid parser should preserve integrated Radeon 780M as integrated'
    );
}

async function testHardwareDetectorUsesGenericFallbackGpuWhenPrimaryIsCpu() {
    const detector = new HardwareDetector();
    detector.unifiedDetector = {
        detect: async () => ({
            primary: { type: 'cpu' },
            summary: {
                bestBackend: 'cpu',
                gpuModel: 'NVIDIA GeForce RTX 4060 Laptop GPU',
                gpuInventory: 'NVIDIA GeForce RTX 4060 Laptop GPU',
                totalVRAM: 8,
                gpuCount: 1,
                isMultiGPU: false
            },
            systemGpu: {
                available: true,
                hasDedicated: true,
                gpus: [
                    {
                        name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
                        type: 'dedicated',
                        memory: { total: 8 }
                    },
                    {
                        name: 'AMD Radeon(TM) Graphics',
                        type: 'integrated',
                        memory: { total: 0 }
                    }
                ],
                totalVRAM: 8,
                isMultiGPU: false
            },
            backends: {
                cpu: { info: { speedCoefficient: 100 } }
            }
        })
    };

    const systemInfo = {
        cpu: {},
        memory: {},
        gpu: {
            model: 'AMD Radeon(TM) Graphics',
            vendor: 'AMD',
            vram: 0,
            vramPerGPU: 0,
            dedicated: false,
            gpuCount: 1,
            isMultiGPU: false
        },
        system: {},
        os: {}
    };

    await detector.enrichWithUnifiedHardware(systemInfo);

    assert.ok(
        (systemInfo.gpu.model || '').toLowerCase().includes('rtx 4060'),
        `Expected fallback enrichment to expose RTX 4060, got: ${systemInfo.gpu.model}`
    );
    assert.strictEqual(systemInfo.gpu.vram, 8, 'Fallback enrichment should populate total VRAM');
    assert.strictEqual(systemInfo.gpu.dedicated, true, 'Fallback enrichment should mark GPU as dedicated');
    assert.strictEqual(systemInfo.gpu.backend, 'generic', 'Fallback enrichment should mark backend as generic');
}

function testUnifiedSummaryPreservesIntegratedGpuOnHybridDedicatedSystem() {
    const detector = new UnifiedDetector();
    const summary = detector.buildSummary({
        cpu: { brand: 'Intel Core Ultra 7 155H', speedCoefficient: 110 },
        primary: {
            type: 'cuda',
            name: 'NVIDIA CUDA',
            info: {
                totalVRAM: 8,
                isMultiGPU: false,
                speedCoefficient: 120,
                gpus: [
                    { name: 'NVIDIA GeForce RTX 4060 Laptop GPU', memory: { total: 8 } }
                ]
            }
        },
        systemGpu: {
            available: true,
            hasDedicated: true,
            gpus: [
                {
                    name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
                    type: 'dedicated',
                    memory: { total: 8 }
                },
                {
                    name: 'Intel Iris Xe Graphics',
                    type: 'integrated',
                    memory: { total: 0 }
                }
            ],
            totalVRAM: 8,
            isMultiGPU: false
        }
    });

    assert.strictEqual(summary.hasDedicatedGPU, true, 'Hybrid summary should preserve dedicated GPU signal');
    assert.strictEqual(summary.hasIntegratedGPU, true, 'Hybrid summary should preserve integrated GPU signal');
    assert.ok(
        summary.integratedGpuModels.some((gpu) => gpu.name.toLowerCase().includes('iris xe')),
        `Expected integrated GPU inventory to include Iris Xe, got: ${JSON.stringify(summary.integratedGpuModels)}`
    );
    assert.ok(
        (summary.gpuInventory || '').toLowerCase().includes('iris xe'),
        `Expected combined GPU inventory to include Iris Xe, got: ${summary.gpuInventory}`
    );
}

async function testHardwareDetectorPreservesIntegratedOnlyInventoryWhenPrimaryIsCpu() {
    const detector = new HardwareDetector();
    detector.unifiedDetector = {
        detect: async () => ({
            primary: { type: 'cpu' },
            summary: {
                bestBackend: 'cpu',
                backendName: 'CPU',
                gpuModel: 'Intel Iris Xe Graphics',
                gpuInventory: 'Intel Iris Xe Graphics',
                totalVRAM: 0,
                gpuCount: 1,
                isMultiGPU: false,
                hasIntegratedGPU: true,
                hasDedicatedGPU: false,
                integratedGpuCount: 1,
                dedicatedGpuCount: 0,
                integratedGpuModels: [{ name: 'Intel Iris Xe Graphics', count: 1 }],
                dedicatedGpuModels: []
            },
            systemGpu: {
                available: true,
                hasDedicated: false,
                gpus: [
                    {
                        name: 'Intel Iris Xe Graphics',
                        type: 'integrated',
                        memory: { total: 0 }
                    }
                ],
                totalVRAM: 0,
                isMultiGPU: false
            },
            backends: {
                cpu: { info: { speedCoefficient: 90 } }
            }
        })
    };

    const systemInfo = {
        cpu: {},
        memory: {},
        gpu: {
            model: 'Intel Iris Xe Graphics',
            vendor: 'Intel',
            vram: 0,
            vramPerGPU: 0,
            dedicated: false,
            gpuCount: 1,
            isMultiGPU: false
        },
        system: {},
        os: {}
    };

    await detector.enrichWithUnifiedHardware(systemInfo);

    assert.ok(systemInfo.summary, 'Unified summary should be attached to system info');
    assert.strictEqual(systemInfo.gpu.model, 'Intel Iris Xe Graphics', 'Integrated model should remain visible');
    assert.strictEqual(systemInfo.gpu.dedicated, false, 'Integrated-only systems should remain non-dedicated');
    assert.strictEqual(systemInfo.gpu.backend, 'cpu', 'Integrated-only CPU path should keep CPU backend');
    assert.strictEqual(systemInfo.gpu.hasIntegratedGPU, true, 'Integrated-only enrichment should preserve integrated signal');
    assert.ok(
        systemInfo.gpu.integratedGpuModels.some((gpu) => gpu.name.toLowerCase().includes('iris xe')),
        `Expected integrated GPU inventory to include Iris Xe, got: ${JSON.stringify(systemInfo.gpu.integratedGpuModels)}`
    );
}

function testHybridSelectorUsesDedicatedPath() {
    const selector = new MultiObjectiveSelector();
    const tps = selector.estimateTokensPerSecond(
        {
            cpu: {
                brand: 'Intel Core Ultra 7 155H',
                physicalCores: 16,
                speed: 4.8
            },
            memory: { total: 32 },
            gpu: {
                model: 'NVIDIA GeForce RTX 4060 Laptop GPU',
                vram: 8,
                dedicated: true
            },
            os: { platform: 'win32' },
            summary: {
                hasIntegratedGPU: true,
                hasDedicatedGPU: true,
                integratedGpuModels: [{ name: 'Intel Arc Graphics' }],
                dedicatedGpuModels: [{ name: 'NVIDIA GeForce RTX 4060 Laptop GPU' }]
            }
        },
        {
            name: 'llama3.2:3b',
            size: '3B'
        }
    );

    assert.ok(
        tps >= 10,
        `Hybrid systems should keep the dedicated-GPU performance path, got ${tps} tok/s`
    );
}

async function run() {
    await testVendorlessTeslaDetection();
    await testUnifiedFallbackEnrichment();
    testIntegratedGpuSharedMemoryHeuristic();
    testGb10AndP100Mappings();
    testDeviceIdFallbackMappings();
    testHeterogeneousGpuSummaryPreserved();
    testIntegratedSummaryReportsSharedMemory();
    await testUnifiedWindowsFallbackGpuDetection();
    testUnifiedLinuxLspciHybridParsing();
    await testHardwareDetectorUsesGenericFallbackGpuWhenPrimaryIsCpu();
    testUnifiedSummaryPreservesIntegratedGpuOnHybridDedicatedSystem();
    await testHardwareDetectorPreservesIntegratedOnlyInventoryWhenPrimaryIsCpu();
    testHybridSelectorUsesDedicatedPath();
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
