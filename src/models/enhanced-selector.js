/**
 * Enhanced Model Selector - Bridge between old and new algorithms
 * 
 * This module provides compatibility with the existing API while using
 * the new deterministic selector under the hood.
 */

const DeterministicModelSelector = require('./deterministic-selector');
const IntelligentModelRecommender = require('./intelligent-recommender');

class EnhancedModelSelector {
    constructor() {
        this.deterministicSelector = new DeterministicModelSelector();
        this.fallbackSelector = new IntelligentModelRecommender();
        this.useDeterministic = true; // Feature flag
    }

    /**
     * Generate intelligent recommendations by category (main API)
     */
    async getBestModelsForHardware(hardware, allModels) {
        if (!this.useDeterministic) {
            return this.fallbackSelector.getBestModelsForHardware(hardware, allModels);
        }

        try {
            const categories = ['coding', 'reasoning', 'multimodal', 'creative', 'talking', 'reading', 'general'];
            const recommendations = {};

            for (const category of categories) {
                try {
                    const result = await this.deterministicSelector.selectModels(category, {
                        topN: 3,
                        enableProbe: false, // Disable for main recommendations to keep it fast
                        silent: true // Silent mode for check command
                    });

                    recommendations[category] = {
                        tier: this.mapHardwareTier(hardware),
                        bestModels: result.candidates.map(candidate => this.mapCandidateToLegacyFormat(candidate)),
                        totalEvaluated: result.total_evaluated,
                        category: this.getCategoryInfo(category)
                    };
                } catch (error) {
                    console.warn(`Failed to get recommendations for ${category}: ${error.message}`);
                    // Fallback to empty for this category
                    recommendations[category] = {
                        tier: this.mapHardwareTier(hardware),
                        bestModels: [],
                        totalEvaluated: 0,
                        category: this.getCategoryInfo(category)
                    };
                }
            }

            return recommendations;
        } catch (error) {
            console.warn('Deterministic selector failed, falling back to legacy:', error.message);
            return this.fallbackSelector.getBestModelsForHardware(hardware, allModels);
        }
    }

    /**
     * Generate recommendation summary (legacy API compatibility)
     */
    generateRecommendationSummary(recommendations, hardware) {
        if (!this.useDeterministic) {
            return this.fallbackSelector.generateRecommendationSummary(recommendations, hardware);
        }

        const summary = {
            hardware_tier: this.mapHardwareTier(hardware),
            total_categories: Object.keys(recommendations).length,
            best_overall: null,
            by_category: {},
            quick_commands: []
        };

        let bestOverallScore = 0;
        let bestOverallModel = null;
        let bestOverallCategory = null;

        // Process each category
        Object.entries(recommendations).forEach(([category, data]) => {
            const bestModel = data.bestModels[0];
            if (bestModel) {
                summary.by_category[category] = {
                    name: bestModel.model_name || bestModel.name,
                    identifier: bestModel.model_identifier,
                    score: Math.round(bestModel.categoryScore || bestModel.score),
                    command: `ollama pull ${bestModel.model_identifier}`,
                    size: this.formatModelSize(bestModel),
                    pulls: bestModel.pulls || 0
                };

                summary.quick_commands.push(`ollama pull ${bestModel.model_identifier}`);

                // Select best overall (prefer general categories)
                const isGeneralCategory = ['general', 'coding', 'talking', 'reading'].includes(category);
                const score = bestModel.categoryScore || bestModel.score || 0;
                
                if (isGeneralCategory && (score > bestOverallScore || !bestOverallModel)) {
                    bestOverallScore = score;
                    bestOverallModel = bestModel;
                    bestOverallCategory = category;
                }
            }
        });

        // Set best overall
        if (bestOverallModel) {
            summary.best_overall = {
                name: bestOverallModel.model_name || bestOverallModel.name,
                identifier: bestOverallModel.model_identifier,
                category: bestOverallCategory,
                score: Math.round(bestOverallScore),
                command: `ollama pull ${bestOverallModel.model_identifier}`
            };
        }

        return summary;
    }

    /**
     * Quick single-category selection for CLI commands
     */
    async selectForCategory(category, options = {}) {
        return this.deterministicSelector.selectModels(category, options);
    }

    /**
     * Enable/disable deterministic selector
     */
    setDeterministicMode(enabled) {
        this.useDeterministic = enabled;
    }

    // ============================================================================
    // MAPPING HELPERS - Convert between legacy and new formats
    // ============================================================================

    mapCandidateToLegacyFormat(candidate) {
        return {
            model_name: candidate.meta.name,
            model_identifier: candidate.meta.model_identifier,
            categoryScore: candidate.score,
            hardwareScore: candidate.components ? candidate.components.F : 90,
            specializationScore: candidate.components ? candidate.components.Q : 85,
            popularityScore: candidate.components ? Math.min(100, (candidate.meta.pulls || 0) / 100000 * 100) : 10,
            efficiencyScore: candidate.components ? candidate.components.S : 80,
            pulls: candidate.meta.pulls || 0,
            size: candidate.meta.paramsB,
            family: candidate.meta.family,
            category: this.inferCategoryFromModel(candidate.meta),
            tags: candidate.meta.tags || [],
            quantization: candidate.quant,
            estimatedRAM: candidate.requiredGB,
            reasoning: candidate.rationale
        };
    }

    mapHardwareTier(hardware) {
        // Handle different hardware object formats
        let ram, cores;
        
        if (hardware.memory && hardware.memory.totalGB) {
            ram = hardware.memory.totalGB;
        } else if (hardware.memory && hardware.memory.total) {
            ram = hardware.memory.total;
        } else if (hardware.total_ram_gb) {
            ram = hardware.total_ram_gb;
        } else {
            ram = 8; // Default fallback
        }
        
        if (hardware.cpu && hardware.cpu.cores) {
            cores = hardware.cpu.cores;
        } else if (hardware.cpu_cores) {
            cores = hardware.cpu_cores;
        } else {
            cores = 4; // Default fallback
        }
        
        if (ram >= 64 && cores >= 16) return 'extreme';
        if (ram >= 32 && cores >= 12) return 'very_high';
        if (ram >= 16 && cores >= 8) return 'high';
        if (ram >= 8 && cores >= 4) return 'medium';
        return 'low';
    }

    getCategoryInfo(category) {
        const categoryData = {
            coding: { weight: 1.0, keywords: ['code', 'programming', 'coder'] },
            reasoning: { weight: 1.2, keywords: ['reasoning', 'logic', 'math'] },
            multimodal: { weight: 1.1, keywords: ['vision', 'image', 'multimodal'] },
            creative: { weight: 0.9, keywords: ['creative', 'writing', 'story'] },
            talking: { weight: 1.0, keywords: ['chat', 'conversation', 'assistant'] },
            reading: { weight: 1.0, keywords: ['reading', 'comprehension', 'text'] },
            general: { weight: 1.0, keywords: ['general', 'assistant', 'helper'] }
        };
        
        return categoryData[category] || categoryData.general;
    }

    inferCategoryFromModel(model) {
        const name = model.name.toLowerCase();
        const tags = model.tags || [];
        
        if (tags.includes('coder') || name.includes('code')) return 'coding';
        if (tags.includes('vision') || model.modalities.includes('vision')) return 'multimodal';
        if (tags.includes('embed')) return 'embeddings';
        if (name.includes('creative') || name.includes('wizard')) return 'creative';
        
        return 'general';
    }

    formatModelSize(model) {
        if (model.paramsB) return `${model.paramsB}B`;
        if (model.size) return `${model.size}B`;
        return 'Unknown';
    }

    // ============================================================================
    // LEGACY API COMPATIBILITY  
    // ============================================================================

    /**
     * Legacy filter method - now uses deterministic selection
     */
    filterModelsByCategory(allModels, category) {
        // This is now handled internally by the deterministic selector
        // Return a simplified filter for backward compatibility
        return allModels.filter(model => {
            switch (category) {
                case 'coding':
                    return model.tags && model.tags.some(tag => ['coder', 'code', 'instruct'].includes(tag));
                case 'multimodal':
                    return model.modalities && model.modalities.includes('vision');
                default:
                    return true;
            }
        });
    }

    /**
     * Legacy scoring method - redirects to deterministic selector
     */
    async scoreModelsForCategory(models, category, hardware) {
        if (models.length === 0) return [];
        
        try {
            const result = await this.deterministicSelector.selectModels(category, {
                topN: models.length,
                silent: true
            });
            
            return result.candidates.map(candidate => this.mapCandidateToLegacyFormat(candidate));
        } catch (error) {
            console.warn('Deterministic scoring failed, using legacy fallback');
            return this.fallbackSelector.scoreModelsForCategory(models, category, hardware);
        }
    }
}

module.exports = EnhancedModelSelector;