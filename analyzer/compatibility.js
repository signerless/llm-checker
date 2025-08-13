const { getLogger } = require('../src/utils/logger');

class CompatibilityAnalyzer {
    constructor() {
        this.compatibilityThresholds = {
            excellent: 90,
            good: 75,
            marginal: 60,
            poor: 40,
            incompatible: 0
        };

        this.logger = getLogger().createChild('CompatibilityAnalyzer');

        this.ollamaOptimizations = {
            quantizationBonuses: {
                'Q2_K': 0.4,
                'Q3_K_M': 0.5,
                'Q4_0': 0.6,
                'Q4_K_M': 0.7,
                'Q5_0': 0.8,
                'Q5_K_M': 0.85,
                'Q6_K': 0.9,
                'Q8_0': 0.95
            },
            hardwareOptimizations: {
                'Apple Silicon': {
                    metalBonus: 1.15,
                    unifiedMemoryBonus: 1.1
                },
                'x86_64': {
                    avxBonus: 1.05,
                    vectorBonus: 1.02
                }
            }
        };
    }

    analyzeCompatibility(hardware, models, options = {}) {
        this.logger.info('Starting compatibility analysis', {
            data: {
                modelCount: models.length,
                hardwareTier: this.getHardwareTier(hardware),
                includeOllama: options.includeOllamaOptimizations !== false
            }
        });

        const results = {
            compatible: [],
            marginal: [],
            incompatible: [],
            recommendations: []
        };

        models.forEach(model => {
            const compatibility = this.calculateModelCompatibility(hardware, model, options);
            const enrichedModel = {
                ...model,
                score: compatibility.score,
                issues: compatibility.issues,
                notes: compatibility.notes,
                recommendations: compatibility.modelSpecificRecommendations
            };

            if (compatibility.score >= this.compatibilityThresholds.good) {
                results.compatible.push(enrichedModel);
            } else if (compatibility.score >= this.compatibilityThresholds.marginal) {
                results.marginal.push(enrichedModel);
            } else {
                results.incompatible.push(enrichedModel);
            }

            this.logger.debug(`Model compatibility: ${model.name} - Score: ${compatibility.score}`);
        });

        results.compatible.sort((a, b) => b.score - a.score);
        results.marginal.sort((a, b) => b.score - a.score);
        results.incompatible.sort((a, b) => b.score - a.score);

        results.recommendations = this.generateRecommendations(hardware, results, options);

        this.logger.info('Compatibility analysis completed', {
            data: {
                compatible: results.compatible.length,
                marginal: results.marginal.length,
                incompatible: results.incompatible.length
            }
        });

        return results;
    }

    calculateModelCompatibility(hardware, model, options = {}) {
        if (model.type === 'cloud') {
            return {
                score: 100,
                issues: [],
                notes: ['Requires internet connection and API key'],
                modelSpecificRecommendations: ['Ensure stable internet connection', 'Configure API key']
            };
        }

        let score = 100;
        const issues = [];
        const notes = [];
        const modelSpecificRecommendations = [];

        const ramAnalysis = this.analyzeRAMCompatibility(hardware.memory, model.requirements);
        score *= ramAnalysis.factor;
        issues.push(...ramAnalysis.issues);
        notes.push(...ramAnalysis.notes);

        const gpuAnalysis = this.analyzeGPUCompatibility(hardware.gpu, model.requirements);
        score *= gpuAnalysis.factor;
        issues.push(...gpuAnalysis.issues);
        notes.push(...gpuAnalysis.notes);

        const cpuAnalysis = this.analyzeCPUCompatibility(hardware.cpu, model.requirements);
        score *= cpuAnalysis.factor;
        issues.push(...cpuAnalysis.issues);
        notes.push(...cpuAnalysis.notes);

        const archAnalysis = this.analyzeArchitectureOptimizations(hardware, model);
        score *= archAnalysis.factor;
        notes.push(...archAnalysis.notes);

        const quantAnalysis = this.analyzeQuantizationOptions(model, hardware);
        score *= quantAnalysis.factor;
        notes.push(...quantAnalysis.notes);
        modelSpecificRecommendations.push(...quantAnalysis.recommendations);

        if (options.includeOllamaOptimizations !== false && model.frameworks?.includes('ollama')) {
            const ollamaAnalysis = this.analyzeOllamaOptimizations(hardware, model);
            score *= ollamaAnalysis.factor;
            notes.push(...ollamaAnalysis.notes);
            modelSpecificRecommendations.push(...ollamaAnalysis.recommendations);
        }

        const edgeAnalysis = this.analyzeEdgeCases(hardware, model);
        score *= edgeAnalysis.factor;
        if (edgeAnalysis.warning) {
            issues.push(edgeAnalysis.warning);
        }

        // NEW: Penalize models that underutilize high-end hardware
        const sizeMatchAnalysis = this.analyzeHardwareSizeMatch(hardware, model);
        score *= sizeMatchAnalysis.factor;
        notes.push(...sizeMatchAnalysis.notes);

        return {
            score: Math.round(Math.max(0, Math.min(100, score))),
            issues: issues.filter(Boolean),
            notes: notes.filter(Boolean),
            modelSpecificRecommendations: modelSpecificRecommendations.filter(Boolean)
        };
    }

    analyzeRAMCompatibility(memory, requirements) {
        const analysis = { factor: 1.0, issues: [], notes: [] };
        const totalRAM = memory.total;
        const availableRAM = memory.free; // Solo para mostrar info, no para lógica
        const requiredRAM = requirements.ram;
        const recommendedRAM = requirements.recommended_ram || requiredRAM * 1.5;

        if (totalRAM < requiredRAM) {
            analysis.factor = 0.1;
            analysis.issues.push(`Critical: ${totalRAM}GB total RAM < ${requiredRAM}GB required`);
        } else if (totalRAM < recommendedRAM) {
            analysis.factor = 0.75;
            analysis.notes.push(`Consider upgrading to ${recommendedRAM}GB for optimal performance`);
        } else {
            analysis.factor = 1.0;
            analysis.notes.push('✅ RAM requirements fully satisfied');


            if (totalRAM >= recommendedRAM * 2) {
                analysis.factor = 1.05;
                analysis.notes.push('Abundant RAM allows multiple models simultaneously');
            }
        }

        // Informational note about current memory usage (not affecting compatibility score)
        if (totalRAM >= requiredRAM && availableRAM < requiredRAM) {
            analysis.notes.push(`Info: Currently ${availableRAM}GB free RAM - you may need to close other applications before running this model`);
        }

        return analysis;
    }

    analyzeGPUCompatibility(gpu, requirements) {
        const analysis = { factor: 1.0, issues: [], notes: [] };
        const availableVRAM = gpu.vram || 0;
        const requiredVRAM = requirements.vram || 0;

        if (requiredVRAM === 0) {
            analysis.notes.push('Model runs on CPU - GPU not required');
            return analysis;
        }

        if (!gpu.dedicated && requiredVRAM > 0) {
            analysis.factor = 0.6;
            analysis.notes.push('⚠️ Integrated GPU - consider CPU-only mode');
        }

        if (availableVRAM < requiredVRAM) {
            if (requiredVRAM <= 4) {
                analysis.factor = 0.3;
                analysis.issues.push(`Low VRAM: ${availableVRAM}GB < ${requiredVRAM}GB required`);
                analysis.notes.push('💡 Model will fallback to CPU (slower)');
            } else {
                analysis.factor = 0.1;
                analysis.issues.push(`Critical VRAM shortage: ${availableVRAM}GB << ${requiredVRAM}GB`);
                analysis.notes.push('🔧 Use heavy quantization or CPU-only mode');
            }
        } else {
            analysis.factor = 1.0;
            analysis.notes.push('✅ VRAM requirements satisfied');

            if (availableVRAM >= requiredVRAM * 2) {
                analysis.factor = 1.1;
                analysis.notes.push('🎮 Excellent VRAM headroom for acceleration');
            }
        }

        if (gpu.vendor === 'NVIDIA' && gpu.dedicated) {
            analysis.factor *= 1.05;
            analysis.notes.push('🟢 NVIDIA GPU - excellent CUDA support');
        } else if (gpu.vendor === 'AMD' && gpu.dedicated) {
            analysis.factor *= 1.02;
            analysis.notes.push('🔴 AMD GPU - ROCm support available');
        }

        return analysis;
    }

    analyzeCPUCompatibility(cpu, requirements) {
        const analysis = { factor: 1.0, issues: [], notes: [] };
        const cores = cpu.cores;
        const requiredCores = requirements.cpu_cores || 4;
        const cpuSpeed = cpu.speedMax || cpu.speed || 2.0;

        if (cores < requiredCores) {
            analysis.factor = Math.max(0.5, cores / requiredCores);
            analysis.issues.push(`Limited cores: ${cores} available, ${requiredCores} recommended`);
        } else if (cores >= requiredCores * 2) {
            analysis.factor = 1.05;
            analysis.notes.push('Abundant CPU cores for parallel processing');
        }

        if (cpuSpeed >= 3.5) {
            analysis.factor *= 1.1;
            analysis.notes.push('High CPU speed boosts inference performance');
        } else if (cpuSpeed < 2.0) {
            analysis.factor *= 0.85;
            analysis.notes.push('⚠️ Low CPU speed may impact performance');
        }

        if (cpu.score) {
            if (cpu.score >= 80) {
                analysis.factor *= 1.05;
                analysis.notes.push('💪 High-performance CPU detected');
            } else if (cpu.score < 40) {
                analysis.factor *= 0.9;
                analysis.notes.push('🐌 CPU performance may be limiting factor');
            }
        }

        return analysis;
    }

    analyzeArchitectureOptimizations(hardware, model) {
        const analysis = { factor: 1.0, notes: [] };
        const arch = hardware.cpu.architecture;

        switch (arch) {
            case 'Apple Silicon':
                if (model.frameworks?.includes('llama.cpp')) {
                    analysis.factor = this.ollamaOptimizations.hardwareOptimizations['Apple Silicon'].metalBonus;
                    analysis.notes.push('Apple Silicon with Metal acceleration');
                }

                if (model.requirements?.vram === 0) {
                    analysis.factor *= this.ollamaOptimizations.hardwareOptimizations['Apple Silicon'].unifiedMemoryBonus;
                    analysis.notes.push('🔄 Unified memory architecture advantage');
                }
                break;

            case 'x86_64':
                if (hardware.cpu.features?.includes('AVX2')) {
                    analysis.factor = this.ollamaOptimizations.hardwareOptimizations['x86_64'].avxBonus;
                    analysis.notes.push('🏃‍♂️ AVX2 vector optimizations available');
                }
                break;

            case 'ARM64':
                analysis.factor = 0.95;
                analysis.notes.push('🔧 ARM64 - good efficiency, some optimizations available');
                break;

            default:
                analysis.notes.push('❓ Unknown architecture - performance may vary');
        }

        return analysis;
    }

    analyzeQuantizationOptions(model, hardware) {
        const analysis = { factor: 1.0, notes: [], recommendations: [] };

        if (!model.quantization || model.quantization.length === 0) {
            return analysis;
        }

        const totalRAM = hardware.memory.total;
        const vram = hardware.gpu.vram || 0;

        let recommendedQuant = null;
        let quantBonus = 1.0;

        if (totalRAM >= 32 && vram >= 16) {
            if (model.quantization.includes('Q8_0')) {
                recommendedQuant = 'Q8_0';
                quantBonus = this.ollamaOptimizations.quantizationBonuses['Q8_0'];
                analysis.recommendations.push('Use Q8_0 for highest quality');
            } else if (model.quantization.includes('Q6_K')) {
                recommendedQuant = 'Q6_K';
                quantBonus = this.ollamaOptimizations.quantizationBonuses['Q6_K'];
                analysis.recommendations.push('Use Q6_K for excellent quality');
            }
        } else if (totalRAM >= 16 && vram >= 8) {
            if (model.quantization.includes('Q5_K_M')) {
                recommendedQuant = 'Q5_K_M';
                quantBonus = this.ollamaOptimizations.quantizationBonuses['Q5_K_M'];
                analysis.recommendations.push('Use Q5_K_M for good quality balance');
            } else if (model.quantization.includes('Q4_K_M')) {
                recommendedQuant = 'Q4_K_M';
                quantBonus = this.ollamaOptimizations.quantizationBonuses['Q4_K_M'];
                analysis.recommendations.push('Use Q4_K_M for balanced performance');
            }
        } else if (totalRAM >= 8) {
            if (model.quantization.includes('Q4_0')) {
                recommendedQuant = 'Q4_0';
                quantBonus = this.ollamaOptimizations.quantizationBonuses['Q4_0'];
                analysis.recommendations.push('Use Q4_0 for your hardware tier');
            } else if (model.quantization.includes('Q3_K_M')) {
                recommendedQuant = 'Q3_K_M';
                quantBonus = this.ollamaOptimizations.quantizationBonuses['Q3_K_M'];
                analysis.recommendations.push('Use Q3_K_M to reduce memory usage');
            }
        } else {
            if (model.quantization.includes('Q2_K')) {
                recommendedQuant = 'Q2_K';
                quantBonus = this.ollamaOptimizations.quantizationBonuses['Q2_K'];
                analysis.recommendations.push('Use Q2_K for minimal memory usage');
            }
        }

        if (recommendedQuant) {
            analysis.factor = quantBonus;
            analysis.notes.push(`Recommended quantization: ${recommendedQuant}`);
        } else {
            analysis.notes.push('⚠️ Limited quantization options for your hardware');
        }

        return analysis;
    }

    analyzeOllamaOptimizations(hardware, model) {
        const analysis = { factor: 1.0, notes: [], recommendations: [] };

        if (!model.frameworks?.includes('ollama')) {
            return analysis;
        }

        analysis.factor = 1.05;
        analysis.notes.push('Native Ollama support');

        if (model.name.includes('Llama')) {
            analysis.factor *= 1.02;
            analysis.notes.push('Llama models are well-optimized in Ollama');
        }

        if (model.name.includes('Mistral')) {
            analysis.factor *= 1.02;
            analysis.notes.push('Mistral models have excellent Ollama integration');
        }

        if (hardware.gpu.dedicated && hardware.gpu.vram >= 8) {
            analysis.recommendations.push('Enable GPU acceleration in Ollama');
        }

        if (hardware.cpu.architecture === 'Apple Silicon') {
            analysis.recommendations.push('Ollama will use Metal acceleration automatically');
        }

        analysis.recommendations.push('Use ollama run for interactive sessions');
        analysis.recommendations.push('Monitor with ollama ps for resource usage');

        return analysis;
    }

    analyzeEdgeCases(hardware, model) {
        const analysis = { factor: 1.0, warning: null };

        const modelSizeGB = this.parseModelSize(model.size);
        if (modelSizeGB > hardware.memory.total * 0.8) {
            analysis.factor = 0.2;
            analysis.warning = `Model size (${modelSizeGB}GB) near total RAM limit`;
        }

        if (hardware.cpu.year && hardware.cpu.year < 2015) {
            analysis.factor *= 0.8;
            analysis.warning = 'Very old CPU may have compatibility issues';
        }

        if (hardware.memory.usagePercent > 90) {
            analysis.factor *= 0.6;
            analysis.warning = 'Very high memory usage - close applications first';
        }

        return analysis;
    }

    parseModelSize(sizeString) {
        const match = sizeString.match(/(\d+\.?\d*)[BM]/i);
        if (!match) return 1;

        const num = parseFloat(match[1]);
        const unit = match[0].slice(-1).toUpperCase();

        return unit === 'B' ? num : num / 1000;
    }

    getHardwareTier(hardware) {
        // Special handling for Apple Silicon with unified memory
        if (hardware.cpu.architecture === 'Apple Silicon' && hardware.gpu.model && hardware.gpu.model.toLowerCase().includes('apple')) {
            if (hardware.memory.total >= 64) return 'ultra_high';
            if (hardware.memory.total >= 32) return 'high';
            if (hardware.memory.total >= 16) return 'medium';
            if (hardware.memory.total >= 8) return 'low';
            return 'ultra_low';
        }
        
        // Traditional dedicated VRAM-based classification
        if (hardware.memory.total >= 64 && hardware.gpu.vram >= 32) return 'ultra_high';
        if (hardware.memory.total >= 32 && hardware.gpu.vram >= 16) return 'high';
        if (hardware.memory.total >= 16 && hardware.gpu.vram >= 8) return 'medium';
        if (hardware.memory.total >= 8) return 'low';
        return 'ultra_low';
    }

    generateRecommendations(hardware, results, options = {}) {
        const recommendations = [];
        const tier = this.getHardwareTier(hardware);

        if (hardware.memory.total < 16) {
            recommendations.push('💾 Upgrade to 16GB+ RAM for better compatibility');
        }

        if (!hardware.gpu.dedicated && hardware.memory.total >= 16) {
            recommendations.push('🎮 Consider dedicated GPU for significant speedup');
        }

        if (results.compatible.length === 0) {
            recommendations.push('🔧 No compatible models - try ultra-small models like TinyLlama');
            recommendations.push('☁️ Consider cloud-based models for complex tasks');
        } else if (results.compatible.length < 3) {
            recommendations.push('📈 Limited options - hardware upgrade recommended');
        }

        switch (tier) {
            case 'ultra_low':
                recommendations.push('🐣 Focus on ultra-small models (0.5B-1B parameters)');
                recommendations.push('🔧 Use Q2_K quantization for minimum memory usage');
                break;

            case 'low':
                recommendations.push('Small models (1B-3B) work well on your system');
                recommendations.push('Use Q4_0 quantization for good balance');
                break;

            case 'medium':
                recommendations.push('Medium models (3B-8B) are ideal for your hardware');
                recommendations.push('Use Q5_K_M for high quality');
                break;

            case 'high':
                recommendations.push('Large models (8B-30B) run excellently');
                recommendations.push('Use Q6_K or Q8_0 for maximum quality');
                break;

            case 'ultra_high':
                recommendations.push('Any model size supported - try the largest available');
                recommendations.push('Consider running multiple models simultaneously');
                break;
        }

        if (options.includeOllamaOptimizations !== false) {
            recommendations.push('Install Ollama for easy model management');

            if (hardware.cpu.architecture === 'Apple Silicon') {
                recommendations.push('Ollama will use Metal acceleration automatically');
            }

            if (results.compatible.length > 0) {
                const topModel = results.compatible[0];
                const ollamaCmd = this.getOllamaCommand(topModel.name);
                if (ollamaCmd) {
                    recommendations.push(`Try: ${ollamaCmd}`);
                }
            }
        }

        return recommendations;
    }

    getOllamaCommand(modelName) {
        const mapping = {
            'TinyLlama 1.1B': 'ollama pull tinyllama:1.1b',
            'Qwen 0.5B': 'ollama pull qwen:0.5b',
            'Gemma 2B': 'ollama pull gemma2:2b',
            'Phi-3 Mini 3.8B': 'ollama pull phi3:mini',
            'Llama 3.2 3B': 'ollama pull llama3.2:3b',
            'Llama 3.1 8B': 'ollama pull llama3.1:8b',
            'Mistral 7B v0.3': 'ollama pull mistral:7b',
            'CodeLlama 7B': 'ollama pull codellama:7b',
            'Qwen 2.5 7B': 'ollama pull qwen2.5:7b'
        };

        return mapping[modelName] || null;
    }

    analyzeHardwareSizeMatch(hardware, model) {
        const analysis = { factor: 1.0, notes: [] };
        
        // Get hardware tier and model size
        const hardwareTier = this.getHardwareTier(hardware);
        const totalRAM = hardware.memory.total;
        const modelSizeGB = this.parseModelSize(model.size);
        
        // Define optimal model sizes for each hardware tier
        const optimalSizes = {
            'ultra_high': { min: 13, max: 70, sweet: 20 },    // 64+ GB: 13B-70B models
            'high': { min: 7, max: 30, sweet: 13 },           // 16-32 GB: 7B-30B models  
            'medium': { min: 3, max: 13, sweet: 7 },          // 8-16 GB: 3B-13B models
            'low': { min: 1, max: 7, sweet: 3 },              // 4-8 GB: 1B-7B models
            'ultra_low': { min: 0.1, max: 3, sweet: 1 }      // <4 GB: <3B models
        };
        
        const optimal = optimalSizes[hardwareTier] || optimalSizes['medium'];
        
        // Calculate penalty/bonus based on model size vs optimal range
        if (modelSizeGB < optimal.min) {
            // Model too small for hardware - penalize significantly
            const underutilization = optimal.min / modelSizeGB;
            if (underutilization >= 10) {
                analysis.factor = 0.3; // Major penalty for extreme underutilization
                analysis.notes.push(`Model (${model.size}) significantly underutilizes your ${hardwareTier.replace('_', ' ')} hardware`);
            } else if (underutilization >= 5) {
                analysis.factor = 0.5; // Moderate penalty
                analysis.notes.push(`Model (${model.size}) underutilizes your hardware - consider larger models`);
            } else {
                analysis.factor = 0.7; // Small penalty
                analysis.notes.push(`Model smaller than optimal for your ${totalRAM}GB system`);
            }
        } else if (modelSizeGB > optimal.max) {
            // Model too large for hardware - already handled by RAM analysis
            analysis.factor = 1.0; // No additional penalty (RAM analysis covers this)
        } else {
            // Model in good range - give bonus for sweet spot
            const distanceFromSweet = Math.abs(modelSizeGB - optimal.sweet) / optimal.sweet;
            if (distanceFromSweet <= 0.3) {
                analysis.factor = 1.1; // 10% bonus for sweet spot
                analysis.notes.push(`Excellent size match for your ${hardwareTier.replace('_', ' ')} hardware`);
            } else {
                analysis.factor = 1.0; // No penalty, good range
            }
        }
        
        return analysis;
    }
}

module.exports = CompatibilityAnalyzer;
