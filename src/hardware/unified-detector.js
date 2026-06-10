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
const { execSync } = require('child_process');
const { normalizePlatform } = require('../utils/platform');

// Recent GPUs whose PCI device id is not yet resolved to a model name by the
// distro pci.ids database (so lspci / systeminformation report them as a bare
// "Device <id>"). Mapping the device id lets us (a) give them a real name and
// (b) collapse the multiple raw views of the SAME card that different detection
// sources produce into one inventory entry. Unknown ids degrade gracefully to a
// stable `pci:<id>` match key, so this table only needs the newest cards.
const PCI_GPU_MAP = {
    // NVIDIA Blackwell (RTX 50 series, desktop)
    '2f04': { family: 'rtx5070', type: 'dedicated', name: 'NVIDIA GeForce RTX 5070' },
    '2c02': { family: 'rtx5080', type: 'dedicated', name: 'NVIDIA GeForce RTX 5080' },
    '2b85': { family: 'rtx5090', type: 'dedicated', name: 'NVIDIA GeForce RTX 5090' },
    // AMD Raphael / Granite Ridge desktop iGPU (Ryzen 7000/9000 non-G)
    '13c0': { family: 'amd-raphael-igpu', type: 'integrated', name: 'AMD Radeon Graphics (Raphael)' }
};

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

        const platform = normalizePlatform();

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
        if (platform === 'darwin' && process.arch === 'arm64') {
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
        if (platform === 'linux') {
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

        // Always collect a generic GPU inventory on Windows/Linux so integrated
        // GPUs remain visible even when a dedicated backend is selected.
        if (platform === 'win32' || platform === 'linux') {
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
            runtimeBackend: result.primary?.type || 'cpu',
            runtimeBackendName: result.primary?.name || 'CPU',
            hasRuntimeAssist: false,
            totalVRAM: 0,
            effectiveMemory: 0,
            speedCoefficient: 0,
            isMultiGPU: false,
            gpuCount: 0,
            gpuModel: null,
            gpuInventory: null,
            gpuModels: [],
            hasHeterogeneousGPU: false,
            hasIntegratedGPU: false,
            hasDedicatedGPU: false,
            integratedGpuCount: 0,
            dedicatedGpuCount: 0,
            integratedGpuModels: [],
            dedicatedGpuModels: [],
            integratedSharedMemory: 0,
            cpuModel: result.cpu?.brand || 'Unknown',
            systemRAM: require('os').totalmem() / (1024 ** 3)
        };

        const primary = result.primary;
        const inventorySource = this.getSummaryInventorySource(result);

        if (primary?.type === 'cuda' && primary.info) {
            const inventory = this.summarizeGPUInventory(inventorySource);
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
            const inventory = this.summarizeGPUInventory(inventorySource);
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
            const inventory = this.summarizeGPUInventory(inventorySource);
            summary.totalVRAM = primary.info.memory.unified;
            summary.gpuCount = 1;
            summary.speedCoefficient = primary.info.speedCoefficient;
            summary.gpuModel = inventory.primaryModel || primary.info.chip || 'Apple Silicon';
            summary.gpuInventory = inventory.displayName || summary.gpuModel;
            summary.gpuModels = inventory.models;
            summary.hasHeterogeneousGPU = inventory.isHeterogeneous;
        }
        else if (primary?.type === 'intel' && primary.info) {
            const inventory = this.summarizeGPUInventory(inventorySource);
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

            if (inventorySource.length > 0) {
                const inventory = this.summarizeGPUInventory(inventorySource);
                summary.totalVRAM = result.systemGpu.totalVRAM || 0;
                summary.gpuCount = inventory.dedicatedCount > 0 ? inventory.dedicatedCount : inventory.gpuCount;
                summary.isMultiGPU = Boolean(result.systemGpu.isMultiGPU);
                summary.gpuModel = inventory.primaryModel || null;
                summary.gpuInventory = inventory.displayName || summary.gpuModel;
                summary.gpuModels = inventory.models;
                summary.hasHeterogeneousGPU = inventory.isHeterogeneous;
            }
        }

        const topology = this.summarizeGPUInventory(inventorySource);
        summary.hasIntegratedGPU = topology.hasIntegratedGPU;
        summary.hasDedicatedGPU = topology.hasDedicatedGPU;
        summary.integratedGpuCount = topology.integratedCount;
        summary.dedicatedGpuCount = topology.dedicatedCount;
        summary.integratedGpuModels = topology.integratedModels;
        summary.dedicatedGpuModels = topology.dedicatedModels;
        summary.integratedSharedMemory = Math.max(
            topology.integratedSharedMemory,
            this.getPrimaryIntegratedSharedMemory(primary)
        );
        if (!summary.gpuModel) {
            summary.gpuModel = topology.primaryModel || null;
        }
        if (!summary.gpuInventory) {
            summary.gpuInventory = topology.displayName || summary.gpuModel;
        }
        if (!summary.gpuModels.length) {
            summary.gpuModels = topology.models;
        }
        summary.hasHeterogeneousGPU = summary.hasHeterogeneousGPU || topology.isHeterogeneous;

        const runtimeSelection = this.detectRuntimeAssistBackend(result, topology);
        summary.runtimeBackend = runtimeSelection.backend;
        summary.runtimeBackendName = runtimeSelection.name;
        summary.hasRuntimeAssist = runtimeSelection.assisted;

        // Effective memory for LLM loading. Integrated ROCm/iGPU devices expose
        // a small aperture as VRAM and a much larger shared pool for model-fit
        // decisions, so avoid treating the aperture as dedicated VRAM.
        if (
            ['rocm', 'intel'].includes(primary?.type) &&
            summary.hasIntegratedGPU &&
            !summary.hasDedicatedGPU &&
            summary.integratedSharedMemory > 0
        ) {
            summary.effectiveMemory = summary.integratedSharedMemory;
        } else if (summary.totalVRAM > 0 && ['cuda', 'rocm', 'intel'].includes(primary?.type)) {
            summary.effectiveMemory = summary.totalVRAM;
        } else {
            // Use 70% of system RAM for models (leave room for OS)
            summary.effectiveMemory = Math.round(summary.systemRAM * 0.7);
        }

        summary.hardwareTier = this.classifyHardwareTierFromSummary(summary);
        summary.bestBackendLabel = this.getBestBackendLabel(summary);

        return summary;
    }

    getPrimaryIntegratedSharedMemory(primary) {
        const gpus = Array.isArray(primary?.info?.gpus) ? primary.info.gpus : [];
        return gpus
            .filter((gpu) => gpu?.type === 'integrated')
            .reduce((max, gpu) => {
                const candidates = [
                    gpu?.sharedMemory,
                    gpu?.unifiedMemory,
                    gpu?.memory?.shared,
                    gpu?.memory?.total
                ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
                return Math.max(max, ...candidates, 0);
            }, 0);
    }

    classifyHardwareTierFromSummary(summary = {}) {
        const effectiveMem = Number(summary.effectiveMemory) || 0;
        const speed = Number(summary.speedCoefficient) || 0;

        if (effectiveMem >= 80 && speed >= 300) return 'ultra_high';      // H100, MI300
        if (effectiveMem >= 48 && speed >= 200) return 'very_high';       // 2x3090, 4090
        if (effectiveMem >= 24 && speed >= 150) return 'high';            // 3090, 4090, M2 Max
        if (effectiveMem >= 16 && speed >= 100) return 'medium_high';     // 4080, 3080, M3 Pro
        if (effectiveMem >= 12 && speed >= 80) return 'medium';           // 3060, 4060 Ti
        if (effectiveMem >= 8 && speed >= 50) return 'medium_low';        // 3060, M2
        if (effectiveMem >= 6 && speed >= 30) return 'low';               // GTX 1660, iGPU
        return 'ultra_low';                                                // CPU only
    }

    getBestBackendLabel(summary = {}) {
        const backendName = summary.backendName || String(summary.bestBackend || 'cpu').toUpperCase();
        if (
            summary.hasRuntimeAssist &&
            summary.runtimeBackend &&
            summary.runtimeBackend !== summary.bestBackend
        ) {
            return `${backendName} + ${summary.runtimeBackendName || summary.runtimeBackend} assist`;
        }
        return backendName;
    }

    summarizeGPUInventory(gpus = []) {
        const normalized = this.normalizeGpuInventory(gpus);
        const counts = new Map();
        const integratedCounts = new Map();
        const dedicatedCounts = new Map();

        for (const gpu of normalized) {
            const name = (gpu?.name || 'Unknown GPU').replace(/\s+/g, ' ').trim();
            counts.set(name, (counts.get(name) || 0) + 1);
            if (gpu.type === 'integrated') {
                integratedCounts.set(name, (integratedCounts.get(name) || 0) + 1);
            } else {
                dedicatedCounts.set(name, (dedicatedCounts.get(name) || 0) + 1);
            }
        }

        const models = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
        const integratedModels = Array.from(integratedCounts.entries()).map(([name, count]) => ({ name, count }));
        const dedicatedModels = Array.from(dedicatedCounts.entries()).map(([name, count]) => ({ name, count }));
        const displayName = models
            .map(({ name, count }) => (count > 1 ? `${count}x ${name}` : name))
            .join(' + ');

        return {
            primaryModel: dedicatedModels[0]?.name || integratedModels[0]?.name || models[0]?.name || null,
            displayName: displayName || null,
            models,
            integratedModels,
            dedicatedModels,
            integratedSharedMemory: normalized
                .filter((gpu) => gpu.type === 'integrated')
                .reduce((max, gpu) => Math.max(max, Number(gpu?.memory?.total || 0)), 0),
            integratedCount: normalized.filter((gpu) => gpu.type === 'integrated').length,
            dedicatedCount: normalized.filter((gpu) => gpu.type === 'dedicated').length,
            hasIntegratedGPU: normalized.some((gpu) => gpu.type === 'integrated'),
            hasDedicatedGPU: normalized.some((gpu) => gpu.type === 'dedicated'),
            gpuCount: normalized.length,
            isHeterogeneous: models.length > 1
        };
    }

    getSummaryInventorySource(result) {
        const primaryInventory = this.getPrimaryInventoryGpus(result.primary);
        const systemInventory = Array.isArray(result.systemGpu?.gpus) ? result.systemGpu.gpus : [];
        return this.mergeGpuInventories(primaryInventory, systemInventory);
    }

    getPrimaryInventoryGpus(primary) {
        if (!primary?.info) return [];

        if (Array.isArray(primary.info.gpus) && primary.info.gpus.length > 0) {
            return primary.info.gpus;
        }

        if (primary.type === 'metal') {
            return [{
                name: primary.info.chip || 'Apple Silicon',
                type: 'integrated',
                memory: { total: primary.info.memory?.unified || 0 }
            }];
        }

        return [];
    }

    normalizeGpuInventory(gpus = []) {
        return gpus
            .map((gpu) => {
                const name = String(gpu?.name || gpu?.model || '').replace(/\s+/g, ' ').trim();
                if (!name) return null;
                if (this.isRemoteDisplayModel(name)) return null;

                let type = gpu?.type;
                if (type !== 'integrated' && type !== 'dedicated') {
                    type = this.isIntegratedGPUModel(name) ? 'integrated' : 'dedicated';
                }

                const totalMemory = Number(gpu?.memory?.total || gpu?.memoryTotal || gpu?.memory || 0);

                return {
                    name,
                    type,
                    memory: {
                        total: Number.isFinite(totalMemory) ? totalMemory : 0
                    }
                };
            })
            .filter(Boolean);
    }

    isRemoteDisplayModel(model) {
        const lower = String(model || '').toLowerCase();
        if (!lower) return false;

        return (
            lower.includes('microsoft remote display adapter') ||
            lower.includes('remote display adapter') ||
            lower.includes('basic render driver')
        );
    }

    inferGpuVendor(name) {
        const lower = String(name || '').toLowerCase();
        if (!lower) return 'unknown';
        if (lower.includes('nvidia') || lower.includes('geforce') || lower.includes('rtx') || lower.includes('gtx')) return 'nvidia';
        if (lower.includes('amd') || lower.includes('ati') || lower.includes('radeon')) return 'amd';
        if (lower.includes('intel') || lower.includes('iris') || lower.includes('uhd') || lower.includes('arc')) return 'intel';
        if (lower.includes('apple')) return 'apple';
        return 'unknown';
    }

    detectRuntimeAssistBackend(result, topology = {}) {
        const primaryType = result?.primary?.type || 'cpu';
        const primaryName = result?.primary?.name || 'CPU';

        if (primaryType !== 'cpu') {
            return {
                backend: primaryType,
                name: primaryName,
                assisted: false
            };
        }

        const platform = result?.platform || result?.os?.platform || normalizePlatform();
        const integratedModels = Array.isArray(topology.integratedModels) ? topology.integratedModels : [];
        const integratedVendors = integratedModels.map((gpu) => this.inferGpuVendor(gpu.name));

        const hasWindowsIntegratedGpu = platform === 'win32' && integratedModels.length > 0;
        const hasKnownIntegratedVendor = integratedVendors.some((vendor) => ['amd', 'intel', 'nvidia'].includes(vendor));

        if (hasWindowsIntegratedGpu && hasKnownIntegratedVendor) {
            return {
                backend: 'vulkan',
                name: 'Vulkan',
                assisted: true
            };
        }

        return {
            backend: primaryType,
            name: primaryName,
            assisted: false
        };
    }

    getSystemMemoryGB(memoryInfo) {
        const totalBytes = Number(memoryInfo?.total || 0);
        if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
        return Math.max(1, Math.round(totalBytes / (1024 ** 3)));
    }

    estimateSystemSharedMemory(totalSystemGB, fallbackGB = 0) {
        const fallback = Math.max(0, Number(fallbackGB) || 0);
        if (!Number.isFinite(totalSystemGB) || totalSystemGB <= 0) {
            return fallback;
        }

        return Math.max(fallback, Math.min(Math.max(1, Math.round(totalSystemGB / 2)), 16));
    }

    estimateIntegratedFallbackMemory(controller, memoryInfo) {
        const dedicatedAperture = this.normalizeFallbackVRAM(controller?.vram || 0);
        const explicitSharedCandidates = [
            controller?.memoryTotal,
            controller?.memory,
            controller?.sharedMemory,
            controller?.memoryShared,
            controller?.memory?.shared,
            controller?.memory?.total
        ]
            .map((value) => this.normalizeFallbackVRAM(value))
            .filter((value) => value > dedicatedAperture);

        if (explicitSharedCandidates.length > 0) {
            return Math.max(...explicitSharedCandidates);
        }

        const totalSystemGB = this.getSystemMemoryGB(memoryInfo);
        if (controller?.vramDynamic || dedicatedAperture <= 2) {
            return this.estimateSystemSharedMemory(totalSystemGB, dedicatedAperture);
        }

        return dedicatedAperture;
    }

    mergeGpuInventories(...gpuLists) {
        const normalizedLists = gpuLists.map((list) => this.normalizeGpuInventory(list));
        const primaryIndex = normalizedLists.findIndex((list) => list.length > 0);
        const merged = [];
        const seen = new Set();

        normalizedLists.forEach((list, listIndex) => {
            for (const gpu of list) {
                const key = `${this.getGpuMatchKey(gpu.name)}|${gpu.type}`;
                if (!key) continue;
                if (listIndex !== primaryIndex && seen.has(key)) continue;
                merged.push(gpu);
                seen.add(key);
            }
        });

        return merged;
    }

    async detectSystemGpuFallback() {
        const graphics = await si.graphics();
        const memoryInfo = await si.mem().catch(() => null);
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
                let name = String(controller?.model || controller?.name || '').replace(/\s+/g, ' ').trim();
                if (!name || name.toLowerCase() === 'unknown') return null;
                if (this.isRemoteDisplayModel(name)) return null;

                const nameLower = name.toLowerCase();
                if (nameLower.includes('microsoft basic') || nameLower.includes('standard vga')) return null;

                // Resolve recent cards that the runtime could only report as a bare
                // "Device <id>" so they get a real name and correct integrated flag.
                const mapped = this.resolveMappedGpu(name) || this.resolveMappedGpu(controller?.deviceId);
                if (mapped) name = mapped.name;

                const isIntegrated = mapped ? mapped.type === 'integrated' : this.isIntegratedGPUModel(name);
                let vram = isIntegrated
                    ? this.estimateIntegratedFallbackMemory(controller, memoryInfo)
                    : this.normalizeFallbackVRAM(controller?.vram || controller?.memoryTotal || controller?.memory || 0);

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

        const platform = normalizePlatform();

        if (platform === 'linux') {
            const lspciControllers = this.detectLinuxLspciGpus();
            const knownKeys = new Set(
                normalized.map((gpu) => this.getGpuMatchKey(gpu.name)).filter(Boolean)
            );

            for (const gpu of lspciControllers) {
                const nameKey = this.getGpuMatchKey(gpu.name);
                if (!nameKey || knownKeys.has(nameKey)) continue;
                normalized.push(gpu);
                knownKeys.add(nameKey);
            }
        }

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
            source: normalized.some((gpu) => gpu.source === 'lspci') ? 'systeminformation+lspci' : 'systeminformation',
            gpus: normalized,
            totalVRAM,
            isMultiGPU: dedicated.length > 1,
            hasDedicated: dedicated.length > 0
        };
    }

    detectLinuxLspciGpus() {
        try {
            const lspciOutput = execSync('lspci -nn | grep -Ei "VGA|3D|Display"', {
                encoding: 'utf8',
                timeout: 8000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return this.parseLinuxLspciGpus(lspciOutput);
        } catch (error) {
            return [];
        }
    }

    parseLinuxLspciGpus(lspciOutput = '') {
        const lines = String(lspciOutput || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

        const results = [];
        const seen = new Set();

        for (const line of lines) {
            const lineLower = line.toLowerCase();
            const isNvidia = lineLower.includes('nvidia');
            const isAMD = lineLower.includes('amd') || lineLower.includes('ati') || lineLower.includes('radeon');
            const isIntel = lineLower.includes('intel');

            if (!isNvidia && !isAMD && !isIntel) continue;

            const vendorLabel = isNvidia ? 'NVIDIA' : (isAMD ? 'AMD' : 'Intel');
            const pciId = this.extractPciDeviceId(line);
            const mapped = this.resolveMappedGpu(line);

            // Prefer the resolved model name inside a trailing "[Model] [vvvv:dddd]"
            // pair (e.g. "[GeForce RTX 4060]"). Otherwise clean the raw lspci line
            // down to a readable device string instead of using the whole line.
            const bracketName = line.match(/\[(?![0-9a-f]{4}:[0-9a-f]{4}\])([^\]]+)\]\s*\[[0-9a-f]{4}:[0-9a-f]{4}\]/i);
            let name = (bracketName?.[1] || '').replace(/\s+/g, ' ').trim();

            if (!name) {
                name = line
                    .replace(/^[0-9a-f]{2,4}:[0-9a-f]{2}\.[0-9a-f]\s+/i, '')                  // PCI address
                    .replace(/^(?:vga compatible|3d|display)\s+controller\s+\[[0-9a-f]{4}\]:\s*/i, '') // class prefix
                    .replace(/\s*\[[0-9a-f]{4}:[0-9a-f]{4}\]/i, '')                            // [vvvv:dddd]
                    .replace(/\s*\(rev\s+[0-9a-f]+\)\s*$/i, '')                                // (rev xx)
                    .replace(/\b(?:corporation|corp\.?|inc\.?|advanced micro devices,?)\b/gi, '')
                    .replace(/\[amd\/ati\]/gi, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            }

            // If the card could not be resolved to a real model, give it a stable,
            // readable name that carries the PCI id so it dedupes across sources.
            const meaningful = name.replace(/\b(?:nvidia|amd|ati|intel|device|graphics|gpu|controller)\b/gi, '').replace(/[^a-z0-9]/gi, '').trim();
            if (mapped) {
                name = mapped.name;
            } else if (!meaningful) {
                name = pciId ? `${vendorLabel} Device ${pciId.toUpperCase()}` : `${vendorLabel} GPU`;
            }

            const isIntegrated = mapped
                ? mapped.type === 'integrated'
                : (this.isIntegratedGPUModel(name) || (isIntel && !/\barc\b/i.test(name)));
            let vram = this.estimateFallbackVRAM(name);
            if (isIntegrated) {
                vram = 0;
            }

            const dedupeKey = `${this.getGpuMatchKey(name)}|${isIntegrated ? 'i' : 'd'}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            results.push({
                name,
                vendor: vendorLabel,
                type: isIntegrated ? 'integrated' : 'dedicated',
                memory: { total: vram },
                pciId: pciId || null,
                source: 'lspci'
            });
        }

        return results;
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
            (lower.includes('radeon') && !lower.includes('radeon rx') && /\b\d{3,4}m\b/.test(lower)) ||
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

    getGpuMatchKey(name) {
        const lower = String(name || '').toLowerCase();
        if (!lower) return '';

        const familyMatch = lower.match(/\b(rtx|gtx|rx|arc)\s*([0-9]{3,4})\b/);
        if (familyMatch) {
            return `${familyMatch[1]}${familyMatch[2]}`;
        }

        // Different detection sources describe an unresolved card in different
        // ways for the SAME hardware, e.g. systeminformation "Device 2f04" and
        // lspci "...Device [10de:2f04]". Key on the PCI device id (mapped to a
        // canonical family when known) so those collapse to one inventory entry.
        const pciId = this.extractPciDeviceId(name);
        if (pciId) {
            return (PCI_GPU_MAP[pciId] && PCI_GPU_MAP[pciId].family) || `pci:${pciId}`;
        }

        const concise = lower
            .replace(/nvidia|amd|ati|intel|corporation|geforce|radeon|graphics/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        return concise || lower;
    }

    /**
     * Extract a 4-hex PCI device id from a GPU name/description, handling both the
     * lspci "[vendor:device]" form and the bare "Device <id>" form that
     * systeminformation emits for cards it cannot name. Returns null when none.
     */
    extractPciDeviceId(text) {
        const value = String(text || '');
        const bracket = value.match(/\[[0-9a-f]{4}:([0-9a-f]{4})\]/i);
        if (bracket) return bracket[1].toLowerCase();
        const bare = value.match(/\bdevice\s+([0-9a-f]{4})\b/i);
        if (bare) return bare[1].toLowerCase();
        return null;
    }

    /** Look up a curated mapping for a recent card by PCI device id (or null). */
    resolveMappedGpu(text) {
        const pciId = this.extractPciDeviceId(text);
        return pciId && PCI_GPU_MAP[pciId] ? { pciId, ...PCI_GPU_MAP[pciId] } : null;
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
        if (
            summary.bestBackend === 'cpu' ||
            summary.bestBackend === 'metal' ||
            (summary.hasIntegratedGPU && !summary.hasDedicatedGPU && summary.integratedSharedMemory > 0)
        ) {
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

        return result.summary?.hardwareTier || this.classifyHardwareTierFromSummary(result.summary);
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
            if (summary.hasIntegratedGPU && !summary.hasDedicatedGPU && summary.integratedSharedMemory > 0) {
                const dedicatedLabel = summary.totalVRAM > 0 ? `, ${summary.totalVRAM}GB aperture` : '';
                return `${gpuDesc} (${summary.integratedSharedMemory}GB shared memory${dedicatedLabel}) + ${summary.cpuModel}`;
            }
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
            const runtimeAssistSuffix = summary.hasRuntimeAssist && summary.runtimeBackend !== summary.bestBackend
                ? `${summary.runtimeBackendName || summary.runtimeBackend} assist`
                : 'CPU backend';
            if (summary.gpuModel && summary.hasIntegratedGPU && !summary.hasDedicatedGPU) {
                const gpuDesc = summary.gpuInventory || summary.gpuModel;
                if (summary.integratedSharedMemory > 0) {
                    return `${gpuDesc} (${summary.integratedSharedMemory}GB shared memory, ${runtimeAssistSuffix}) + ${summary.cpuModel}`;
                }
                return `${gpuDesc} (integrated/shared memory, ${runtimeAssistSuffix}) + ${summary.cpuModel}`;
            }
            if (summary.gpuModel && summary.gpuCount > 0) {
                const gpuDesc = summary.gpuInventory || summary.gpuModel;
                return `${gpuDesc} (${summary.totalVRAM}GB VRAM detected, ${runtimeAssistSuffix}) + ${summary.cpuModel}`;
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
