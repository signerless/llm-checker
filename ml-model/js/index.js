const fs = require('fs');
const path = require('path');

// Try to load optional dependencies
let ort = null;
let si = null;

try {
    ort = require('onnxruntime-node');
} catch (e) {
    console.warn('ONNX Runtime not available, using fallback mode');
}

try {
    si = require('systeminformation');
} catch (e) {
    console.warn('systeminformation not available, using basic system detection');
}

class AIModelSelector {
    constructor() {
        this.session = null;
        this.metadata = null;
        this.scaler = null;
        this.encoders = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        if (!ort) {
            throw new Error('ONNX Runtime not available. Install with: npm install onnxruntime-node');
        }

        try {
            // Load metadata
            const metadataPath = path.join(__dirname, '../trained/metadata.json');
            if (!fs.existsSync(metadataPath)) {
                throw new Error('Model metadata not found. Please train the model first.');
            }
            
            this.metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

            // Load ONNX model
            const modelPath = path.join(__dirname, '../trained/model_quantized.onnx');
            if (!fs.existsSync(modelPath)) {
                throw new Error('ONNX model not found. Please train the model first.');
            }

            this.session = await ort.InferenceSession.create(modelPath);

            // Load preprocessing objects (simplified - we'll implement basic versions)
            this.scaler = this.loadScaler();
            this.encoders = this.loadEncoders();

            this.initialized = true;
            console.log('✅ AI Model Selector initialized successfully');

        } catch (error) {
            console.error('❌ Failed to initialize AI Model Selector:', error.message);
            throw error;
        }
    }

    loadScaler() {
        // Simplified scaler implementation
        // In production, you'd load the actual joblib scaler
        return {
            mean: [7.2, 3.2, 16.5, 8.2, 0], // Default values
            scale: [10.1, 1.1, 15.2, 12.1, 1],
            transform: function(data) {
                return data.map((value, index) => {
                    return (value - this.mean[index]) / this.scale[index];
                });
            }
        };
    }

    loadEncoders() {
        // Simplified label encoders
        // In production, you'd load the actual joblib encoders
        return {
            model_id: {
                'llama2:7b': 0, 'llama2:13b': 1, 'llama2:70b': 2,
                'mistral:7b': 3, 'phi3:mini': 4, 'gemma:7b': 5,
                'codellama:7b': 6, 'deepseek-coder:6.7b': 7
            },
            gpu_model_normalized: {
                'cpu_only': 0, 'rtx_4090': 1, 'rtx_4080': 2, 'rtx_4070': 3,
                'rtx_3090': 4, 'rtx_3080': 5, 'apple_silicon': 6, 'nvidia_gpu_other': 7
            },
            hw_platform: {
                'Darwin': 0, 'Linux': 1, 'Windows': 2
            },
            ram_tier: {
                'low': 0, 'medium': 1, 'high': 2, 'very_high': 3, 'extreme': 4
            },
            cpu_tier: {
                'low': 0, 'medium': 1, 'high': 2, 'very_high': 3, 'extreme': 4
            },
            vram_tier: {
                'none': 0, 'low': 1, 'medium': 2, 'high': 3, 'very_high': 4, 'extreme': 5
            }
        };
    }

    async getSystemSpecs() {
        if (si) {
            try {
                const [cpu, mem, graphics, osInfo] = await Promise.all([
                    si.cpu(),
                    si.mem(),
                    si.graphics(),
                    si.osInfo()
                ]);

                const specs = {
                    cpu_cores: cpu.cores || 4,
                    cpu_freq_max: (cpu.speed || 3000) / 1000, // Convert to GHz
                    total_ram_gb: (mem.total || 8 * 1024 * 1024 * 1024) / (1024 ** 3),
                    platform: osInfo.platform || 'unknown'
                };

                // GPU detection
                let gpu_model = 'cpu_only';
                let gpu_vram_gb = 0;

                if (graphics.controllers && graphics.controllers.length > 0) {
                    const gpu = graphics.controllers[0];
                    const model = (gpu.model || '').toLowerCase();
                    
                    if (model.includes('rtx 4090')) gpu_model = 'rtx_4090';
                    else if (model.includes('rtx 4080')) gpu_model = 'rtx_4080';
                    else if (model.includes('rtx 4070')) gpu_model = 'rtx_4070';
                    else if (model.includes('rtx 3090')) gpu_model = 'rtx_3090';
                    else if (model.includes('rtx 3080')) gpu_model = 'rtx_3080';
                    else if (model.includes('apple')) gpu_model = 'apple_silicon';
                    else if (model.includes('nvidia') || model.includes('geforce')) gpu_model = 'nvidia_gpu_other';

                    gpu_vram_gb = (gpu.vram || 0) / 1024; // Convert MB to GB
                    
                    // Special case for Apple Silicon - use unified memory
                    if (gpu_model === 'apple_silicon') {
                        gpu_vram_gb = specs.total_ram_gb * 0.75; // Assume 75% available
                    }
                }

                specs.gpu_model_normalized = gpu_model;
                specs.gpu_vram_gb = gpu_vram_gb;

                // Create tiers
                specs.ram_tier = this.getRamTier(specs.total_ram_gb);
                specs.cpu_tier = this.getCpuTier(specs.cpu_cores);
                specs.vram_tier = this.getVramTier(specs.gpu_vram_gb);

                return specs;

            } catch (error) {
                console.error('Error getting system specs:', error);
            }
        }

        // Fallback to basic detection
        const os = require('os');
        const platform = os.platform();
        const totalMem = os.totalmem() / (1024 ** 3); // GB
        const cpuCount = os.cpus().length;

        const specs = {
            cpu_cores: cpuCount,
            cpu_freq_max: 3.0, // Default
            total_ram_gb: totalMem,
            gpu_model_normalized: platform === 'darwin' ? 'apple_silicon' : 'cpu_only',
            gpu_vram_gb: platform === 'darwin' ? totalMem * 0.75 : 0,
            platform: platform
        };

        specs.ram_tier = this.getRamTier(specs.total_ram_gb);
        specs.cpu_tier = this.getCpuTier(specs.cpu_cores);
        specs.vram_tier = this.getVramTier(specs.gpu_vram_gb);

        return specs;
    }

    getRamTier(ramGB) {
        if (ramGB <= 8) return 'low';
        if (ramGB <= 16) return 'medium';
        if (ramGB <= 32) return 'high';
        if (ramGB <= 64) return 'very_high';
        return 'extreme';
    }

    getCpuTier(cores) {
        if (cores <= 4) return 'low';
        if (cores <= 8) return 'medium';
        if (cores <= 16) return 'high';
        if (cores <= 32) return 'very_high';
        return 'extreme';
    }

    getVramTier(vramGB) {
        if (vramGB <= 0) return 'none';
        if (vramGB <= 4) return 'low';
        if (vramGB <= 8) return 'medium';
        if (vramGB <= 16) return 'high';
        if (vramGB <= 24) return 'very_high';
        return 'extreme';
    }

    getModelSize(modelId) {
        // Extract model size from ID
        const sizeMatch = modelId.match(/(\d+\.?\d*)[kmb]/i);
        if (sizeMatch) {
            const num = parseFloat(sizeMatch[1]);
            const unit = sizeMatch[0].slice(-1).toLowerCase();
            
            if (unit === 'k') return num / 1000;
            if (unit === 'm') return num / 1000;
            if (unit === 'b') return num;
        }
        
        // Default sizes for common models
        if (modelId.includes('mini')) return 3.8;
        if (modelId.includes('7b')) return 7;
        if (modelId.includes('13b')) return 13;
        if (modelId.includes('70b')) return 70;
        
        return 7; // Default
    }

    encodeFeatures(specs, modelId) {
        const features = {};

        // Categorical features
        const categoricalFeatures = this.metadata.categorical_features;
        
        for (const feature of categoricalFeatures) {
            let value;
            
            if (feature === 'model_id') {
                value = this.encoders[feature][modelId] || 0;
            } else if (feature === 'gpu_model_normalized') {
                value = this.encoders[feature][specs.gpu_model_normalized] || 0;
            } else if (feature === 'hw_platform') {
                value = this.encoders[feature][specs.platform] || 0;
            } else if (feature === 'ram_tier') {
                value = this.encoders[feature][specs.ram_tier] || 1;
            } else if (feature === 'cpu_tier') {
                value = this.encoders[feature][specs.cpu_tier] || 1;
            } else if (feature === 'vram_tier') {
                value = this.encoders[feature][specs.vram_tier] || 0;
            } else {
                value = 0;
            }
            
            features[feature] = new ort.Tensor('int32', [value], [1]);
        }

        // Numerical features
        const numericalData = [
            this.getModelSize(modelId),
            specs.cpu_cores,
            specs.cpu_freq_max,
            specs.total_ram_gb,
            specs.gpu_vram_gb
        ];

        // Apply scaling
        const scaledData = this.scaler.transform(numericalData);
        
        const numericalFeatures = this.metadata.numerical_features;
        for (let i = 0; i < numericalFeatures.length; i++) {
            const feature = numericalFeatures[i];
            features[feature] = new ort.Tensor('float32', [scaledData[i]], [1, 1]);
        }

        return features;
    }

    async predictBestModel(modelCandidates, specs = null) {
        if (!this.initialized) {
            await this.initialize();
        }

        if (!specs) {
            specs = await this.getSystemSpecs();
        }

        const predictions = [];

        for (const modelId of modelCandidates) {
            try {
                const features = this.encodeFeatures(specs, modelId);
                const result = await this.session.run(features);
                
                const outputTensor = result[Object.keys(result)[0]];
                const score = outputTensor.data[0];
                
                predictions.push({
                    model: modelId,
                    score: score,
                    size: this.getModelSize(modelId)
                });
                
            } catch (error) {
                console.warn(`Warning: Failed to predict for ${modelId}:`, error.message);
                // Add with low score as fallback
                predictions.push({
                    model: modelId,
                    score: 0.1,
                    size: this.getModelSize(modelId)
                });
            }
        }

        // Sort by score (descending)
        predictions.sort((a, b) => b.score - a.score);

        return {
            bestModel: predictions[0]?.model || modelCandidates[0],
            allPredictions: predictions,
            systemSpecs: specs
        };
    }

    // Fallback heuristic method
    selectModelHeuristic(modelCandidates, specs = null) {
        console.log('🔄 Using fallback heuristic selection...');
        
        if (!specs) {
            // Use simplified specs if not provided
            specs = {
                total_ram_gb: 8,
                gpu_vram_gb: 0,
                cpu_cores: 4
            };
        }

        // Simple heuristic based on available memory
        const availableMemory = specs.gpu_vram_gb > 0 ? 
            specs.gpu_vram_gb : specs.total_ram_gb * 0.7; // 70% of RAM for CPU-only

        const suitableModels = modelCandidates
            .map(model => ({
                model,
                size: this.getModelSize(model),
                memoryReq: this.getModelSize(model) * 1.2 // Rough estimate
            }))
            .filter(m => m.memoryReq <= availableMemory)
            .sort((a, b) => b.size - a.size); // Prefer larger models that fit

        const bestModel = suitableModels.length > 0 ? 
            suitableModels[0].model : 
            modelCandidates.reduce((a, b) => 
                this.getModelSize(a) < this.getModelSize(b) ? a : b
            );

        return {
            bestModel,
            method: 'heuristic',
            systemSpecs: specs,
            reason: suitableModels.length > 0 ? 
                'Best fitting model for available memory' : 
                'Smallest available model (fallback)'
        };
    }
}

module.exports = AIModelSelector;