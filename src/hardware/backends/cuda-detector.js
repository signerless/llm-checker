/**
 * CUDA Detector
 * Detects NVIDIA GPUs using nvidia-smi
 * Supports multi-GPU setups and detailed CUDA information
 */

const { execSync, exec } = require('child_process');

class CUDADetector {
    constructor() {
        this.cache = null;
        this.isAvailable = null;
    }

    /**
     * Check if CUDA is available
     */
    checkAvailability() {
        if (this.isAvailable !== null) {
            return this.isAvailable;
        }

        try {
            execSync('nvidia-smi --version', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            this.isAvailable = true;
        } catch (e) {
            this.isAvailable = false;
        }

        return this.isAvailable;
    }

    /**
     * Detect all NVIDIA GPUs and their capabilities
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
     * Get detailed GPU information using nvidia-smi
     */
    getGPUInfo() {
        const result = {
            gpus: [],
            driver: null,
            cuda: null,
            totalVRAM: 0,
            backend: 'cuda',
            isMultiGPU: false,
            speedCoefficient: 0
        };

        try {
            // Get driver and CUDA version
            const versionInfo = execSync('nvidia-smi --query-gpu=driver_version --format=csv,noheader,nounits', {
                encoding: 'utf8',
                timeout: 5000
            }).trim().split('\n')[0];
            result.driver = versionInfo;

            // Get CUDA version from nvidia-smi header
            const header = execSync('nvidia-smi | head -n 3', {
                encoding: 'utf8',
                timeout: 5000
            });
            const cudaMatch = header.match(/CUDA Version:\s*([\d.]+)/);
            if (cudaMatch) {
                result.cuda = cudaMatch[1];
            }
        } catch (e) {
            // Continue without version info
        }

        try {
            // Query all GPUs with detailed info
            const query = [
                'index',
                'name',
                'uuid',
                'memory.total',
                'memory.free',
                'memory.used',
                'compute_mode',
                'pcie.link.gen.current',
                'pcie.link.width.current',
                'power.draw',
                'power.limit',
                'temperature.gpu',
                'utilization.gpu',
                'utilization.memory',
                'clocks.current.sm',
                'clocks.max.sm'
            ].join(',');

            const gpuData = execSync(
                `nvidia-smi --query-gpu=${query} --format=csv,noheader,nounits`,
                { encoding: 'utf8', timeout: 10000 }
            ).trim();

            const lines = gpuData.split('\n');

            for (const line of lines) {
                const parts = line.split(', ').map(p => p.trim());

                if (parts.length < 10) continue;

                const gpu = {
                    index: parseInt(parts[0]) || 0,
                    name: parts[1] || 'Unknown NVIDIA GPU',
                    uuid: parts[2] || null,
                    memory: {
                        total: Math.round(parseInt(parts[3]) / 1024) || 0,  // Convert MB to GB
                        free: Math.round(parseInt(parts[4]) / 1024) || 0,
                        used: Math.round(parseInt(parts[5]) / 1024) || 0
                    },
                    computeMode: parts[6] || 'Default',
                    pcie: {
                        generation: parseInt(parts[7]) || 0,
                        width: parseInt(parts[8]) || 0
                    },
                    power: {
                        draw: parseFloat(parts[9]) || 0,
                        limit: parseFloat(parts[10]) || 0
                    },
                    temperature: parseInt(parts[11]) || 0,
                    utilization: {
                        gpu: parseInt(parts[12]) || 0,
                        memory: parseInt(parts[13]) || 0
                    },
                    clocks: {
                        current: parseInt(parts[14]) || 0,
                        max: parseInt(parts[15]) || 0
                    },
                    capabilities: this.getGPUCapabilities(parts[1]),
                    speedCoefficient: this.calculateSpeedCoefficient(parts[1], parseInt(parts[3]))
                };

                result.gpus.push(gpu);
                result.totalVRAM += gpu.memory.total;
            }
        } catch (e) {
            // Fallback to simpler query
            try {
                const simpleQuery = execSync(
                    'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
                    { encoding: 'utf8', timeout: 5000 }
                ).trim();

                const lines = simpleQuery.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const [name, memMB] = lines[i].split(', ').map(p => p.trim());
                    const memGB = Math.round(parseInt(memMB) / 1024) || 0;

                    result.gpus.push({
                        index: i,
                        name: name || 'NVIDIA GPU',
                        memory: { total: memGB, free: memGB, used: 0 },
                        capabilities: this.getGPUCapabilities(name),
                        speedCoefficient: this.calculateSpeedCoefficient(name, parseInt(memMB))
                    });
                    result.totalVRAM += memGB;
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
            tensorCores: false,
            fp16: true,
            bf16: false,
            int8: true,
            fp8: false,
            nvlink: false,
            computeCapability: '5.0',
            architecture: 'Unknown'
        };

        // RTX 50 series (Blackwell)
        if (nameLower.includes('rtx 50') || nameLower.includes('rtx50')) {
            capabilities.tensorCores = true;
            capabilities.bf16 = true;
            capabilities.fp8 = true;
            capabilities.computeCapability = '10.0';
            capabilities.architecture = 'Blackwell';
        }
        // RTX 40 series (Ada Lovelace)
        else if (nameLower.includes('rtx 40') || nameLower.includes('rtx40') ||
                 nameLower.includes('l40') || nameLower.includes('l4')) {
            capabilities.tensorCores = true;
            capabilities.bf16 = true;
            capabilities.fp8 = true;
            capabilities.computeCapability = '8.9';
            capabilities.architecture = 'Ada Lovelace';
        }
        // RTX 30 series (Ampere)
        else if (nameLower.includes('rtx 30') || nameLower.includes('rtx30') ||
                 nameLower.includes('a100') || nameLower.includes('a40') ||
                 nameLower.includes('a30') || nameLower.includes('a10')) {
            capabilities.tensorCores = true;
            capabilities.bf16 = true;
            capabilities.computeCapability = '8.0';
            capabilities.architecture = 'Ampere';
            if (nameLower.includes('a100')) {
                capabilities.nvlink = true;
            }
        }
        // RTX 20 series (Turing)
        else if (nameLower.includes('rtx 20') || nameLower.includes('rtx20') ||
                 nameLower.includes('t4') || nameLower.includes('quadro rtx')) {
            capabilities.tensorCores = true;
            capabilities.computeCapability = '7.5';
            capabilities.architecture = 'Turing';
        }
        // GTX 16 series (Turing without Tensor Cores)
        else if (nameLower.includes('gtx 16')) {
            capabilities.computeCapability = '7.5';
            capabilities.architecture = 'Turing';
        }
        // Tesla V100 (Volta)
        else if (nameLower.includes('v100') || nameLower.includes('volta')) {
            capabilities.tensorCores = true;
            capabilities.computeCapability = '7.0';
            capabilities.architecture = 'Volta';
            capabilities.nvlink = true;
        }
        // H100 (Hopper)
        else if (nameLower.includes('h100') || nameLower.includes('h200')) {
            capabilities.tensorCores = true;
            capabilities.bf16 = true;
            capabilities.fp8 = true;
            capabilities.nvlink = true;
            capabilities.computeCapability = '9.0';
            capabilities.architecture = 'Hopper';
        }

        return capabilities;
    }

    /**
     * Calculate speed coefficient for LLM inference
     */
    calculateSpeedCoefficient(name, vramMB) {
        const nameLower = (name || '').toLowerCase();
        const vramGB = Math.round(vramMB / 1024);

        // Speed coefficients (tokens/sec per B params at Q4)
        const speedMap = {
            // RTX 50 series
            'rtx 5090': 300,
            'rtx 5080': 260,
            'rtx 5070 ti': 230,
            'rtx 5070': 210,
            'rtx 5060': 180,

            // RTX 40 series
            'rtx 4090': 260,
            'rtx 4080': 220,
            'rtx 4070 ti': 190,
            'rtx 4070': 170,
            'rtx 4060 ti': 150,
            'rtx 4060': 130,

            // RTX 30 series
            'rtx 3090 ti': 220,
            'rtx 3090': 200,
            'rtx 3080 ti': 190,
            'rtx 3080': 180,
            'rtx 3070 ti': 160,
            'rtx 3070': 150,
            'rtx 3060 ti': 130,
            'rtx 3060': 110,

            // RTX 20 series
            'rtx 2080 ti': 140,
            'rtx 2080': 120,
            'rtx 2070': 100,
            'rtx 2060': 80,

            // Data center
            'h100': 400,
            'h200': 450,
            'a100': 300,
            'l40': 220,
            'l4': 150,
            'a40': 180,
            't4': 70,
            'v100': 120
        };

        for (const [model, speed] of Object.entries(speedMap)) {
            if (nameLower.includes(model)) {
                return speed;
            }
        }

        // Estimate based on VRAM if model not found
        if (vramGB >= 24) return 200;
        if (vramGB >= 16) return 150;
        if (vramGB >= 12) return 120;
        if (vramGB >= 8) return 90;
        if (vramGB >= 6) return 60;
        return 40;
    }

    /**
     * Get primary GPU (highest VRAM or fastest)
     */
    getPrimaryGPU() {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return null;

        return info.gpus.reduce((best, gpu) => {
            if (!best) return gpu;
            // Prefer higher VRAM, then higher speed coefficient
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
            .replace(/nvidia|geforce|quadro|tesla/gi, '')
            .replace(/\s+/g, '-')
            .trim();

        return `cuda-${gpuName}-${info.totalVRAM}gb${info.isMultiGPU ? '-x' + info.gpus.length : ''}`;
    }

    /**
     * Estimate inference speed for a model size
     */
    estimateTokensPerSecond(paramsB, quantization = 'Q4_K_M', gpuIndex = null) {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return 0;

        const gpu = gpuIndex !== null && info.gpus[gpuIndex]
            ? info.gpus[gpuIndex]
            : this.getPrimaryGPU();

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
        const baseSpeed = gpu.speedCoefficient / paramsB * mult;

        return Math.round(baseSpeed);
    }

    /**
     * Check if model will fit in VRAM
     */
    willFitInVRAM(sizeGB, useMultiGPU = true) {
        const info = this.detect();
        if (!info) return false;

        const availableVRAM = useMultiGPU ? info.totalVRAM : this.getPrimaryGPU()?.memory?.total || 0;
        // Leave 2GB headroom for system
        return sizeGB <= (availableVRAM - 2);
    }
}

module.exports = CUDADetector;
