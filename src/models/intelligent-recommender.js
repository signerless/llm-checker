class IntelligentModelRecommender {
    constructor() {
        this.categories = {
            coding: {
                weight: 1.0,
                keywords: ['code', 'programming', 'development', 'coder', 'deepseek', 'codellama'],
                preferredSizes: ['1b', '3b', '7b', '13b'],
                hardwareMinimums: { ram: 4, vram: 2, cpu_cores: 4 }
            },
            reading: {
                weight: 1.0,
                keywords: ['reading', 'comprehension', 'text', 'analysis', 'llama', 'mistral'],
                preferredSizes: ['3b', '7b', '13b', '20b'],
                hardwareMinimums: { ram: 4, vram: 1, cpu_cores: 2 }
            },
            talking: {
                weight: 1.0,
                keywords: ['chat', 'conversation', 'assistant', 'phi', 'gemma'],
                preferredSizes: ['1b', '3b', '7b'],
                hardwareMinimums: { ram: 2, vram: 1, cpu_cores: 2 }
            },
            reasoning: {
                weight: 1.2,
                keywords: ['reason', 'logic', 'math', 'problem', 'deepseek-r1', 'qwen'],
                preferredSizes: ['7b', '14b', '32b', '70b'],
                hardwareMinimums: { ram: 8, vram: 4, cpu_cores: 6 }
            },
            multimodal: {
                weight: 1.1,
                keywords: ['vision', 'image', 'multimodal', 'llava', 'pixtral'],
                preferredSizes: ['7b', '12b', '22b'],
                hardwareMinimums: { ram: 8, vram: 6, cpu_cores: 4 }
            },
            creative: {
                weight: 0.9,
                keywords: ['creative', 'writing', 'story', 'novel', 'llama', 'mistral'],
                preferredSizes: ['7b', '13b', '20b'],
                hardwareMinimums: { ram: 6, vram: 2, cpu_cores: 4 }
            },
            general: {
                weight: 1.0,
                keywords: ['general', 'assistant', 'helper'],
                preferredSizes: ['1b', '3b', '7b', '13b'],
                hardwareMinimums: { ram: 2, vram: 1, cpu_cores: 2 }
            }
        };
    }

    /**
     * Algoritmo inteligente para recomendar el mejor modelo para cada categoría
     * Basado en hardware del usuario y análisis heurístico avanzado
     */
    getBestModelsForHardware(hardware, allModels) {
        const hardwareTier = this.calculateHardwareTier(hardware);
        const recommendations = {};

        console.log(`🧠 Analyzing ${allModels.length} models for hardware tier: ${hardwareTier}`);

        // Para cada categoría, encontrar los mejores modelos
        Object.keys(this.categories).forEach(category => {
            const categoryModels = this.filterModelsByCategory(allModels, category);
            const scoredModels = this.scoreModelsForCategory(categoryModels, category, hardware);
            const bestModels = this.selectBestModels(scoredModels, hardwareTier, 3);

            recommendations[category] = {
                tier: hardwareTier,
                bestModels: bestModels,
                totalEvaluated: categoryModels.length,
                category: this.categories[category]
            };
        });

        return recommendations;
    }

    calculateHardwareTier(hardware) {
        const { memory, gpu, cpu } = hardware;
        const ram = memory.total;
        const vram = gpu.vram || 0;
        const cores = cpu.cores;

        // Algoritmo matemático avanzado para determinar tier
        const ramScore = Math.min(100, (ram / 64) * 100);
        const vramScore = Math.min(100, (vram / 32) * 100);
        const cpuScore = Math.min(100, (cores / 16) * 100);

        // Peso basado en importancia para LLMs
        const totalScore = (ramScore * 0.5) + (cpuScore * 0.3) + (vramScore * 0.2);

        if (totalScore >= 80) return 'ultra_high';
        if (totalScore >= 60) return 'high';
        if (totalScore >= 40) return 'medium';
        if (totalScore >= 20) return 'low';
        return 'ultra_low';
    }

    filterModelsByCategory(allModels, category) {
        const categoryInfo = this.categories[category];
        if (!categoryInfo) return [];

        return allModels.filter(model => {
            // Filtrar por palabras clave en nombre, descripción o use_cases
            const searchText = [
                model.model_name,
                model.description,
                model.detailed_description,
                ...(model.use_cases || []),
                model.model_identifier,
                model.category
            ].join(' ').toLowerCase();

            const matchesKeywords = categoryInfo.keywords.some(keyword => 
                searchText.includes(keyword.toLowerCase())
            );

            // También incluir modelos generales para categorías básicas
            const isGeneralModel = model.category === 'general' && 
                ['talking', 'reading', 'general'].includes(category);

            return matchesKeywords || isGeneralModel;
        });
    }

    scoreModelsForCategory(models, category, hardware) {
        const categoryInfo = this.categories[category];
        
        return models.map(model => {
            let score = 50; // Base score
            
            // Factor 1: Compatibilidad con hardware (40%)
            const hardwareScore = this.calculateHardwareCompatibility(model, hardware);
            score += hardwareScore * 0.4;

            // Factor 2: Especialización para la categoría (30%)
            const specializationScore = this.calculateSpecializationScore(model, category);
            score += specializationScore * 0.3;

            // Factor 3: Popularidad y confiabilidad (20%)
            const popularityScore = this.calculatePopularityScore(model);
            score += popularityScore * 0.2;

            // Factor 4: Eficiencia (tamaño vs rendimiento) (10%)
            const efficiencyScore = this.calculateEfficiencyScore(model, hardware);
            score += efficiencyScore * 0.1;

            // Penalizaciones
            score = this.applyPenalties(score, model, hardware);

            // Bonus especiales
            score = this.applyBonuses(score, model, category, hardware);

            return {
                ...model,
                categoryScore: Math.min(100, Math.max(0, score)),
                hardwareScore,
                specializationScore,
                popularityScore,
                efficiencyScore
            };
        });
    }

    calculateHardwareCompatibility(model, hardware) {
        let score = 0;
        
        // Estimar requisitos del modelo
        const estimatedRAM = this.estimateRAMRequirement(model);
        const estimatedVRAM = this.estimateVRAMRequirement(model);
        
        // RAM compatibility (40% of hardware score)
        const ramRatio = hardware.memory.total / estimatedRAM;
        if (ramRatio >= 3) score += 40;
        else if (ramRatio >= 2) score += 30;
        else if (ramRatio >= 1.5) score += 20;
        else if (ramRatio >= 1) score += 10;
        else score -= 20;

        // VRAM compatibility (30% of hardware score)
        const vramRatio = (hardware.gpu.vram || 0) / estimatedVRAM;
        if (vramRatio >= 2) score += 30;
        else if (vramRatio >= 1) score += 20;
        else if (vramRatio >= 0.5) score += 10;
        // CPU compatibility (30% of hardware score)
        if (hardware.cpu.cores >= 8) score += 30;
        else if (hardware.cpu.cores >= 4) score += 20;
        else if (hardware.cpu.cores >= 2) score += 10;

        return Math.min(100, Math.max(0, score));
    }

    calculateSpecializationScore(model, category) {
        const categoryInfo = this.categories[category];
        let score = 0;

        // Coincidencia directa de categoría
        if (model.category === category) {
            score += 50;
        }

        // Coincidencia en use_cases
        if (model.use_cases) {
            const matchingUseCases = model.use_cases.filter(useCase => 
                categoryInfo.keywords.some(keyword => 
                    useCase.toLowerCase().includes(keyword.toLowerCase())
                )
            );
            score += Math.min(30, matchingUseCases.length * 10);
        }

        // Coincidencia en nombre/identificador
        const modelText = `${model.model_name} ${model.model_identifier}`.toLowerCase();
        const keywordMatches = categoryInfo.keywords.filter(keyword => 
            modelText.includes(keyword.toLowerCase())
        );
        score += Math.min(20, keywordMatches.length * 5);

        return Math.min(100, score);
    }

    calculatePopularityScore(model) {
        const pulls = model.pulls || 0;
        
        if (pulls > 10000000) return 100;      // 10M+ pulls
        if (pulls > 1000000) return 80;       // 1M+ pulls
        if (pulls > 100000) return 60;       // 100K+ pulls
        if (pulls > 10000) return 40;        // 10K+ pulls
        if (pulls > 1000) return 20;         // 1K+ pulls
        return 10; // Less popular models
    }

    calculateEfficiencyScore(model, hardware) {
        const modelSize = this.extractModelSizeGB(model);
        const hardwareTier = this.calculateHardwareTier(hardware);
        
        // Modelos más pequeños son más eficientes para hardware limitado
        if (hardwareTier === 'ultra_low' || hardwareTier === 'low') {
            if (modelSize <= 1) return 100;
            if (modelSize <= 3) return 80;
            if (modelSize <= 7) return 60;
            return 20;
        }
        
        // Para hardware potente, balance entre tamaño y capacidad
        if (hardwareTier === 'high' || hardwareTier === 'ultra_high') {
            if (modelSize >= 13 && modelSize <= 30) return 100;
            if (modelSize >= 7 && modelSize <= 13) return 90;
            if (modelSize >= 3 && modelSize <= 7) return 80;
            return 60;
        }
        
        // Hardware medio
        if (modelSize >= 3 && modelSize <= 13) return 100;
        if (modelSize <= 3) return 80;
        return 40;
    }

    applyPenalties(score, model, hardware) {
        // Penalización por modelos muy grandes para hardware limitado
        const modelSize = this.extractModelSizeGB(model);
        const requiredRAM = this.estimateRAMRequirement(model);
        
        if (requiredRAM > hardware.memory.total) {
            score -= 30; // Penalización severa
        }
        
        if (modelSize > 30 && this.calculateHardwareTier(hardware) === 'low') {
            score -= 20; // Modelo demasiado grande
        }

        return score;
    }

    applyBonuses(score, model, category, hardware) {
        // Bonus por arquitectura Apple Silicon
        if (hardware.cpu.architecture === 'Apple Silicon') {
            score += 5;
        }

        // Bonus por modelos muy recientes (2024-2025)
        const currentYear = new Date().getFullYear();
        if (model.last_updated && model.last_updated.includes('day')) {
            score += 10; // Modelo muy reciente
        }

        // Bonus por quantización disponible
        if (model.quantizations && model.quantizations.length > 0) {
            score += 5;
        }

        // Bonus especial por categoría
        const categoryWeight = this.categories[category].weight;
        score *= categoryWeight;

        return score;
    }

    selectBestModels(scoredModels, hardwareTier, count = 3) {
        // Ordenar por score y seleccionar los mejores
        const sorted = scoredModels
            .sort((a, b) => b.categoryScore - a.categoryScore)
            .slice(0, count * 2); // Tomar más para diversidad

        const selected = [];
        const seenBases = new Set();

        // Seleccionar evitando duplicados de la misma base (ej: llama3.1:7b y llama3.1:8b)
        for (const model of sorted) {
            if (selected.length >= count) break;
            
            const baseName = this.extractBaseName(model.model_identifier);
            if (!seenBases.has(baseName)) {
                selected.push(model);
                seenBases.add(baseName);
            }
        }

        // Si no tenemos suficientes, agregar más sin restricción
        if (selected.length < count) {
            const remaining = sorted.filter(m => !selected.includes(m));
            selected.push(...remaining.slice(0, count - selected.length));
        }

        return selected;
    }

    extractBaseName(identifier) {
        // Extraer nombre base del modelo (ej: "llama3.1:7b" -> "llama3.1")
        return identifier.split(':')[0].split('-')[0];
    }

    estimateRAMRequirement(model) {
        const size = this.extractModelSizeGB(model);
        // Estimación: modelo necesita ~1.2x su tamaño en RAM mínimo
        return Math.max(1, size * 1.2);
    }

    estimateVRAMRequirement(model) {
        const size = this.extractModelSizeGB(model);
        // Para VRAM, modelos pequeños pueden correr solo en CPU
        if (size <= 3) return 0;
        return Math.max(2, size * 0.6);
    }

    extractModelSizeGB(model) {
        // Intentar extraer tamaño de diferentes campos
        const sources = [
            model.model_identifier,
            model.model_name,
            ...(model.model_sizes || []),
            ...(model.tags || [])
        ];

        for (const source of sources) {
            if (!source) continue;
            const sizeMatch = source.match(/(\d+\.?\d*)\s*[bg]/i);
            if (sizeMatch) {
                const num = parseFloat(sizeMatch[1]);
                const unit = sizeMatch[0].slice(-1).toLowerCase();
                return unit === 'b' ? num : (unit === 'g' ? num : num);
            }
        }

        return 1; // Default size
    }

    generateRecommendationSummary(recommendations, hardware) {
        const summary = {
            hardware_tier: this.calculateHardwareTier(hardware),
            total_categories: Object.keys(recommendations).length,
            best_overall: null,
            by_category: {},
            quick_commands: []
        };

        let bestOverallScore = 0;
        let bestOverallModel = null;

        Object.entries(recommendations).forEach(([category, data]) => {
            const bestModel = data.bestModels[0];
            if (bestModel) {
                summary.by_category[category] = {
                    name: bestModel.model_name,
                    identifier: bestModel.model_identifier,
                    score: Math.round(bestModel.categoryScore),
                    command: `ollama pull ${bestModel.model_identifier}`,
                    size: this.extractModelSizeGB(bestModel) + 'B',
                    pulls: bestModel.pulls
                };

                summary.quick_commands.push(`ollama pull ${bestModel.model_identifier}`);

                if (bestModel.categoryScore > bestOverallScore) {
                    bestOverallScore = bestModel.categoryScore;
                    bestOverallModel = bestModel;
                }
            }
        });

        if (bestOverallModel) {
            summary.best_overall = {
                name: bestOverallModel.model_name,
                identifier: bestOverallModel.model_identifier,
                category: Object.keys(recommendations).find(cat => 
                    recommendations[cat].bestModels.includes(bestOverallModel)
                ),
                score: Math.round(bestOverallScore),
                command: `ollama pull ${bestOverallModel.model_identifier}`
            };
        }

        return summary;
    }
}

module.exports = IntelligentModelRecommender;