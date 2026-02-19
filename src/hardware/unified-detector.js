/**
 * Unified Hardware Detector
 * Coordinates all hardware detection backends and provides a unified interface
 * Automatically selects the best backend for LLM inference
 */

const AppleSiliconDetector = require('./backends/apple-silicon');
const CUDADetector = require('./backends/cuda-detector');
const ROCmDetector = require('./backends/rocm-detector');
const IntelDetector = require('./backends/intel-detector');
const CPUDetector = require('./backends/cpu-detector');
const si = require('systeminformation');

class UnifiedDetector {
    constructor() {
        this.backends = {
            metal: new AppleSiliconDetector(),
            cuda: new CUDADetector(),
            rocm: new ROCmDetector(),
            intel: new IntelDetector(),
            cpu: new CPUDetector()
        };

        this.cache = null;
        this.cacheTime = 0;
        this.cacheExpiry = 5 * 60 * 1000;  // 5 minutes
    }

    /**
     * Detect all available hardware and select the best backend
     */
    async detect() {
        if (this.cache && (Date.now() - this.cacheTime < this.cacheExpiry)) {
            return this.cache;
        }

        const result = {
            backends: {},
            primary: null,
            cpu: null,
            systemGpu: null,
            summary: {
                bestBackend: 'cpu',
                totalVRAM: 0,
                effectiveMemory: 0,
                speedCoefficient: 0,
                isMultiGPU: false,
                gpuCount: 0
            },
            fingerprint: null,
            timestamp: Date.now()
        };

        // Detect CPU first (always available)
        try {
            result.cpu = this.backends.cpu.detect();
            result.backends.cpu = {
                available: true,
                info: result.cpu
            };
        } catch (e) {
            result.backends.cpu = { available: false, error: e.message };
        }

        // Detect Apple Silicon (macOS ARM only)
        if (process.platform === 'darwin' && process.arch === 'arm64') {
            try {
                const metalInfo = this.backends.metal.detect();
                if (metalInfo) {
                    result.backends.metal = {
                        available: true,
                        info: metalInfo
                    };
                }
            } catch (e) {
                result.backends.metal = { available: false, error: e.message };
            }
        }

        // Detect NVIDIA CUDA
        try {
            if (this.backends.cuda.checkAvailability()) {
                const cudaInfo = this.backends.cuda.detect();
                if (cudaInfo && cudaInfo.gpus.length > 0) {
                    result.backends.cuda = {
                        available: true,
                        info: cudaInfo
                    };
                }
            }
        } catch (e) {
            result.backends.cuda = { available: false, error: e.message };
        }

        // Detect AMD ROCm
        try {
            if (this.backends.rocm.checkAvailability()) {
                const rocmInfo = this.backends.rocm.detect();
                if (rocmInfo && rocmInfo.gpus.length > 0) {
                    result.backends.rocm = {
                        available: true,
                        info: rocmInfo
                    };
                }
            }
        } catch (e) {
            result.backends.rocm = { available: false, error: e.message };
        }

        // Detect Intel (Linux only for now)
        if (process.platform === 'linux') {
            try {
                if (this.backends.intel.checkAvailability()) {
                    const intelInfo = this.backends.intel.detect();
                    if (intelInfo && intelInfo.gpus.length > 0) {
                        result.backends.intel = {
                            available: true,
                            info: intelInfo
                        };
                    }
                }
            } catch (e) {
                result.backends.intel = { available: false, error: e.message };
            }
        }

        // Fallback GPU inventory via systeminformation (Windows/Linux) when no
        // accelerator backend is currently available (CUDA/ROCm/Metal/Intel).
        const hasAcceleratedBackend = Boolean(
            result.backends.cuda?.available ||
            result.backends.rocm?.available ||
            result.backends.metal?.available ||
            result.backends.intel?.available
        );

        if (!hasAcceleratedBackend && (process.platform === 'win32' || process.platform === 'linux')) {
            try {
                const genericGpuInfo = await this.detectSystemGpuFallback();
                if (genericGpuInfo?.available) {
                    result.systemGpu = genericGpuInfo;
                    result.backends.generic = {
                        available: true,
                        info: genericGpuInfo
                    };
                }
            } catch (e) {
                result.backends.generic = { available: false, error: e.message };
            }
        }

        // Select the best available backend
        result.primary = this.selectPrimaryBackend(result.backends);

        // Build summary
        result.summary = this.buildSummary(result);

        // Generate fingerprint
        result.fingerprint = this.generateFingerprint(result);

        this.cache = result;
        this.cacheTime = Date.now();

        return result;
    }

    /**
     * Select the best backend for LLM inference
     * Priority: CUDA > ROCm > Metal > Intel > CPU
     */
    selectPrimaryBackend(backends) {
        // CUDA is generally the fastest
        if (backends.cuda?.available) {
            return {
                type: 'cuda',
                name: 'NVIDIA CUDA',
                info: backends.cuda.info
            };
        }

        // ROCm for AMD GPUs
        if (backends.rocm?.available) {
            return {
                type: 'rocm',
                name: 'AMD ROCm',
                info: backends.rocm.info
            };
        }

        // Metal for Apple Silicon
        if (backends.metal?.available) {
            return {
                type: 'metal',
                name: 'Apple Metal',
                info: backends.metal.info
            };
        }

        // Intel Arc/Iris
        if (backends.intel?.available && backends.intel.info.hasDedicated) {
            return {
                type: 'intel',
                name: 'Intel oneAPI',
                info: backends.intel.info
            };
        }

        // Fallback to CPU
        return {
            type: 'cpu',
            name: 'CPU',
            info: backends.cpu?.info || null
        };
    }

    /**
     * Build hardware summary
     */
    buildSummary(result) {
        const summary = {
            bestBackend: result.primary?.type || 'cpu',
            backendName: result.primary?.name || 'CPU',
            totalVRAM: 0,
            effectiveMemory: 0,
            speedCoefficient: 0,
            isMultiGPU: false,
            gpuCount: 0,
            gpuModel: null,
            gpuInventory: null,
            gpuModels: [],
            hasHeterogeneousGPU: false,
            cpuModel: result.cpu?.brand || 'Unknown',
            systemRAM: require('os').totalmem() / (1024 ** 3)
        };

        const primary = result.primary;

        if (primary?.type === 'cuda' && primary.info) {
            const inventory = this.summarizeGPUInventory(primary.info.gpus);
            summary.totalVRAM = primary.info.totalVRAM;
            summary.gpuCount = primary.info.gpus.length;
            summary.isMultiGPU = primary.info.isMultiGPU;
            summary.speedCoefficient = primary.info.speedCoefficient;
            summary.gpuModel = inventory.primaryModel || 'NVIDIA GPU';
            summary.gpuInventory = inventory.displayName || summary.gpuModel;
            summary.gpuModels = inventory.models;
            summary.hasHeterogeneousGPU = inventory.isHeterogeneous;
        }
        else if (primary?.type === 'rocm' && primary.info) {
            const inventory = this.summarizeGPUInventory(primary.info.gpus);
            summary.totalVRAM = primary.info.totalVRAM;
            summary.gpuCount = primary.info.gpus.length;
            summary.isMultiGPU = primary.info.isMultiGPU;
            summary.speedCoefficient = primary.info.speedCoefficient;
            summary.gpuModel = inventory.primaryModel || 'AMD GPU';
            summary.gpuInventory = inventory.displayName || summary.gpuModel;
            summary.gpuModels = inventory.models;
            summary.hasHeterogeneousGPU = inventory.isHeterogeneous;
        }
        else if (primary?.type === 'metal' && primary.info) {
            // Apple Silicon uses unified memory
            summary.totalVRAM = primary.info.memory.unified;
            summary.gpuCount = 1;
            summary.speedCoefficient = primary.info.speedCoefficient;
            summary.gpuModel = primary.info.chip || 'Apple Silicon';
            summary.gpuInventory = summary.gpuModel;
            summary.gpuModels = [{ name: summary.gpuModel, count: 1 }];
        }
        else if (primary?.type === 'intel' && primary.info) {
            const inventory = this.summarizeGPUInventory(primary.info.gpus);
            summary.totalVRAM = primary.info.totalVRAM;
            summary.gpuCount = primary.info.gpus.filter(g => g.type === 'dedicated').length;
            summary.speedCoefficient = primary.info.speedCoefficient;
            summary.gpuModel = inventory.primaryModel || 'Intel GPU';
            summary.gpuInventory = inventory.displayName || summary.gpuModel;
            summary.gpuModels = inventory.models;
            summary.hasHeterogeneousGPU = inventory.isHeterogeneous;
        }
        else if (result.cpu) {
            summary.speedCoefficient = result.cpu.speedCoefficient;

            if (result.systemGpu?.available && Array.isArray(result.systemGpu.gpus) && result.systemGpu.gpus.length > 0) {
                const inventory = this.summarizeGPUInventory(result.systemGpu.gpus);
                summary.totalVRAM = result.systemGpu.totalVRAM || 0;
                summary.gpuCount = result.systemGpu.gpus.length;
                summary.isMultiGPU = Boolean(result.systemGpu.isMultiGPU);
                summary.gpuModel = inventory.primaryModel || null;
                summary.gpuInventory = inventory.displayName || summary.gpuModel;
                summary.gpuModels = inventory.models;
                summary.hasHeterogeneousGPU = inventory.isHeterogeneous;
            }
        }

        // Effective memory for LLM loading
        // For GPU: use VRAM; for CPU/Metal: use system RAM
        if (summary.totalVRAM > 0 && ['cuda', 'rocm', 'intel'].includes(primary?.type)) {
            summary.effectiveMemory = summary.totalVRAM;
        } else {
            // Use 70% of system RAM for models (leave room for OS)
            summary.effectiveMemory = Math.round(summary.systemRAM * 0.7);
        }

        return summary;
    }

    summarizeGPUInventory(gpus = []) {
        const counts = new Map();

        for (const gpu of gpus) {
            const name = (gpu?.name || 'Unknown GPU').replace(/\s+/g, ' ').trim();
            counts.set(name, (counts.get(name) || 0) + 1);
        }

        const models = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
        const displayName = models
            .map(({ name, count }) => (count > 1 ? `${count}x ${name}` : name))
            .join(' + ');

        return {
            primaryModel: models[0]?.name || null,
            displayName: displayName || null,
            models,
            isHeterogeneous: models.length > 1
        };
    }

    async detectSystemGpuFallback() {
        const graphics = await si.graphics();
        const controllers = Array.isArray(graphics?.controllers) ? graphics.controllers : [];

        if (controllers.length === 0) {
            return {
                available: false,
                source: 'systeminformation',
                gpus: [],
                totalVRAM: 0,
                isMultiGPU: false,
                hasDedicated: false
            };
        }

        const normalized = controllers
            .map((controller) => {
                const name = String(controller?.model || controller?.name || '').replace(/\s+/g, ' ').trim();
                if (!name || name.toLowerCase() === 'unknown') return null;

                const nameLower = name.toLowerCase();
                if (nameLower.includes('microsoft basic') || nameLower.includes('standard vga')) return null;

                const isIntegrated = this.isIntegratedGPUModel(name);
                let vram = this.normalizeFallbackVRAM(controller?.vram || controller?.memoryTotal || controller?.memory || 0);

                // For dedicated cards, estimate VRAM from model if runtime did not report memory.
                if (!isIntegrated && vram === 0) {
                    vram = this.estimateFallbackVRAM(name);
                }

                return {
                    name,
                    vendor: controller?.vendor || '',
                    type: isIntegrated ? 'integrated' : 'dedicated',
                    memory: { total: vram }
                };
            })
            .filter(Boolean);

        if (normalized.length === 0) {
            return {
                available: false,
                source: 'systeminformation',
                gpus: [],
                totalVRAM: 0,
                isMultiGPU: false,
                hasDedicated: false
            };
        }

        const dedicated = normalized.filter((gpu) => gpu.type === 'dedicated');
        const totalVRAM = dedicated.length > 0
            ? dedicated.reduce((sum, gpu) => sum + (gpu.memory?.total || 0), 0)
            : 0;

        return {
            available: true,
            source: 'systeminformation',
            gpus: normalized,
            totalVRAM,
            isMultiGPU: dedicated.length > 1,
            hasDedicated: dedicated.length > 0
        };
    }

    normalizeFallbackVRAM(value) {
        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0) return 0;

        // Bytes -> GB
        if (num > 1024 * 1024) {
            return Math.round(num / (1024 * 1024 * 1024));
        }

        // MB -> GB
        if (num >= 1024) {
            return Math.round(num / 1024);
        }

        // Likely already GB
        if (num >= 1 && num <= 80) {
            return Math.round(num);
        }

        return 0;
    }

    isIntegratedGPUModel(model) {
        const lower = String(model || '').toLowerCase();
        if (!lower) return false;

        if (lower.includes('radeon rx') || lower.includes('rtx') || lower.includes('gtx') ||
            lower.includes('geforce') || lower.includes('tesla') || lower.includes('quadro') ||
            lower.includes('instinct') || lower.includes('arc a') || lower.includes('radeon pro')) {
            return false;
        }

        return (
            lower.includes('intel') ||
            lower.includes('iris') ||
            lower.includes('uhd') ||
            lower.includes('hd graphics') ||
            lower.includes('radeon graphics') ||
            lower.includes('radeon(tm) graphics') ||
            lower.includes('vega') ||
            lower.includes('apple')
        );
    }

    estimateFallbackVRAM(model) {
        const lower = String(model || '').toLowerCase();
        if (!lower) return 0;

        if (lower.includes('rx 7900')) return 24;
        if (lower.includes('rx 7800')) return 16;
        if (lower.includes('rx 7700')) return 12;
        if (lower.includes('rx 7600 xt')) return 16;
        if (lower.includes('rx 7600')) return 8;
        if (lower.includes('rx 6900') || lower.includes('rx 6800')) return 16;
        if (lower.includes('rx 6700')) return 12;

        if (lower.includes('rtx 5090')) return 32;
        if (lower.includes('rtx 4090') || lower.includes('rtx 3090')) return 24;
        if (lower.includes('rtx 5080') || lower.includes('rtx 4080')) return 16;
        if (lower.includes('rtx 5070') || lower.includes('rtx 4070') || lower.includes('rtx 3060')) return 12;
        if (lower.includes('rtx 4060') || lower.includes('rtx 3070')) return 8;

        return 0;
    }

    /**
     * Generate hardware fingerprint for benchmarks
     */
    generateFingerprint(result) {
        const primary = result.primary;

        if (primary?.type === 'cuda') {
            return this.backends.cuda.getFingerprint();
        } else if (primary?.type === 'rocm') {
            return this.backends.rocm.getFingerprint();
        } else if (primary?.type === 'metal') {
            return this.backends.metal.getFingerprint();
        } else if (primary?.type === 'intel') {
            return this.backends.intel.getFingerprint();
        } else {
            return this.backends.cpu.getFingerprint();
        }
    }

    /**
     * Estimate tokens per second for a model
     */
    estimateTokensPerSecond(paramsB, quantization = 'Q4_K_M') {
        const result = this.cache || { primary: { type: 'cpu' } };
        const primary = result.primary;

        if (primary?.type === 'cuda') {
            return this.backends.cuda.estimateTokensPerSecond(paramsB, quantization);
        } else if (primary?.type === 'rocm') {
            return this.backends.rocm.estimateTokensPerSecond(paramsB, quantization);
        } else if (primary?.type === 'metal') {
            return this.backends.metal.estimateTokensPerSecond(paramsB, quantization);
        } else if (primary?.type === 'intel') {
            return this.backends.intel.estimateTokensPerSecond(paramsB, quantization);
        } else {
            return this.backends.cpu.estimateTokensPerSecond(paramsB, quantization);
        }
    }

    /**
     * Check if a model will fit in memory
     */
    willModelFit(sizeGB, useMultiGPU = true) {
        const result = this.cache;
        if (!result) return false;

        const summary = result.summary;

        // Leave headroom (2GB for GPU, 20% for RAM)
        if (summary.bestBackend === 'cpu' || summary.bestBackend === 'metal') {
            return sizeGB <= (summary.effectiveMemory - 2);
        } else {
            const availableVRAM = useMultiGPU ? summary.totalVRAM : (summary.totalVRAM / summary.gpuCount);
            return sizeGB <= (availableVRAM - 2);
        }
    }

    /**
     * Get the maximum model size that can be loaded
     */
    getMaxModelSize(headroomGB = 2) {
        const result = this.cache;
        if (!result) return 0;

        return Math.max(0, result.summary.effectiveMemory - headroomGB);
    }

    /**
     * Get hardware tier classification
     */
    getHardwareTier() {
        const result = this.cache;
        if (!result) return 'unknown';

        const summary = result.summary;
        const effectiveMem = summary.effectiveMemory;
        const speed = summary.speedCoefficient;

        // Tier based on effective memory and speed
        if (effectiveMem >= 80 && speed >= 300) return 'ultra_high';      // H100, MI300
        if (effectiveMem >= 48 && speed >= 200) return 'very_high';       // 2x3090, 4090
        if (effectiveMem >= 24 && speed >= 150) return 'high';            // 3090, 4090, M2 Max
        if (effectiveMem >= 16 && speed >= 100) return 'medium_high';     // 4080, 3080, M3 Pro
        if (effectiveMem >= 12 && speed >= 80) return 'medium';           // 3060, 4060 Ti
        if (effectiveMem >= 8 && speed >= 50) return 'medium_low';        // 3060, M2
        if (effectiveMem >= 6 && speed >= 30) return 'low';               // GTX 1660, iGPU
        return 'ultra_low';                                                // CPU only
    }

    /**
     * Get recommended quantization levels
     */
    getRecommendedQuantizations(paramsB) {
        const result = this.cache;
        if (!result) return ['Q4_K_M'];

        const maxSize = this.getMaxModelSize();
        const recommendations = [];

        // Estimate size for each quantization
        const quantSizes = {
            'FP16': paramsB * 2,
            'Q8_0': paramsB * 1.1,
            'Q6_K': paramsB * 0.85,
            'Q5_K_M': paramsB * 0.75,
            'Q4_K_M': paramsB * 0.65,
            'Q4_0': paramsB * 0.55,
            'Q3_K_M': paramsB * 0.45,
            'IQ4_XS': paramsB * 0.5,
            'IQ3_XXS': paramsB * 0.35,
            'Q2_K': paramsB * 0.35
        };

        // Quality order (best first)
        const qualityOrder = [
            'FP16', 'Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M',
            'IQ4_XS', 'Q4_0', 'Q3_K_M', 'IQ3_XXS', 'Q2_K'
        ];

        for (const quant of qualityOrder) {
            if (quantSizes[quant] <= maxSize) {
                recommendations.push(quant);
            }
        }

        // Always suggest at least Q4_K_M if nothing fits
        if (recommendations.length === 0) {
            recommendations.push('Q4_K_M');
        }

        return recommendations.slice(0, 3);  // Return top 3
    }

    /**
     * Get a simple text description of the hardware
     */
    getHardwareDescription() {
        const result = this.cache;
        if (!result) return 'Unknown hardware';

        const summary = result.summary;

        if (summary.bestBackend === 'cuda') {
            const gpuDesc = summary.gpuInventory || (
                summary.isMultiGPU ? `${summary.gpuCount}x ${summary.gpuModel}` : summary.gpuModel
            );
            return `${gpuDesc} (${summary.totalVRAM}GB VRAM) + ${summary.cpuModel}`;
        }
        else if (summary.bestBackend === 'rocm') {
            const gpuDesc = summary.gpuInventory || (
                summary.isMultiGPU ? `${summary.gpuCount}x ${summary.gpuModel}` : summary.gpuModel
            );
            return `${gpuDesc} (${summary.totalVRAM}GB VRAM) + ${summary.cpuModel}`;
        }
        else if (summary.bestBackend === 'metal') {
            return `${summary.gpuModel} (${summary.totalVRAM}GB Unified Memory)`;
        }
        else if (summary.bestBackend === 'intel') {
            const gpuDesc = summary.gpuInventory || summary.gpuModel;
            return `${gpuDesc} (${summary.totalVRAM}GB) + ${summary.cpuModel}`;
        }
        else {
            if (summary.gpuModel && summary.gpuCount > 0) {
                const gpuDesc = summary.gpuInventory || summary.gpuModel;
                return `${gpuDesc} (${summary.totalVRAM}GB VRAM detected, CPU backend) + ${summary.cpuModel}`;
            }
            return `${summary.cpuModel} (${Math.round(summary.systemRAM)}GB RAM, CPU-only)`;
        }
    }

    /**
     * Get the active backend instance
     */
    getActiveBackend() {
        const result = this.cache;
        if (!result || !result.primary) return this.backends.cpu;

        return this.backends[result.primary.type] || this.backends.cpu;
    }

    /**
     * Clear cache to force re-detection
     */
    clearCache() {
        this.cache = null;
        this.cacheTime = 0;

        // Clear individual backend caches
        for (const backend of Object.values(this.backends)) {
            if (backend.cache !== undefined) {
                backend.cache = null;
            }
        }
    }
}

module.exports = UnifiedDetector;
