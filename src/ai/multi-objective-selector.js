/**
 * Multi-Objective Model Selector
 * 
 * Implements the improved algorithm with:
 * 1. Hard filters (memory, compatibility)
 * 2. Multi-objective scoring (quality, speed, hardware-match, context, headroom)
 * 3. Hardware-appropriate model size recommendations
 * 4. Benchmark-based quality scoring
 */

class MultiObjectiveSelector {
    constructor() {
        // Performance weights by category - prioritize hardware match and quality over raw speed
        this.categoryWeights = {
            'general': { quality: 0.45, speed: 0.15, ttfb: 0.05, context: 0.05, hardwareMatch: 0.30 },
            'coding': { quality: 0.45, speed: 0.15, ttfb: 0.05, context: 0.10, hardwareMatch: 0.25 },
            'reasoning': { quality: 0.50, speed: 0.10, ttfb: 0.05, context: 0.15, hardwareMatch: 0.20 },
            'multimodal': { quality: 0.40, speed: 0.10, ttfb: 0.05, context: 0.10, hardwareMatch: 0.35 },
            'longctx': { quality: 0.30, speed: 0.10, ttfb: 0.05, context: 0.35, hardwareMatch: 0.20 }
        };

        // Optimal model sizes by hardware tier (in billions of parameters)
        this.optimalSizes = {
            'flagship': { min: 30, max: 175, sweet: 70 },    // RTX 5090 tier: 30B-175B models
            'ultra_high': { min: 20, max: 105, sweet: 35 },  // RTX 4090 tier: 20B-105B models  
            'high': { min: 8, max: 50, sweet: 20 },          // RTX 4080, Apple 32GB: 8B-50B models
            'medium': { min: 3, max: 20, sweet: 8 },         // RTX 4070, Apple 16GB: 3B-20B models
            'low': { min: 1, max: 8, sweet: 3 },             // Budget systems: 1B-8B models
            'ultra_low': { min: 0.1, max: 3, sweet: 1 }     // Very limited: <3B models
        };

        // Benchmark-based quality priors (normalized 0-1)
        this.qualityPriors = {
            // By family and scale - rough estimates from public benchmarks
            'llama': { base: 0.75, coding: 0.80, reasoning: 0.78 },
            'qwen': { base: 0.73, coding: 0.85, reasoning: 0.76 },
            'mistral': { base: 0.72, coding: 0.75, reasoning: 0.80 },
            'gemma': { base: 0.68, coding: 0.70, reasoning: 0.72 },
            'phi': { base: 0.65, coding: 0.78, reasoning: 0.70 },
            'tinyllama': { base: 0.45, coding: 0.50, reasoning: 0.48 },
            'default': { base: 0.60, coding: 0.60, reasoning: 0.60 }
        };
    }

    /**
     * Select best models using multi-objective ranking
     */
    async selectBestModels(hardware, models, category = 'general', topK = 10) {
        // Step 1: Hard filters - remove incompatible models
        const compatibleModels = this.applyHardFilters(hardware, models);
        
        if (compatibleModels.length === 0) {
            return { compatible: [], marginal: [], incompatible: models };
        }

        // Step 2: Multi-objective scoring
        const scoredModels = compatibleModels.map(model => 
            this.calculateMultiObjectiveScore(hardware, model, category)
        ).filter(Boolean);
        

        // Step 3: Sort and classify
        scoredModels.sort((a, b) => b.totalScore - a.totalScore);

        return this.classifyResults(scoredModels, topK);
    }

    /**
     * Step 1: Hard filters - memory, compatibility, architecture
     */
    applyHardFilters(hardware, models) {
        return models.filter(model => {
            // Memory filter - can it fit?
            const memoryFits = this.checkMemoryCompatibility(hardware, model);
            
            // Architecture compatibility
            const archCompatible = this.checkArchitectureCompatibility(hardware, model);
            
            // Basic requirements met
            const requirementsMet = this.checkBasicRequirements(hardware, model);
            
            return memoryFits && archCompatible && requirementsMet;
        });
    }

    /**
     * Realistic hardware compatibility check based on tier and actual capabilities
     */
    checkMemoryCompatibility(hardware, model) {
        const modelSizeGB = this.parseModelSize(model.size);
        const contextLength = model.context || 4096;
        
        // Get hardware tier using same algorithm as main system
        const hardwareTier = this.getHardwareTier(hardware);
        
        // Estimate KV cache (rough approximation)  
        const kvCacheGB = this.estimateKVCache(model, contextLength);
        const totalMemoryNeeded = modelSizeGB + kvCacheGB;
        
        // Tier-based realistic limits (not just memory, but practical performance)
        const tierLimits = {
            'flagship': { maxModelSize: 180, availableMemoryRatio: 0.85 },  // RTX 5090 tier, massive VRAM
            'ultra_high': { maxModelSize: 105, availableMemoryRatio: 0.8 }, // RTX 4090, H100 tier
            'high': { maxModelSize: 50, availableMemoryRatio: 0.75 },       // RTX 4080, Apple Silicon 32GB+
            'medium': { maxModelSize: 20, availableMemoryRatio: 0.7 },      // RTX 4070, Apple Silicon 16GB
            'low': { maxModelSize: 8, availableMemoryRatio: 0.6 },          // Budget systems, iGPU
            'ultra_low': { maxModelSize: 3, availableMemoryRatio: 0.5 }     // Very limited systems
        };
        
        const limits = tierLimits[hardwareTier] || tierLimits['ultra_low'];
        
        // Hard size limit based on what the hardware tier can realistically handle
        if (modelSizeGB > limits.maxModelSize) {
            return false; // Model too large for this tier regardless of RAM
        }
        
        // Memory check with tier-appropriate safety margin
        const availableMemory = hardware.memory.total * limits.availableMemoryRatio;
        
        return totalMemoryNeeded <= availableMemory;
    }

    /**
     * Step 2: Multi-objective scoring
     */
    calculateMultiObjectiveScore(hardware, model, category) {
        const weights = this.categoryWeights[category] || this.categoryWeights['general'];
        
        
        // Individual component scores (0-1)
        const qualityScore = this.calculateQualityScore(model, category);
        const speedScore = this.calculateSpeedScore(hardware, model);
        const ttfbScore = this.calculateTTFBScore(hardware, model);
        const contextScore = this.calculateContextScore(model, category);
        const hardwareMatchScore = this.calculateHardwareMatchScore(hardware, model);
        
        // Weighted total
        const totalScore = (
            weights.quality * qualityScore +
            weights.speed * speedScore +
            weights.ttfb * ttfbScore +
            weights.context * contextScore +
            weights.hardwareMatch * hardwareMatchScore
        ) * 100; // Scale to 0-100

        return {
            ...model,
            totalScore: Math.round(totalScore * 100) / 100,
            components: {
                quality: qualityScore,
                speed: speedScore,
                ttfb: ttfbScore,
                context: contextScore,
                hardwareMatch: hardwareMatchScore
            },
            reasoning: this.generateReasoning(model, hardware, qualityScore, hardwareMatchScore)
        };
    }

    /**
     * Quality score based on model family and benchmarks
     */
    calculateQualityScore(model, category) {
        const family = this.guessModelFamily(model.name);
        const priors = this.qualityPriors[family] || this.qualityPriors['default'];
        
        // Base quality by family
        let baseQuality = priors.base;
        
        // Category-specific adjustments
        if (category === 'coding' && priors.coding) {
            baseQuality = priors.coding;
        } else if (category === 'reasoning' && priors.reasoning) {
            baseQuality = priors.reasoning;
        }
        
        // Scale adjustment (larger models generally better quality)
        const modelSizeB = this.estimateModelParams(model);
        const scaleBonus = Math.min(0.15, Math.log2(Math.max(1, modelSizeB)) * 0.03);
        
        return Math.min(1.0, baseQuality + scaleBonus);
    }

    /**
     * Hardware-size matching score - key improvement!
     */
    calculateHardwareMatchScore(hardware, model) {
        const hardwareTier = this.getHardwareTier(hardware);
        const modelSizeB = this.estimateModelParams(model);
        const optimal = this.optimalSizes[hardwareTier];
        
        
        if (!optimal) return 0.5; // Fallback
        
        if (modelSizeB < optimal.min) {
            // Underutilization penalty
            const underutilization = optimal.min / modelSizeB;
            if (underutilization >= 10) return 0.1; // Severe penalty
            if (underutilization >= 5) return 0.3;  // Moderate penalty
            return 0.6; // Small penalty
        } else if (modelSizeB > optimal.max) {
            // Too large, but let memory filter handle this
            return 0.4;
        } else {
            // In good range - bonus for sweet spot
            const distanceFromSweet = Math.abs(modelSizeB - optimal.sweet) / optimal.sweet;
            if (distanceFromSweet <= 0.3) return 1.0; // Perfect match
            return 0.8; // Good range
        }
    }

    /**
     * Speed score estimation
     */
    calculateSpeedScore(hardware, model) {
        const estimatedTokps = this.estimateTokensPerSecond(hardware, model);
        // Normalize against reasonable expectation (50 tok/s = 1.0)
        return Math.min(1.0, estimatedTokps / 50);
    }

    /**
     * Time to First Byte score
     */
    calculateTTFBScore(hardware, model) {
        const estimatedTTFB = this.estimateTTFB(hardware, model);
        // Lower TTFB is better, normalize against 1000ms
        return Math.min(1.0, 1000 / Math.max(100, estimatedTTFB));
    }

    /**
     * Context score based on model's context window
     */
    calculateContextScore(model, category) {
        const contextLength = model.context || 4096;
        const targetContext = category === 'longctx' ? 32768 : 4096;
        return Math.min(1.0, contextLength / targetContext);
    }

    /**
     * Classify results into compatible/marginal/incompatible
     * Lower thresholds for more realistic classification
     */
    classifyResults(scoredModels, topK) {
        const compatible = scoredModels.filter(m => m.totalScore >= 65);
        const marginal = scoredModels.filter(m => m.totalScore >= 45 && m.totalScore < 65);
        const incompatible = scoredModels.filter(m => m.totalScore < 45);

        return {
            compatible: compatible.slice(0, topK),
            marginal: marginal.slice(0, topK),
            incompatible: incompatible.slice(0, 5) // Limit incompatible list
        };
    }

    // Helper methods
    parseModelSize(sizeString) {
        if (!sizeString) return 4; // Default 4GB
        
        // Handle different size formats
        let cleanSize = sizeString.toString().toUpperCase();
        
        // Extract number and unit - be more specific about units
        const match = cleanSize.match(/([0-9.]+)\s*(GB|MB|B)$/i);
        if (!match) return 4;
        
        const num = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        
        // Handle file size units (GB, MB) vs parameter count indicators
        if (unit === 'MB') return num / 1024; // Convert MB to GB
        if (unit === 'GB') return num; // Already in GB
        
        // If unit is 'B', determine if it's bytes or billion parameters
        if (unit === 'B') {
            if (num >= 1000000) {
                // Large numbers (>= 1M) are likely bytes
                return num / (1024 ** 3); // Convert bytes to GB
            } else if (num >= 0.1 && num <= 100) {
                // Small numbers (0.1-100) are likely billion parameters - convert to file size
                // Rough estimate: 1B params ≈ 2GB in Q4 quantization
                return Math.max(0.5, num * 2);
            } else {
                // Fallback for edge cases
                return Math.max(0.5, num);
            }
        }
        
        return num; // Default fallback
    }

    estimateModelParams(model) {
        // First, try to extract parameter count directly from model name
        const nameMatch = model.name.match(/(\d+\.?\d*)[bB]\b/i);
        if (nameMatch) {
            const paramCount = parseFloat(nameMatch[1]);
            // Sanity check: parameter counts should be reasonable (0.1B to 100B)
            if (paramCount >= 0.1 && paramCount <= 100) {
                return paramCount;
            }
        }
        
        // Use installedSize from Ollama if available, otherwise fall back to size field
        let sizeGB;
        
        if (model.installedSize) {
            // Use real size from Ollama (this is file size)
            sizeGB = this.parseModelSize(model.installedSize);
        } else if (model.size) {
            // Use size field from database (this is file size)  
            sizeGB = this.parseModelSize(model.size);
        } else {
            sizeGB = 4; // Default fallback file size
        }
        
        // Convert file size to parameter count: roughly 1B params ≈ 2GB in Q4 quantization
        return sizeGB / 2;
    }

    guessModelFamily(name) {
        const n = name.toLowerCase();
        if (n.includes('llama')) return 'llama';
        if (n.includes('qwen')) return 'qwen';
        if (n.includes('mistral')) return 'mistral';
        if (n.includes('gemma')) return 'gemma';
        if (n.includes('phi')) return 'phi';
        if (n.includes('tinyllama')) return 'tinyllama';
        return 'default';
    }

    getHardwareTier(hardware) {
        // Use the same advanced scoring algorithm for consistency
        const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
        
        const ramGB = hardware.memory.total || 0;
        const vramGB = hardware.gpu?.vram || 0;
        const cpuModel = hardware.cpu?.brand || hardware.cpu?.model || '';
        const gpuModel = hardware.gpu?.model || '';
        const architecture = hardware.cpu?.architecture || hardware.cpu?.brand || '';
        const cpuCoresPhys = hardware.cpu?.physicalCores || hardware.cpu?.cores || 1;
        const cpuGHzBase = hardware.cpu?.speed || 2.0;
        
        // Enhanced Apple Silicon detection to match main algorithm
        const isAppleSilicon = architecture.toLowerCase().includes('apple') || 
                              architecture.toLowerCase().includes('m1') || 
                              architecture.toLowerCase().includes('m2') ||
                              architecture.toLowerCase().includes('m3') ||
                              architecture.toLowerCase().includes('m4') ||
                              cpuModel.toLowerCase().includes('apple') ||
                              gpuModel.toLowerCase().includes('apple');
        const unified = isAppleSilicon;
        
        // Detect PC platform (Windows/Linux) to match main algorithm
        const isPC = !isAppleSilicon && (process.platform === 'win32' || process.platform === 'linux');
        
        // 1) Effective memory for model weights (45%) - Apple Silicon & PC optimized
        let effMem;
        
        if (vramGB > 0 && !unified) {
            // Dedicated GPU path (Windows/Linux with discrete GPU)
            if (isPC) {
                // PC-specific GPU memory calculation with offload support
                const pcSpecs = this.getPCGPUSpecs(hardware, vramGB, ramGB);
                effMem = vramGB + pcSpecs.offloadCapacity;
            } else {
                // Generic discrete GPU calculation
                effMem = vramGB + Math.min(0.25 * ramGB, 8);
            }
        } else if (unified && isAppleSilicon) {
            // Apple Silicon unified memory optimization
            const appleSiliconInfo = this.getAppleSiliconSpecs(cpuModel, gpuModel, ramGB);
            effMem = appleSiliconInfo.effectiveMemoryRatio * ramGB;
            
            // Apply model size bonus for larger unified memory pools
            if (ramGB >= 32) {
                effMem += appleSiliconInfo.largeMemoryBonus;
            }
        } else {
            // Traditional CPU-only path or integrated GPU
            if (isPC) {
                // PC CPU-only with potential iGPU assist
                const pcSpecs = this.getPCCPUSpecs(hardware, ramGB);
                effMem = pcSpecs.effectiveMemoryRatio * ramGB;
            } else {
                // Generic CPU-only calculation
                effMem = 0.6 * ramGB;
            }
        }
        
        const mem_cap = clamp(effMem / 32);  // More realistic normalization
        
        // 2) Memory bandwidth (20%) - simplified estimation
        let memBandwidthGBs = 50; // fallback
        const gpu = gpuModel.toLowerCase();
        if (gpu.includes('m4 pro')) memBandwidthGBs = 273;
        else if (gpu.includes('m4')) memBandwidthGBs = 120;
        else if (gpu.includes('rtx 4090')) memBandwidthGBs = 1008;
        else if (gpu.includes('rtx 4080')) memBandwidthGBs = 716;
        else if (gpu.includes('rtx 4070')) memBandwidthGBs = 448;
        else if (gpu.includes('iris xe')) memBandwidthGBs = 68;
        
        const mem_bw = clamp(memBandwidthGBs / 500);  // Match main algorithm
        
        // 3) Compute (20%) - simplified estimation
        let compute = 0;
        if (gpu.includes('m4 pro')) compute = clamp(28 / 80);  // Match main algorithm
        else if (gpu.includes('m4')) compute = clamp(15 / 80);
        else if (gpu.includes('rtx 4090')) compute = clamp(165 / 80);
        else if (gpu.includes('rtx 4080')) compute = clamp(121 / 80);
        else if (gpu.includes('iris xe')) compute = 0.02;
        else {
            // CPU fallback
            compute = clamp((cpuCoresPhys * cpuGHzBase) / 60);
        }
        
        // 4) System RAM for KV-cache (10%)
        const sys_ram = clamp(ramGB / 64);
        
        // 5) Storage (5%) - assume NVMe
        const storage = 1.0;
        
        // Final score
        const score = 100 * (0.45 * mem_cap + 0.20 * mem_bw + 0.20 * compute + 0.10 * sys_ram + 0.05 * storage);
        
        // Map to tier (expanded for flagship hardware)
        let tier = score >= 85 ? 'flagship' :     // New flagship tier for extreme hardware
                  score >= 75 ? 'ultra_high' :
                  score >= 55 ? 'high' :
                  score >= 35 ? 'medium' :
                  score >= 20 ? 'low' : 'ultra_low';
        
        // Apply same reality-based adjustments as main algorithm
        const bumpTier = (t, direction) => {
            const tiers = ['ultra_low', 'low', 'medium', 'high', 'ultra_high', 'flagship'];
            const index = tiers.indexOf(t);
            const newIndex = Math.max(0, Math.min(tiers.length - 1, index + direction));
            return tiers[newIndex];
        };
        
        // Enhanced tier adjustments for flagship hardware
        if (vramGB >= 32) {
            // RTX 5090 tier - automatic flagship promotion
            tier = 'flagship';
        } else if (vramGB >= 24) {
            tier = bumpTier(tier, +1);  // High-end GPU boost
        } else if (!vramGB && !unified) {
            tier = bumpTier(tier, -1);  // CPU-only penalty (moderate)
        } else if (/iris xe|uhd.*graphics|vega.*integrated|radeon.*graphics/i.test(gpuModel)) {
            tier = bumpTier(tier, -1);  // iGPU penalty
        } else if (vramGB > 0 && vramGB < 6) {
            tier = bumpTier(tier, -1);  // Low VRAM penalty
        }
        
        // Special flagship GPU detection by model name
        if (gpuModel.toLowerCase().includes('rtx 50') || 
            gpuModel.toLowerCase().includes('h100') || 
            gpuModel.toLowerCase().includes('a100')) {
            tier = 'flagship';
        }
        
        return tier;
    }
    
    /**
     * Apple Silicon-specific specifications and optimization parameters
     * Shared implementation with main algorithm for consistency
     */
    getAppleSiliconSpecs(cpuModel, gpuModel, ramGB) {
        const cpu = cpuModel.toLowerCase();
        const gpu = gpuModel.toLowerCase();
        
        // Base specs for different Apple Silicon generations
        let baseSpecs = {
            effectiveMemoryRatio: 0.85,  // Default unified memory efficiency
            largeMemoryBonus: 0,         // Bonus for large memory configs
            memoryBandwidth: 100,        // GB/s
            quantizationEfficiency: 1.0, // Quantization optimization factor
            metalOptimization: 1.2       // Metal backend boost
        };
        
        // M4 Pro/Max optimizations
        if (cpu.includes('m4 pro') || gpu.includes('m4 pro')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.90,  // Higher efficiency due to newer architecture
                largeMemoryBonus: 4,         // 4GB bonus for 32GB+ configs
                memoryBandwidth: 273,        // 273 GB/s memory bandwidth
                quantizationEfficiency: 1.15, // Better quantization support
                metalOptimization: 1.3       // Enhanced Metal backend
            };
        } else if (cpu.includes('m4') || gpu.includes('m4')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.88,
                largeMemoryBonus: 2,
                memoryBandwidth: 120,
                quantizationEfficiency: 1.10,
                metalOptimization: 1.25
            };
        }
        // M3 optimizations
        else if (cpu.includes('m3 max') || gpu.includes('m3 max')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.87,
                largeMemoryBonus: 3,
                memoryBandwidth: 400,
                quantizationEfficiency: 1.08,
                metalOptimization: 1.2
            };
        } else if (cpu.includes('m3 pro') || gpu.includes('m3 pro')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.86,
                largeMemoryBonus: 2,
                memoryBandwidth: 150,
                quantizationEfficiency: 1.05,
                metalOptimization: 1.15
            };
        } else if (cpu.includes('m3') || gpu.includes('m3')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.85,
                largeMemoryBonus: 1,
                memoryBandwidth: 100,
                quantizationEfficiency: 1.03,
                metalOptimization: 1.1
            };
        }
        // M2 optimizations
        else if (cpu.includes('m2 max') || gpu.includes('m2 max')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.84,
                largeMemoryBonus: 2,
                memoryBandwidth: 400,
                quantizationEfficiency: 1.02,
                metalOptimization: 1.1
            };
        } else if (cpu.includes('m2 pro') || gpu.includes('m2 pro')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.83,
                largeMemoryBonus: 1,
                memoryBandwidth: 200,
                quantizationEfficiency: 1.0,
                metalOptimization: 1.05
            };
        } else if (cpu.includes('m2') || gpu.includes('m2')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.82,
                largeMemoryBonus: 0,
                memoryBandwidth: 100,
                quantizationEfficiency: 1.0,
                metalOptimization: 1.0
            };
        }
        // M1 optimizations (legacy but still supported)
        else if (cpu.includes('m1 max') || gpu.includes('m1 max')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.80,
                largeMemoryBonus: 1,
                memoryBandwidth: 400,
                quantizationEfficiency: 0.95,
                metalOptimization: 1.0
            };
        } else if (cpu.includes('m1 pro') || gpu.includes('m1 pro')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.78,
                largeMemoryBonus: 0,
                memoryBandwidth: 200,
                quantizationEfficiency: 0.95,
                metalOptimization: 0.95
            };
        } else if (cpu.includes('m1') || gpu.includes('m1')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.75,
                largeMemoryBonus: 0,
                memoryBandwidth: 68.25,
                quantizationEfficiency: 0.90,
                metalOptimization: 0.90
            };
        }
        
        // Apply memory configuration scaling
        if (ramGB >= 64) {
            baseSpecs.effectiveMemoryRatio += 0.03;  // Bonus for very large memory
            baseSpecs.largeMemoryBonus += 2;
        } else if (ramGB >= 32) {
            baseSpecs.effectiveMemoryRatio += 0.02;  // Bonus for large memory
        } else if (ramGB <= 8) {
            baseSpecs.effectiveMemoryRatio -= 0.05;  // Penalty for small memory
        }
        
        return baseSpecs;
    }
    
    /**
     * PC GPU-specific specifications - shared implementation with main algorithm
     */
    getPCGPUSpecs(hardware, vramGB, ramGB) {
        const gpuModel = hardware.gpu?.model || '';
        const gpu = gpuModel.toLowerCase();
        
        let specs = {
            offloadCapacity: 0,      // Additional effective memory from RAM offload
            memoryEfficiency: 0.85,  // VRAM utilization efficiency
            backendOptimization: 1.0, // Backend-specific optimization
            quantizationSupport: 1.0  // Quantization efficiency
        };
        
        // NVIDIA GPU optimizations
        if (gpu.includes('nvidia') || gpu.includes('geforce') || gpu.includes('rtx') || gpu.includes('gtx')) {
            if (gpu.includes('rtx 50')) {
                // RTX 50xx series - flagship tier with massive VRAM + excellent offload
                specs.offloadCapacity = Math.min(ramGB * 0.5, 24);
                specs.memoryEfficiency = 0.95;
            } else if (gpu.includes('rtx 40')) {
                specs.offloadCapacity = Math.min(ramGB * 0.35, 16);
                specs.memoryEfficiency = 0.90;
            } else if (gpu.includes('rtx 30')) {
                specs.offloadCapacity = Math.min(ramGB * 0.25, 12);
            } else if (gpu.includes('rtx 20') || gpu.includes('gtx 16')) {
                specs.offloadCapacity = Math.min(ramGB * 0.15, 6);
            }
        }
        // AMD GPU optimizations
        else if (gpu.includes('amd') || gpu.includes('radeon') || gpu.includes('rx ')) {
            if (gpu.includes('rx 7000') || gpu.includes('rx 7900') || gpu.includes('rx 7800')) {
                specs.offloadCapacity = Math.min(ramGB * 0.2, 8);
            } else if (gpu.includes('rx 6000')) {
                specs.offloadCapacity = Math.min(ramGB * 0.15, 6);
            }
        }
        // Intel GPU optimizations
        else if (gpu.includes('intel') || gpu.includes('arc')) {
            if (gpu.includes('arc a7') || gpu.includes('arc a5')) {
                specs.offloadCapacity = Math.min(ramGB * 0.2, 6);
            }
        }
        
        // Apply memory scaling bonuses for high-end systems
        if (ramGB >= 64) {
            specs.offloadCapacity += 8;  // Massive system bonus
        } else if (ramGB >= 32) {
            specs.offloadCapacity += 4;  // High-end system bonus
        }
        
        return specs;
    }
    
    /**
     * PC CPU-specific specifications - shared implementation with main algorithm
     */
    getPCCPUSpecs(hardware, ramGB) {
        const cpuModel = hardware.cpu?.brand || hardware.cpu?.model || '';
        const gpuModel = hardware.gpu?.model || '';
        const cpu = cpuModel.toLowerCase();
        const gpu = gpuModel.toLowerCase();
        const cores = hardware.cpu?.physicalCores || hardware.cpu?.cores || 1;
        
        let specs = {
            effectiveMemoryRatio: 0.6,   // Default CPU memory efficiency
            instructionOptimization: 1.0, // CPU instruction set bonus
            iGPUAssist: 0,               // Integrated GPU assistance
            thermalHeadroom: 1.0         // Thermal performance factor
        };
        
        // Intel CPU optimizations
        if (cpu.includes('intel')) {
            if (cpu.includes('i9') || cpu.includes('13th gen') || cpu.includes('14th gen')) {
                specs.effectiveMemoryRatio = 0.75;
            } else if (cpu.includes('i7') || cpu.includes('12th gen')) {
                specs.effectiveMemoryRatio = 0.70;
            } else if (cpu.includes('i5')) {
                specs.effectiveMemoryRatio = 0.65;
            }
            
            // Intel iGPU assistance
            if (gpu.includes('iris xe')) {
                specs.effectiveMemoryRatio += 0.05;
            } else if (gpu.includes('uhd')) {
                specs.effectiveMemoryRatio += 0.02;
            }
        }
        // AMD CPU optimizations
        else if (cpu.includes('amd') || cpu.includes('ryzen')) {
            if (cpu.includes('ryzen 9') || cpu.includes('7000') || cpu.includes('9000')) {
                specs.effectiveMemoryRatio = 0.72;
            } else if (cpu.includes('ryzen 7') || cpu.includes('5000') || cpu.includes('6000')) {
                specs.effectiveMemoryRatio = 0.68;
            } else if (cpu.includes('ryzen 5')) {
                specs.effectiveMemoryRatio = 0.65;
            }
            
            // AMD iGPU assistance (RDNA2/3 in APUs)
            if (gpu.includes('radeon') && gpu.includes('graphics')) {
                if (gpu.includes('780m') || gpu.includes('880m')) {
                    specs.effectiveMemoryRatio += 0.08;
                } else if (gpu.includes('680m') || gpu.includes('660m')) {
                    specs.effectiveMemoryRatio += 0.06;
                }
            }
        }
        
        // Multi-core and memory scaling
        if (cores >= 16) {
            specs.effectiveMemoryRatio += 0.05;
        } else if (cores >= 8) {
            specs.effectiveMemoryRatio += 0.03;
        }
        
        if (ramGB >= 64) {
            specs.effectiveMemoryRatio += 0.05;
        } else if (ramGB >= 32) {
            specs.effectiveMemoryRatio += 0.03;
        } else if (ramGB <= 8) {
            specs.effectiveMemoryRatio -= 0.05;
        }
        
        return specs;
    }

    estimateKVCache(model, contextLength) {
        // Rough KV cache estimation: 2 * layers * hidden_size * seq_len * 2 bytes
        const params = this.estimateModelParams(model);
        const layers = Math.round(params * 2); // Rough approximation
        const hiddenSize = Math.round(params * 1000); // Rough approximation
        return (2 * layers * hiddenSize * contextLength * 2) / (1024 ** 3); // GB
    }

    estimateTokensPerSecond(hardware, model) {
        const params = this.estimateModelParams(model);
        const cpuModel = hardware.cpu?.brand || hardware.cpu?.model || '';
        const gpuModel = hardware.gpu?.model || '';
        const cores = hardware.cpu?.physicalCores || hardware.cpu?.cores || 1;
        const baseSpeed = hardware.cpu?.speed || 2.0;
        const vramGB = hardware.gpu?.vram || 0;
        
        // Use improved CPU estimation function for more realistic and varying speeds
        const hasAVX512 = cpuModel.toLowerCase().includes('intel') && 
                         (cpuModel.includes('13th') || cpuModel.includes('14th') || cpuModel.includes('12th'));
        
        // GPU-based calculation (dedicated GPU only)
        if (vramGB > 0 && !gpuModel.toLowerCase().includes('iris') && !gpuModel.toLowerCase().includes('integrated')) {
            let gpuTPS = 20; // Conservative GPU baseline
            if (gpuModel.toLowerCase().includes('rtx 50')) {
                gpuTPS = 60; // RTX 50 series - more realistic
            } else if (gpuModel.toLowerCase().includes('rtx 40')) {
                gpuTPS = 45; // RTX 40 series  
            } else if (gpuModel.toLowerCase().includes('rtx 30')) {
                gpuTPS = 35; // RTX 30 series
            } else if (gpuModel.toLowerCase().includes('rtx 20')) {
                gpuTPS = 25; // RTX 20 series
            } else if (vramGB >= 8) {
                gpuTPS = 30; // Other high-end GPUs
            } else if (vramGB >= 4) {
                gpuTPS = 20; // Mid-range GPUs
            }
            
            // Scale by model size for GPU
            return Math.max(5, Math.round((gpuTPS / Math.max(0.8, params)) * 100) / 100);
        }
        // CPU-based calculation (more realistic formula)
        else {
            return this.estimateCpuTps({
                ghz: baseSpeed,
                threads: cores,
                paramsB: params,
                avx512: hasAVX512,
                isIrisXe: gpuModel.toLowerCase().includes('iris xe')
            });
        }
    }
    
    /**
     * Realistic CPU token per second estimation that varies significantly by model size
     */
    estimateCpuTps({ghz, threads, paramsB, avx512, isIrisXe}) {
        // Base coefficient chosen empirically for realistic results
        const k = avx512 ? 2.8 : 2.0;
        
        // Apply iGPU boost for Iris Xe
        const iGpuMultiplier = isIrisXe ? 1.25 : 1.0;
        
        // More aggressive scaling for larger models (they really slow down on CPU)
        const sizeScaling = Math.max(0.5, paramsB); // Linear scaling, larger models much slower
        
        // Calculate base TPS with realistic threading efficiency
        const effectiveThreads = Math.min(threads, 8); // Diminishing returns after 8 threads
        const baseTPS = (k * ghz * effectiveThreads * iGpuMultiplier) / sizeScaling;
        
        // Apply realistic upper bound for CPU (even with best CPUs)
        const maxCpuTPS = avx512 ? 40 : 30;
        const finalTPS = Math.min(maxCpuTPS, baseTPS);
        
        return Math.max(3, Math.round(finalTPS * 100) / 100);
    }

    estimateTTFB(hardware, model) {
        const sizeGB = this.parseModelSize(model.size);
        const loadTime = sizeGB * (hardware.gpu ? 50 : 100); // ms per GB
        return Math.max(200, loadTime);
    }

    checkArchitectureCompatibility(hardware, model) {
        // For now, assume all models are compatible
        // TODO: Add specific architecture checks
        return true;
    }

    checkBasicRequirements(hardware, model) {
        // Basic CPU/memory requirements
        const minRAM = model.requirements?.ram || 2;
        return hardware.memory.total >= minRAM;
    }

    generateReasoning(model, hardware, qualityScore, hardwareMatchScore) {
        const tier = this.getHardwareTier(hardware);
        const params = this.estimateModelParams(model);
        
        if (hardwareMatchScore >= 0.9) {
            return `Excellent match for your ${tier.replace('_', ' ')} hardware (${params.toFixed(1)}B params)`;
        } else if (hardwareMatchScore >= 0.6) {
            return `Good fit for your system with quality score ${(qualityScore * 100).toFixed(0)}%`;
        } else {
            return `Suboptimal - model ${params < 3 ? 'underutilizes' : 'may strain'} your hardware`;
        }
    }
}

module.exports = MultiObjectiveSelector;