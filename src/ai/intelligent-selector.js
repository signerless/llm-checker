/**
 * Intelligent Model Selector - JavaScript-only mathematical model
 * Uses advanced heuristics and mathematical scoring for optimal model selection
 */

class IntelligentModelSelector {
    constructor() {
        this.modelDatabase = this.initializeModelDatabase();
        this.hardwareTiers = this.initializeHardwareTiers();
        this.performanceWeights = {
            memory_efficiency: 0.35,    // Most important - must fit in memory
            performance_match: 0.25,    // CPU/GPU capability match
            task_optimization: 0.20,    // Model specialization
            popularity_quality: 0.15,   // Community adoption & quality
            resource_efficiency: 0.05   // Power/thermal considerations
        };
    }

    initializeModelDatabase() {
        return {
            // Llama family
            'llama2:7b': {
                name: 'Llama 2 7B',
                size_gb: 3.8,
                parameters: 7,
                memory_requirement: 8,
                cpu_cores_min: 4,
                cpu_intensive: 0.7,
                specialization: ['general', 'chat', 'reasoning'],
                quality_score: 9.2,
                popularity_score: 9.8,
                context_length: 4096,
                quantization: 'Q4_0',
                inference_speed: 'medium'
            },
            'llama2:13b': {
                name: 'Llama 2 13B',
                size_gb: 7.3,
                parameters: 13,
                memory_requirement: 16,
                cpu_cores_min: 6,
                cpu_intensive: 0.8,
                specialization: ['general', 'chat', 'reasoning', 'complex'],
                quality_score: 9.5,
                popularity_score: 9.0,
                context_length: 4096,
                quantization: 'Q4_0',
                inference_speed: 'slow'
            },
            'llama2:70b': {
                name: 'Llama 2 70B',
                size_gb: 39,
                parameters: 70,
                memory_requirement: 48,
                cpu_cores_min: 8,
                cpu_intensive: 0.95,
                specialization: ['general', 'chat', 'reasoning', 'complex', 'professional'],
                quality_score: 9.8,
                popularity_score: 8.5,
                context_length: 4096,
                quantization: 'Q4_0',
                inference_speed: 'very_slow'
            },

            // Code Llama family
            'codellama:7b': {
                name: 'Code Llama 7B',
                size_gb: 3.8,
                parameters: 7,
                memory_requirement: 8,
                cpu_cores_min: 4,
                cpu_intensive: 0.7,
                specialization: ['coding', 'programming', 'debugging'],
                quality_score: 9.0,
                popularity_score: 8.8,
                context_length: 16384,
                quantization: 'Q4_0',
                inference_speed: 'medium'
            },
            'codellama:13b': {
                name: 'Code Llama 13B',
                size_gb: 7.3,
                parameters: 13,
                memory_requirement: 16,
                cpu_cores_min: 6,
                cpu_intensive: 0.8,
                specialization: ['coding', 'programming', 'debugging', 'complex'],
                quality_score: 9.3,
                popularity_score: 8.5,
                context_length: 16384,
                quantization: 'Q4_0',
                inference_speed: 'slow'
            },

            // Mistral family
            'mistral:7b': {
                name: 'Mistral 7B',
                size_gb: 4.1,
                parameters: 7.3,
                memory_requirement: 8,
                cpu_cores_min: 4,
                cpu_intensive: 0.6,
                specialization: ['general', 'chat', 'reasoning'],
                quality_score: 9.1,
                popularity_score: 9.2,
                context_length: 8192,
                quantization: 'Q4_0',
                inference_speed: 'fast'
            },

            // Phi family
            'phi3:mini': {
                name: 'Phi-3 Mini',
                size_gb: 2.3,
                parameters: 3.8,
                memory_requirement: 4,
                cpu_cores_min: 2,
                cpu_intensive: 0.4,
                specialization: ['general', 'chat', 'lightweight'],
                quality_score: 8.5,
                popularity_score: 8.0,
                context_length: 128000,
                quantization: 'Q4_0',
                inference_speed: 'very_fast'
            },
            'phi3:medium': {
                name: 'Phi-3 Medium',
                size_gb: 7.9,
                parameters: 14,
                memory_requirement: 16,
                cpu_cores_min: 4,
                cpu_intensive: 0.7,
                specialization: ['general', 'chat', 'reasoning'],
                quality_score: 8.8,
                popularity_score: 7.5,
                context_length: 128000,
                quantization: 'Q4_0',
                inference_speed: 'medium'
            },

            // Gemma family
            'gemma:2b': {
                name: 'Gemma 2B',
                size_gb: 1.4,
                parameters: 2,
                memory_requirement: 3,
                cpu_cores_min: 2,
                cpu_intensive: 0.3,
                specialization: ['general', 'chat', 'ultra_lightweight'],
                quality_score: 7.8,
                popularity_score: 7.0,
                context_length: 8192,
                quantization: 'Q4_0',
                inference_speed: 'very_fast'
            },
            'gemma:7b': {
                name: 'Gemma 7B',
                size_gb: 4.8,
                parameters: 8.5,
                memory_requirement: 10,
                cpu_cores_min: 4,
                cpu_intensive: 0.6,
                specialization: ['general', 'chat', 'reasoning'],
                quality_score: 8.7,
                popularity_score: 7.8,
                context_length: 8192,
                quantization: 'Q4_0',
                inference_speed: 'fast'
            },

            // Deepseek family
            'deepseek-coder:1.3b': {
                name: 'DeepSeek Coder 1.3B',
                size_gb: 0.8,
                parameters: 1.3,
                memory_requirement: 2,
                cpu_cores_min: 2,
                cpu_intensive: 0.3,
                specialization: ['coding', 'programming', 'ultra_lightweight'],
                quality_score: 8.2,
                popularity_score: 7.5,
                context_length: 16384,
                quantization: 'Q4_0',
                inference_speed: 'very_fast'
            },
            'deepseek-coder:6.7b': {
                name: 'DeepSeek Coder 6.7B',
                size_gb: 3.9,
                parameters: 6.7,
                memory_requirement: 8,
                cpu_cores_min: 4,
                cpu_intensive: 0.7,
                specialization: ['coding', 'programming', 'debugging'],
                quality_score: 9.0,
                popularity_score: 8.2,
                context_length: 16384,
                quantization: 'Q4_0',
                inference_speed: 'medium'
            },

            // Qwen family
            'qwen2:1.5b': {
                name: 'Qwen2 1.5B',
                size_gb: 0.9,
                parameters: 1.5,
                memory_requirement: 2,
                cpu_cores_min: 2,
                cpu_intensive: 0.3,
                specialization: ['general', 'chat', 'multilingual'],
                quality_score: 8.0,
                popularity_score: 7.2,
                context_length: 32768,
                quantization: 'Q4_0',
                inference_speed: 'very_fast'
            },
            'qwen2:7b': {
                name: 'Qwen2 7B',
                size_gb: 4.4,
                parameters: 7,
                memory_requirement: 8,
                cpu_cores_min: 4,
                cpu_intensive: 0.6,
                specialization: ['general', 'chat', 'multilingual', 'reasoning'],
                quality_score: 8.9,
                popularity_score: 8.0,
                context_length: 32768,
                quantization: 'Q4_0',
                inference_speed: 'fast'
            }
        };
    }

    initializeHardwareTiers() {
        return {
            memory: {
                ultra_low: { min: 0, max: 4, multiplier: 0.3 },
                low: { min: 4, max: 8, multiplier: 0.6 },
                medium: { min: 8, max: 16, multiplier: 1.0 },
                high: { min: 16, max: 32, multiplier: 1.4 },
                very_high: { min: 32, max: 64, multiplier: 1.8 },
                extreme: { min: 64, max: 128, multiplier: 2.2 }
            },
            cpu: {
                ultra_low: { min: 0, max: 2, multiplier: 0.4 },
                low: { min: 2, max: 4, multiplier: 0.7 },
                medium: { min: 4, max: 8, multiplier: 1.0 },
                high: { min: 8, max: 16, multiplier: 1.3 },
                very_high: { min: 16, max: 32, multiplier: 1.6 },
                extreme: { min: 32, max: 64, multiplier: 2.0 }
            },
            gpu: {
                none: { vram: 0, multiplier: 1.0 },
                integrated: { vram: 2, multiplier: 1.1 },
                low_vram: { vram: 4, multiplier: 1.3 },
                medium_vram: { vram: 8, multiplier: 1.6 },
                high_vram: { vram: 16, multiplier: 2.0 },
                very_high_vram: { vram: 24, multiplier: 2.4 }
            }
        };
    }

    analyzeHardware(hardware) {
        const analysis = {
            memory_tier: this.getHardwareTier('memory', hardware.total_ram_gb),
            cpu_tier: this.getHardwareTier('cpu', hardware.cpu_cores),
            gpu_tier: this.getGPUTier(hardware.gpu_vram_gb, hardware.gpu_model_normalized),
            available_memory: this.calculateAvailableMemory(hardware),
            performance_multiplier: this.calculatePerformanceMultiplier(hardware),
            thermal_constraint: this.estimateThermalConstraint(hardware)
        };

        analysis.overall_tier = this.calculateOverallTier(analysis);
        return analysis;
    }

    getHardwareTier(type, value) {
        const tiers = this.hardwareTiers[type];
        for (const [tierName, tierData] of Object.entries(tiers)) {
            if (value >= tierData.min && value <= tierData.max) {
                return { name: tierName, ...tierData };
            }
        }
        return { name: 'extreme', ...tiers.extreme };
    }

    getGPUTier(vram, gpuModel) {
        if (gpuModel === 'apple_silicon') {
            // Apple Silicon uses unified memory
            if (vram >= 24) return { name: 'very_high_vram', vram: vram, multiplier: 2.2 };
            if (vram >= 16) return { name: 'high_vram', vram: vram, multiplier: 1.8 };
            if (vram >= 8) return { name: 'medium_vram', vram: vram, multiplier: 1.5 };
            return { name: 'low_vram', vram: vram, multiplier: 1.2 };
        }

        if (vram <= 0) return { name: 'none', vram: 0, multiplier: 1.0 };
        if (vram <= 4) return { name: 'low_vram', vram: vram, multiplier: 1.3 };
        if (vram <= 8) return { name: 'medium_vram', vram: vram, multiplier: 1.6 };
        if (vram <= 16) return { name: 'high_vram', vram: vram, multiplier: 2.0 };
        return { name: 'very_high_vram', vram: vram, multiplier: 2.4 };
    }

    calculateAvailableMemory(hardware) {
        let availableRAM = hardware.total_ram_gb * 0.7; // Reserve 30% for OS
        let availableVRAM = hardware.gpu_vram_gb * 0.9; // Reserve 10% for GPU overhead

        // Apple Silicon unified memory calculation
        if (hardware.gpu_model_normalized === 'apple_silicon') {
            availableVRAM = hardware.total_ram_gb * 0.6; // 60% can be used for models
            availableRAM = hardware.total_ram_gb * 0.4;  // Remaining for system
        }

        return {
            ram: availableRAM,
            vram: availableVRAM,
            total: Math.max(availableRAM, availableVRAM)
        };
    }

    calculatePerformanceMultiplier(hardware) {
        let multiplier = 1.0;

        // CPU frequency boost
        if (hardware.cpu_freq_max > 3.5) multiplier *= 1.2;
        else if (hardware.cpu_freq_max > 3.0) multiplier *= 1.1;
        else if (hardware.cpu_freq_max < 2.0) multiplier *= 0.9;

        // Architecture boost
        if (hardware.gpu_model_normalized === 'apple_silicon') multiplier *= 1.15;
        if (hardware.gpu_model_normalized.includes('rtx_40')) multiplier *= 1.3;
        if (hardware.gpu_model_normalized.includes('rtx_30')) multiplier *= 1.2;

        return multiplier;
    }

    estimateThermalConstraint(hardware) {
        // Laptop vs Desktop heuristic
        if (hardware.cpu_cores <= 4 && hardware.total_ram_gb <= 16) {
            return 0.8; // Likely laptop - thermal constraints
        }
        if (hardware.cpu_cores >= 12 || hardware.total_ram_gb >= 32) {
            return 1.2; // Likely desktop/workstation - better cooling
        }
        return 1.0; // Neutral
    }

    calculateOverallTier(analysis) {
        const memoryScore = analysis.memory_tier.multiplier;
        const cpuScore = analysis.cpu_tier.multiplier;
        const gpuScore = analysis.gpu_tier.multiplier;

        const weightedScore = (memoryScore * 0.4) + (cpuScore * 0.3) + (gpuScore * 0.3);

        if (weightedScore >= 2.0) return 'extreme';
        if (weightedScore >= 1.6) return 'very_high';
        if (weightedScore >= 1.2) return 'high';
        if (weightedScore >= 0.8) return 'medium';
        if (weightedScore >= 0.5) return 'low';
        return 'ultra_low';
    }

    calculateModelScore(model, hardware, analysis, userPreference = 'general') {
        const scores = {
            memory_efficiency: this.calculateMemoryEfficiencyScore(model, analysis),
            performance_match: this.calculatePerformanceMatchScore(model, analysis),
            task_optimization: this.calculateTaskOptimizationScore(model, userPreference),
            popularity_quality: this.calculatePopularityQualityScore(model),
            resource_efficiency: this.calculateResourceEfficiencyScore(model, analysis)
        };

        // Apply penalties for problematic configurations
        const penalties = this.calculatePenalties(model, hardware, analysis);

        // Calculate weighted final score
        let finalScore = 0;
        for (const [factor, weight] of Object.entries(this.performanceWeights)) {
            finalScore += scores[factor] * weight;
        }

        // Apply penalties
        finalScore *= (1 - penalties);

        // Normalize to 0-100 scale
        return Math.max(0, Math.min(100, finalScore * 100));
    }

    calculateMemoryEfficiencyScore(model, analysis) {
        const requiredMemory = model.memory_requirement;
        const availableMemory = analysis.available_memory.total;

        if (requiredMemory > availableMemory) {
            // Model won't fit - severe penalty
            return 0.1;
        }

        // Calculate efficiency ratio
        const utilizationRatio = requiredMemory / availableMemory;

        if (utilizationRatio <= 0.3) return 0.6; // Under-utilizing
        if (utilizationRatio <= 0.5) return 0.8; // Good utilization
        if (utilizationRatio <= 0.7) return 1.0; // Optimal utilization
        if (utilizationRatio <= 0.9) return 0.9; // High utilization
        return 0.7; // Very tight fit
    }

    calculatePerformanceMatchScore(model, analysis) {
        const cpuMatch = Math.min(1.0, analysis.cpu_tier.multiplier * model.cpu_intensive);
        const memoryMatch = analysis.memory_tier.multiplier / 2.0;
        const gpuBoost = analysis.gpu_tier.multiplier > 1.0 ? 0.2 : 0;

        return Math.min(1.0, cpuMatch + memoryMatch + gpuBoost);
    }

    calculateTaskOptimizationScore(model, userPreference) {
        if (!model.specialization.includes(userPreference)) {
            // Check for compatible tasks
            const compatibleTasks = {
                'coding': ['programming', 'debugging'],
                'general': ['chat', 'reasoning'],
                'chat': ['general', 'reasoning']
            };

            const compatible = compatibleTasks[userPreference] || [];
            const hasCompatible = compatible.some(task => model.specialization.includes(task));

            return hasCompatible ? 0.7 : 0.5;
        }

        return 1.0; // Perfect match
    }

    calculatePopularityQualityScore(model) {
        const qualityNormalized = model.quality_score / 10.0;
        const popularityNormalized = model.popularity_score / 10.0;

        return (qualityNormalized * 0.6) + (popularityNormalized * 0.4);
    }

    calculateResourceEfficiencyScore(model, analysis) {
        // Favor models that don't waste resources
        const efficiencyFactors = {
            inference_speed: {
                'very_fast': 1.0,
                'fast': 0.9,
                'medium': 0.8,
                'slow': 0.6,
                'very_slow': 0.4
            }
        };

        const speedScore = efficiencyFactors.inference_speed[model.inference_speed] || 0.8;
        const thermalScore = analysis.thermal_constraint;

        return (speedScore * 0.7) + (thermalScore * 0.3);
    }

    calculatePenalties(model, hardware, analysis) {
        let totalPenalty = 0;

        // Memory overflow penalty
        if (model.memory_requirement > analysis.available_memory.total) {
            totalPenalty += 0.8; // Severe penalty
        }

        // CPU insufficient penalty
        if (hardware.cpu_cores < model.cpu_cores_min) {
            totalPenalty += 0.3;
        }

        // Thermal throttling penalty
        if (model.cpu_intensive > 0.8 && analysis.thermal_constraint < 1.0) {
            totalPenalty += 0.2;
        }

        return Math.min(0.9, totalPenalty); // Cap penalty at 90%
    }

    selectBestModels(hardware, availableModels, userPreference = 'general', topK = 5) {
        const analysis = this.analyzeHardware(hardware);
        const modelScores = [];

        // Get model info for each available model
        for (const modelId of availableModels) {
            const modelInfo = this.getModelInfo(modelId);
            if (!modelInfo) continue;

            const score = this.calculateModelScore(modelInfo, hardware, analysis, userPreference);
            
            modelScores.push({
                modelId,
                modelInfo,
                score,
                confidence: this.calculateConfidence(score, analysis),
                reasoning: this.generateReasoning(modelInfo, hardware, analysis, score)
            });
        }

        // Sort by score and return top K
        modelScores.sort((a, b) => b.score - a.score);

        return {
            hardware_analysis: analysis,
            recommendations: modelScores.slice(0, topK),
            best_model: modelScores[0],
            selection_method: 'intelligent_mathematical'
        };
    }

    getModelInfo(modelId) {
        // Direct match
        if (this.modelDatabase[modelId]) {
            return { ...this.modelDatabase[modelId], id: modelId };
        }

        // Fuzzy matching for variations
        const normalizedId = modelId.toLowerCase().replace(/[:\-_]/g, '');
        
        for (const [dbId, modelData] of Object.entries(this.modelDatabase)) {
            const normalizedDbId = dbId.toLowerCase().replace(/[:\-_]/g, '');
            if (normalizedId.includes(normalizedDbId) || normalizedDbId.includes(normalizedId)) {
                return { ...modelData, id: modelId };
            }
        }

        // Fallback - estimate from model name
        return this.estimateModelInfo(modelId);
    }

    estimateModelInfo(modelId) {
        const sizeMatch = modelId.match(/(\d+\.?\d*)([kmb])/i);
        let size = 7; // Default size

        if (sizeMatch) {
            const num = parseFloat(sizeMatch[1]);
            const unit = sizeMatch[2].toLowerCase();
            
            if (unit === 'k') size = num / 1000;
            else if (unit === 'm') size = num / 1000;
            else if (unit === 'b') size = num;
        }

        return {
            id: modelId,
            name: modelId,
            size_gb: size * 0.55, // Rough estimation
            parameters: size,
            memory_requirement: size * 1.2,
            cpu_cores_min: Math.max(2, Math.floor(size / 3)),
            cpu_intensive: Math.min(0.9, 0.3 + (size / 50)),
            specialization: ['general'],
            quality_score: 7.5,
            popularity_score: 6.0,
            context_length: 4096,
            quantization: 'Q4_0',
            inference_speed: size > 13 ? 'slow' : size > 7 ? 'medium' : 'fast'
        };
    }

    calculateConfidence(score, analysis) {
        let confidence = score / 100;

        // Boost confidence for well-understood hardware
        if (analysis.overall_tier !== 'ultra_low') {
            confidence *= 1.1;
        }

        // Reduce confidence for edge cases
        if (analysis.available_memory.total < 4) {
            confidence *= 0.8;
        }

        return Math.min(1.0, confidence);
    }

    generateReasoning(modelInfo, hardware, analysis, score) {
        const reasons = [];

        if (score >= 80) {
            reasons.push(`Excellent fit for your ${analysis.overall_tier} hardware configuration`);
        } else if (score >= 60) {
            reasons.push(`Good match for your system capabilities`);
        } else {
            reasons.push(`Adequate choice given hardware constraints`);
        }

        // Memory reasoning
        const memoryUtilization = modelInfo.memory_requirement / analysis.available_memory.total;
        if (memoryUtilization <= 0.5) {
            reasons.push(`Efficient memory usage (${Math.round(memoryUtilization * 100)}% of available)`);
        } else if (memoryUtilization <= 0.8) {
            reasons.push(`Optimal memory utilization`);
        } else {
            reasons.push(`High memory usage - may impact system performance`);
        }

        // Performance reasoning
        if (hardware.cpu_cores >= modelInfo.cpu_cores_min * 1.5) {
            reasons.push(`CPU well-suited for this model`);
        } else if (hardware.cpu_cores >= modelInfo.cpu_cores_min) {
            reasons.push(`CPU meets minimum requirements`);
        } else {
            reasons.push(`CPU may be limiting factor`);
        }

        // Quality reasoning
        if (modelInfo.quality_score >= 9.0) {
            reasons.push(`High-quality model with excellent capabilities`);
        } else if (modelInfo.quality_score >= 8.0) {
            reasons.push(`Well-regarded model with good performance`);
        }

        return reasons.join('. ') + '.';
    }
}

module.exports = IntelligentModelSelector;