/**
 * CUDA Detector
 * Detects NVIDIA GPUs using nvidia-smi
 * Supports multi-GPU setups and detailed CUDA information
 */

const fs = require('fs');
const os = require('os');
const { execSync, exec } = require('child_process');

class CUDADetector {
    constructor() {
        this.cache = null;
        this.isAvailable = null;
        this.detectionMode = null;
    }

    /**
     * Check if CUDA is available
     */
    checkAvailability() {
        if (this.isAvailable !== null) {
            return this.isAvailable;
        }

        if (this.hasNvidiaSMI()) {
            this.isAvailable = true;
            this.detectionMode = 'nvidia-smi';
            return this.isAvailable;
        }

        if (this.isJetsonPlatform() && this.hasJetsonCudaSupport()) {
            this.isAvailable = true;
            this.detectionMode = 'jetson';
            return this.isAvailable;
        }

        this.isAvailable = false;
        this.detectionMode = null;

        return this.isAvailable;
    }

    hasNvidiaSMI() {
        try {
            execSync('nvidia-smi --version', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return true;
        } catch (e) {
            return false;
        }
    }

    readFileIfExists(path) {
        try {
            if (!fs.existsSync(path)) return null;
            return fs.readFileSync(path, 'utf8').replace(/\0/g, '').trim();
        } catch (e) {
            return null;
        }
    }

    isJetsonPlatform() {
        if (process.platform !== 'linux') return false;

        // Strong L4T marker present on Jetson devices
        if (this.readFileIfExists('/etc/nv_tegra_release')) {
            return true;
        }

        const modelPaths = [
            '/proc/device-tree/model',
            '/sys/firmware/devicetree/base/model',
            '/proc/device-tree/compatible',
            '/sys/firmware/devicetree/base/compatible'
        ];

        const jetsonMarkers = [
            'jetson',
            'tegra',
            'orin',
            'xavier',
            'p3701',
            'p3767',
            'p2888',
            'p3668',
            'p3448'
        ];

        for (const modelPath of modelPaths) {
            const model = this.readFileIfExists(modelPath);
            if (!model) continue;

            const modelLower = model.toLowerCase();
            if (jetsonMarkers.some((marker) => modelLower.includes(marker))) {
                return true;
            }
        }

        // Jetson kernels often include tegra in release string
        const kernelRelease = (os.release() || '').toLowerCase();
        if (kernelRelease.includes('tegra')) {
            return true;
        }

        // Last-resort utility-based detection for minimal installs
        if (process.arch === 'arm64' && (
            fs.existsSync('/usr/bin/tegrastats') ||
            fs.existsSync('/usr/sbin/nvpmodel')
        )) {
            return true;
        }

        const cpuInfo = this.readFileIfExists('/proc/cpuinfo');
        if (cpuInfo) {
            const cpuLower = cpuInfo.toLowerCase();
            if (cpuLower.includes('nvidia') && cpuLower.includes('tegra')) {
                return true;
            }
        }

        return false;
    }

    hasJetsonCudaSupport() {
        const runtimeHints = [
            '/usr/local/cuda',
            '/usr/bin/tegrastats',
            '/usr/sbin/nvpmodel',
            '/usr/lib/aarch64-linux-gnu/tegra',
            '/etc/nv_tegra_release',
            '/dev/nvhost-gpu',
            '/dev/nvmap',
            '/proc/driver/nvidia/version'
        ];

        if (runtimeHints.some((hintPath) => fs.existsSync(hintPath))) {
            return true;
        }

        try {
            execSync('nvcc --version', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return true;
        } catch (e) {
            return false;
        }
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
            const info = this.detectionMode === 'jetson'
                ? this.getJetsonGPUInfo()
                : this.getGPUInfo();

            if (!info || !Array.isArray(info.gpus) || info.gpus.length === 0) {
                return null;
            }

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

    getJetsonGPUInfo() {
        const modelRaw = this.readJetsonModel();
        const model = this.normalizeJetsonModel(modelRaw);
        const cudaVersion = this.detectJetsonCudaVersion();
        const driverVersion = this.detectJetsonDriverVersion();
        const totalSystemGB = Math.max(1, Math.round(os.totalmem() / (1024 ** 3)));
        const sharedGpuMemoryGB = Math.max(1, Math.round(totalSystemGB * 0.85));
        const capabilities = this.getJetsonCapabilities(modelRaw || model);
        const speedCoefficient = this.getJetsonSpeedCoefficient(modelRaw || model);

        return {
            gpus: [
                {
                    index: 0,
                    name: model,
                    uuid: null,
                    memory: {
                        total: sharedGpuMemoryGB,
                        free: Math.max(0, sharedGpuMemoryGB - 1),
                        used: Math.min(1, sharedGpuMemoryGB)
                    },
                    computeMode: 'Default',
                    pcie: {
                        generation: 0,
                        width: 0
                    },
                    power: {
                        draw: 0,
                        limit: 0
                    },
                    temperature: 0,
                    utilization: {
                        gpu: 0,
                        memory: 0
                    },
                    clocks: {
                        current: 0,
                        max: 0
                    },
                    capabilities,
                    speedCoefficient
                }
            ],
            driver: driverVersion,
            cuda: cudaVersion,
            totalVRAM: sharedGpuMemoryGB,
            backend: 'cuda',
            isMultiGPU: false,
            speedCoefficient
        };
    }

    readJetsonModel() {
        const sources = [
            '/proc/device-tree/model',
            '/sys/firmware/devicetree/base/model'
        ];

        for (const source of sources) {
            const model = this.readFileIfExists(source);
            if (model) return model;
        }

        return null;
    }

    normalizeJetsonModel(model) {
        const modelLower = (model || '').toLowerCase();

        if (modelLower.includes('agx orin')) return 'NVIDIA Jetson AGX Orin';
        if (modelLower.includes('orin nx')) return 'NVIDIA Jetson Orin NX';
        if (modelLower.includes('orin nano')) return 'NVIDIA Jetson Orin Nano';
        if (modelLower.includes('orin')) return 'NVIDIA Jetson Orin';
        if (modelLower.includes('xavier nx')) return 'NVIDIA Jetson Xavier NX';
        if (modelLower.includes('agx xavier')) return 'NVIDIA Jetson AGX Xavier';
        if (modelLower.includes('xavier')) return 'NVIDIA Jetson Xavier';
        if (modelLower.includes('jetson nano')) return 'NVIDIA Jetson Nano';
        if (modelLower.includes('tx2')) return 'NVIDIA Jetson TX2';

        return 'NVIDIA Jetson (CUDA)';
    }

    detectJetsonCudaVersion() {
        const versionTxt = this.readFileIfExists('/usr/local/cuda/version.txt');
        if (versionTxt) {
            const match = versionTxt.match(/CUDA Version\s+([\d.]+)/i);
            if (match) return match[1];
        }

        try {
            const nvccVersion = execSync('nvcc --version', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            const match = nvccVersion.match(/release\s+([\d.]+)/i);
            if (match) return match[1];
        } catch (e) {
            // Ignore missing nvcc
        }

        return null;
    }

    detectJetsonDriverVersion() {
        const versionInfo = this.readFileIfExists('/proc/driver/nvidia/version');
        if (!versionInfo) return null;

        const match = versionInfo.match(/Kernel Module\s+([0-9.]+)/i);
        return match ? match[1] : null;
    }

    getJetsonCapabilities(model) {
        const modelLower = (model || '').toLowerCase();

        if (modelLower.includes('orin')) {
            return {
                tensorCores: true,
                fp16: true,
                bf16: true,
                int8: true,
                fp8: false,
                nvlink: false,
                computeCapability: '8.7',
                architecture: 'Ampere'
            };
        }

        if (modelLower.includes('xavier')) {
            return {
                tensorCores: true,
                fp16: true,
                bf16: false,
                int8: true,
                fp8: false,
                nvlink: false,
                computeCapability: '7.2',
                architecture: 'Volta'
            };
        }

        if (modelLower.includes('tx2')) {
            return {
                tensorCores: false,
                fp16: true,
                bf16: false,
                int8: true,
                fp8: false,
                nvlink: false,
                computeCapability: '6.2',
                architecture: 'Pascal'
            };
        }

        if (modelLower.includes('nano')) {
            return {
                tensorCores: false,
                fp16: true,
                bf16: false,
                int8: true,
                fp8: false,
                nvlink: false,
                computeCapability: '5.3',
                architecture: 'Maxwell'
            };
        }

        return {
            tensorCores: false,
            fp16: true,
            bf16: false,
            int8: true,
            fp8: false,
            nvlink: false,
            computeCapability: '6.2',
            architecture: 'Jetson'
        };
    }

    getJetsonSpeedCoefficient(model) {
        const modelLower = (model || '').toLowerCase();

        if (modelLower.includes('agx orin')) return 95;
        if (modelLower.includes('orin nx')) return 75;
        if (modelLower.includes('orin nano')) return 65;
        if (modelLower.includes('orin')) return 70;
        if (modelLower.includes('agx xavier')) return 55;
        if (modelLower.includes('xavier nx')) return 45;
        if (modelLower.includes('xavier')) return 50;
        if (modelLower.includes('tx2')) return 30;
        if (modelLower.includes('nano')) return 24;

        return 35;
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

        // NVIDIA GB10 / Grace Blackwell (DGX Spark)
        if (nameLower.includes('gb10') || nameLower.includes('grace blackwell') ||
            nameLower.includes('dgx spark') || nameLower.includes('blackwell')) {
            capabilities.tensorCores = true;
            capabilities.bf16 = true;
            capabilities.fp8 = true;
            capabilities.computeCapability = '10.0';
            capabilities.architecture = 'Grace Blackwell';
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
        // Tesla P100 (Pascal)
        else if (nameLower.includes('p100') || nameLower.includes('tesla p100')) {
            capabilities.tensorCores = false;
            capabilities.bf16 = false;
            capabilities.fp8 = false;
            capabilities.computeCapability = '6.0';
            capabilities.architecture = 'Pascal';
        }
        // RTX 50 series (Blackwell)
        else if (nameLower.includes('rtx 50') || nameLower.includes('rtx50')) {
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
        // Jetson Orin (Ampere)
        else if (nameLower.includes('jetson') && nameLower.includes('orin')) {
            capabilities.tensorCores = true;
            capabilities.bf16 = true;
            capabilities.computeCapability = '8.7';
            capabilities.architecture = 'Ampere';
        }
        // Jetson Xavier (Volta)
        else if (nameLower.includes('jetson') && nameLower.includes('xavier')) {
            capabilities.tensorCores = true;
            capabilities.computeCapability = '7.2';
            capabilities.architecture = 'Volta';
        }
        // Jetson Nano / TX2
        else if (nameLower.includes('jetson') && (nameLower.includes('nano') || nameLower.includes('tx2'))) {
            capabilities.computeCapability = nameLower.includes('tx2') ? '6.2' : '5.3';
            capabilities.architecture = nameLower.includes('tx2') ? 'Pascal' : 'Maxwell';
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
            'gb10': 95,
            'grace blackwell': 95,
            'dgx spark': 95,
            'h100': 400,
            'h200': 450,
            'a100': 300,
            'l40': 220,
            'l4': 150,
            'a40': 180,
            't4': 70,
            'v100': 120,
            'p100': 45,

            // Jetson family
            'jetson agx orin': 95,
            'jetson orin nx': 75,
            'jetson orin nano': 65,
            'jetson orin': 70,
            'jetson agx xavier': 55,
            'jetson xavier nx': 45,
            'jetson xavier': 50,
            'jetson tx2': 30,
            'jetson nano': 24
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
