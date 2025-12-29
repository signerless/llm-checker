/**
 * ROCm Detector
 * Detects AMD GPUs using rocm-smi
 * Supports multi-GPU setups and ROCm capabilities
 */

const { execSync } = require('child_process');

class ROCmDetector {
    constructor() {
        this.cache = null;
        this.isAvailable = null;
    }

    /**
     * Check if ROCm is available
     */
    checkAvailability() {
        if (this.isAvailable !== null) {
            return this.isAvailable;
        }

        try {
            execSync('rocm-smi --version', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            this.isAvailable = true;
        } catch (e) {
            // Try alternative rocminfo command
            try {
                execSync('rocminfo', {
                    encoding: 'utf8',
                    timeout: 5000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                this.isAvailable = true;
            } catch (e2) {
                this.isAvailable = false;
            }
        }

        return this.isAvailable;
    }

    /**
     * Detect all AMD GPUs and their capabilities
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
     * Get detailed GPU information using rocm-smi
     */
    getGPUInfo() {
        const result = {
            gpus: [],
            rocmVersion: null,
            totalVRAM: 0,
            backend: 'rocm',
            isMultiGPU: false,
            speedCoefficient: 0
        };

        // Get ROCm version
        try {
            const versionOutput = execSync('rocm-smi --version', {
                encoding: 'utf8',
                timeout: 5000
            });
            const match = versionOutput.match(/(\d+\.\d+\.?\d*)/);
            if (match) {
                result.rocmVersion = match[1];
            }
        } catch (e) {
            // Continue without version
        }

        try {
            // Get GPU list using rocm-smi
            const gpuList = execSync('rocm-smi --showproductname', {
                encoding: 'utf8',
                timeout: 10000
            });

            // Parse GPU names
            const gpuNames = [];
            const nameMatches = gpuList.matchAll(/GPU\[(\d+)\].*?:\s*(.+)/g);
            for (const match of nameMatches) {
                gpuNames[parseInt(match[1])] = match[2].trim();
            }

            // Get VRAM info
            const memInfo = execSync('rocm-smi --showmeminfo vram', {
                encoding: 'utf8',
                timeout: 10000
            });

            // Parse memory info
            const memMatches = memInfo.matchAll(/GPU\[(\d+)\].*?Total.*?:\s*(\d+)/g);
            const gpuMemory = {};
            for (const match of memMatches) {
                const idx = parseInt(match[1]);
                const memMB = parseInt(match[2]);
                gpuMemory[idx] = Math.round(memMB / 1024);  // Convert to GB
            }

            // Get temperature and utilization
            let temps = {};
            let utils = {};
            try {
                const tempInfo = execSync('rocm-smi --showtemp', {
                    encoding: 'utf8',
                    timeout: 5000
                });
                const tempMatches = tempInfo.matchAll(/GPU\[(\d+)\].*?Temperature.*?:\s*(\d+\.?\d*)/g);
                for (const match of tempMatches) {
                    temps[parseInt(match[1])] = parseFloat(match[2]);
                }

                const utilInfo = execSync('rocm-smi --showuse', {
                    encoding: 'utf8',
                    timeout: 5000
                });
                const utilMatches = utilInfo.matchAll(/GPU\[(\d+)\].*?GPU use.*?:\s*(\d+)/g);
                for (const match of utilMatches) {
                    utils[parseInt(match[1])] = parseInt(match[2]);
                }
            } catch (e) {
                // Continue without temp/util
            }

            // Build GPU list
            const numGPUs = Math.max(gpuNames.length, Object.keys(gpuMemory).length);
            for (let i = 0; i < numGPUs; i++) {
                const name = gpuNames[i] || `AMD GPU ${i}`;
                const vram = gpuMemory[i] || this.estimateVRAMFromModel(name);

                const gpu = {
                    index: i,
                    name: name,
                    memory: {
                        total: vram,
                        free: vram,  // ROCm doesn't always report free memory
                        used: 0
                    },
                    temperature: temps[i] || 0,
                    utilization: utils[i] || 0,
                    capabilities: this.getGPUCapabilities(name),
                    speedCoefficient: this.calculateSpeedCoefficient(name, vram)
                };

                result.gpus.push(gpu);
                result.totalVRAM += vram;
            }
        } catch (e) {
            // Fallback to rocminfo
            try {
                const rocmInfo = execSync('rocminfo', {
                    encoding: 'utf8',
                    timeout: 10000
                });

                // Parse AMD GPUs from rocminfo
                const agentMatches = rocmInfo.matchAll(/Name:\s*(gfx\d+|AMD.*)/gi);
                let idx = 0;
                for (const match of agentMatches) {
                    const name = match[1].trim();
                    if (name.toLowerCase().includes('gfx') || name.toLowerCase().includes('amd')) {
                        const vram = this.estimateVRAMFromGfxName(name);

                        result.gpus.push({
                            index: idx,
                            name: name,
                            memory: { total: vram, free: vram, used: 0 },
                            capabilities: this.getGPUCapabilities(name),
                            speedCoefficient: this.calculateSpeedCoefficient(name, vram)
                        });
                        result.totalVRAM += vram;
                        idx++;
                    }
                }
            } catch (e2) {
                return null;
            }
        }

        result.isMultiGPU = result.gpus.length > 1;
        result.speedCoefficient = result.gpus.length > 0
            ? Math.max(...result.gpus.map(g => g.speedCoefficient))
            : 0;

        return result;
    }

    /**
     * Get GPU capabilities based on model name
     */
    getGPUCapabilities(name) {
        const nameLower = (name || '').toLowerCase();

        const capabilities = {
            fp16: true,
            bf16: false,
            int8: true,
            matrixCores: false,
            infinityCache: false,
            architecture: 'Unknown',
            gfxVersion: null
        };

        // RDNA 3 (RX 7000 series)
        if (nameLower.includes('7900') || nameLower.includes('7800') ||
            nameLower.includes('7700') || nameLower.includes('7600') ||
            nameLower.includes('gfx1100') || nameLower.includes('gfx1101') ||
            nameLower.includes('gfx1102')) {
            capabilities.bf16 = true;
            capabilities.matrixCores = true;  // AI Accelerators
            capabilities.infinityCache = true;
            capabilities.architecture = 'RDNA 3';
            capabilities.gfxVersion = 'gfx1100';
        }
        // RDNA 2 (RX 6000 series)
        else if (nameLower.includes('6900') || nameLower.includes('6800') ||
                 nameLower.includes('6700') || nameLower.includes('6600') ||
                 nameLower.includes('gfx1030') || nameLower.includes('gfx1031') ||
                 nameLower.includes('gfx1032')) {
            capabilities.infinityCache = true;
            capabilities.architecture = 'RDNA 2';
            capabilities.gfxVersion = 'gfx1030';
        }
        // CDNA 2/3 (Instinct MI200/MI300 series)
        else if (nameLower.includes('mi300') || nameLower.includes('mi250') ||
                 nameLower.includes('mi210') || nameLower.includes('gfx940') ||
                 nameLower.includes('gfx90a')) {
            capabilities.bf16 = true;
            capabilities.matrixCores = true;
            capabilities.architecture = 'CDNA';
            capabilities.gfxVersion = nameLower.includes('mi300') ? 'gfx940' : 'gfx90a';
        }
        // CDNA (Instinct MI100)
        else if (nameLower.includes('mi100') || nameLower.includes('gfx908')) {
            capabilities.bf16 = true;
            capabilities.matrixCores = true;
            capabilities.architecture = 'CDNA';
            capabilities.gfxVersion = 'gfx908';
        }
        // RDNA 1 (RX 5000 series)
        else if (nameLower.includes('5700') || nameLower.includes('5600') ||
                 nameLower.includes('5500') || nameLower.includes('gfx1010')) {
            capabilities.architecture = 'RDNA 1';
            capabilities.gfxVersion = 'gfx1010';
        }

        return capabilities;
    }

    /**
     * Estimate VRAM from model name
     */
    estimateVRAMFromModel(name) {
        const nameLower = (name || '').toLowerCase();

        // RX 7000 series
        if (nameLower.includes('7900 xtx')) return 24;
        if (nameLower.includes('7900 xt')) return 20;
        if (nameLower.includes('7900 gre')) return 16;
        if (nameLower.includes('7800 xt')) return 16;
        if (nameLower.includes('7700 xt')) return 12;
        if (nameLower.includes('7600')) return 8;

        // RX 6000 series
        if (nameLower.includes('6950 xt')) return 16;
        if (nameLower.includes('6900 xt')) return 16;
        if (nameLower.includes('6800 xt')) return 16;
        if (nameLower.includes('6800')) return 16;
        if (nameLower.includes('6750 xt')) return 12;
        if (nameLower.includes('6700 xt')) return 12;
        if (nameLower.includes('6700')) return 10;
        if (nameLower.includes('6650 xt')) return 8;
        if (nameLower.includes('6600')) return 8;

        // Instinct series
        if (nameLower.includes('mi300x')) return 192;
        if (nameLower.includes('mi300')) return 128;
        if (nameLower.includes('mi250x')) return 128;
        if (nameLower.includes('mi250')) return 64;
        if (nameLower.includes('mi210')) return 64;
        if (nameLower.includes('mi100')) return 32;

        return 8;  // Default
    }

    /**
     * Estimate VRAM from gfx name
     */
    estimateVRAMFromGfxName(name) {
        const nameLower = (name || '').toLowerCase();

        if (nameLower.includes('gfx1100')) return 24;  // RX 7900 XTX
        if (nameLower.includes('gfx1101')) return 16;  // RX 7800
        if (nameLower.includes('gfx1102')) return 8;   // RX 7600
        if (nameLower.includes('gfx1030')) return 16;  // RX 6900/6800
        if (nameLower.includes('gfx1031')) return 12;  // RX 6700
        if (nameLower.includes('gfx1032')) return 8;   // RX 6600
        if (nameLower.includes('gfx940')) return 128;  // MI300
        if (nameLower.includes('gfx90a')) return 64;   // MI250

        return 8;
    }

    /**
     * Calculate speed coefficient for LLM inference
     */
    calculateSpeedCoefficient(name, vramGB) {
        const nameLower = (name || '').toLowerCase();

        // Speed coefficients (tokens/sec per B params at Q4)
        const speedMap = {
            // RX 7000 series (RDNA 3)
            '7900 xtx': 200,
            '7900 xt': 180,
            '7900 gre': 160,
            '7800 xt': 150,
            '7700 xt': 120,
            '7600': 90,

            // RX 6000 series (RDNA 2)
            '6950 xt': 150,
            '6900 xt': 140,
            '6800 xt': 130,
            '6800': 120,
            '6750 xt': 100,
            '6700 xt': 90,
            '6700': 80,
            '6600 xt': 70,
            '6600': 60,

            // Instinct series
            'mi300x': 400,
            'mi300': 350,
            'mi250x': 280,
            'mi250': 250,
            'mi210': 200,
            'mi100': 150
        };

        for (const [model, speed] of Object.entries(speedMap)) {
            if (nameLower.includes(model)) {
                return speed;
            }
        }

        // Estimate based on VRAM if model not found
        if (vramGB >= 24) return 180;
        if (vramGB >= 16) return 140;
        if (vramGB >= 12) return 100;
        if (vramGB >= 8) return 70;
        return 40;
    }

    /**
     * Get primary GPU
     */
    getPrimaryGPU() {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return null;

        return info.gpus.reduce((best, gpu) => {
            if (!best) return gpu;
            if (gpu.memory.total > best.memory.total) return gpu;
            if (gpu.memory.total === best.memory.total &&
                gpu.speedCoefficient > best.speedCoefficient) return gpu;
            return best;
        }, null);
    }

    /**
     * Get hardware fingerprint for benchmarks
     */
    getFingerprint() {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return null;

        const primary = this.getPrimaryGPU();
        const gpuName = primary.name.toLowerCase()
            .replace(/amd|radeon|rx/gi, '')
            .replace(/\s+/g, '-')
            .trim();

        return `rocm-${gpuName}-${info.totalVRAM}gb${info.isMultiGPU ? '-x' + info.gpus.length : ''}`;
    }

    /**
     * Estimate inference speed for a model size
     */
    estimateTokensPerSecond(paramsB, quantization = 'Q4_K_M') {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return 0;

        const gpu = this.getPrimaryGPU();

        const quantMult = {
            'FP16': 1.0,
            'Q8_0': 1.4,
            'Q6_K': 1.6,
            'Q5_K_M': 1.8,
            'Q5_0': 1.8,
            'Q4_K_M': 2.2,
            'Q4_0': 2.4,
            'Q3_K_M': 2.6,
            'Q2_K': 3.0,
            'IQ4_XS': 2.3,
            'IQ3_XXS': 2.8
        };

        const mult = quantMult[quantization] || 1.8;
        const baseSpeed = gpu.speedCoefficient / paramsB * mult;

        return Math.round(baseSpeed);
    }
}

module.exports = ROCmDetector;
