/**
 * PC Hardware Optimizer for Windows/Linux
 * 
 * Implements practical backend detection and optimization logic for:
 * - NVIDIA (CUDA/Vulkan/DirectML)
 * - AMD (ROCm/Vulkan/DirectML) 
 * - Intel Arc/iGPU (SYCL/OpenVINO/DirectML/Vulkan)
 * - CPU-only (BLAS accelerated)
 */

const { spawn } = require('child_process');
const si = require('systeminformation');

class PCOptimizer {
    constructor() {
        // Backend performance coefficients (tokens/sec baseline)
        this.backendCoefficients = {
            cuda: 220,          // NVIDIA CUDA/cuBLAS
            rocm: 180,          // AMD ROCm/HIP
            sycl: 140,          // Intel oneAPI/SYCL
            vulkan: 120,        // Vulkan (cross-platform)
            directml: 100,      // DirectML (Windows)
            openvino: 90,       // Intel OpenVINO
            cpu_avx512: 70,     // CPU with AVX512
            cpu_avx2: 60,       // CPU with AVX2
            cpu_basic: 40       // Basic CPU
        };

        // Quantization factors (speed multiplier)
        this.quantFactors = {
            'Q8_0': 0.85,       // Highest quality, slower
            'Q6_K': 1.0,        // Balanced
            'Q5_K_M': 1.1,      // Good speed/quality
            'Q4_K_M': 1.2,      // Fast inference
            'Q3_K': 1.35,       // Very fast, lower quality
            'Q2_K': 1.5         // Fastest, lowest quality
        };

        // Bytes per parameter for different quantizations
        this.bytesPerParam = {
            'FP16': 2.0,
            'Q8_0': 1.0,
            'Q6_K': 0.75,
            'Q5_K_M': 0.63,
            'Q4_K_M': 0.50,
            'Q3_K': 0.375,
            'Q2_K': 0.25
        };

        // KV cache estimation per 1k tokens (GB)
        this.kvCacheEstimates = {
            7: 0.3,     // 7B models
            13: 0.6,    // 13B models
            33: 1.4,    // 30-40B models
            70: 2.6     // 70B+ models
        };
    }

    /**
     * Detect PC hardware capabilities and available backends
     */
    async detectPCCapabilities() {
        try {
            const [graphics, cpu, memory, osInfo] = await Promise.all([
                si.graphics(),
                si.cpu(),
                si.mem(),
                si.osInfo()
            ]);

            const gpu = graphics.controllers?.[0] || {};
            const vendor = (gpu.vendor || '').toLowerCase();
            const model = (gpu.model || '').toLowerCase();
            
            // Enhanced VRAM detection
            let vramGB = Math.round((gpu.vram || 0) / 1024);
            if (vramGB === 0 && gpu.vram) {
                // Handle different VRAM reporting formats
                if (gpu.vram > 100000) {
                    vramGB = Math.round(gpu.vram / (1024 * 1024 * 1024)); // bytes to GB
                } else if (gpu.vram > 1000) {
                    vramGB = Math.round(gpu.vram / 1024); // MB to GB
                }
            }

            // Detect GPU type and capabilities
            const gpuInfo = this.classifyGPU(vendor, model, vramGB);
            
            // Detect available backends
            const availableBackends = await this.detectAvailableBackends(osInfo.platform);
            
            // Get CPU capabilities
            const cpuInfo = this.analyzeCPUCapabilities(cpu);

            return {
                gpu: gpuInfo,
                cpu: cpuInfo,
                memory: {
                    total: Math.round(memory.total / (1024 ** 3)),
                    available: Math.round(memory.available / (1024 ** 3))
                },
                os: {
                    platform: osInfo.platform,
                    distro: osInfo.distro
                },
                backends: availableBackends,
                timestamp: Date.now()
            };
        } catch (error) {
            throw new Error(`PC capability detection failed: ${error.message}`);
        }
    }

    /**
     * Classify GPU type and capabilities
     */
    classifyGPU(vendor, model, vramGB) {
        const isNvidia = vendor.includes('nvidia') || model.includes('nvidia') || model.includes('geforce') || model.includes('rtx') || model.includes('gtx');
        const isAMD = vendor.includes('amd') || vendor.includes('ati') || model.includes('radeon') || model.includes('rx ');
        const isIntel = vendor.includes('intel') || model.includes('intel') || model.includes('arc') || model.includes('iris') || model.includes('uhd');

        let tier = 'entry';
        let type = 'unknown';
        let computeUnits = 0;
        let memoryBandwidth = 50; // GB/s default

        if (isNvidia) {
            type = 'nvidia';
            if (model.includes('rtx 5090')) { tier = 'flagship'; computeUnits = 21760; memoryBandwidth = 1792; }
            else if (model.includes('rtx 5080')) { tier = 'high_end'; computeUnits = 10752; memoryBandwidth = 960; }
            else if (model.includes('rtx 5070')) { tier = 'upper_mid'; computeUnits = 6144; memoryBandwidth = 504; }
            else if (model.includes('rtx 4090')) { tier = 'flagship'; computeUnits = 16384; memoryBandwidth = 1008; }
            else if (model.includes('rtx 4080')) { tier = 'high_end'; computeUnits = 9728; memoryBandwidth = 716; }
            else if (model.includes('rtx 4070')) { tier = 'upper_mid'; computeUnits = 5888; memoryBandwidth = 448; }
            else if (model.includes('rtx 4060')) { tier = 'mid_range'; computeUnits = 3072; memoryBandwidth = 272; }
            else if (model.includes('rtx 30')) { tier = 'upper_mid'; computeUnits = 6000; memoryBandwidth = 500; }
            else if (model.includes('rtx 20')) { tier = 'mid_range'; computeUnits = 2000; memoryBandwidth = 300; }
            else if (model.includes('gtx 16')) { tier = 'budget'; computeUnits = 1500; memoryBandwidth = 200; }
            else if (vramGB >= 8) { tier = 'mid_range'; computeUnits = 2000; memoryBandwidth = 300; }
            else if (vramGB >= 4) { tier = 'budget'; computeUnits = 1000; memoryBandwidth = 150; }
        } else if (isAMD) {
            type = 'amd';
            if (model.includes('rx 7900')) { tier = 'high_end'; computeUnits = 6000; memoryBandwidth = 960; }
            else if (model.includes('rx 7800')) { tier = 'upper_mid'; computeUnits = 3840; memoryBandwidth = 624; }
            else if (model.includes('rx 7700')) { tier = 'mid_range'; computeUnits = 2560; memoryBandwidth = 432; }
            else if (model.includes('rx 7600')) { tier = 'budget'; computeUnits = 2048; memoryBandwidth = 288; }
            else if (model.includes('rx 6000')) { tier = 'mid_range'; computeUnits = 2000; memoryBandwidth = 400; }
            else if (vramGB >= 16) { tier = 'upper_mid'; computeUnits = 3000; memoryBandwidth = 500; }
            else if (vramGB >= 8) { tier = 'mid_range'; computeUnits = 2000; memoryBandwidth = 300; }
            else if (vramGB >= 4) { tier = 'budget'; computeUnits = 1000; memoryBandwidth = 200; }
        } else if (isIntel) {
            type = 'intel';
            if (model.includes('arc a770')) { tier = 'mid_range'; computeUnits = 512; memoryBandwidth = 560; }
            else if (model.includes('arc a750')) { tier = 'mid_range'; computeUnits = 448; memoryBandwidth = 512; }
            else if (model.includes('arc a580')) { tier = 'budget'; computeUnits = 384; memoryBandwidth = 448; }
            else if (model.includes('iris xe')) { tier = 'igpu'; computeUnits = 96; memoryBandwidth = 68; }
            else if (model.includes('uhd')) { tier = 'igpu'; computeUnits = 32; memoryBandwidth = 47; }
            else if (vramGB >= 8) { tier = 'mid_range'; computeUnits = 400; memoryBandwidth = 400; }
            else { tier = 'igpu'; computeUnits = 64; memoryBandwidth = 50; }
        }

        // Determine if integrated GPU
        const isIntegrated = tier === 'igpu' || 
                           (vramGB === 0 && (model.includes('intel') || model.includes('integrated') || 
                           model.includes('iris') || model.includes('uhd') || model.includes('vega')));

        return {
            vendor: type,
            model: model || 'Unknown GPU',
            tier,
            vramGB,
            isIntegrated,
            computeUnits,
            memoryBandwidth,
            estimatedTFLOPS: this.estimateGPUTFLOPS(type, tier, computeUnits)
        };
    }

    /**
     * Estimate GPU TFLOPS for FP16 operations
     */
    estimateGPUTFLOPS(type, tier, computeUnits) {
        const multipliers = {
            nvidia: {
                flagship: 0.010,    // RTX 4090 ~165 TFLOPS
                high_end: 0.008,    // RTX 4080 ~120 TFLOPS  
                upper_mid: 0.006,   // RTX 4070 ~65 TFLOPS
                mid_range: 0.004,   // RTX 4060 ~32 TFLOPS
                budget: 0.002,      // GTX 1660 ~15 TFLOPS
                igpu: 0.001
            },
            amd: {
                flagship: 0.008,    // Similar to NVIDIA but slightly lower
                high_end: 0.006,
                upper_mid: 0.005,
                mid_range: 0.003,
                budget: 0.002,
                igpu: 0.001
            },
            intel: {
                mid_range: 0.003,   // Arc A770 ~8 TFLOPS
                budget: 0.002,      // Arc A580 ~6 TFLOPS
                igpu: 0.001         // Iris Xe ~2 TFLOPS
            }
        };

        const multiplier = multipliers[type]?.[tier] || 0.001;
        return Math.round(computeUnits * multiplier * 10) / 10;
    }

    /**
     * Analyze CPU capabilities for LLM inference
     */
    analyzeCPUCapabilities(cpu) {
        const brand = (cpu.brand || '').toLowerCase();
        const model = (cpu.model || '').toLowerCase();
        const cores = cpu.physicalCores || cpu.cores || 1;
        const threads = cpu.cores || cores;
        const baseSpeed = cpu.speed || 2.0;

        // Detect instruction set capabilities
        const hasAVX512 = brand.includes('intel') && 
                         (model.includes('12th') || model.includes('13th') || model.includes('14th') || model.includes('15th'));
        const hasAVX2 = brand.includes('intel') || brand.includes('amd');
        const hasVNNI = hasAVX512; // VNNI usually comes with AVX512

        // Estimate CPU tier for LLM inference
        let tier = 'entry';
        if (cores >= 16 && baseSpeed >= 3.0) tier = 'high_end';
        else if (cores >= 8 && baseSpeed >= 2.5) tier = 'mid_range';
        else if (cores >= 4 && baseSpeed >= 2.0) tier = 'budget';

        return {
            brand: brand,
            model: cpu.model || 'Unknown CPU',
            cores,
            threads,
            baseSpeed,
            tier,
            features: {
                avx512: hasAVX512,
                avx2: hasAVX2,
                vnni: hasVNNI
            },
            estimatedGFLOPS: cores * baseSpeed * (hasAVX512 ? 64 : hasAVX2 ? 32 : 16)
        };
    }

    /**
     * Detect available backends on the system
     */
    async detectAvailableBackends(platform) {
        const backends = {
            cuda: false,
            rocm: false,
            sycl: false,
            vulkan: false,
            directml: false,
            openvino: false,
            blas: true  // Always assume basic BLAS
        };

        try {
            // Check for NVIDIA CUDA
            try {
                await this.runCommand('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
                backends.cuda = true;
            } catch (e) {
                // CUDA not available
            }

            // Check for AMD ROCm (Linux mainly)
            if (platform === 'linux') {
                try {
                    await this.runCommand('rocm-smi', ['--showid']);
                    backends.rocm = true;
                } catch (e) {
                    // ROCm not available
                }
            }

            // Check for Intel SYCL/oneAPI
            try {
                await this.runCommand('sycl-ls', []);
                backends.sycl = true;
            } catch (e) {
                // Try alternative oneAPI detection
                try {
                    await this.runCommand('oneapi-cli', ['--version']);
                    backends.sycl = true;
                } catch (e2) {
                    // SYCL not available
                }
            }

            // DirectML available on Windows
            if (platform === 'win32') {
                backends.directml = true;
            }

            // Vulkan detection (cross-platform)
            try {
                // Basic Vulkan detection - could be enhanced
                backends.vulkan = true; // Assume modern systems have Vulkan
            } catch (e) {
                // Vulkan not available
            }

            // OpenVINO detection
            try {
                await this.runCommand('benchmark_app', ['--help']);
                backends.openvino = true;
            } catch (e) {
                // OpenVINO not available
            }

        } catch (error) {
            console.warn('Backend detection failed:', error.message);
        }

        return backends;
    }

    /**
     * Choose optimal backend based on available options and hardware
     */
    chooseOptimalBackend(hardware) {
        const { gpu, backends, os } = hardware;
        
        // Priority order for different GPU vendors
        if (gpu.vendor === 'nvidia' && backends.cuda) {
            return { backend: 'cuda', reason: 'NVIDIA GPU with CUDA support' };
        }
        
        if (gpu.vendor === 'amd' && backends.rocm && os.platform === 'linux') {
            return { backend: 'rocm', reason: 'AMD GPU with ROCm support (Linux)' };
        }
        
        if (gpu.vendor === 'intel' && backends.sycl) {
            return { backend: 'sycl', reason: 'Intel GPU with oneAPI/SYCL support' };
        }
        
        // Fallback options for Windows
        if (os.platform === 'win32' && backends.directml && !gpu.isIntegrated) {
            return { backend: 'directml', reason: 'Windows DirectML fallback' };
        }
        
        // Vulkan as cross-platform fallback
        if (backends.vulkan && !gpu.isIntegrated) {
            return { backend: 'vulkan', reason: 'Vulkan cross-platform acceleration' };
        }
        
        // Intel OpenVINO for Intel hardware
        if (gpu.vendor === 'intel' && backends.openvino) {
            return { backend: 'openvino', reason: 'Intel OpenVINO optimization' };
        }
        
        // CPU fallback
        if (hardware.cpu.features.avx512) {
            return { backend: 'cpu_avx512', reason: 'CPU with AVX512 acceleration' };
        } else if (hardware.cpu.features.avx2) {
            return { backend: 'cpu_avx2', reason: 'CPU with AVX2 acceleration' };
        } else {
            return { backend: 'cpu_basic', reason: 'Basic CPU inference' };
        }
    }

    /**
     * Calculate optimal quantization and GPU offload strategy
     */
    pickQuantAndOffload(modelSizeB, hardware, contextLength = 4096) {
        const { gpu, memory } = hardware;
        const vramGB = gpu.vramGB || 0;
        const ramGB = memory.total;
        
        // KV cache estimation
        const kvSizeKey = modelSizeB <= 8 ? 7 : modelSizeB <= 15 ? 13 : modelSizeB <= 40 ? 33 : 70;
        const kvCacheGB = this.kvCacheEstimates[kvSizeKey] * (contextLength / 1000);
        
        // Available memory (with safety margins)
        const usableVRAM = vramGB * 0.9;  // 90% usable VRAM
        const usableRAM = ramGB * 0.8;    // 80% usable RAM
        
        // Try quantizations from best to worst
        const quantOptions = ['Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q3_K', 'Q2_K'];
        
        for (const quant of quantOptions) {
            const modelSizeGB = modelSizeB * this.bytesPerParam[quant];
            const totalNeed = modelSizeGB + kvCacheGB;
            
            // Check if it fits fully in VRAM
            if (totalNeed <= usableVRAM && !gpu.isIntegrated) {
                return {
                    quantization: quant,
                    gpuLayers: -1,  // Full GPU
                    memoryUsage: {
                        vram: totalNeed,
                        ram: 0,
                        total: totalNeed
                    },
                    strategy: 'full_gpu'
                };
            }
            
            // Calculate partial offload if VRAM is insufficient but available
            if (usableVRAM > 0 && !gpu.isIntegrated) {
                const vramRatio = Math.min(0.85, usableVRAM / totalNeed);
                if (vramRatio > 0.15) { // Minimum 15% on GPU to be worthwhile
                    const ramNeed = totalNeed - usableVRAM;
                    if (ramNeed <= usableRAM) {
                        // Estimate layers (rough heuristic: 80 layers for most models)
                        const estimatedLayers = Math.max(16, Math.floor(80 * vramRatio));
                        return {
                            quantization: quant,
                            gpuLayers: estimatedLayers,
                            memoryUsage: {
                                vram: usableVRAM,
                                ram: ramNeed,
                                total: totalNeed
                            },
                            strategy: 'partial_offload'
                        };
                    }
                }
            }
            
            // Check if it fits in RAM (CPU-only)
            if (totalNeed <= usableRAM) {
                return {
                    quantization: quant,
                    gpuLayers: 0,  // CPU only
                    memoryUsage: {
                        vram: 0,
                        ram: totalNeed,
                        total: totalNeed
                    },
                    strategy: 'cpu_only'
                };
            }
        }
        
        // If nothing fits, return most aggressive quantization
        const modelSizeGB = modelSizeB * this.bytesPerParam['Q2_K'];
        return {
            quantization: 'Q2_K',
            gpuLayers: 0,
            memoryUsage: {
                vram: 0,
                ram: modelSizeGB + kvCacheGB,
                total: modelSizeGB + kvCacheGB
            },
            strategy: 'aggressive_quant',
            warning: 'Model may not fit comfortably in available memory'
        };
    }

    /**
     * Predict inference speed for given configuration
     */
    predictInferenceSpeed(modelSizeB, config, hardware) {
        const { quantization, gpuLayers, strategy } = config;
        const backend = this.chooseOptimalBackend(hardware).backend;
        
        // Base throughput from backend
        const baseK = this.backendCoefficients[backend] || this.backendCoefficients.cpu_basic;
        
        // Scale by model size (inverse relationship)
        let throughput = baseK / modelSizeB;
        
        // Quantization speed factor
        const quantFactor = this.quantFactors[quantization] || 1.0;
        throughput *= quantFactor;
        
        // Offload strategy factor
        let offloadFactor = 1.0;
        if (strategy === 'partial_offload') {
            // Estimate offload efficiency based on GPU layers ratio
            const totalLayers = 80; // Rough estimate
            const gpuRatio = gpuLayers / totalLayers;
            offloadFactor = 0.5 + (gpuRatio * 0.4); // 0.5 to 0.9 range
        } else if (strategy === 'cpu_only') {
            offloadFactor = 0.6; // CPU penalty compared to GPU
        } else if (strategy === 'aggressive_quant') {
            offloadFactor = 0.4; // Heavy memory pressure penalty
        }
        
        throughput *= offloadFactor;
        
        // Hardware-specific adjustments
        if (hardware.gpu.vendor === 'nvidia' && backend === 'cuda') {
            throughput *= 1.1; // NVIDIA optimization bonus
        } else if (hardware.gpu.vendor === 'amd' && backend === 'rocm') {
            throughput *= 0.9; // AMD slight penalty vs NVIDIA
        } else if (hardware.gpu.isIntegrated) {
            throughput *= 0.7; // Integrated GPU penalty
        }
        
        return Math.max(1, Math.round(throughput * 100) / 100);
    }

    /**
     * Generate hardware-specific model recommendations
     */
    generateRecommendations(hardware) {
        const recommendations = [];
        const { gpu, memory, cpu } = hardware;
        
        // Categorize hardware capability
        let capability = 'basic';
        if (gpu.vramGB >= 24) capability = 'high_end';
        else if (gpu.vramGB >= 12) capability = 'enthusiast';
        else if (gpu.vramGB >= 6) capability = 'gaming';
        else if (memory.total >= 32) capability = 'workstation';
        else if (memory.total >= 16) capability = 'standard';
        
        // Model size recommendations based on capability
        const recommendations_map = {
            high_end: [
                { model: '70B', quant: 'Q4_K_M', reason: 'Large model with good quality' },
                { model: '33B', quant: 'Q5_K_M', reason: 'Excellent balance of size and quality' },
                { model: '13B', quant: 'Q6_K', reason: 'High quality medium model' }
            ],
            enthusiast: [
                { model: '33B', quant: 'Q4_K_M', reason: 'Large model fits in VRAM' },
                { model: '13B', quant: 'Q5_K_M', reason: 'Optimal size for your GPU' },
                { model: '7B', quant: 'Q6_K', reason: 'Fast high-quality option' }
            ],
            gaming: [
                { model: '13B', quant: 'Q4_K_M', reason: 'Good balance for gaming GPU' },
                { model: '7B', quant: 'Q5_K_M', reason: 'Recommended for your VRAM' },
                { model: '3B', quant: 'Q6_K', reason: 'Fast inference option' }
            ],
            workstation: [
                { model: '33B', quant: 'Q4_K_M', reason: 'CPU offload with large RAM' },
                { model: '13B', quant: 'Q5_K_M', reason: 'Good CPU performance' },
                { model: '7B', quant: 'Q6_K', reason: 'Reliable CPU inference' }
            ],
            standard: [
                { model: '13B', quant: 'Q4_K_M', reason: 'Fits in 16GB RAM' },
                { model: '7B', quant: 'Q5_K_M', reason: 'Optimal for your system' },
                { model: '3B', quant: 'Q6_K', reason: 'Fast and efficient' }
            ],
            basic: [
                { model: '7B', quant: 'Q4_K_M', reason: 'Recommended for limited hardware' },
                { model: '3B', quant: 'Q5_K_M', reason: 'Good performance on basic systems' },
                { model: '1B', quant: 'Q6_K', reason: 'Ultra-fast option' }
            ]
        };
        
        const recs = recommendations_map[capability] || recommendations_map.basic;
        
        // Add backend and command suggestions
        const optimalBackend = this.chooseOptimalBackend(hardware);
        
        recs.forEach(rec => {
            const modelSizeB = parseFloat(rec.model);
            const config = this.pickQuantAndOffload(modelSizeB, hardware);
            const speed = this.predictInferenceSpeed(modelSizeB, config, hardware);
            
            recommendations.push({
                ...rec,
                backend: optimalBackend.backend,
                config,
                estimatedSpeed: speed,
                command: this.generateCommand(rec.model, config, optimalBackend.backend)
            });
        });
        
        return {
            capability,
            backend: optimalBackend,
            recommendations: recommendations.slice(0, 5) // Top 5
        };
    }

    /**
     * Generate appropriate CLI command for the configuration
     */
    generateCommand(modelSize, config, backend) {
        const { quantization, gpuLayers } = config;
        
        // llama.cpp style command
        let cmd = 'llama-cli -m model.gguf';
        
        if (gpuLayers === -1) {
            cmd += ' -ngl -1';  // Full GPU
        } else if (gpuLayers > 0) {
            cmd += ` -ngl ${gpuLayers}`;  // Partial offload
        }
        // No -ngl flag for CPU-only
        
        cmd += ' -t 8 -c 4096';  // 8 threads, 4k context
        
        return {
            llamacpp: cmd,
            ollama: `ollama run model:${modelSize.toLowerCase()}-${quantization.toLowerCase().replace('_', '-')}`,
            description: `${modelSize} model with ${quantization} quantization (${config.strategy})`
        };
    }

    /**
     * Run shell command with timeout
     */
    async runCommand(command, args, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const proc = spawn(command, args, { stdio: 'pipe' });
            let output = '';
            let error = '';
            
            const timer = setTimeout(() => {
                proc.kill();
                reject(new Error('Command timeout'));
            }, timeout);
            
            proc.stdout.on('data', (data) => output += data);
            proc.stderr.on('data', (data) => error += data);
            
            proc.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve(output.trim());
                } else {
                    reject(new Error(`Command failed: ${error || 'Unknown error'}`));
                }
            });
            
            proc.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }
}

module.exports = PCOptimizer;