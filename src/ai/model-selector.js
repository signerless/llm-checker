const path = require('path');
const fs = require('fs');

class AIModelSelector {
    constructor() {
        this.aiSelectorPath = path.join(__dirname, '../../ml-model/js');
        this.isAvailable = this.checkAvailability();
    }

    checkAvailability() {
        try {
            const indexPath = path.join(this.aiSelectorPath, 'index.js');
            return fs.existsSync(indexPath);
        } catch {
            return false;
        }
    }

    async initialize() {
        if (!this.isAvailable) {
            throw new Error('AI Model Selector not available. Please train the model first.');
        }

        try {
            const AISelector = require(path.join(this.aiSelectorPath, 'index.js'));
            this.selector = new AISelector();
            await this.selector.initialize();
            return true;
        } catch (error) {
            throw new Error(`Failed to initialize AI selector: ${error.message}`);
        }
    }

    async selectBestModel(candidateModels, systemSpecs = null) {
        if (!this.isAvailable) {
            return this.fallbackSelection(candidateModels, systemSpecs);
        }

        try {
            if (!this.selector) {
                await this.initialize();
            }

            const result = await this.selector.predictBestModel(candidateModels, systemSpecs);
            
            return {
                bestModel: result.bestModel,
                confidence: result.allPredictions[0]?.score || 0,
                allPredictions: result.allPredictions,
                method: 'ai',
                systemSpecs: result.systemSpecs
            };

        } catch (error) {
            console.warn(`AI selection failed: ${error.message}`);
            return this.fallbackSelection(candidateModels, systemSpecs);
        }
    }

    fallbackSelection(candidateModels, systemSpecs = null) {
        if (!systemSpecs) {
            systemSpecs = {
                total_ram_gb: 8,
                gpu_vram_gb: 0,
                cpu_cores: 4
            };
        }

        // Simple heuristic: pick largest model that fits in memory
        const availableMemory = systemSpecs.gpu_vram_gb > 0 ? 
            systemSpecs.gpu_vram_gb : 
            systemSpecs.total_ram_gb * 0.7;

        const modelSizes = candidateModels.map(model => ({
            model,
            size: this.estimateModelSize(model),
            memoryReq: this.estimateModelSize(model) * 1.2
        }));

        const suitableModels = modelSizes
            .filter(m => m.memoryReq <= availableMemory)
            .sort((a, b) => b.size - a.size);

        const bestModel = suitableModels.length > 0 ? 
            suitableModels[0].model : 
            modelSizes.reduce((a, b) => a.size < b.size ? a : b).model;

        return {
            bestModel,
            confidence: suitableModels.length > 0 ? 0.8 : 0.5,
            method: 'heuristic',
            reason: suitableModels.length > 0 ? 
                'Best fitting model for available memory' : 
                'Smallest available model (safety fallback)',
            systemSpecs
        };
    }

    estimateModelSize(modelId) {
        const sizeMatch = modelId.match(/(\d+\.?\d*)[kmb]/i);
        if (sizeMatch) {
            const num = parseFloat(sizeMatch[1]);
            const unit = sizeMatch[0].slice(-1).toLowerCase();
            
            if (unit === 'k') return num / 1000;
            if (unit === 'm') return num / 1000;
            if (unit === 'b') return num;
        }
        
        // Default sizes for common model names
        if (modelId.includes('mini')) return 3.8;
        if (modelId.includes('7b')) return 7;
        if (modelId.includes('13b')) return 13;
        if (modelId.includes('70b')) return 70;
        
        return 7; // Safe default
    }

    async benchmarkModel(modelId) {
        // This would interface with the Python benchmarking script
        const { spawn } = require('child_process');
        
        return new Promise((resolve, reject) => {
            const benchmark = spawn('python', [
                path.join(__dirname, '../../ml-model/python/benchmark_collector.py'),
                '--single-model', modelId
            ]);

            let output = '';
            let error = '';

            benchmark.stdout.on('data', (data) => output += data);
            benchmark.stderr.on('data', (data) => error += data);

            benchmark.on('close', (code) => {
                if (code === 0) {
                    resolve({ success: true, data: output });
                } else {
                    reject(new Error(`Benchmark failed: ${error}`));
                }
            });
        });
    }

    getTrainingStatus() {
        const modelPath = path.join(__dirname, '../../ml-model/trained/model_quantized.onnx');
        const metadataPath = path.join(__dirname, '../../ml-model/trained/metadata.json');
        
        const hasModel = fs.existsSync(modelPath);
        const hasMetadata = fs.existsSync(metadataPath);
        
        if (hasModel && hasMetadata) {
            try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                const modelStats = fs.statSync(modelPath);
                
                return {
                    status: 'trained',
                    modelSize: Math.round(modelStats.size / 1024), // KB
                    version: metadata.model_version || '1.0',
                    features: metadata.feature_count || 0,
                    lastUpdated: modelStats.mtime.toISOString()
                };
            } catch {
                return { status: 'corrupted' };
            }
        }
        
        return { status: 'not_trained' };
    }
}

module.exports = AIModelSelector;