/**
 * AMD GPU Detection Tests
 * Tests that AMD GPUs are detected on Linux even without ROCm installed.
 * Simulates hardware via mocking execSync and fs to verify lspci/sysfs fallback.
 *
 * Issue #9: Linux does not detect AMD Radeon RX 7900 XTX
 */

const { execSync: realExecSync } = require('child_process');
const realFs = require('fs');
const path = require('path');

class AMDGPUDetectionTest {
    constructor() {
        this.results = [];
        this.failures = [];
    }

    log(message, type = 'info') {
        const colors = {
            info: '\x1b[36m',
            pass: '\x1b[32m',
            fail: '\x1b[31m',
            warn: '\x1b[33m',
            reset: '\x1b[0m'
        };
        console.log(`${colors[type] || ''}${message}${colors.reset}`);
    }

    assert(condition, testName, detail = '') {
        if (condition) {
            this.log(`  PASS: ${testName}`, 'pass');
            this.results.push({ name: testName, passed: true });
        } else {
            this.log(`  FAIL: ${testName}${detail ? ' - ' + detail : ''}`, 'fail');
            this.results.push({ name: testName, passed: false });
            this.failures.push({ name: testName, detail });
        }
    }

    /**
     * Create a mock ROCmDetector that simulates a specific detection scenario.
     * We re-require the module fresh each time with mocked dependencies.
     */
    createMockedDetector(options = {}) {
        const {
            rocmSmiAvailable = false,
            rocmInfoAvailable = false,
            lspciOutput = null,
            sysfsCards = [],
            platform = 'linux',
        } = options;

        // We need to mock execSync and fs at the module level
        // Since ROCmDetector uses require('child_process') and require('fs'),
        // we'll create a fresh instance and override its methods

        // Clear module cache to get a fresh instance
        const modulePath = require.resolve('../src/hardware/backends/rocm-detector');
        delete require.cache[modulePath];

        // Save originals
        const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

        // Mock platform
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });

        // Now we need to intercept execSync calls within the module
        // We'll monkey-patch child_process.execSync temporarily
        const cp = require('child_process');
        const origExecSync = cp.execSync;

        cp.execSync = (cmd, opts) => {
            const cmdStr = typeof cmd === 'string' ? cmd : cmd.toString();

            // ROCm tools
            if (cmdStr.includes('rocm-smi')) {
                if (!rocmSmiAvailable) throw new Error('rocm-smi: command not found');
                return '';
            }
            if (cmdStr.includes('rocminfo')) {
                if (!rocmInfoAvailable) throw new Error('rocminfo: command not found');
                return '';
            }

            // lspci
            if (cmdStr.includes('lspci')) {
                if (lspciOutput === null) throw new Error('lspci: command not found');
                if (lspciOutput === '') throw new Error('No AMD GPU found');
                return lspciOutput;
            }

            throw new Error(`Unexpected command: ${cmdStr}`);
        };

        // Mock fs for sysfs
        const origReaddirSync = realFs.readdirSync;
        const origReadFileSync = realFs.readFileSync;

        if (sysfsCards.length > 0) {
            realFs.readdirSync = (dirPath) => {
                if (dirPath === '/sys/class/drm') {
                    return sysfsCards.map(c => c.card);
                }
                return origReaddirSync(dirPath);
            };

            realFs.readFileSync = (filePath, encoding) => {
                for (const card of sysfsCards) {
                    if (filePath === `/sys/class/drm/${card.card}/device/vendor`) {
                        return card.vendor;
                    }
                    if (filePath === `/sys/class/drm/${card.card}/device/device`) {
                        return card.device;
                    }
                    if (filePath === `/sys/class/drm/${card.card}/device/mem_info_vram_total`) {
                        if (card.vramBytes !== undefined) return String(card.vramBytes);
                        throw new Error('ENOENT');
                    }
                }
                return origReadFileSync(filePath, encoding);
            };
        }

        const ROCmDetector = require(modulePath);
        const detector = new ROCmDetector();

        // Cleanup function
        const cleanup = () => {
            cp.execSync = origExecSync;
            realFs.readdirSync = origReaddirSync;
            realFs.readFileSync = origReadFileSync;
            if (origPlatform) {
                Object.defineProperty(process, 'platform', origPlatform);
            }
            delete require.cache[modulePath];
        };

        return { detector, cleanup };
    }

    // ==========================================
    // TEST CASES
    // ==========================================

    /**
     * Test 1: RX 7900 XTX detected via lspci (no ROCm installed)
     * This is the exact scenario from Issue #9
     */
    test_lspci_rx7900xtx_no_rocm() {
        this.log('\n--- Test 1: RX 7900 XTX via lspci (no ROCm) ---', 'info');

        const lspciOutput = '03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XT/7900 XTX/7900M] [1002:744c] (rev c8)\n';

        const { detector, cleanup } = this.createMockedDetector({
            rocmSmiAvailable: false,
            rocmInfoAvailable: false,
            lspciOutput: lspciOutput,
            platform: 'linux',
        });

        try {
            const available = detector.checkAvailability();
            this.assert(available, 'GPU should be detected as available');
            this.assert(detector.detectionMethod === 'lspci', `Detection method should be lspci, got: ${detector.detectionMethod}`);

            const info = detector.detect();
            this.assert(info !== null, 'detect() should return non-null');
            this.assert(info.gpus.length === 1, `Should detect 1 GPU, got: ${info?.gpus?.length}`);

            if (info && info.gpus.length > 0) {
                const gpu = info.gpus[0];
                this.assert(gpu.name.includes('7900 XTX') || gpu.name.includes('7900'), `GPU name should contain 7900 XTX, got: ${gpu.name}`);
                this.assert(gpu.memory.total === 24, `VRAM should be 24GB, got: ${gpu.memory.total}GB`);
                this.assert(gpu.speedCoefficient >= 180, `Speed coefficient should be >= 180, got: ${gpu.speedCoefficient}`);
                this.assert(gpu.capabilities.architecture === 'RDNA 3', `Architecture should be RDNA 3, got: ${gpu.capabilities.architecture}`);
                this.assert(gpu.capabilities.bf16 === true, 'BF16 should be supported');
                this.assert(info.totalVRAM === 24, `Total VRAM should be 24, got: ${info.totalVRAM}`);
            }
        } finally {
            cleanup();
        }
    }

    /**
     * Test 2: RX 7900 XTX detected via sysfs (no ROCm, no lspci)
     */
    test_sysfs_rx7900xtx() {
        this.log('\n--- Test 2: RX 7900 XTX via sysfs (no ROCm, no lspci) ---', 'info');

        const { detector, cleanup } = this.createMockedDetector({
            rocmSmiAvailable: false,
            rocmInfoAvailable: false,
            lspciOutput: null,  // lspci not available
            sysfsCards: [
                {
                    card: 'card0',
                    vendor: '0x1002',     // AMD
                    device: '0x744c',     // RX 7900 XTX
                    vramBytes: 25769803776 // 24GB in bytes
                }
            ],
            platform: 'linux',
        });

        try {
            const available = detector.checkAvailability();
            this.assert(available, 'GPU should be detected as available via sysfs');
            this.assert(detector.detectionMethod === 'sysfs', `Detection method should be sysfs, got: ${detector.detectionMethod}`);

            const info = detector.detect();
            this.assert(info !== null, 'detect() should return non-null');
            this.assert(info.gpus.length === 1, `Should detect 1 GPU, got: ${info?.gpus?.length}`);

            if (info && info.gpus.length > 0) {
                const gpu = info.gpus[0];
                this.assert(gpu.name.includes('7900 XTX'), `GPU name should contain 7900 XTX, got: ${gpu.name}`);
                this.assert(gpu.memory.total === 24, `VRAM should be 24GB, got: ${gpu.memory.total}GB`);
            }
        } finally {
            cleanup();
        }
    }

    /**
     * Test 3: RX 6800 XT detected via lspci
     */
    test_lspci_rx6800xt() {
        this.log('\n--- Test 3: RX 6800 XT via lspci ---', 'info');

        const lspciOutput = '03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 [Radeon RX 6800/6800 XT / 6900 XT] [1002:73a3]\n';

        const { detector, cleanup } = this.createMockedDetector({
            rocmSmiAvailable: false,
            rocmInfoAvailable: false,
            lspciOutput: lspciOutput,
            platform: 'linux',
        });

        try {
            const info = detector.detect();
            this.assert(info !== null, 'detect() should return non-null');
            this.assert(info.gpus.length === 1, `Should detect 1 GPU, got: ${info?.gpus?.length}`);

            if (info && info.gpus.length > 0) {
                const gpu = info.gpus[0];
                this.assert(gpu.name.includes('6800 XT'), `GPU name should contain 6800 XT, got: ${gpu.name}`);
                this.assert(gpu.memory.total === 16, `VRAM should be 16GB, got: ${gpu.memory.total}GB`);
                this.assert(gpu.capabilities.architecture === 'RDNA 2', `Architecture should be RDNA 2, got: ${gpu.capabilities.architecture}`);
            }
        } finally {
            cleanup();
        }
    }

    /**
     * Test 4: Multi-GPU setup via lspci (2x RX 7900 XTX)
     */
    test_lspci_multi_gpu() {
        this.log('\n--- Test 4: Multi-GPU (2x RX 7900 XTX) via lspci ---', 'info');

        const lspciOutput = [
            '03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XT/7900 XTX/7900M] [1002:744c] (rev c8)',
            '06:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XT/7900 XTX/7900M] [1002:744c] (rev c8)',
        ].join('\n') + '\n';

        const { detector, cleanup } = this.createMockedDetector({
            rocmSmiAvailable: false,
            rocmInfoAvailable: false,
            lspciOutput: lspciOutput,
            platform: 'linux',
        });

        try {
            const info = detector.detect();
            this.assert(info !== null, 'detect() should return non-null');
            this.assert(info.gpus.length === 2, `Should detect 2 GPUs, got: ${info?.gpus?.length}`);
            this.assert(info.isMultiGPU === true, 'isMultiGPU should be true');
            this.assert(info.totalVRAM === 48, `Total VRAM should be 48GB, got: ${info?.totalVRAM}GB`);
        } finally {
            cleanup();
        }
    }

    /**
     * Test 5: No AMD GPU present (should return null)
     */
    test_no_amd_gpu() {
        this.log('\n--- Test 5: No AMD GPU present ---', 'info');

        const { detector, cleanup } = this.createMockedDetector({
            rocmSmiAvailable: false,
            rocmInfoAvailable: false,
            lspciOutput: null,
            sysfsCards: [
                {
                    card: 'card0',
                    vendor: '0x10de',  // NVIDIA vendor ID
                    device: '0x2684',
                }
            ],
            platform: 'linux',
        });

        try {
            const available = detector.checkAvailability();
            this.assert(!available, 'GPU should NOT be detected as available');

            const info = detector.detect();
            this.assert(info === null, 'detect() should return null');
        } finally {
            cleanup();
        }
    }

    /**
     * Test 6: Instinct MI300X via sysfs
     */
    test_sysfs_mi300x() {
        this.log('\n--- Test 6: Instinct MI300X via sysfs ---', 'info');

        const { detector, cleanup } = this.createMockedDetector({
            rocmSmiAvailable: false,
            rocmInfoAvailable: false,
            lspciOutput: null,
            sysfsCards: [
                {
                    card: 'card0',
                    vendor: '0x1002',
                    device: '0x740f',   // MI300X
                    vramBytes: 206158430208  // 192GB
                }
            ],
            platform: 'linux',
        });

        try {
            const info = detector.detect();
            this.assert(info !== null, 'detect() should return non-null');

            if (info && info.gpus.length > 0) {
                const gpu = info.gpus[0];
                this.assert(gpu.name.includes('MI300X'), `GPU name should contain MI300X, got: ${gpu.name}`);
                this.assert(gpu.memory.total === 192, `VRAM should be 192GB, got: ${gpu.memory.total}GB`);
                this.assert(gpu.capabilities.architecture === 'CDNA', `Architecture should be CDNA, got: ${gpu.capabilities.architecture}`);
                this.assert(gpu.speedCoefficient >= 350, `Speed coefficient should be >= 350, got: ${gpu.speedCoefficient}`);
            }
        } finally {
            cleanup();
        }
    }

    /**
     * Test 7: Integrated AMD GPU should NOT be listed (only discrete AMD GPUs via lspci with proper device IDs)
     */
    test_sysfs_integrated_amd_skipped() {
        this.log('\n--- Test 7: Unknown device ID via sysfs (fallback VRAM) ---', 'info');

        const { detector, cleanup } = this.createMockedDetector({
            rocmSmiAvailable: false,
            rocmInfoAvailable: false,
            lspciOutput: null,
            sysfsCards: [
                {
                    card: 'card0',
                    vendor: '0x1002',
                    device: '0xffff',  // Unknown device ID
                }
            ],
            platform: 'linux',
        });

        try {
            const info = detector.detect();
            // Should still detect it (could be a new/unknown AMD GPU)
            this.assert(info !== null, 'Should detect unknown AMD GPU');
            if (info && info.gpus.length > 0) {
                this.assert(info.gpus[0].memory.total === 8, `Default VRAM should be 8GB, got: ${info.gpus[0].memory.total}GB`);
            }
        } finally {
            cleanup();
        }
    }

    /**
     * Test 8: Verify isIntegratedGPU correctly handles AMD Radeon RX
     */
    test_isIntegratedGPU_fix() {
        this.log('\n--- Test 8: isIntegratedGPU correctly classifies AMD GPUs ---', 'info');

        const HardwareDetector = require('../src/hardware/detector');
        const detector = new HardwareDetector();

        // Discrete GPUs should NOT be classified as integrated
        this.assert(!detector.isIntegratedGPU('AMD Radeon RX 7900 XTX'), 'RX 7900 XTX should NOT be integrated');
        this.assert(!detector.isIntegratedGPU('AMD Radeon RX 6800 XT'), 'RX 6800 XT should NOT be integrated');
        this.assert(!detector.isIntegratedGPU('AMD Radeon RX 7600'), 'RX 7600 should NOT be integrated');
        this.assert(!detector.isIntegratedGPU('AMD Radeon Pro W7900'), 'Radeon Pro W7900 should NOT be integrated');
        this.assert(!detector.isIntegratedGPU('AMD Instinct MI300X'), 'Instinct MI300X should NOT be integrated');

        // Integrated GPUs SHOULD be classified as integrated
        this.assert(detector.isIntegratedGPU('AMD Radeon Graphics'), 'AMD Radeon Graphics should be integrated');
        this.assert(detector.isIntegratedGPU('AMD Radeon Vega 8 Graphics'), 'Vega 8 Graphics should be integrated');
        this.assert(detector.isIntegratedGPU('Intel UHD Graphics 770'), 'Intel UHD should be integrated');
        this.assert(detector.isIntegratedGPU('Intel Iris Xe Graphics'), 'Intel Iris Xe should be integrated');
    }

    /**
     * Test 9: Full pipeline simulation - RX 7900 XTX via UnifiedDetector
     * Simulates what would happen in the actual hw-detect CLI command
     */
    test_unified_detector_with_lspci_fallback() {
        this.log('\n--- Test 9: UnifiedDetector with lspci AMD fallback ---', 'info');

        const lspciOutput = '03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XT/7900 XTX/7900M] [1002:744c] (rev c8)\n';

        // We need to mock at a lower level for UnifiedDetector
        const cp = require('child_process');
        const origExecSync = cp.execSync;
        const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

        cp.execSync = (cmd, opts) => {
            const cmdStr = typeof cmd === 'string' ? cmd : cmd.toString();

            // Block ROCm tools
            if (cmdStr.includes('rocm-smi')) throw new Error('not found');
            if (cmdStr.includes('rocminfo')) throw new Error('not found');

            // Block NVIDIA tools
            if (cmdStr.includes('nvidia-smi')) throw new Error('not found');

            // Block Intel tools
            if (cmdStr.includes('intel') || cmdStr.includes('sycl-ls')) throw new Error('not found');

            // Allow lspci for AMD
            if (cmdStr.includes('lspci') && (cmdStr.includes('AMD') || cmdStr.includes('ATI') || cmdStr.includes('Radeon'))) {
                return lspciOutput;
            }
            if (cmdStr.includes('lspci') && cmdStr.includes('intel')) {
                throw new Error('no intel gpu');
            }
            if (cmdStr.includes('lspci') && cmdStr.includes('VGA')) {
                return lspciOutput;
            }

            // CPU detection
            if (cmdStr.includes('/proc/cpuinfo') || cmdStr.includes('cpuinfo')) {
                return '';
            }

            throw new Error(`mock: command not found: ${cmdStr}`);
        };

        try {
            // Clear all cached modules
            const rocmPath = require.resolve('../src/hardware/backends/rocm-detector');
            const cudaPath = require.resolve('../src/hardware/backends/cuda-detector');
            const unifiedPath = require.resolve('../src/hardware/unified-detector');
            delete require.cache[rocmPath];
            delete require.cache[cudaPath];
            delete require.cache[unifiedPath];

            const UnifiedDetector = require(unifiedPath);
            const detector = new UnifiedDetector();

            // Test ROCm backend directly
            const rocmAvail = detector.backends.rocm.checkAvailability();
            this.assert(rocmAvail, 'ROCm backend should be available via lspci fallback');

            const rocmInfo = detector.backends.rocm.detect();
            this.assert(rocmInfo !== null, 'ROCm detect should return data');
            this.assert(rocmInfo.gpus.length > 0, `Should have at least 1 GPU, got: ${rocmInfo?.gpus?.length}`);

            if (rocmInfo && rocmInfo.gpus.length > 0) {
                const gpu = rocmInfo.gpus[0];
                this.assert(gpu.memory.total === 24, `VRAM should be 24GB, got: ${gpu.memory.total}GB`);
                this.assert(rocmInfo.totalVRAM === 24, `Total VRAM should be 24, got: ${rocmInfo.totalVRAM}`);
                this.log(`  GPU detected: ${gpu.name} (${gpu.memory.total}GB, speed=${gpu.speedCoefficient})`, 'info');
            }
        } finally {
            cp.execSync = origExecSync;
            if (origPlatform) {
                Object.defineProperty(process, 'platform', origPlatform);
            }
        }
    }

    /**
     * Test 10: RX 7600 via lspci (smaller GPU, different device ID)
     */
    test_lspci_rx7600() {
        this.log('\n--- Test 10: RX 7600 via lspci ---', 'info');

        const lspciOutput = '03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 33 [Radeon RX 7600/7600 XT/7600M XT/7600S] [1002:7483]\n';

        const { detector, cleanup } = this.createMockedDetector({
            rocmSmiAvailable: false,
            rocmInfoAvailable: false,
            lspciOutput: lspciOutput,
            platform: 'linux',
        });

        try {
            const info = detector.detect();
            this.assert(info !== null, 'detect() should return non-null');

            if (info && info.gpus.length > 0) {
                const gpu = info.gpus[0];
                this.assert(gpu.memory.total === 8, `VRAM should be 8GB, got: ${gpu.memory.total}GB`);
                this.assert(gpu.capabilities.architecture === 'RDNA 3', `Architecture should be RDNA 3, got: ${gpu.capabilities.architecture}`);
            }
        } finally {
            cleanup();
        }
    }

    // ==========================================
    // RUN ALL
    // ==========================================

    runAll() {
        console.log('\n' + '='.repeat(60));
        console.log('AMD GPU DETECTION TEST SUITE (Issue #9)');
        console.log('='.repeat(60));

        this.test_lspci_rx7900xtx_no_rocm();
        this.test_sysfs_rx7900xtx();
        this.test_lspci_rx6800xt();
        this.test_lspci_multi_gpu();
        this.test_no_amd_gpu();
        this.test_sysfs_mi300x();
        this.test_sysfs_integrated_amd_skipped();
        this.test_isIntegratedGPU_fix();
        this.test_unified_detector_with_lspci_fallback();
        this.test_lspci_rx7600();

        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('TEST SUMMARY');
        console.log('='.repeat(60));

        const total = this.results.length;
        const passed = this.results.filter(r => r.passed).length;
        const failed = this.failures.length;

        this.log(`\nTotal assertions: ${total}`, 'info');
        this.log(`Passed: ${passed}`, 'pass');
        this.log(`Failed: ${failed}`, failed > 0 ? 'fail' : 'pass');

        if (this.failures.length > 0) {
            this.log('\nFailed tests:', 'fail');
            for (const f of this.failures) {
                console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
            }
        }

        return this.failures.length === 0;
    }
}

// Run tests
const test = new AMDGPUDetectionTest();
const success = test.runAll();
process.exit(success ? 0 : 1);
