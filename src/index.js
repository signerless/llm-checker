const HardwareDetector = require('./hardware/detector');
const ExpandedModelsDatabase = require('./models/expanded_database');
const CompatibilityAnalyzer = require('../analyzer/compatibility');
const PerformanceAnalyzer = require('../analyzer/performance');
const OllamaClient = require('./ollama/client');
const { getLogger } = require('./utils/logger');

class LLMChecker {
    constructor() {
        this.hardwareDetector = new HardwareDetector();
        this.expandedModelsDatabase = new ExpandedModelsDatabase();
        this.compatibilityAnalyzer = new CompatibilityAnalyzer();
        this.performanceAnalyzer = new PerformanceAnalyzer();
        this.ollamaClient = new OllamaClient();
        this.logger = getLogger().createChild('LLMChecker');
    }

    async analyze(options = {}) {
        try {
            const hardware = await this.hardwareDetector.getSystemInfo();
            this.logger.info('Hardware detected', { hardware });

            let models = this.expandedModelsDatabase.getAllModels();

            const ollamaIntegration = await this.integrateOllamaModels(hardware, models);

            if (options.filter) {
                models = this.filterModels(models, options.filter);
            }

            if (!options.includeCloud) {
                models = models.filter(model => model.type === 'local');
            }

            const compatibility = this.compatibilityAnalyzer.analyzeCompatibility(hardware, models);

            const enrichedResults = await this.enrichWithPerformanceData(hardware, compatibility);

            const recommendations = await this.generateEnhancedRecommendations(
                hardware,
                enrichedResults,
                ollamaIntegration,
                options.useCase || 'general'
            );

            return {
                hardware,
                compatible: enrichedResults.compatible,
                marginal: enrichedResults.marginal,
                incompatible: enrichedResults.incompatible,
                recommendations,
                ollamaInfo: ollamaIntegration.ollamaInfo,
                ollamaModels: ollamaIntegration.compatibleOllamaModels,
                summary: this.generateEnhancedSummary(hardware, enrichedResults, ollamaIntegration),
                performanceEstimates: enrichedResults.performanceEstimates
            };

        } catch (error) {
            this.logger.error('Analysis failed', { error: error.message, component: 'LLMChecker', method: 'analyze' });
            throw new Error(`Analysis failed: ${error.message}`);
        }
    }

    async integrateOllamaModels(hardware, availableModels) {
        const integration = {
            ollamaInfo: { available: false },
            compatibleOllamaModels: [],
            recommendedPulls: [],
            currentlyRunning: []
        };

        try {
            const ollamaStatus = await this.ollamaClient.checkOllamaAvailability();
            integration.ollamaInfo = ollamaStatus;

            if (!ollamaStatus.available) {
                this.logger.warn('Ollama not available', { error: ollamaStatus.error });
                return integration;
            }

            const [localModels, runningModels] = await Promise.all([
                this.ollamaClient.getLocalModels().catch(() => []),
                this.ollamaClient.getRunningModels().catch(() => [])
            ]);

            integration.currentlyRunning = runningModels;

            for (const ollamaModel of localModels) {
                const matchedModel = this.findMatchingModel(ollamaModel, availableModels);

                if (matchedModel) {
                    const compatibility = this.compatibilityAnalyzer.calculateModelCompatibility(hardware, matchedModel);

                    const enrichedOllamaModel = {
                        ...ollamaModel,
                        matchedModel,
                        compatibilityScore: compatibility.score,
                        issues: compatibility.issues,
                        notes: compatibility.notes,
                        isRunning: runningModels.some(r => r.name === ollamaModel.name),
                        canRun: compatibility.score >= 60,
                        performanceEstimate: await this.performanceAnalyzer.estimateModelPerformance(matchedModel, hardware)
                    };

                    integration.compatibleOllamaModels.push(enrichedOllamaModel);

                    this.logger.debug(`Model analysis: ${matchedModel.name} - Score: ${compatibility.score}`);
                }
            }

            integration.recommendedPulls = await this.generateOllamaRecommendations(hardware, availableModels, localModels);

            this.logger.info('Ollama integration completed', {
                data: {
                    localModels: localModels.length,
                    compatibleModels: integration.compatibleOllamaModels.length,
                    runningModels: runningModels.length,
                    recommendations: integration.recommendedPulls.length
                }
            });

        } catch (error) {
            this.logger.error('Ollama integration failed', { error: error.message, component: 'LLMChecker', method: 'integrateOllamaModels' });
        }

        return integration;
    }

    findMatchingModel(ollamaModel, availableModels) {
        const ollamaName = ollamaModel.name.toLowerCase();

        const nameMapping = {
            'llama3.2:3b': 'Llama 3.2 3B',
            'llama3.1:8b': 'Llama 3.1 8B',
            'mistral:7b': 'Mistral 7B v0.3',
            'codellama:7b': 'CodeLlama 7B',
            'phi3:mini': 'Phi-3 Mini 3.8B',
            'gemma2:2b': 'Gemma 2B',
            'tinyllama:1.1b': 'TinyLlama 1.1B',
            'qwen2.5:7b': 'Qwen 2.5 7B'
        };

        if (nameMapping[ollamaName]) {
            return availableModels.find(m => m.name === nameMapping[ollamaName]);
        }

        const modelKeywords = ollamaName.split(':')[0].split('-');

        return availableModels.find(model => {
            const modelName = model.name.toLowerCase();
            return modelKeywords.some(keyword =>
                keyword.length > 2 && modelName.includes(keyword)
            );
        });
    }

    async generateOllamaRecommendations(hardware, availableModels, installedModels) {
        const recommendations = [];
        const installedNames = new Set(installedModels.map(m => m.name.toLowerCase()));

        const compatibleModels = availableModels.filter(model => {
            const compatibility = this.compatibilityAnalyzer.calculateModelCompatibility(hardware, model);
            return compatibility.score >= 75 && model.frameworks?.includes('ollama');
        });

        for (const model of compatibleModels.slice(0, 5)) {
            const ollamaCommand = this.getOllamaCommand(model);

            if (ollamaCommand && !installedNames.has(ollamaCommand.split(' ')[2])) {
                const performance = await this.performanceAnalyzer.estimateModelPerformance(model, hardware);

                recommendations.push({
                    model,
                    command: ollamaCommand,
                    reason: this.getRecommendationReason(model, hardware),
                    estimatedPerformance: performance,
                    priority: this.calculatePriority(model, hardware)
                });
            }
        }

        return recommendations.sort((a, b) => b.priority - a.priority);
    }

    async enrichWithPerformanceData(hardware, compatibility) {
        const performanceEstimates = new Map();

        for (const model of [...compatibility.compatible, ...compatibility.marginal]) {
            try {
                const estimate = await this.performanceAnalyzer.estimateModelPerformance(model, hardware);
                performanceEstimates.set(model.name, estimate);

                model.performanceEstimate = estimate;
                model.tokensPerSecond = estimate.estimatedTokensPerSecond;
                model.loadTime = estimate.loadTimeEstimate;
            } catch (error) {
                this.logger.warn(`Failed to estimate performance for ${model.name}`, { error });
            }
        }

        return {
            ...compatibility,
            performanceEstimates: Object.fromEntries(performanceEstimates)
        };
    }

    async generateEnhancedRecommendations(hardware, results, ollamaIntegration, useCase) {
        const recommendations = [];

        recommendations.push(...this.compatibilityAnalyzer.generateRecommendations(hardware, results));

        if (ollamaIntegration.ollamaInfo.available) {
            if (ollamaIntegration.compatibleOllamaModels.length === 0) {
                recommendations.push('🦙 No compatible models installed in Ollama - install recommended models below');
            }

            ollamaIntegration.recommendedPulls.slice(0, 3).forEach((rec, index) => {
                recommendations.push(`${index + 1}. 🚀 ${rec.command} - ${rec.reason}`);
            });
        } else {
            recommendations.push('🦙 Install Ollama for local LLM management: https://ollama.ai');
        }

        const useCaseRecs = this.getUseCaseRecommendations(results, useCase);
        recommendations.push(...useCaseRecs);

        return [...new Set(recommendations)];
    }

    getOllamaCommand(model) {
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

        return mapping[model.name] || null;
    }

    getRecommendationReason(model, hardware) {
        if (model.specialization === 'code') {
            return 'Excellent for coding tasks';
        }
        if (hardware.memory.total >= 16 && model.size.includes('8B')) {
            return 'Perfect size for your RAM capacity';
        }
        if (model.category === 'small' && hardware.memory.total < 16) {
            return 'Optimized for systems with limited RAM';
        }
        return 'Great balance of performance and efficiency';
    }

    calculatePriority(model, hardware) {
        let priority = 50;
        const modelSize = this.parseModelSize(model.size);
        const requiredRAM = model.requirements?.ram || 4;
        const ramRatio = hardware.memory.total / requiredRAM;

        if (ramRatio >= 2) priority += 20;
        else if (ramRatio >= 1.5) priority += 10;
        else if (ramRatio < 1) priority -= 20;

        if (modelSize <= 1) priority += 15;
        else if (modelSize <= 3) priority += 10;
        else if (modelSize <= 7) priority += 5;
        else if (modelSize > 30) priority -= 15;

        if (model.specialization === 'code') priority += 15;
        else if (model.specialization === 'chat') priority += 10;
        else if (model.specialization === 'embeddings') priority += 5;

        if (model.year >= 2024) priority += 10;
        else if (model.year >= 2023) priority += 5;

        if (hardware.gpu.dedicated && model.requirements?.vram > 0) {
            if (hardware.gpu.vram >= model.requirements.vram) {
                priority += 10;
            } else {
                priority -= 5;
            }
        }

        if (hardware.cpu.architecture === 'Apple Silicon' &&
            model.frameworks?.includes('llama.cpp')) {
            priority += 8;
        }

        return Math.max(0, priority);
    }

    parseModelSize(sizeString) {
        const match = sizeString.match(/(\d+\.?\d*)[BM]/i);
        if (!match) return 1;

        const num = parseFloat(match[1]);
        const unit = match[0].slice(-1).toUpperCase();

        return unit === 'B' ? num : num / 1000;
    }

    getUseCaseRecommendations(results, useCase) {
        const recommendations = [];

        switch (useCase) {
            case 'code':
                const codeModels = results.compatible.filter(m => m.specialization === 'code');
                if (codeModels.length > 0) {
                    recommendations.push(`💻 Top coding model: ${codeModels[0].name}`);
                }
                break;

            case 'chat':
                const chatModels = results.compatible.filter(m =>
                    m.specialization === 'chat' || m.specialization === 'general'
                );
                if (chatModels.length > 0) {
                    recommendations.push(`💬 Best chat model: ${chatModels[0].name}`);
                }
                break;

            case 'multimodal':
                const multiModels = results.compatible.filter(m => m.multimodal);
                if (multiModels.length > 0) {
                    recommendations.push(`🖼️ Multimodal option: ${multiModels[0].name}`);
                }
                break;
        }

        return recommendations;
    }

    generateEnhancedSummary(hardware, results, ollamaIntegration) {
        const baseSummary = this.generateSummary(hardware, results);

        return {
            ...baseSummary,
            ollama: {
                available: ollamaIntegration.ollamaInfo.available,
                installedModels: ollamaIntegration.compatibleOllamaModels.length,
                runningModels: ollamaIntegration.currentlyRunning.length,
                recommendedInstalls: ollamaIntegration.recommendedPulls.length
            },
            hardwareTier: this.getHardwareTier(hardware),
            topPerformanceModel: this.getTopPerformanceModel(results)
        };
    }

    getHardwareTier(hardware) {
        if (hardware.memory.total >= 64 && hardware.gpu.vram >= 32) return 'ultra_high';
        if (hardware.memory.total >= 32 && hardware.gpu.vram >= 16) return 'high';
        if (hardware.memory.total >= 16 && hardware.gpu.vram >= 8) return 'medium';
        if (hardware.memory.total >= 8) return 'low';
        return 'ultra_low';
    }

    getTopPerformanceModel(results) {
        if (results.compatible.length === 0) return null;

        const sorted = results.compatible
            .filter(m => m.performanceEstimate)
            .sort((a, b) => (b.performanceEstimate.estimatedTokensPerSecond || 0) -
                (a.performanceEstimate.estimatedTokensPerSecond || 0));

        return sorted[0] || results.compatible[0];
    }

    async analyzeOllamaModel(modelName) {
        try {
            const [hardware, model] = await Promise.all([
                this.getSystemInfo(),
                Promise.resolve(this.findModel(modelName))
            ]);

            if (!model) {
                throw new Error(`Model "${modelName}" not found in database`);
            }

            const [localModels, runningModels] = await Promise.all([
                this.ollamaClient.getLocalModels().catch(() => []),
                this.ollamaClient.getRunningModels().catch(() => [])
            ]);

            const isInstalled = localModels.some(m => m.name.toLowerCase().includes(modelName.toLowerCase()));
            const isRunning = runningModels.some(m => m.name.toLowerCase().includes(modelName.toLowerCase()));

            const [compatibility, performance] = await Promise.all([
                Promise.resolve(this.compatibilityAnalyzer.calculateModelCompatibility(hardware, model)),
                this.performanceAnalyzer.estimateModelPerformance(model, hardware)
            ]);

            let benchmarkResults = null;
            if (isInstalled) {
                try {
                    benchmarkResults = await this.performanceAnalyzer.benchmarkInferenceSpeed(
                        modelName, hardware, this.ollamaClient
                    );
                } catch (error) {
                    this.logger.warn(`Benchmark failed for ${modelName}`, { error });
                }
            }

            return {
                model,
                hardware,
                status: {
                    installed: isInstalled,
                    running: isRunning,
                    canRun: compatibility.score >= 60
                },
                compatibility,
                performance,
                benchmarkResults,
                recommendations: this.generateModelSpecificRecommendations(model, hardware, compatibility)
            };

        } catch (error) {
            this.logger.error('Model analysis failed', { error: error.message, component: 'LLMChecker', method: 'analyzeOllamaModel' });
            throw error;
        }
    }

    generateModelSpecificRecommendations(model, hardware, compatibility) {
        const recommendations = [];

        if (compatibility.score < 60) {
            recommendations.push('⚠️ Model may not run well on this hardware');
            recommendations.push('💡 Consider using heavy quantization (Q2_K, Q3_K_M)');
        } else if (compatibility.score < 75) {
            recommendations.push('✅ Model should run with some optimizations');
            recommendations.push('🎯 Use Q4_K_M quantization for best balance');
        } else {
            recommendations.push('🚀 Model should run excellently on this hardware');
            if (hardware.memory.total >= 32) {
                recommendations.push('💎 You can use higher quality quantization (Q5_K_M, Q6_K)');
            }
        }

        if (hardware.gpu.dedicated && hardware.gpu.vram >= (model.requirements?.vram || 0)) {
            recommendations.push('🎮 Enable GPU acceleration for faster inference');
        }

        return recommendations;
    }

    filterModels(models, filter) {
        switch (filter.toLowerCase()) {
            case 'local':
                return models.filter(m => m.type === 'local');
            case 'cloud':
                return models.filter(m => m.type === 'cloud');
            case 'ultra_small':
                return models.filter(m => m.category === 'ultra_small');
            case 'small':
                return models.filter(m => m.category === 'small');
            case 'medium':
                return models.filter(m => m.category === 'medium');
            case 'large':
                return models.filter(m => m.category === 'large');
            case 'code':
                return models.filter(m => m.specialization === 'code');
            case 'chat':
                return models.filter(m => m.specialization === 'chat' || !m.specialization);
            case 'multimodal':
                return models.filter(m => m.specialization === 'multimodal' || m.multimodal);
            case 'embeddings':
                return models.filter(m => m.specialization === 'embeddings');
            default:
                return models;
        }
    }

    generateSummary(hardware, compatibility) {
        return {
            grade: this.calculateGrade(compatibility),
            systemClass: this.getSystemClass(hardware),
            compatibleCount: compatibility.compatible.length,
            marginalCount: compatibility.marginal.length,
            incompatibleCount: compatibility.incompatible.length,
            totalModels: compatibility.compatible.length + compatibility.marginal.length + compatibility.incompatible.length
        };
    }

    calculateGrade(compatibility) {
        const total = compatibility.compatible.length + compatibility.marginal.length + compatibility.incompatible.length;
        const compatiblePercent = total > 0 ? (compatibility.compatible.length / total) * 100 : 0;

        if (compatiblePercent >= 80) return 'A';
        if (compatiblePercent >= 60) return 'B';
        if (compatiblePercent >= 40) return 'C';
        if (compatiblePercent >= 20) return 'D';
        return 'F';
    }

    getSystemClass(hardware) {
        if (hardware.memory.total >= 32 && hardware.gpu.vram >= 16) return 'High End';
        if (hardware.memory.total >= 16 && hardware.gpu.vram >= 8) return 'Mid Range';
        if (hardware.memory.total >= 8) return 'Budget';
        return 'Entry Level';
    }

    async getOllamaInfo() {
        return await this.integrateOllamaModels(await this.getSystemInfo(), []);
    }

    async getSystemInfo() {
        return await this.hardwareDetector.getSystemInfo();
    }

    getAllModels() {
        return this.expandedModelsDatabase.getAllModels();
    }

    findModel(name) {
        return this.expandedModelsDatabase.findModel ?
            this.expandedModelsDatabase.findModel(name) :
            this.getAllModels().find(m => m.name.toLowerCase().includes(name.toLowerCase()));
    }
}

module.exports = LLMChecker;
