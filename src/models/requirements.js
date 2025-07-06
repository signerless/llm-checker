class RequirementsCalculator {
    constructor() {
        this.baseRequirements = this.initializeBaseRequirements();
        this.quantizationMultipliers = this.initializeQuantizationMultipliers();
        this.frameworkOverheads = this.initializeFrameworkOverheads();
    }

    initializeBaseRequirements() {
        return {
            // Base requirements per billion parameters
            ramPerBillion: 2.0,    // GB RAM per billion parameters (FP16)
            vramPerBillion: 1.5,   // GB VRAM per billion parameters
            cpuCoresBase: 2,       // Minimum CPU cores
            storageMultiplier: 1.1, // Storage overhead factor

            // Context window impact
            contextImpact: {
                '2K': 1.0,
                '4K': 1.1,
                '8K': 1.2,
                '16K': 1.4,
                '32K': 1.6,
                '64K': 1.8,
                '128K': 2.0,
                '200K': 2.5
            },

            // Model architecture impact
            architectureMultipliers: {
                'transformer': 1.0,
                'mixture_of_experts': 0.7, // More efficient due to sparse activation
                'state_space': 0.8,
                'retrieval_augmented': 1.3
            }
        };
    }

    initializeQuantizationMultipliers() {
        return {
            'FP32': { ram: 1.0, vram: 1.0, quality: 1.0, speed: 0.8 },
            'FP16': { ram: 0.5, vram: 0.5, quality: 0.99, speed: 1.0 },
            'BF16': { ram: 0.5, vram: 0.5, quality: 0.995, speed: 1.0 },
            'INT8': { ram: 0.25, vram: 0.25, quality: 0.95, speed: 1.2 },
            'Q8_0': { ram: 0.25, vram: 0.25, quality: 0.97, speed: 1.1 },
            'Q6_K': { ram: 0.19, vram: 0.19, quality: 0.94, speed: 1.15 },
            'Q5_K_M': { ram: 0.16, vram: 0.16, quality: 0.92, speed: 1.2 },
            'Q5_0': { ram: 0.16, vram: 0.16, quality: 0.90, speed: 1.2 },
            'Q4_K_M': { ram: 0.125, vram: 0.125, quality: 0.88, speed: 1.3 },
            'Q4_0': { ram: 0.125, vram: 0.125, quality: 0.85, speed: 1.3 },
            'Q3_K_M': { ram: 0.09, vram: 0.09, quality: 0.80, speed: 1.4 },
            'Q2_K': { ram: 0.06, vram: 0.06, quality: 0.70, speed: 1.5 }
        };
    }

    initializeFrameworkOverheads() {
        return {
            'ollama': { ram: 0.5, vram: 0.2, cpu: 0.1 },
            'llama.cpp': { ram: 0.3, vram: 0.1, cpu: 0.05 },
            'transformers': { ram: 1.0, vram: 0.5, cpu: 0.2 },
            'vllm': { ram: 0.8, vram: 0.3, cpu: 0.15 },
            'mlx': { ram: 0.4, vram: 0, cpu: 0.1 }, // Apple Silicon unified memory
            'tensorrt': { ram: 0.6, vram: 0.4, cpu: 0.1 }
        };
    }

    calculateModelRequirements(modelConfig) {
        const {
            name,
            size,
            architecture = 'transformer',
            contextLength = 4096,
            quantization = 'FP16',
            framework = 'ollama',
            specialization
        } = modelConfig;

        // Parse model size
        const sizeInBillions = this.parseModelSize(size);

        // Get base requirements
        let baseRAM = sizeInBillions * this.baseRequirements.ramPerBillion;
        let baseVRAM = sizeInBillions * this.baseRequirements.vramPerBillion;
        let baseCPUCores = Math.max(
            this.baseRequirements.cpuCoresBase,
            Math.ceil(sizeInBillions / 2)
        );
        let baseStorage = sizeInBillions * this.baseRequirements.storageMultiplier;

        // Apply architecture multiplier
        const archMultiplier = this.baseRequirements.architectureMultipliers[architecture] || 1.0;
        baseRAM *= archMultiplier;
        baseVRAM *= archMultiplier;

        // Apply context length impact
        const contextMultiplier = this.getContextMultiplier(contextLength);
        baseRAM *= contextMultiplier;

        // Apply quantization
        const quantMultiplier = this.quantizationMultipliers[quantization] || this.quantizationMultipliers['FP16'];
        baseRAM *= quantMultiplier.ram;
        baseVRAM *= quantMultiplier.vram;

        // Apply framework overhead
        const frameworkOverhead = this.frameworkOverheads[framework] || this.frameworkOverheads['ollama'];
        baseRAM += frameworkOverhead.ram;
        baseVRAM += frameworkOverhead.vram;
        baseCPUCores = Math.ceil(baseCPUCores * (1 + frameworkOverhead.cpu));

        // Specialization adjustments
        if (specialization === 'multimodal') {
            baseRAM *= 1.3;
            baseVRAM *= 1.5;
            baseStorage *= 1.2;
        } else if (specialization === 'code') {
            baseRAM *= 1.1;
            baseCPUCores += 1;
        }

        // Round to reasonable values
        return {
            ram: Math.ceil(baseRAM),
            vram: Math.ceil(baseVRAM),
            cpu_cores: baseCPUCores,
            storage: Math.ceil(baseStorage),
            recommended_ram: Math.ceil(baseRAM * 1.5),
            recommended_vram: Math.ceil(baseVRAM * 1.3),
            quantization,
            framework,
            performance: {
                estimatedSpeed: this.estimateInferenceSpeed(sizeInBillions, quantization),
                qualityImpact: quantMultiplier.quality
            }
        };
    }

    parseModelSize(sizeString) {
        const normalized = sizeString.toLowerCase().replace(/[^0-9.kmb]/g, '');

        if (normalized.includes('k')) {
            return parseFloat(normalized.replace('k', '')) / 1000;
        } else if (normalized.includes('m')) {
            return parseFloat(normalized.replace('m', '')) / 1000;
        } else if (normalized.includes('b')) {
            return parseFloat(normalized.replace('b', ''));
        } else {
            return parseFloat(normalized);
        }
    }

    getContextMultiplier(contextLength) {
        if (contextLength >= 200000) return this.baseRequirements.contextImpact['200K'];
        if (contextLength >= 128000) return this.baseRequirements.contextImpact['128K'];
        if (contextLength >= 64000) return this.baseRequirements.contextImpact['64K'];
        if (contextLength >= 32000) return this.baseRequirements.contextImpact['32K'];
        if (contextLength >= 16000) return this.baseRequirements.contextImpact['16K'];
        if (contextLength >= 8000) return this.baseRequirements.contextImpact['8K'];
        if (contextLength >= 4000) return this.baseRequirements.contextImpact['4K'];
        return this.baseRequirements.contextImpact['2K'];
    }

    estimateInferenceSpeed(sizeInBillions, quantization) {
        // Base tokens per second for different model sizes
        let baseSpeed = 100 / Math.sqrt(sizeInBillions); // Rough approximation

        // Apply quantization speed multiplier
        const quantMultiplier = this.quantizationMultipliers[quantization] || this.quantizationMultipliers['FP16'];
        baseSpeed *= quantMultiplier.speed;

        return {
            cpuOnly: Math.round(baseSpeed * 0.3),
            withGPU: Math.round(baseSpeed),
            optimized: Math.round(baseSpeed * 1.5)
        };
    }

    getOptimalQuantization(hardware, targetModel) {
        const { memory, gpu } = hardware;
        const modelRequirements = this.calculateModelRequirements(targetModel);

        // Try different quantization levels from highest to lowest quality
        const quantizationLevels = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q4_0', 'Q3_K_M', 'Q2_K'];

        for (const quant of quantizationLevels) {
            const requirements = this.calculateModelRequirements({
                ...targetModel,
                quantization: quant
            });

            if (requirements.ram <= memory.total && requirements.vram <= gpu.vram) {
                return {
                    quantization: quant,
                    requirements,
                    qualityImpact: this.quantizationMultipliers[quant].quality,
                    fitsInMemory: true
                };
            }
        }

        return {
            quantization: 'Q2_K',
            requirements: this.calculateModelRequirements({
                ...targetModel,
                quantization: 'Q2_K'
            }),
            qualityImpact: this.quantizationMultipliers['Q2_K'].quality,
            fitsInMemory: false
        };
    }

    calculateBatchRequirements(models, hardware) {
        // Calculate requirements for running multiple models
        let totalRAM = 0;
        let totalVRAM = 0;
        let maxCPUCores = 0;
        let totalStorage = 0;

        const modelsWithRequirements = models.map(model => {
            const requirements = this.calculateModelRequirements(model);
            totalRAM += requirements.ram;
            totalVRAM += requirements.vram;
            maxCPUCores = Math.max(maxCPUCores, requirements.cpu_cores);
            totalStorage += requirements.storage;

            return {
                ...model,
                requirements
            };
        });

        return {
            models: modelsWithRequirements,
            total: {
                ram: totalRAM,
                vram: totalVRAM,
                cpu_cores: maxCPUCores,
                storage: totalStorage
            },
            canRunAll: totalRAM <= hardware.memory.total &&
                totalVRAM <= hardware.gpu.vram &&
                maxCPUCores <= hardware.cpu.cores,
            recommendations: this.generateBatchRecommendations(modelsWithRequirements, hardware)
        };
    }

    generateBatchRecommendations(models, hardware) {
        const recommendations = [];

        // Check if models can run simultaneously
        const totalRAM = models.reduce((sum, m) => sum + m.requirements.ram, 0);

        if (totalRAM > hardware.memory.total) {
            recommendations.push('Models cannot run simultaneously - consider model swapping');
            recommendations.push('Use ollama for automatic model management');
        }

        // Suggest optimization strategies
        if (models.length > 2) {
            recommendations.push('Consider using smaller variants for background models');
        }

        // Framework recommendations
        const hasLargeModels = models.some(m => parseFloat(m.size) > 10);
        if (hasLargeModels) {
            recommendations.push('Use vLLM for efficient batched inference');
        }

        return recommendations;
    }

    estimateLoadTime(model, hardware) {
        const sizeGB = this.parseModelSize(model.size);
        const { memory, gpu, cpu } = hardware;

        // Base load time factors
        let loadTimeSeconds = sizeGB * 2; // 2 seconds per GB baseline

        // Storage speed impact (assuming SSD)
        if (hardware.storage?.type === 'nvme') {
            loadTimeSeconds *= 0.5;
        } else if (hardware.storage?.type === 'ssd') {
            loadTimeSeconds *= 0.7;
        } else {
            loadTimeSeconds *= 1.5; // HDD penalty
        }

        // CPU impact
        if (cpu.cores >= 8) {
            loadTimeSeconds *= 0.8;
        } else if (cpu.cores <= 4) {
            loadTimeSeconds *= 1.2;
        }

        // GPU loading
        if (gpu.dedicated && gpu.vram >= sizeGB) {
            loadTimeSeconds *= 1.3; // GPU transfer overhead
        }

        return {
            estimated: Math.round(loadTimeSeconds),
            factors: {
                modelSize: sizeGB,
                storageType: hardware.storage?.type || 'unknown',
                cpuCores: cpu.cores,
                gpuTransfer: gpu.dedicated && gpu.vram >= sizeGB
            }
        };
    }
}

module.exports = RequirementsCalculator;