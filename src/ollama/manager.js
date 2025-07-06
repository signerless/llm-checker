const OllamaClient = require('./client');
const { EventEmitter } = require('events');

class OllamaManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.client = new OllamaClient(options.baseURL);
        this.modelQueue = [];
        this.isProcessing = false;
        this.maxConcurrent = options.maxConcurrent || 1;
        this.autoCleanup = options.autoCleanup || true;
        this.cleanupInterval = options.cleanupInterval || 30 * 60 * 1000; // 30 minutes

        if (this.autoCleanup) {
            this.startCleanupTimer();
        }
    }

    async initializeManager() {
        try {
            const status = await this.client.checkOllamaAvailability();
            if (!status.available) {
                throw new Error(`Ollama not available: ${status.error}`);
            }

            this.emit('initialized', status);
            return status;
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    async installModel(modelName, options = {}) {
        return new Promise((resolve, reject) => {
            const task = {
                type: 'install',
                modelName,
                options,
                resolve,
                reject,
                progress: options.onProgress || (() => {})
            };

            this.modelQueue.push(task);
            this.processQueue();
        });
    }

    async removeModel(modelName) {
        return new Promise((resolve, reject) => {
            const task = {
                type: 'remove',
                modelName,
                resolve,
                reject
            };

            this.modelQueue.push(task);
            this.processQueue();
        });
    }

    async updateModel(modelName) {
        // Update is essentially a re-pull
        return this.installModel(modelName, { force: true });
    }

    async processQueue() {
        if (this.isProcessing || this.modelQueue.length === 0) {
            return;
        }

        this.isProcessing = true;
        const task = this.modelQueue.shift();

        try {
            this.emit('taskStarted', { type: task.type, model: task.modelName });

            let result;
            if (task.type === 'install') {
                result = await this.client.pullModel(task.modelName, task.progress);
            } else if (task.type === 'remove') {
                result = await this.client.deleteModel(task.modelName);
            }

            this.emit('taskCompleted', { type: task.type, model: task.modelName, result });
            task.resolve(result);
        } catch (error) {
            this.emit('taskFailed', { type: task.type, model: task.modelName, error });
            task.reject(error);
        }

        this.isProcessing = false;

        // Process next task
        if (this.modelQueue.length > 0) {
            setTimeout(() => this.processQueue(), 1000);
        }
    }

    async getModelStatus(modelName) {
        try {
            const localModels = await this.client.getLocalModels();
            const runningModels = await this.client.getRunningModels();

            const localModel = localModels.find(m => m.name === modelName);
            const runningModel = runningModels.find(m => m.name === modelName);

            return {
                installed: !!localModel,
                running: !!runningModel,
                details: localModel || null,
                runtime: runningModel || null
            };
        } catch (error) {
            throw new Error(`Failed to get model status: ${error.message}`);
        }
    }

    async getAllModelsStatus() {
        try {
            const [localModels, runningModels] = await Promise.all([
                this.client.getLocalModels(),
                this.client.getRunningModels()
            ]);

            const runningSet = new Set(runningModels.map(m => m.name));

            return localModels.map(model => ({
                ...model,
                running: runningSet.has(model.name),
                runtime: runningModels.find(r => r.name === model.name) || null
            }));
        } catch (error) {
            throw new Error(`Failed to get models status: ${error.message}`);
        }
    }

    async optimizeModels(hardware) {
        try {
            const modelsStatus = await this.getAllModelsStatus();
            const recommendations = [];

            // Find models that could be optimized
            for (const model of modelsStatus) {
                const analysis = await this.analyzeModelOptimization(model, hardware);
                if (analysis.canOptimize) {
                    recommendations.push(analysis);
                }
            }

            return {
                totalModels: modelsStatus.length,
                optimizable: recommendations.length,
                recommendations,
                estimatedSavings: this.calculateSavings(recommendations)
            };
        } catch (error) {
            throw new Error(`Failed to optimize models: ${error.message}`);
        }
    }

    async analyzeModelOptimization(model, hardware) {
        // Analyze if a model can be optimized (re-quantized, etc.)
        const currentQuant = model.quantization || 'Unknown';
        const modelSizeGB = model.fileSizeGB;

        // Suggest better quantization
        let suggestedQuant = currentQuant;
        let canOptimize = false;

        if (hardware.memory.total >= 32 && currentQuant === 'Q4_0') {
            suggestedQuant = 'Q5_K_M';
            canOptimize = true;
        } else if (hardware.memory.total <= 8 && currentQuant === 'Q8_0') {
            suggestedQuant = 'Q4_K_M';
            canOptimize = true;
        }

        return {
            model: model.name,
            currentQuantization: currentQuant,
            suggestedQuantization: suggestedQuant,
            currentSize: modelSizeGB,
            estimatedNewSize: canOptimize ? modelSizeGB * 0.8 : modelSizeGB,
            canOptimize,
            reason: canOptimize ?
                `Better quantization available for your hardware` :
                'Current quantization is optimal'
        };
    }

    calculateSavings(recommendations) {
        const totalCurrentSize = recommendations.reduce((sum, r) => sum + r.currentSize, 0);
        const totalNewSize = recommendations.reduce((sum, r) => sum + r.estimatedNewSize, 0);

        return {
            currentSize: Math.round(totalCurrentSize * 10) / 10,
            newSize: Math.round(totalNewSize * 10) / 10,
            saved: Math.round((totalCurrentSize - totalNewSize) * 10) / 10,
            percentage: Math.round(((totalCurrentSize - totalNewSize) / totalCurrentSize) * 100)
        };
    }

    async cleanupUnusedModels() {
        try {
            const runningModels = await this.client.getRunningModels();
            const allModels = await this.client.getLocalModels();

            // Find models not running for extended period
            const candidates = allModels.filter(model => {
                const isRunning = runningModels.some(r => r.name === model.name);
                const lastModified = new Date(model.modified);
                const daysSinceModified = (Date.now() - lastModified.getTime()) / (1000 * 60 * 60 * 24);

                return !isRunning && daysSinceModified > 30; // Not used in 30 days
            });

            this.emit('cleanupCandidatesFound', candidates);

            return {
                totalModels: allModels.length,
                runningModels: runningModels.length,
                cleanupCandidates: candidates.length,
                candidates: candidates.map(m => ({
                    name: m.name,
                    size: m.fileSizeGB,
                    lastUsed: m.modified
                }))
            };
        } catch (error) {
            throw new Error(`Failed to cleanup analysis: ${error.message}`);
        }
    }

    async performCleanup(modelNames) {
        const results = [];

        for (const modelName of modelNames) {
            try {
                await this.removeModel(modelName);
                results.push({ model: modelName, success: true });
                this.emit('modelCleaned', modelName);
            } catch (error) {
                results.push({ model: modelName, success: false, error: error.message });
                this.emit('cleanupError', { model: modelName, error });
            }
        }

        return results;
    }

    async benchmarkModel(modelName, options = {}) {
        const testPrompts = options.prompts || [
            "Hello, how are you?",
            "Explain quantum computing in simple terms.",
            "Write a short Python function to sort a list."
        ];

        const results = [];

        for (const prompt of testPrompts) {
            try {
                const result = await this.client.testModelPerformance(modelName, prompt);
                results.push({
                    prompt: prompt.substring(0, 50) + (prompt.length > 50 ? '...' : ''),
                    ...result
                });
            } catch (error) {
                results.push({
                    prompt: prompt.substring(0, 50) + (prompt.length > 50 ? '...' : ''),
                    success: false,
                    error: error.message
                });
            }
        }

        // Calculate averages
        const successful = results.filter(r => r.success);
        const avgTokensPerSecond = successful.length > 0 ?
            successful.reduce((sum, r) => sum + r.tokensPerSecond, 0) / successful.length : 0;
        const avgResponseTime = successful.length > 0 ?
            successful.reduce((sum, r) => sum + r.responseTime, 0) / successful.length : 0;

        return {
            model: modelName,
            testCount: testPrompts.length,
            successfulTests: successful.length,
            failedTests: results.length - successful.length,
            averageTokensPerSecond: Math.round(avgTokensPerSecond * 10) / 10,
            averageResponseTime: Math.round(avgResponseTime),
            detailedResults: results
        };
    }

    startCleanupTimer() {
        setInterval(async () => {
            try {
                const analysis = await this.cleanupUnusedModels();
                if (analysis.cleanupCandidates > 0) {
                    this.emit('cleanupSuggested', analysis);
                }
            } catch (error) {
                this.emit('error', error);
            }
        }, this.cleanupInterval);
    }

    async getStatistics() {
        try {
            const [localModels, runningModels] = await Promise.all([
                this.client.getLocalModels(),
                this.client.getRunningModels()
            ]);

            const totalSize = localModels.reduce((sum, m) => sum + m.fileSizeGB, 0);
            const avgSize = localModels.length > 0 ? totalSize / localModels.length : 0;

            // Group by quantization
            const quantizationStats = {};
            localModels.forEach(model => {
                const quant = model.quantization || 'Unknown';
                quantizationStats[quant] = (quantizationStats[quant] || 0) + 1;
            });

            // Group by family
            const familyStats = {};
            localModels.forEach(model => {
                const family = model.family || 'Unknown';
                familyStats[family] = (familyStats[family] || 0) + 1;
            });

            return {
                total: localModels.length,
                running: runningModels.length,
                totalSizeGB: Math.round(totalSize * 10) / 10,
                averageSizeGB: Math.round(avgSize * 10) / 10,
                quantizationBreakdown: quantizationStats,
                familyBreakdown: familyStats,
                queueLength: this.modelQueue.length,
                isProcessing: this.isProcessing
            };
        } catch (error) {
            throw new Error(`Failed to get statistics: ${error.message}`);
        }
    }

    destroy() {
        // Clean up resources
        this.removeAllListeners();
        this.modelQueue = [];
        this.isProcessing = false;
    }
}

module.exports = OllamaManager;