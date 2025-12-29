/**
 * Intel GPU Detector
 * Detects Intel Arc (dedicated) and Iris/UHD (integrated) GPUs
 * Uses intel_gpu_top, lspci, and sysfs
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class IntelDetector {
    constructor() {
        this.cache = null;
        this.isAvailable = null;
    }

    /**
     * Check if Intel GPU is available
     */
    checkAvailability() {
        if (this.isAvailable !== null) {
            return this.isAvailable;
        }

        // Only available on Linux (Windows detection handled by systeminformation)
        if (process.platform !== 'linux') {
            this.isAvailable = false;
            return false;
        }

        try {
            // Check for Intel GPU in lspci
            const lspci = execSync('lspci | grep -i "VGA\\|3D\\|Display" | grep -i intel', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            this.isAvailable = lspci.length > 0;
        } catch (e) {
            // Check sysfs for Intel render nodes
            try {
                const renderNodes = fs.readdirSync('/sys/class/drm');
                this.isAvailable = renderNodes.some(node => {
                    try {
                        const vendor = fs.readFileSync(
                            `/sys/class/drm/${node}/device/vendor`,
                            'utf8'
                        ).trim();
                        return vendor === '0x8086';  // Intel vendor ID
                    } catch (e) {
                        return false;
                    }
                });
            } catch (e2) {
                this.isAvailable = false;
            }
        }

        return this.isAvailable;
    }

    /**
     * Detect Intel GPUs
     */
    detect() {
        if (!this.checkAvailability()) {
            return null;
        }

        if (this.cache) {
            return this.cache;
        }

        try {
            const info = this.getGPUInfo();
            this.cache = info;
            return info;
        } catch (error) {
            return null;
        }
    }

    /**
     * Get detailed GPU information
     */
    getGPUInfo() {
        const result = {
            gpus: [],
            totalVRAM: 0,
            backend: 'sycl',  // Intel uses oneAPI/SYCL for LLM
            isMultiGPU: false,
            hasDedicated: false,
            speedCoefficient: 0
        };

        try {
            // Parse lspci output for Intel GPUs
            const lspci = execSync('lspci -v | grep -A 20 -i "VGA\\|3D\\|Display" | grep -i intel -A 20', {
                encoding: 'utf8',
                timeout: 10000
            });

            const gpuBlocks = lspci.split(/(?=\d{2}:\d{2}\.\d)/);

            for (const block of gpuBlocks) {
                if (!block.trim()) continue;

                const nameMatch = block.match(/Intel.*?(Arc|Iris|UHD|HD Graphics)[^\n]*/i);
                if (!nameMatch) continue;

                const name = nameMatch[0].replace(/Corporation\s*/i, '').trim();
                const isDedicated = name.toLowerCase().includes('arc');

                // Get VRAM from sysfs or estimate
                let vram = this.getVRAMFromSysfs(block) || this.estimateVRAM(name);

                const gpu = {
                    index: result.gpus.length,
                    name: name,
                    type: isDedicated ? 'dedicated' : 'integrated',
                    memory: {
                        total: vram,
                        shared: isDedicated ? 0 : vram
                    },
                    capabilities: this.getGPUCapabilities(name),
                    speedCoefficient: this.calculateSpeedCoefficient(name, vram, isDedicated)
                };

                result.gpus.push(gpu);
                if (isDedicated) {
                    result.totalVRAM += vram;
                    result.hasDedicated = true;
                }
            }
        } catch (e) {
            // Fallback: check sysfs directly
            try {
                const drmPath = '/sys/class/drm';
                const cards = fs.readdirSync(drmPath).filter(f => f.startsWith('card') && !f.includes('-'));

                for (const card of cards) {
                    const vendorPath = path.join(drmPath, card, 'device/vendor');
                    try {
                        const vendor = fs.readFileSync(vendorPath, 'utf8').trim();
                        if (vendor !== '0x8086') continue;

                        const devicePath = path.join(drmPath, card, 'device/device');
                        const deviceId = fs.readFileSync(devicePath, 'utf8').trim();

                        const gpuInfo = this.getGPUFromDeviceId(deviceId);
                        result.gpus.push({
                            index: result.gpus.length,
                            ...gpuInfo
                        });

                        if (gpuInfo.type === 'dedicated') {
                            result.totalVRAM += gpuInfo.memory.total;
                            result.hasDedicated = true;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            } catch (e2) {
                return null;
            }
        }

        if (result.gpus.length === 0) {
            return null;
        }

        result.isMultiGPU = result.gpus.filter(g => g.type === 'dedicated').length > 1;
        result.speedCoefficient = result.gpus.length > 0
            ? Math.max(...result.gpus.map(g => g.speedCoefficient))
            : 0;

        return result;
    }

    /**
     * Get VRAM from sysfs
     */
    getVRAMFromSysfs(lspciBlock) {
        // Look for memory region in lspci output
        const memMatch = lspciBlock.match(/Memory.*?\[size=(\d+)(G|M)/i);
        if (memMatch) {
            const size = parseInt(memMatch[1]);
            return memMatch[2].toUpperCase() === 'G' ? size : Math.round(size / 1024);
        }
        return null;
    }

    /**
     * Estimate VRAM based on model name
     */
    estimateVRAM(name) {
        const nameLower = (name || '').toLowerCase();

        // Arc discrete GPUs
        if (nameLower.includes('a770')) return 16;
        if (nameLower.includes('a750')) return 8;
        if (nameLower.includes('a580')) return 8;
        if (nameLower.includes('a380')) return 6;
        if (nameLower.includes('a310')) return 4;

        // Arc Pro series
        if (nameLower.includes('a60') || nameLower.includes('a50')) return 16;
        if (nameLower.includes('a40')) return 12;
        if (nameLower.includes('a30')) return 6;

        // Integrated (shares system memory)
        if (nameLower.includes('iris xe')) return 0;  // Reports 0, uses system RAM
        if (nameLower.includes('iris plus')) return 0;
        if (nameLower.includes('uhd')) return 0;
        if (nameLower.includes('hd graphics')) return 0;

        return 0;
    }

    /**
     * Get GPU info from device ID
     */
    getGPUFromDeviceId(deviceId) {
        const id = deviceId.toLowerCase().replace('0x', '');

        // Intel Arc discrete GPU device IDs
        const arcGPUs = {
            '56a0': { name: 'Intel Arc A770', vram: 16, dedicated: true },
            '56a1': { name: 'Intel Arc A750', vram: 8, dedicated: true },
            '56a5': { name: 'Intel Arc A580', vram: 8, dedicated: true },
            '56a6': { name: 'Intel Arc A380', vram: 6, dedicated: true },
            '5690': { name: 'Intel Arc A310', vram: 4, dedicated: true },
            // Arc Pro
            '56c0': { name: 'Intel Arc A60 Pro', vram: 16, dedicated: true },
            '56c1': { name: 'Intel Arc A40 Pro', vram: 12, dedicated: true }
        };

        // Integrated GPU device IDs (partial list)
        const iGPUs = {
            '9a49': { name: 'Intel Iris Xe Graphics', vram: 0, dedicated: false },
            '9a40': { name: 'Intel Iris Xe Graphics', vram: 0, dedicated: false },
            '4626': { name: 'Intel Iris Xe Graphics (12th Gen)', vram: 0, dedicated: false },
            '46a6': { name: 'Intel UHD Graphics (12th Gen)', vram: 0, dedicated: false },
            'a7a0': { name: 'Intel Iris Xe Graphics (13th Gen)', vram: 0, dedicated: false }
        };

        const gpuInfo = arcGPUs[id] || iGPUs[id] || {
            name: `Intel GPU (${deviceId})`,
            vram: 0,
            dedicated: false
        };

        return {
            name: gpuInfo.name,
            type: gpuInfo.dedicated ? 'dedicated' : 'integrated',
            memory: {
                total: gpuInfo.vram,
                shared: gpuInfo.dedicated ? 0 : gpuInfo.vram
            },
            capabilities: this.getGPUCapabilities(gpuInfo.name),
            speedCoefficient: this.calculateSpeedCoefficient(gpuInfo.name, gpuInfo.vram, gpuInfo.dedicated)
        };
    }

    /**
     * Get GPU capabilities
     */
    getGPUCapabilities(name) {
        const nameLower = (name || '').toLowerCase();

        const capabilities = {
            fp16: true,
            bf16: false,
            int8: true,
            xmx: false,  // Xe Matrix Extensions
            architecture: 'Unknown',
            xeVersion: null
        };

        // Arc GPUs (Alchemist - Xe HPG)
        if (nameLower.includes('arc a7') || nameLower.includes('arc a5')) {
            capabilities.bf16 = true;
            capabilities.xmx = true;
            capabilities.architecture = 'Xe HPG';
            capabilities.xeVersion = 'Xe-HPG';
        }
        else if (nameLower.includes('arc a3')) {
            capabilities.xmx = true;
            capabilities.architecture = 'Xe HPG';
            capabilities.xeVersion = 'Xe-HPG';
        }
        // Iris Xe (Xe LP)
        else if (nameLower.includes('iris xe')) {
            capabilities.architecture = 'Xe LP';
            capabilities.xeVersion = 'Xe-LP';
        }
        // UHD/HD Graphics
        else if (nameLower.includes('uhd') || nameLower.includes('hd graphics')) {
            capabilities.architecture = 'Gen 12'
            capabilities.xeVersion = 'Xe-LP';
        }

        return capabilities;
    }

    /**
     * Calculate speed coefficient
     */
    calculateSpeedCoefficient(name, vramGB, isDedicated) {
        const nameLower = (name || '').toLowerCase();

        // Speed coefficients (tokens/sec per B params at Q4)
        // Intel GPUs are generally slower than NVIDIA for LLM inference
        const speedMap = {
            // Arc discrete
            'a770': 120,
            'a750': 100,
            'a580': 80,
            'a380': 50,
            'a310': 35,
            // Arc Pro
            'a60': 110,
            'a50': 90,
            'a40': 70,
            'a30': 45,
            // Integrated
            'iris xe': 25,
            'iris plus': 15,
            'uhd': 12,
            'hd graphics': 8
        };

        for (const [model, speed] of Object.entries(speedMap)) {
            if (nameLower.includes(model)) {
                return speed;
            }
        }

        // Estimate based on VRAM/type
        if (isDedicated) {
            if (vramGB >= 16) return 100;
            if (vramGB >= 8) return 70;
            if (vramGB >= 6) return 50;
            return 30;
        }

        return 15;  // Integrated default
    }

    /**
     * Get primary GPU
     */
    getPrimaryGPU() {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return null;

        // Prefer dedicated over integrated
        const dedicated = info.gpus.filter(g => g.type === 'dedicated');
        if (dedicated.length > 0) {
            return dedicated.reduce((best, gpu) => {
                if (!best) return gpu;
                if (gpu.memory.total > best.memory.total) return gpu;
                return best;
            }, null);
        }

        return info.gpus[0];
    }

    /**
     * Get hardware fingerprint
     */
    getFingerprint() {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return null;

        const primary = this.getPrimaryGPU();
        const gpuName = primary.name.toLowerCase()
            .replace(/intel|graphics/gi, '')
            .replace(/\s+/g, '-')
            .trim();

        return `intel-${gpuName}-${primary.memory.total || 'shared'}gb`;
    }

    /**
     * Estimate inference speed
     */
    estimateTokensPerSecond(paramsB, quantization = 'Q4_K_M') {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return 0;

        const gpu = this.getPrimaryGPU();

        // Intel GPUs have different quantization performance characteristics
        const quantMult = {
            'FP16': 1.0,
            'Q8_0': 1.3,
            'Q6_K': 1.5,
            'Q5_K_M': 1.7,
            'Q5_0': 1.7,
            'Q4_K_M': 2.0,
            'Q4_0': 2.2,
            'Q3_K_M': 2.4,
            'Q2_K': 2.8,
            'IQ4_XS': 2.1,
            'IQ3_XXS': 2.5
        };

        const mult = quantMult[quantization] || 1.8;
        const baseSpeed = gpu.speedCoefficient / paramsB * mult;

        return Math.round(baseSpeed);
    }

    /**
     * Check oneAPI/SYCL availability for LLM inference
     */
    checkOneAPISupport() {
        try {
            // Check for SYCL runtime
            execSync('sycl-ls', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return true;
        } catch (e) {
            // Check for Intel oneAPI environment
            return !!process.env.ONEAPI_ROOT || !!process.env.SYCL_DEVICE_FILTER;
        }
    }
}

module.exports = IntelDetector;
