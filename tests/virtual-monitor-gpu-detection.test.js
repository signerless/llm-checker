/**
 * Virtual-monitor GPU detection regression (issue #106)
 * =====================================================
 * Virtual display adapters from streaming hosts (Apollo/Sunshine via
 * IddSampleDriver), VR headsets (Meta Quest, Oculus), and remote-desktop tools
 * (Parsec, spacedesk) were classified as dedicated GPUs, faking multi-GPU and
 * burying the real card (a Radeon RX 7900 XTX), leaving CPU-only results.
 */

const assert = require('assert');
const UnifiedDetector = require('../src/hardware/unified-detector');
const HardwareDetector = require('../src/hardware/detector');

const VIRTUAL = [
    'Apollo Virtual Monitor',
    'Meta Quest Virtual Monitor',
    'IddSampleDriver Device',
    'Oculus Virtual Audio Device',
    'Virtual Display Driver',
    'Parsec Virtual Display Adapter',
    'spacedesk Graphics Adapter'
];

// Real GPUs (and a real Intel "Apollo Lake" iGPU) must NOT be filtered.
const REAL = [
    'AMD Radeon(TM) RX 7900 XTX',
    'AMD Radeon RX 7900 XTX',
    'NVIDIA GeForce RTX 4090',
    'Intel HD Graphics 500 (Apollo Lake)',
    'Intel Arc A770',
    'NVIDIA A100-SXM4-80GB'
];

function testUnifiedFilterClassification() {
    const u = new UnifiedDetector();
    for (const name of VIRTUAL) {
        assert.strictEqual(u.isRemoteDisplayModel(name), true, `virtual adapter must be filtered: ${name}`);
    }
    for (const name of REAL) {
        assert.strictEqual(u.isRemoteDisplayModel(name), false, `real GPU must NOT be filtered: ${name}`);
    }
}

function testNormalizeGpuInventoryDropsVirtual() {
    const u = new UnifiedDetector();
    const inventory = [
        { name: 'Apollo Virtual Monitor', type: 'dedicated', memory: { total: 0 } },
        { name: 'Meta Quest Virtual Monitor', type: 'dedicated', memory: { total: 0 } },
        { name: 'AMD Radeon RX 7900 XTX', type: 'dedicated', memory: { total: 24 } }
    ];
    const out = u.normalizeGpuInventory(inventory);
    assert.strictEqual(out.length, 1, 'only the real GPU survives');
    assert.ok(/7900 xtx/i.test(out[0].name), 'the surviving GPU is the 7900 XTX');
}

function testDetectorFilterAndPrimary() {
    const d = new HardwareDetector();
    for (const name of VIRTUAL) {
        assert.strictEqual(d.isVirtualDisplayAdapter(name), true, `detector must flag virtual: ${name}`);
    }
    assert.strictEqual(d.isVirtualDisplayAdapter('Intel HD Graphics 500 (Apollo Lake)'), false, 'real iGPU kept');

    // Virtual monitors listed FIRST must not displace the real dedicated GPU.
    const graphics = { controllers: [
        { model: 'Apollo Virtual Monitor', vendor: '', vram: 0 },
        { model: 'Meta Quest Virtual Monitor', vendor: '', vram: 0 },
        { model: 'IddSampleDriver Device', vendor: '', vram: 0 },
        { model: 'AMD Radeon(TM) RX 7900 XTX', vendor: 'Advanced Micro Devices, Inc.', vram: 0 }
    ]};
    const gpu = d.processGPUInfo(graphics, { total: 32 * 1024 ** 3 });
    assert.ok(/7900 xtx/i.test(gpu.model), `primary must be the 7900 XTX, got ${gpu.model}`);
    assert.strictEqual(gpu.dedicated, true, 'primary is dedicated');
    assert.ok(gpu.vram >= 24, `7900 XTX VRAM must be ~24GB, got ${gpu.vram}`);
    assert.ok(!gpu.isMultiGPU, 'virtual monitors must not fake multi-GPU');
}

function run() {
    testUnifiedFilterClassification();
    testNormalizeGpuInventoryDropsVirtual();
    testDetectorFilterAndPrimary();
    console.log('virtual-monitor-gpu-detection.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('virtual-monitor-gpu-detection.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
