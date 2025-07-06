class CompatibilityAnalyzer {
    constructor() {
        this.compatibilityThresholds = {
            excellent: 90,
            good: 75,
            marginal: 60,
            poor: 40,
            incompatible: 0
        };
    }

    analyzeCompatibility(hardware, models) {
        const results = {
            compatible: [],
            marginal: [],
            incompatible: [],
            recommendations: []
        };

        models.forEach(model => {
            const compatibility = this.calculateModelCompatibility(hardware, model);
            const modelWithScore = { ...model, score: compatibility.score, issues: compatibility.issues };

            if (compatibility.score >= this.compatibilityThresholds.marginal) {
                if (compatibility.score >= this.compatibilityThresholds.good) {
                    results.compatible.push(modelWithScore);
                } else {
                    results.marginal.push(modelWithScore);
                }
            } else {
                results.incompatible.push(modelWithScore);
            }
        });


        results.compatible.sort((a, b) => b.score - a.score);
        results.marginal.sort((a, b) => b.score - a.score);
        results.incompatible.sort((a, b) => b.score - a.score);


        results.recommendations = this.generateRecommendations(hardware, results);

        return results;
    }

    calculateModelCompatibility(hardware, model) {

        if (model.type === 'cloud') {
            return {
                score: 100,
                issues: [],
                notes: ['Requires internet connection and API key']
            };
        }

        const { memory, gpu, cpu } = hardware;
        const req = model.requirements;

        let score = 100;
        const issues = [];
        const notes = [];


        const ramCompatibility = this.checkRAMCompatibility(memory, req);
        score *= ramCompatibility.factor;
        if (ramCompatibility.issues.length > 0) {
            issues.push(...ramCompatibility.issues);
        }
        notes.push(...ramCompatibility.notes);


        if (req.vram > 0) {
            const vramCompatibility = this.checkVRAMCompatibility(gpu, req);
            score *= vramCompatibility.factor;
            if (vramCompatibility.issues.length > 0) {
                issues.push(...vramCompatibility.issues);
            }
            notes.push(...vramCompatibility.notes);
        }


        const cpuCompatibility = this.checkCPUCompatibility(cpu, req);
        score *= cpuCompatibility.factor;
        if (cpuCompatibility.issues.length > 0) {
            issues.push(...cpuCompatibility.issues);
        }
        notes.push(...cpuCompatibility.notes);


        const archBonus = this.getArchitectureBonus(cpu, model);
        score *= archBonus.factor;
        notes.push(...archBonus.notes);


        const quantBonus = this.getQuantizationBonus(model, hardware);
        score *= quantBonus.factor;
        notes.push(...quantBonus.notes);

        return {
            score: Math.round(Math.max(0, Math.min(100, score))),
            issues,
            notes: notes.filter(note => note)
        };
    }

    checkRAMCompatibility(memory, requirements) {
        const factor = { factor: 1.0, issues: [], notes: [] };
        const availableRAM = memory.free;
        const totalRAM = memory.total;
        const requiredRAM = requirements.ram;
        const recommendedRAM = requirements.recommended_ram || requiredRAM;

        if (totalRAM < requiredRAM) {
            factor.factor = 0.1;
            factor.issues.push(`Insufficient total RAM: ${totalRAM}GB available, ${requiredRAM}GB required`);
        } else if (availableRAM < requiredRAM) {
            factor.factor = 0.4;
            factor.issues.push(`Low available RAM: ${availableRAM}GB free, ${requiredRAM}GB needed`);
            factor.notes.push('Close other applications to free up memory');
        } else if (totalRAM < recommendedRAM) {
            factor.factor = 0.7;
            factor.notes.push(`Consider upgrading to ${recommendedRAM}GB RAM for optimal performance`);
        } else if (availableRAM >= recommendedRAM) {
            factor.factor = 1.0;
            factor.notes.push('RAM requirements fully satisfied');
        } else {
            factor.factor = 0.85;
            factor.notes.push('RAM is adequate but close to recommended minimum');
        }

        return factor;
    }

    checkVRAMCompatibility(gpu, requirements) {
        const factor = { factor: 1.0, issues: [], notes: [] };
        const availableVRAM = gpu.vram;
        const requiredVRAM = requirements.vram;
        const recommendedVRAM = requirements.recommended_vram || requiredVRAM;

        if (!gpu.dedicated && requiredVRAM > 0) {
            factor.factor = 0.6; // Integrated GPU penalty
            factor.notes.push('Integrated GPU detected - performance may be limited');
        }

        if (availableVRAM < requiredVRAM) {
            if (requiredVRAM <= 2) {
                factor.factor = 0.3; // Podría funcionar en CPU
                factor.issues.push(`Insufficient VRAM: ${availableVRAM}GB available, ${requiredVRAM}GB required`);
                factor.notes.push('Model will run on CPU (slower performance)');
            } else {
                factor.factor = 0.1; // Muy problemático
                factor.issues.push(`Insufficient VRAM: ${availableVRAM}GB available, ${requiredVRAM}GB required`);
                factor.notes.push('Consider using heavy quantization or CPU-only mode');
            }
        } else if (availableVRAM >= recommendedVRAM) {
            factor.factor = 1.0; // Perfecto
            factor.notes.push('VRAM requirements fully satisfied');
        } else {
            factor.factor = 0.8; // Bueno
            factor.notes.push('VRAM is adequate but close to minimum requirements');
        }

        return factor;
    }

    checkCPUCompatibility(cpu, requirements) {
        const factor = { factor: 1.0, issues: [], notes: [] };
        const availableCores = cpu.cores;
        const requiredCores = requirements.cpu_cores;
        const cpuSpeed = cpu.speedMax || cpu.speed;

        if (availableCores < requiredCores) {
            factor.factor = Math.max(0.5, availableCores / requiredCores);
            factor.issues.push(`Limited CPU cores: ${availableCores} available, ${requiredCores} recommended`);
        }

        // Bonus por velocidad de CPU alta
        if (cpuSpeed > 3.5) {
            factor.factor *= 1.1;
            factor.notes.push('High CPU speed will help with inference performance');
        } else if (cpuSpeed < 2.0) {
            factor.factor *= 0.8;
            factor.notes.push('Low CPU speed may impact performance');
        }

        // Bonus por CPU score alto
        if (cpu.score > 80) {
            factor.factor *= 1.05;
        } else if (cpu.score < 40) {
            factor.factor *= 0.9;
        }

        return factor;
    }

    getArchitectureBonus(cpu, model) {
        const bonus = { factor: 1.0, notes: [] };

        if (cpu.architecture === 'Apple Silicon') {

            if (model.frameworks && model.frameworks.includes('llama.cpp')) {
                bonus.factor = 1.15;
                bonus.notes.push('Apple Silicon optimizations available');
            }
            // Metal GPU acceleration
            if (model.requirements.vram === 0) {
                bonus.factor *= 1.1;
                bonus.notes.push('Can utilize Metal GPU acceleration');
            }
        }

        if (cpu.architecture === 'x86_64' && cpu.speed > 3.0) {
            bonus.factor = 1.05;
            bonus.notes.push('Modern x86_64 CPU with vector optimizations');
        }

        return bonus;
    }

    getQuantizationBonus(model, hardware) {
        const bonus = { factor: 1.0, notes: [] };

        if (!model.quantization || model.quantization.length === 0) {
            return bonus;
        }

        const { memory, gpu } = hardware;
        const totalRAM = memory.total;
        const vram = gpu.vram;


        if (totalRAM < 16 || vram < 8) {
            if (model.quantization.includes('Q4_0') || model.quantization.includes('Q4_K_M')) {
                bonus.factor = 1.2;
                bonus.notes.push('Q4 quantization recommended for your hardware');
            } else if (model.quantization.includes('Q2_K')) {
                bonus.factor = 1.3;
                bonus.notes.push('Q2 quantization available for very limited hardware');
            }
        }

        if (totalRAM >= 32 && vram >= 16) {
            if (model.quantization.includes('Q8_0')) {
                bonus.factor = 1.1;
                bonus.notes.push('High-quality Q8 quantization recommended');
            } else if (model.quantization.includes('Q6_K')) {
                bonus.factor = 1.05;
                bonus.notes.push('Q6 quantization offers good quality/performance balance');
            }
        }

        return bonus;
    }

    generateRecommendations(hardware, results) {
        const recommendations = [];
        const { memory, gpu, cpu } = hardware;

        if (memory.total < 8) {
            recommendations.push('💡 Upgrade to at least 16GB RAM to run more models');
        } else if (memory.total < 16) {
            recommendations.push('💡 Consider upgrading to 32GB RAM for medium-large models');
        }

        if (gpu.vram < 4 && gpu.dedicated) {
            recommendations.push('💡 GPU has limited VRAM - consider CPU-only inference');
        } else if (!gpu.dedicated) {
            recommendations.push('💡 Dedicated GPU would significantly improve performance');
        }

        if (cpu.cores < 4) {
            recommendations.push('💡 More CPU cores would help with parallel processing');
        }

        if (results.compatible.length === 0) {
            recommendations.push('🔧 No models fully compatible - try TinyLlama for testing');
            recommendations.push('☁️ Consider cloud-based models for better performance');
        } else if (results.compatible.length < 3) {
            recommendations.push('📈 Limited model options - hardware upgrade recommended');
        }

        if (results.compatible.length > 0) {
            recommendations.push('🛠️ Install Ollama for easy model management: https://ollama.ai');
            recommendations.push('⚡ Use quantized models (Q4_K_M) for better performance');
        }

        if (memory.total >= 16 && gpu.vram >= 8) {
            recommendations.push('🎯 Your system can handle Q5_K_M or Q6_K quantization');
        } else if (memory.total >= 8) {
            recommendations.push('🎯 Use Q4_0 or Q4_K_M quantization for optimal balance');
        } else {
            recommendations.push('🎯 Stick to Q2_K or Q3_K quantization for your hardware');
        }

        if (cpu.architecture === 'Apple Silicon') {
            recommendations.push('🍎 Use llama.cpp with Metal support for Apple Silicon optimization');
        }

        return recommendations;
    }

    getPerformanceEstimate(hardware, model) {
        const { memory, gpu, cpu } = hardware;
        const req = model.requirements;


        let baseTokensPerSecond = 10;


        const cpuFactor = Math.min(2.0, cpu.score / 50);
        baseTokensPerSecond *= cpuFactor;


        if (gpu.dedicated && gpu.vram >= req.vram) {
            const gpuFactor = Math.min(3.0, gpu.score / 30);
            baseTokensPerSecond *= gpuFactor;
        }


        const memoryFactor = Math.min(1.5, memory.total / req.ram);
        baseTokensPerSecond *= memoryFactor;


        const sizeGB = parseInt(model.size.replace('B', ''));
        if (sizeGB > 30) {
            baseTokensPerSecond *= 0.3;
        } else if (sizeGB > 10) {
            baseTokensPerSecond *= 0.6;
        } else if (sizeGB > 5) {
            baseTokensPerSecond *= 0.8;
        }

        return {
            tokensPerSecond: Math.round(baseTokensPerSecond),
            category: baseTokensPerSecond > 50 ? 'fast' :
                baseTokensPerSecond > 20 ? 'medium' :
                    baseTokensPerSecond > 5 ? 'slow' : 'very_slow'
        };
    }
}

module.exports = CompatibilityAnalyzer;