class PerformanceAnalyzer {
    constructor() {
        this.benchmarkCache = new Map();
        this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 horas
    }

    async analyzeSystemPerformance(hardware) {
        const cacheKey = this.generateCacheKey(hardware);
        const cached = this.benchmarkCache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
            return cached.data;
        }

        const performance = {
            cpu: await this.analyzeCPUPerformance(hardware.cpu),
            memory: await this.analyzeMemoryPerformance(hardware.memory),
            gpu: await this.analyzeGPUPerformance(hardware.gpu),
            storage: await this.analyzeStoragePerformance(),
            overall: 0
        };

        // Calculate overall score
        performance.overall = Math.round(
            (performance.cpu.score * 0.3 +
                performance.memory.score * 0.25 +
                performance.gpu.score * 0.35 +
                performance.storage.score * 0.1)
        );

        // Cache results
        this.benchmarkCache.set(cacheKey, {
            data: performance,
            timestamp: Date.now()
        });

        return performance;
    }

    async analyzeCPUPerformance(cpu) {
        const analysis = {
            score: cpu.score || 50,
            details: {
                cores: cpu.cores,
                threads: cpu.physicalCores * 2, // Assume hyperthreading
                speed: cpu.speedMax || cpu.speed,
                architecture: cpu.architecture,
                cache: cpu.cache
            },
            benchmarks: {},
            strengths: [],
            weaknesses: [],
            recommendations: []
        };

        // Run CPU benchmarks
        try {
            analysis.benchmarks = await this.runCPUBenchmarks();
        } catch (error) {
            analysis.benchmarks = { error: error.message };
        }

        // Analyze strengths and weaknesses
        this.analyzeCPUCharacteristics(analysis);

        return analysis;
    }

    async runCPUBenchmarks() {
        const results = {};

        // Single-threaded performance test
        const singleThreadStart = process.hrtime.bigint();
        let result = 0;
        for (let i = 0; i < 1000000; i++) {
            result += Math.sqrt(i) * Math.sin(i);
        }
        const singleThreadEnd = process.hrtime.bigint();
        results.singleThread = {
            duration: Number(singleThreadEnd - singleThreadStart) / 1000000, // ms
            score: Math.max(0, 1000 - (Number(singleThreadEnd - singleThreadStart) / 1000000))
        };

        // Multi-threaded performance test (simulate with Promise.all)
        const multiThreadStart = process.hrtime.bigint();
        const workers = Array.from({ length: 4 }, () =>
            Promise.resolve().then(() => {
                let result = 0;
                for (let i = 0; i < 250000; i++) {
                    result += Math.sqrt(i) * Math.sin(i);
                }
                return result;
            })
        );
        await Promise.all(workers);
        const multiThreadEnd = process.hrtime.bigint();
        results.multiThread = {
            duration: Number(multiThreadEnd - multiThreadStart) / 1000000, // ms
            score: Math.max(0, 1000 - (Number(multiThreadEnd - multiThreadStart) / 1000000))
        };

        // Memory bandwidth test
        const memBandwidthStart = process.hrtime.bigint();
        const largeArray = new Array(1000000).fill(0);
        for (let i = 0; i < largeArray.length; i++) {
            largeArray[i] = Math.random();
        }
        largeArray.sort();
        const memBandwidthEnd = process.hrtime.bigint();
        results.memoryBandwidth = {
            duration: Number(memBandwidthEnd - memBandwidthStart) / 1000000, // ms
            score: Math.max(0, 2000 - (Number(memBandwidthEnd - memBandwidthStart) / 1000000))
        };

        return results;
    }

    analyzeCPUCharacteristics(analysis) {
        const { details, benchmarks } = analysis;

        // Strengths
        if (details.cores >= 8) {
            analysis.strengths.push('High core count suitable for parallel processing');
        }
        if (details.speed >= 3.5) {
            analysis.strengths.push('High clock speed for single-threaded performance');
        }
        if (details.architecture === 'Apple Silicon') {
            analysis.strengths.push('Unified memory architecture with excellent efficiency');
        }
        if (details.cache.l3 >= 16) {
            analysis.strengths.push('Large L3 cache improves model loading performance');
        }

        // Weaknesses
        if (details.cores < 4) {
            analysis.weaknesses.push('Low core count may limit concurrent model execution');
        }
        if (details.speed < 2.5) {
            analysis.weaknesses.push('Low clock speed may impact inference speed');
        }
        if (benchmarks.singleThread?.score < 500) {
            analysis.weaknesses.push('Below-average single-threaded performance');
        }

        // Recommendations
        if (details.cores >= 8) {
            analysis.recommendations.push('Consider running multiple small models simultaneously');
        }
        if (details.architecture === 'Apple Silicon') {
            analysis.recommendations.push('Use llama.cpp with Metal acceleration for optimal performance');
        }
        if (details.cores < 6) {
            analysis.recommendations.push('Focus on smaller models (1B-7B parameters)');
        }
    }

    async analyzeMemoryPerformance(memory) {
        const analysis = {
            score: memory.score || 50,
            details: {
                total: memory.total,
                available: memory.free,
                usage: memory.usagePercent,
                type: 'Unknown' // Would need additional detection
            },
            characteristics: {},
            recommendations: []
        };

        // Memory characteristics analysis
        this.analyzeMemoryCharacteristics(analysis);

        return analysis;
    }

    analyzeMemoryCharacteristics(analysis) {
        const { details } = analysis;

        // Memory adequacy for different model sizes
        analysis.characteristics = {
            ultraSmall: details.total >= 2,
            small: details.total >= 8,
            medium: details.total >= 16,
            large: details.total >= 32,
            ultraLarge: details.total >= 64
        };

        // Recommendations based on memory
        if (details.total < 8) {
            analysis.recommendations.push('Upgrade to 16GB+ RAM for better model compatibility');
            analysis.recommendations.push('Use aggressive quantization (Q2_K, Q3_K_M)');
        } else if (details.total < 16) {
            analysis.recommendations.push('Current RAM suitable for small-medium models');
            analysis.recommendations.push('Consider 32GB for large model flexibility');
        } else if (details.total >= 32) {
            analysis.recommendations.push('Excellent RAM capacity for most models');
            analysis.recommendations.push('Can run multiple models simultaneously');
        }

        if (details.usage > 80) {
            analysis.recommendations.push('High memory usage - close unnecessary applications');
            analysis.recommendations.push('Consider memory optimization tools');
        }
    }

    async analyzeGPUPerformance(gpu) {
        const analysis = {
            score: gpu.score || 0,
            details: {
                model: gpu.model,
                vram: gpu.vram,
                dedicated: gpu.dedicated,
                vendor: gpu.vendor
            },
            capabilities: {},
            recommendations: []
        };

        // GPU capabilities analysis
        this.analyzeGPUCapabilities(analysis);

        return analysis;
    }

    analyzeGPUCapabilities(analysis) {
        const { details } = analysis;

        // VRAM adequacy for different model sizes
        analysis.capabilities = {
            acceleratesSmall: details.vram >= 4 && details.dedicated,
            acceleratesMedium: details.vram >= 8 && details.dedicated,
            acceleratesLarge: details.vram >= 16 && details.dedicated,
            acceleratesUltraLarge: details.vram >= 24 && details.dedicated
        };

        // GPU-specific recommendations
        if (!details.dedicated) {
            analysis.recommendations.push('Integrated GPU detected - CPU inference recommended');
            analysis.recommendations.push('Consider dedicated GPU for significant speedup');
        } else if (details.vram < 4) {
            analysis.recommendations.push('Limited VRAM - focus on CPU inference or small models');
        } else if (details.vram >= 8) {
            analysis.recommendations.push('Good VRAM capacity for GPU-accelerated inference');
            analysis.recommendations.push('Enable GPU acceleration in llama.cpp or Ollama');
        }

        if (details.vendor === 'NVIDIA' && details.dedicated) {
            analysis.recommendations.push('NVIDIA GPU detected - CUDA acceleration available');
        } else if (details.vendor === 'AMD' && details.dedicated) {
            analysis.recommendations.push('AMD GPU detected - ROCm acceleration may be available');
        }
    }

    async analyzeStoragePerformance() {
        const analysis = {
            score: 70, // Default assumption of SSD
            details: {
                type: 'Unknown',
                estimatedSpeed: 'Unknown'
            },
            impact: {},
            recommendations: []
        };

        // Storage impact on model loading
        analysis.impact = {
            modelLoadTime: 'Moderate', // Would be faster with NVMe
            swapPerformance: 'Adequate',
            tempFileAccess: 'Good'
        };

        // Storage recommendations
        analysis.recommendations.push('SSD storage recommended for faster model loading');
        analysis.recommendations.push('NVMe storage provides best performance for large models');
        analysis.recommendations.push('Ensure sufficient free space for model downloads');

        return analysis;
    }

    async estimateModelPerformance(model, hardware) {
        // Use realistic estimation that considers hardware type properly
        return this.calculateRealisticPerformance(model, hardware);
    }
    
    calculateRealisticPerformance(model, hardware) {
        // Parse model size
        const modelSizeB = this.parseModelSize(model.size);
        
        // Get hardware specifics  
        const cpuModel = hardware.cpu?.brand || hardware.cpu?.model || '';
        const gpuModel = hardware.gpu?.model || '';
        const cores = hardware.cpu?.physicalCores || hardware.cpu?.cores || 1;
        const baseSpeed = hardware.cpu?.speed || 2.4;
        const vramGB = hardware.gpu?.vram || 0;
        const memoryTotal = hardware.memory?.total || 8;
        
        // Hardware type detection
        const isAppleSilicon = hardware.cpu?.architecture === 'Apple Silicon' || (
            process.platform === 'darwin' && (
                gpuModel.toLowerCase().includes('apple') || 
                gpuModel.toLowerCase().includes('m1') || 
                gpuModel.toLowerCase().includes('m2') || 
                gpuModel.toLowerCase().includes('m3') || 
                gpuModel.toLowerCase().includes('m4')
            )
        );
        const isIntegratedGPU = /iris.*xe|iris.*graphics|uhd.*graphics|vega.*integrated|radeon.*graphics/i.test(gpuModel);
        const hasDedicatedGPU = vramGB > 0 && !isIntegratedGPU && !isAppleSilicon;
        
        let tokensPerSecond;
        
        if (isAppleSilicon) {
            // Apple Silicon - realistic but optimistic due to unified memory
            let baseTPS = 20; // More realistic baseline
            if (gpuModel.toLowerCase().includes('m4 pro')) baseTPS = 30;
            else if (gpuModel.toLowerCase().includes('m4')) baseTPS = 25;
            else if (gpuModel.toLowerCase().includes('m3 pro')) baseTPS = 28;
            else if (gpuModel.toLowerCase().includes('m3')) baseTPS = 22;
            else if (gpuModel.toLowerCase().includes('m2 pro')) baseTPS = 25;
            else if (gpuModel.toLowerCase().includes('m2')) baseTPS = 20;
            else if (gpuModel.toLowerCase().includes('m1 pro')) baseTPS = 22;
            else if (gpuModel.toLowerCase().includes('m1')) baseTPS = 18;
            
            // Memory scaling for Apple Silicon
            if (memoryTotal >= 64) baseTPS *= 1.2;
            else if (memoryTotal >= 32) baseTPS *= 1.1;
            
            tokensPerSecond = Math.max(6, Math.round(baseTPS / Math.max(0.7, modelSizeB)));
            
        } else if (hasDedicatedGPU) {
            // Dedicated GPU - much better but still realistic
            let gpuTPS = 25;
            if (gpuModel.toLowerCase().includes('rtx 50')) gpuTPS = 60;
            else if (gpuModel.toLowerCase().includes('rtx 40')) gpuTPS = 45;
            else if (gpuModel.toLowerCase().includes('rtx 30')) gpuTPS = 35;
            else if (gpuModel.toLowerCase().includes('rtx 20')) gpuTPS = 28;
            else if (vramGB >= 16) gpuTPS = 40;
            else if (vramGB >= 8) gpuTPS = 30;
            else if (vramGB >= 4) gpuTPS = 25;
            
            tokensPerSecond = Math.max(8, Math.round(gpuTPS / Math.max(0.4, modelSizeB)));
            
        } else {
            // CPU-only or integrated GPU - most conservative and realistic
            const hasAVX512 = cpuModel.toLowerCase().includes('intel') && 
                             (cpuModel.includes('12th') || cpuModel.includes('13th') || cpuModel.includes('14th'));
            const hasAVX2 = cpuModel.toLowerCase().includes('intel') || cpuModel.toLowerCase().includes('amd');
            
            // Base CPU performance - very conservative
            let cpuK = 1.2; // Much more realistic
            if (hasAVX512) cpuK = 2.0;
            else if (hasAVX2) cpuK = 1.6;
            
            // Threading efficiency (realistic diminishing returns)
            const effectiveThreads = Math.min(cores, 6); // CPU inference doesn't scale linearly
            
            // iGPU small boost
            const iGpuMultiplier = isIntegratedGPU ? 1.2 : 1.0;
            
            // Memory pressure factor
            const memoryPressure = Math.min(1.0, Math.max(0.6, memoryTotal / (modelSizeB * 2)));
            
            const baseTPS = (cpuK * baseSpeed * effectiveThreads * iGpuMultiplier * memoryPressure) / Math.max(2.0, modelSizeB);
            
            // Realistic CPU caps based on hardware
            const maxCPUTPS = hasAVX512 ? 18 : (isIntegratedGPU ? 12 : 8);
            tokensPerSecond = Math.max(1, Math.min(maxCPUTPS, Math.round(baseTPS)));
        }

        return {
            estimatedTokensPerSecond: Math.round(tokensPerSecond),
            confidence: this.calculateConfidence(hardware, model),
            factors: {
                cpu: cpuModel,
                memory: memoryTotal,
                gpu: hasDedicatedGPU ? 'dedicated' : (isIntegratedGPU ? 'integrated' : 'cpu_only'),
                modelSize: modelSizeB,
                architecture: isAppleSilicon ? 'Apple Silicon' : 'x86'
            },
            category: this.categorizePerformance(Math.round(tokensPerSecond)),
            loadTimeEstimate: this.estimateLoadTime(model, hardware)
        };
    }

    parseModelSize(sizeString) {
        const match = sizeString.match(/(\d+\.?\d*)[BM]/i);
        if (!match) return 1;

        const num = parseFloat(match[1]);
        const unit = match[0].slice(-1).toUpperCase();

        return unit === 'B' ? num : num / 1000; // Convert M to B
    }

    calculateConfidence(hardware, model) {
        let confidence = 50; // Base confidence

        // Higher confidence for better documented hardware
        if (hardware.cpu.score > 70) confidence += 20;
        if (hardware.memory.total >= 16) confidence += 15;
        if (hardware.gpu.dedicated) confidence += 10;

        // Lower confidence for edge cases
        if (hardware.memory.total < 4) confidence -= 30;
        if (!model.requirements) confidence -= 20;

        return Math.max(10, Math.min(90, confidence));
    }

    categorizePerformance(tokensPerSecond) {
        if (tokensPerSecond >= 50) return 'excellent';
        if (tokensPerSecond >= 25) return 'good';
        if (tokensPerSecond >= 10) return 'moderate';
        if (tokensPerSecond >= 5) return 'slow';
        return 'very_slow';
    }

    estimateLoadTime(model, hardware) {
        const modelSizeGB = this.parseModelSize(model.size) * 2;

        let loadTimeSeconds = modelSizeGB * 2;


        loadTimeSeconds *= 0.7;

        const cpuSpeedFactor = Math.max(0.5, Math.min(1.5, (hardware.cpu.speed || 2.5) / 2.5));
        loadTimeSeconds /= cpuSpeedFactor;


        // Load time doesn't depend on current free memory, but on total RAM vs model size
        if (hardware.memory.total < modelSizeGB * 1.5) {
            loadTimeSeconds *= 1.5; // Slower if tight on total memory
        }

        return {
            estimated: Math.round(loadTimeSeconds),
            confidence: this.calculateConfidence(hardware, model),
            factors: ['storage_speed', 'cpu_performance', 'available_memory']
        };
    }

    generateCacheKey(hardware) {
        return `${hardware.cpu.brand}-${hardware.memory.total}-${hardware.gpu.model}`;
    }

    async benchmarkInferenceSpeed(modelName, hardware, ollamaClient) {
        if (!ollamaClient) {
            throw new Error('Ollama client required for inference benchmarking');
        }

        const testPrompts = [
            "Hello, how are you today?",
            "Explain the concept of artificial intelligence in one sentence.",
            "What is 2 + 2?",
            "Write a haiku about programming.",
            "List three benefits of renewable energy."
        ];

        const results = [];

        for (const prompt of testPrompts) {
            try {
                const result = await ollamaClient.testModelPerformance(modelName, prompt);
                results.push({
                    prompt: prompt.substring(0, 30) + '...',
                    tokensPerSecond: result.tokensPerSecond,
                    responseTime: result.responseTime,
                    success: result.success
                });
            } catch (error) {
                results.push({
                    prompt: prompt.substring(0, 30) + '...',
                    tokensPerSecond: 0,
                    responseTime: 0,
                    success: false,
                    error: error.message
                });
            }
        }

        const successful = results.filter(r => r.success);
        const avgTokensPerSecond = successful.length > 0 ?
            successful.reduce((sum, r) => sum + r.tokensPerSecond, 0) / successful.length : 0;

        return {
            model: modelName,
            hardware: {
                cpu: hardware.cpu.brand,
                ram: hardware.memory.total,
                gpu: hardware.gpu.model
            },
            averageTokensPerSecond: Math.round(avgTokensPerSecond * 10) / 10,
            successRate: (successful.length / results.length) * 100,
            detailedResults: results,
            timestamp: new Date().toISOString()
        };
    }

    clearCache() {
        this.benchmarkCache.clear();
    }
}

module.exports = PerformanceAnalyzer;