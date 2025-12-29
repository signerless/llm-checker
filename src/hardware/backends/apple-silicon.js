/**
 * Apple Silicon Detector
 * Detects M1, M2, M3, M4 chips and their capabilities
 * Uses sysctl and system_profiler for accurate detection
 */

const { execSync } = require('child_process');

class AppleSiliconDetector {
    constructor() {
        this.cache = null;
        this.isSupported = process.platform === 'darwin' && process.arch === 'arm64';
    }

    /**
     * Detect if running on Apple Silicon
     */
    detect() {
        if (!this.isSupported) {
            return null;
        }

        if (this.cache) {
            return this.cache;
        }

        try {
            const info = this.getChipInfo();
            this.cache = info;
            return info;
        } catch (error) {
            return null;
        }
    }

    /**
     * Get detailed chip information using sysctl
     */
    getChipInfo() {
        const result = {
            chip: null,
            variant: null,  // base, pro, max, ultra
            generation: null,  // 1, 2, 3, 4
            cores: {
                performance: 0,
                efficiency: 0,
                total: 0
            },
            gpu: {
                cores: 0,
                model: null
            },
            neuralEngine: {
                cores: 0
            },
            memory: {
                unified: 0,
                bandwidth: null
            },
            capabilities: {
                metal: true,
                metalVersion: null,
                fp16: true,
                int8: true,
                amx: true
            },
            backend: 'metal',
            speedCoefficient: 0
        };

        // Get chip brand
        try {
            const brand = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8', timeout: 5000 }).trim();
            result.chip = brand;

            // Parse chip variant and generation
            const parsed = this.parseChipBrand(brand);
            result.variant = parsed.variant;
            result.generation = parsed.generation;
        } catch (e) {
            // Fallback
        }

        // Get CPU cores
        try {
            result.cores.total = parseInt(execSync('sysctl -n hw.ncpu', { encoding: 'utf8', timeout: 5000 }).trim());
            result.cores.performance = parseInt(execSync('sysctl -n hw.perflevel0.logicalcpu', { encoding: 'utf8', timeout: 5000 }).trim()) || Math.ceil(result.cores.total / 2);
            result.cores.efficiency = parseInt(execSync('sysctl -n hw.perflevel1.logicalcpu', { encoding: 'utf8', timeout: 5000 }).trim()) || Math.floor(result.cores.total / 2);
        } catch (e) {
            result.cores.total = require('os').cpus().length;
        }

        // Get memory (unified memory on Apple Silicon)
        try {
            const memBytes = parseInt(execSync('sysctl -n hw.memsize', { encoding: 'utf8', timeout: 5000 }).trim());
            result.memory.unified = Math.round(memBytes / (1024 ** 3));
        } catch (e) {
            result.memory.unified = Math.round(require('os').totalmem() / (1024 ** 3));
        }

        // Get GPU cores from system_profiler
        try {
            const gpuInfo = execSync('system_profiler SPDisplaysDataType -json', {
                encoding: 'utf8',
                timeout: 5000
            });
            const parsed = JSON.parse(gpuInfo);
            const displays = parsed.SPDisplaysDataType || [];

            if (displays.length > 0) {
                const gpu = displays[0];
                result.gpu.model = gpu.sppci_model || result.chip;

                // Parse GPU cores from model name or estimate
                const coreMatch = gpu.sppci_cores?.match(/(\d+)/);
                if (coreMatch) {
                    result.gpu.cores = parseInt(coreMatch[1]);
                } else {
                    result.gpu.cores = this.estimateGPUCores(result.variant, result.generation);
                }
            }
        } catch (e) {
            result.gpu.cores = this.estimateGPUCores(result.variant, result.generation);
            result.gpu.model = result.chip;
        }

        // Get Metal version
        try {
            const metalVersion = execSync('system_profiler SPDisplaysDataType | grep "Metal Support"', {
                encoding: 'utf8',
                timeout: 5000
            });
            const match = metalVersion.match(/Metal\s*([\d.]+|Family)/i);
            if (match) {
                result.capabilities.metalVersion = match[1];
            }
        } catch (e) {
            result.capabilities.metalVersion = '3';  // Apple Silicon supports Metal 3
        }

        // Calculate speed coefficient for LLM inference
        result.speedCoefficient = this.calculateSpeedCoefficient(result);
        result.memory.bandwidth = this.estimateMemoryBandwidth(result.variant, result.generation);

        return result;
    }

    /**
     * Parse chip brand string to extract variant and generation
     */
    parseChipBrand(brand) {
        const result = { variant: 'base', generation: 1 };

        const brandLower = brand.toLowerCase();

        // Detect generation
        if (brandLower.includes('m4')) result.generation = 4;
        else if (brandLower.includes('m3')) result.generation = 3;
        else if (brandLower.includes('m2')) result.generation = 2;
        else if (brandLower.includes('m1')) result.generation = 1;

        // Detect variant
        if (brandLower.includes('ultra')) result.variant = 'ultra';
        else if (brandLower.includes('max')) result.variant = 'max';
        else if (brandLower.includes('pro')) result.variant = 'pro';
        else result.variant = 'base';

        return result;
    }

    /**
     * Estimate GPU cores based on variant and generation
     */
    estimateGPUCores(variant, generation) {
        const coreMap = {
            // M1 series
            '1-base': 8,
            '1-pro': 16,
            '1-max': 32,
            '1-ultra': 64,
            // M2 series
            '2-base': 10,
            '2-pro': 19,
            '2-max': 38,
            '2-ultra': 76,
            // M3 series
            '3-base': 10,
            '3-pro': 18,
            '3-max': 40,
            '3-ultra': 80,
            // M4 series
            '4-base': 10,
            '4-pro': 20,
            '4-max': 40,
            '4-ultra': 80
        };

        return coreMap[`${generation}-${variant}`] || 10;
    }

    /**
     * Estimate memory bandwidth in GB/s
     */
    estimateMemoryBandwidth(variant, generation) {
        const bandwidthMap = {
            // M1 series
            '1-base': 68,
            '1-pro': 200,
            '1-max': 400,
            '1-ultra': 800,
            // M2 series
            '2-base': 100,
            '2-pro': 200,
            '2-max': 400,
            '2-ultra': 800,
            // M3 series
            '3-base': 100,
            '3-pro': 150,
            '3-max': 400,
            '3-ultra': 800,
            // M4 series
            '4-base': 120,
            '4-pro': 273,
            '4-max': 546,
            '4-ultra': 800
        };

        return bandwidthMap[`${generation}-${variant}`] || 100;
    }

    /**
     * Calculate speed coefficient for LLM inference (tokens/sec per B params)
     */
    calculateSpeedCoefficient(info) {
        // Base coefficient by generation and variant
        const baseCoefficients = {
            '1-base': 180,
            '1-pro': 200,
            '1-max': 220,
            '1-ultra': 240,
            '2-base': 200,
            '2-pro': 220,
            '2-max': 240,
            '2-ultra': 260,
            '3-base': 220,
            '3-pro': 240,
            '3-max': 260,
            '3-ultra': 280,
            '4-base': 240,
            '4-pro': 270,
            '4-max': 300,
            '4-ultra': 320
        };

        const key = `${info.generation}-${info.variant}`;
        return baseCoefficients[key] || 180;
    }

    /**
     * Check if Ollama is using Metal backend
     */
    async checkMetalSupport() {
        if (!this.isSupported) {
            return false;
        }

        try {
            // Check if Metal framework is available
            const metalCheck = execSync('ls /System/Library/Frameworks/Metal.framework', {
                encoding: 'utf8',
                timeout: 2000
            });
            return metalCheck.includes('Metal');
        } catch (e) {
            return true;  // Assume Metal is available on Apple Silicon
        }
    }

    /**
     * Get hardware fingerprint for benchmarks
     */
    getFingerprint() {
        const info = this.detect();
        if (!info) return null;

        return `apple-${info.chip.toLowerCase().replace(/\s+/g, '-')}-${info.memory.unified}gb`;
    }

    /**
     * Estimate inference speed for a model size
     */
    estimateTokensPerSecond(paramsB, quantization = 'Q4_K_M') {
        const info = this.detect();
        if (!info) return 0;

        // Quantization multipliers (how much faster vs FP16)
        const quantMult = {
            'FP16': 1.0,
            'Q8_0': 1.5,
            'Q6_K': 1.8,
            'Q5_K_M': 2.0,
            'Q5_0': 2.0,
            'Q4_K_M': 2.5,
            'Q4_0': 2.8,
            'Q3_K_M': 3.0,
            'Q2_K': 3.5,
            'IQ4_XS': 2.6,
            'IQ3_XXS': 3.2
        };

        const mult = quantMult[quantization] || 2.0;
        const baseSpeed = info.speedCoefficient / paramsB * mult;

        return Math.round(baseSpeed);
    }
}

module.exports = AppleSiliconDetector;
