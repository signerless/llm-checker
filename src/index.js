const HardwareDetector = require('./hardware/detector');
const ModelsDatabase = require('./models/database');
const ExpandedModelsDatabase = require('./models/expanded_database');

const OllamaClient = require('./ollama/client');

class LLMChecker {
    constructor() {
        this.hardwareDetector = new HardwareDetector();
        this.modelsDatabase = new ModelsDatabase();
        this.expandedModelsDatabase = new ExpandedModelsDatabase();
        this.ollamaClient = new OllamaClient();
    }

    async analyze(options = {}) {
        try {

            const hardware = await this.hardwareDetector.getSystemInfo();


            let models = this.expandedModelsDatabase.getAllModels();


            if (options.filter) {
                models = this.filterModels(models, options.filter);
            }

            if (!options.includeCloud) {
                models = models.filter(model => model.type === 'local');
            }


            const compatibility = this.analyzeCompatibilityExpanded(hardware, models);


            const dbRecommendations = this.expandedModelsDatabase.getModelRecommendations(hardware, options.useCase || 'general');


            const allRecommendations = [
                ...compatibility.recommendations,
                ...dbRecommendations.topRecommendations.map(m => `Consider ${m.name} (${m.compatibilityScore}/100)`)
            ];


            const uniqueRecommendations = [...new Set(allRecommendations)];

            return {
                hardware,
                compatible: compatibility.compatible,
                marginal: compatibility.marginal,
                incompatible: compatibility.incompatible,
                recommendations: uniqueRecommendations,
                summary: this.generateSummary(hardware, compatibility),
                ollamaInfo: await this.getOllamaInfo()
            };

        } catch (error) {
            throw new Error(`Analysis failed: ${error.message}`);
        }
    }

    analyzeCompatibilityExpanded(hardware, models) {
        const compatible = [];
        const marginal = [];
        const incompatible = [];
        const recommendations = [];

        models.forEach(model => {
            const analysis = this.expandedModelsDatabase.getDetailedCompatibilityAnalysis(model, hardware);
            const modelWithScore = { ...model, score: analysis.score, issues: analysis.issues };

            if (analysis.score >= 75) {
                compatible.push(modelWithScore);
            } else if (analysis.score >= 60) {
                marginal.push(modelWithScore);
            } else {
                incompatible.push(modelWithScore);
            }
        });


        compatible.sort((a, b) => b.score - a.score);
        marginal.sort((a, b) => b.score - a.score);
        incompatible.sort((a, b) => b.score - a.score);


        if (compatible.length === 0) {
            recommendations.push('Consider upgrading RAM for better model compatibility');
        }
        if (hardware.gpu.dedicated && hardware.gpu.vram >= 8) {
            recommendations.push('Your GPU can accelerate most local models');
        }
        if (hardware.cpu.architecture === 'Apple Silicon') {
            recommendations.push('Use llama.cpp with Metal support for optimal performance');
        }

        return {
            compatible,
            marginal,
            incompatible,
            recommendations
        };
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
        const total = compatibility.compatible.length +
            compatibility.marginal.length +
            compatibility.incompatible.length;

        const compatiblePercent = total > 0 ? Math.round((compatibility.compatible.length / total) * 100) : 0;
        const marginalPercent = total > 0 ? Math.round((compatibility.marginal.length / total) * 100) : 0;

        let grade = 'F';
        if (compatiblePercent >= 80) grade = 'A';
        else if (compatiblePercent >= 60) grade = 'B';
        else if (compatiblePercent >= 40) grade = 'C';
        else if (compatiblePercent >= 20) grade = 'D';

        let systemClass = 'Entry Level';
        if (hardware.memory.total >= 32 && hardware.gpu.vram >= 16) {
            systemClass = 'High End';
        } else if (hardware.memory.total >= 16 && hardware.gpu.vram >= 8) {
            systemClass = 'Mid Range';
        } else if (hardware.memory.total >= 8) {
            systemClass = 'Budget';
        }

        return {
            grade,
            systemClass,
            compatibleCount: compatibility.compatible.length,
            marginalCount: compatibility.marginal.length,
            incompatibleCount: compatibility.incompatible.length,
            compatiblePercent,
            marginalPercent,
            totalModels: total,
            topModel: compatibility.compatible[0]?.name || 'None',
            overallScore: Math.round((hardware.cpu.score + hardware.memory.score + hardware.gpu.score) / 3)
        };
    }

    async getOllamaInfo() {
        try {
            const status = await this.ollamaClient.checkOllamaAvailability();
            if (!status.available) {
                return { available: false, error: status.error };
            }

            const localModels = await this.ollamaClient.getLocalModels();
            const runningModels = await this.ollamaClient.getRunningModels();

            return {
                available: true,
                version: status.version,
                localModels: localModels.length,
                runningModels: runningModels.length,
                models: localModels
            };
        } catch (error) {
            return { available: false, error: error.message };
        }
    }

    async getInstallationInstructions(modelName) {
        return this.expandedModelsDatabase.getInstallationInstructions ?
            this.expandedModelsDatabase.getInstallationInstructions(modelName) :
            this.modelsDatabase.getInstallationInstructions(modelName);
    }

    async runBenchmark() {
        return await this.hardwareDetector.runQuickBenchmark();
    }

    async getSystemInfo() {
        return await this.hardwareDetector.getSystemInfo();
    }

    getAllModels() {
        return this.expandedModelsDatabase.getAllModels();
    }

    getModelsByCategory(category) {
        return this.expandedModelsDatabase.getModelsByCategory(category);
    }

    getModelsBySpecialization(specialization) {
        return this.expandedModelsDatabase.getModelsBySpecialization(specialization);
    }

    findModel(name) {
        return this.expandedModelsDatabase.findModel(name);
    }

    async getDetailedAnalysis(modelName) {
        const model = this.findModel(modelName);
        if (!model) {
            throw new Error(`Model "${modelName}" not found`);
        }

        const hardware = await this.getSystemInfo();
        const analysis = this.expandedModelsDatabase.getDetailedCompatibilityAnalysis(model, hardware);
        const performance = this.expandedModelsDatabase.estimatePerformance(model, hardware);

        return {
            model,
            hardware,
            compatibility: analysis,
            performance,
            canRun: analysis.score >= 60,
            installationInstructions: await this.getInstallationInstructions(modelName)
        };
    }

    async compareModels(modelNames) {
        const hardware = await this.getSystemInfo();
        const comparisons = [];

        for (const modelName of modelNames) {
            const model = this.findModel(modelName);
            if (model) {
                const analysis = this.expandedModelsDatabase.getDetailedCompatibilityAnalysis(model, hardware);
                const performance = this.expandedModelsDatabase.estimatePerformance(model, hardware);

                comparisons.push({
                    model,
                    compatibility: analysis,
                    performance,
                    canRun: analysis.score >= 60
                });
            }
        }


        comparisons.sort((a, b) => b.compatibility.score - a.compatibility.score);

        return {
            hardware,
            comparisons,
            recommendation: comparisons.find(c => c.canRun)?.model.name || 'None suitable'
        };
    }

    getPopularModels() {

        const popular = [
            'TinyLlama 1.1B',
            'Qwen 0.5B',
            'Gemma 3 1B',
            'Phi-3 Mini 3.8B',
            'Llama 3.2 3B',
            'Llama 3.1 8B',
            'Mistral 7B v0.3',
            'CodeLlama 7B'
        ];

        return popular.map(name => this.findModel(name)).filter(Boolean);
    }

    async exportReport(format = 'json') {
        const analysis = await this.analyze();

        if (format.toLowerCase() === 'json') {
            return JSON.stringify(analysis, null, 2);
        }

        if (format.toLowerCase() === 'text') {
            let report = `LLM Compatibility Report\n`;
            report += `Generated: ${new Date().toISOString()}\n`;
            report += `========================================\n\n`;

            report += `System Information:\n`;
            report += `- CPU: ${analysis.hardware.cpu.brand}\n`;
            report += `- RAM: ${analysis.hardware.memory.total}GB\n`;
            report += `- GPU: ${analysis.hardware.gpu.model}\n`;
            report += `- VRAM: ${analysis.hardware.gpu.vram}GB\n\n`;

            report += `Summary:\n`;
            report += `- Grade: ${analysis.summary.grade}\n`;
            report += `- System Class: ${analysis.summary.systemClass}\n`;
            report += `- Compatible Models: ${analysis.summary.compatibleCount}\n`;
            report += `- Marginal Models: ${analysis.summary.marginalCount}\n\n`;

            report += `Top Compatible Models:\n`;
            analysis.compatible.slice(0, 5).forEach((model, index) => {
                report += `${index + 1}. ${model.name} (Score: ${model.score}/100)\n`;
            });

            report += `\nRecommendations:\n`;
            analysis.recommendations.forEach((rec, index) => {
                report += `${index + 1}. ${rec}\n`;
            });

            return report;
        }

        throw new Error(`Unsupported export format: ${format}`);
    }
}

module.exports = LLMChecker;