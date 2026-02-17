/**
 * LLM-Checker: Deterministic Model Selection Algorithm (Spec v1.0)
 * 
 * A two-phase selector that picks the best Ollama model + quantization
 * for a given machine and task category.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DETERMINISTIC_WEIGHTS } = require('./scoring-config');

class DeterministicModelSelector {
    constructor() {
        this.catalogPath = path.join(__dirname, 'catalog.json');
        this.benchCachePath = path.join(require('os').homedir(), '.llm-checker', 'bench.json');
        
        // Quality priors table
        this.baseQualityByParams = {
            0.5: 45, 1: 45, 1.5: 45,
            2: 60, 3: 60, 4: 60,
            7: 75, 8: 75, 9: 75,
            13: 82, 14: 82, 15: 82,
            30: 89, 32: 89, 34: 89,
            70: 95, 72: 95
        };
        
        // Family quality bumps
        this.familyBumps = {
            'qwen2.5': 2,
            'deepseek': 3,
            'mistral': 1,
            'llama3.1': 1,
            'llama3.2': 2,
            'gemma2': 1,
            'phi-3': 0,
            'granite': 0,
            'solar': 0,
            'starcoder': 1,
            'minicpm': 0,
            'llava': 0
        };
        
        // Quantization penalties
        this.quantPenalties = {
            'Q8_0': 0,
            'Q6_K': -1,
            'Q5_K_M': -2,
            'Q4_K_M': -5,
            'Q3_K': -8,
            'Q2_K': -12
        };
        
        // Quantization hierarchy (best to worst)
        this.quantHierarchy = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q3_K', 'Q2_K'];
        
        // Quantization speed multipliers
        this.quantSpeedMultipliers = {
            'Q8_0': 0.8,
            'Q6_K': 0.95,
            'Q5_K_M': 1.00,
            'Q4_K_M': 1.15,
            'Q3_K': 1.25,
            'Q2_K': 1.35
        };
        
        // Backend speed constants (K)
        this.backendK = {
            'metal': 160,    // Apple Metal
            'cuda': 220,     // NVIDIA CUDA
            'cpu_x86': 70,   // CPU x86_64
            'cpu_arm': 90    // CPU ARM64
        };
        
        // Category target speeds (tokens/sec)
        this.targetSpeeds = {
            'general': 40,
            'coding': 40,
            'reasoning': 25,
            'summarization': 60,
            'reading': 60,
            'multimodal': 40,
            'embeddings': 200
        };
        
        // Category target contexts
        this.targetContexts = {
            'general': 4096,
            'coding': 8192,
            'reasoning': 8192,
            'summarization': 8192,
            'reading': 8192,
            'multimodal': 4096,
            'embeddings': 512
        };
        
        // Category scoring weights [Q, S, F, C] from centralized config
        this.categoryWeights = DETERMINISTIC_WEIGHTS;
    }

    // ============================================================================
    // PHASE 0: DATA SOURCES
    // ============================================================================

    /**
     * Hardware Profiler - Detect CPU, GPU, RAM, and acceleration support
     */
    async getHardware() {
        const hardware = {
            cpu: await this.getCPUInfo(),
            gpu: await this.getGPUInfo(),
            memory: await this.getMemoryInfo(),
            os: await this.getOSInfo(),
            acceleration: await this.getAccelerationSupport()
        };
        
        // Calculate usable memory: min(0.8 * total_ram, total_ram - 2GB)
        hardware.usableMemGB = Math.min(
            0.8 * hardware.memory.totalGB,
            hardware.memory.totalGB - 2
        );
        
        return hardware;
    }

    async getCPUInfo() {
        const os = require('os');
        return {
            architecture: os.arch(),
            cores: os.cpus().length,
            threads: os.cpus().length, // Simplified
            platform: os.platform()
        };
    }

    async getGPUInfo() {
        const cpu = await this.getCPUInfo();
        
        // Simplified GPU detection
        if (cpu.platform === 'darwin' && cpu.architecture === 'arm64') {
            return {
                type: 'apple_silicon',
                vramGB: 0, // Unified memory
                unified: true
            };
        }
        
        // TODO: Add NVIDIA/AMD detection for other platforms
        return {
            type: 'cpu_only',
            vramGB: 0,
            unified: false
        };
    }

    async getMemoryInfo() {
        const os = require('os');
        const totalBytes = os.totalmem();
        return {
            totalGB: Math.round((totalBytes / (1024**3)) * 10) / 10
        };
    }

    async getOSInfo() {
        const os = require('os');
        return {
            platform: os.platform(),
            arch: os.arch(),
            release: os.release()
        };
    }

    async getAccelerationSupport() {
        const cpu = await this.getCPUInfo();
        const gpu = await this.getGPUInfo();
        
        return {
            supports_metal: gpu.type === 'apple_silicon',
            supports_cuda: gpu.type === 'nvidia',
            supports_rocm: gpu.type === 'amd'
        };
    }

    /**
     * Local Ollama Inventory - Get installed models from `ollama list`
     */
    async getInstalledModels() {
        try {
            const models = await this.runOllamaCommand(['list']);
            const parsed = [];
            
            for (const line of models.split('\n').slice(1)) { // Skip header
                if (!line.trim()) continue;
                
                const parts = line.trim().split(/\s+/);
                if (parts.length < 3) continue;
                
                const modelName = parts[0];
                const modelId = parts[1];
                const size = parts.length >= 4 ? `${parts[2]} ${parts[3]}` : parts[2];
                
                // Get detailed info for each model
                try {
                    const details = await this.getModelDetails(modelName);
                    parsed.push({
                        ...details,
                        installed: true,
                        installedSize: size,
                        source: 'ollama_local',
                        registry: details.registry || 'ollama.com',
                        version: details.version || modelName,
                        license: details.license || 'unknown',
                        digest: details.digest || 'unknown',
                        provenance: {
                            ...(details.provenance || {}),
                            source: 'ollama_local',
                            registry: details.registry || 'ollama.com',
                            version: details.version || modelName,
                            license: details.license || 'unknown',
                            digest: details.digest || 'unknown'
                        }
                    });
                } catch (error) {
                    console.warn(`Failed to get details for ${modelName}:`, error.message);
                }
            }
            
            return parsed;
        } catch (error) {
            // Silently fail when Ollama is not available - this is expected
            return [];
        }
    }

    async getModelDetails(modelName) {
        try {
            const details = await this.runOllamaCommand(['show', modelName]);
        
        // Parse model details from ollama show output
        const meta = {
            name: modelName,
            family: this.extractFamily(modelName),
            paramsB: this.extractParams(details),
            ctxMax: this.extractContextLength(details),
            quant: this.extractQuantization(details),
            sizeGB: this.extractSizeGB(details),
            modalities: this.extractModalities(details),
            tags: this.extractTags(details),
            model_identifier: modelName,
            source: 'ollama_local',
            registry: 'ollama.com',
            version: modelName,
            license: this.extractLicense(details),
            digest: this.extractDigest(details)
        };
        meta.provenance = {
            source: meta.source,
            registry: meta.registry,
            version: meta.version,
            license: meta.license,
            digest: meta.digest
        };
        
            return meta;
        } catch (error) {
            // If Ollama is not available or model details can't be fetched, return minimal info
            return {
                name: modelName,
                family: 'unknown',
                paramsB: 0,
                ctxMax: 2048,
                quant: 'unknown',
                sizeGB: 0,
                modalities: ['text'],
                tags: [],
                model_identifier: modelName,
                source: 'ollama_local',
                registry: 'ollama.com',
                version: modelName,
                license: 'unknown',
                digest: 'unknown',
                provenance: {
                    source: 'ollama_local',
                    registry: 'ollama.com',
                    version: modelName,
                    license: 'unknown',
                    digest: 'unknown'
                },
                error: error.message
            };
        }
    }

    /**
     * Curated Catalog - Load known models from catalog.json
     */
    async loadCatalog() {
        try {
            if (!fs.existsSync(this.catalogPath)) {
                console.warn('Catalog not found, creating default...');
                await this.createDefaultCatalog();
            }
            
            const catalogData = fs.readFileSync(this.catalogPath, 'utf8');
            const catalog = JSON.parse(catalogData);
            
            return catalog.models.map(model => ({
                ...model,
                installed: false,
                source: model.source || 'static_catalog',
                registry: model.registry || 'ollama.com',
                version: model.version || model.model_identifier || model.name || 'unknown',
                license: model.license || 'unknown',
                digest: model.digest || 'unknown',
                provenance: {
                    source: model.source || 'static_catalog',
                    registry: model.registry || 'ollama.com',
                    version: model.version || model.model_identifier || model.name || 'unknown',
                    license: model.license || 'unknown',
                    digest: model.digest || 'unknown'
                }
            }));
        } catch (error) {
            console.warn('Failed to load catalog:', error.message);
            return [];
        }
    }

    async createDefaultCatalog() {
        const defaultCatalog = {
            version: "1.0",
            updated: new Date().toISOString(),
            models: [
                {
                    name: "qwen2.5-coder:0.5b",
                    family: "qwen2.5",
                    paramsB: 0.5,
                    ctxMax: 32768,
                    quant: "Q4_K_M",
                    sizeGB: 0.4,
                    modalities: ["text"],
                    tags: ["coder", "instruct"],
                    model_identifier: "qwen2.5-coder:0.5b"
                },
                {
                    name: "qwen2.5-coder:1.5b", 
                    family: "qwen2.5",
                    paramsB: 1.5,
                    ctxMax: 32768,
                    quant: "Q4_K_M",
                    sizeGB: 1.1,
                    modalities: ["text"],
                    tags: ["coder", "instruct"],
                    model_identifier: "qwen2.5-coder:1.5b"
                },
                {
                    name: "qwen2.5-coder:7b",
                    family: "qwen2.5", 
                    paramsB: 7,
                    ctxMax: 32768,
                    quant: "Q4_K_M",
                    sizeGB: 4.4,
                    modalities: ["text"],
                    tags: ["coder", "instruct"],
                    model_identifier: "qwen2.5-coder:7b"
                },
                {
                    name: "llama3.2:3b",
                    family: "llama3.2",
                    paramsB: 3,
                    ctxMax: 131072,
                    quant: "Q4_K_M", 
                    sizeGB: 2.0,
                    modalities: ["text"],
                    tags: ["instruct", "chat"],
                    model_identifier: "llama3.2:3b"
                },
                {
                    name: "llava:7b",
                    family: "llava",
                    paramsB: 7,
                    ctxMax: 4096,
                    quant: "Q4_K_M",
                    sizeGB: 4.7,
                    modalities: ["text", "vision"],
                    tags: ["multimodal", "vision"],
                    model_identifier: "llava:7b"
                }
            ]
        };
        
        // Ensure directory exists
        const dir = path.dirname(this.catalogPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(this.catalogPath, JSON.stringify(defaultCatalog, null, 2));
    }

    // ============================================================================
    // HELPER METHODS FOR PARSING OLLAMA OUTPUT  
    // ============================================================================

    extractFamily(modelName) {
        const name = modelName.toLowerCase();
        if (name.includes('qwen2.5')) return 'qwen2.5';
        if (name.includes('qwen3')) return 'qwen2.5';
        if (name.includes('qwen')) return 'qwen2.5';
        if (name.includes('deepseek')) return 'deepseek';
        if (name.includes('llama3.2') || name.includes('llama3.3')) return 'llama3.2';
        if (name.includes('llama3.1')) return 'llama3.1';
        if (name.includes('llama')) return 'llama';
        if (name.includes('mistral')) return 'mistral';
        if (name.includes('gemma')) return 'gemma2';
        if (name.includes('phi')) return 'phi-3';
        if (name.includes('llava')) return 'llava';
        if (name.includes('granite')) return 'granite';
        if (name.includes('solar')) return 'solar';
        if (name.includes('starcoder')) return 'starcoder';
        if (name.includes('minicpm')) return 'minicpm';
        return 'unknown';
    }

    extractParams(details) {
        // Look for parameter info in ollama show output
        const match = details.match(/parameters\s+(\d+\.?\d*)[BM]/i);
        if (match) {
            const num = parseFloat(match[1]);
            return match[0].toUpperCase().includes('B') ? num : num / 1000;
        }
        return 7; // Default fallback
    }

    extractContextLength(details) {
        const match = details.match(/context_length\s+(\d+)/i);
        return match ? parseInt(match[1]) : 4096;
    }

    extractQuantization(details) {
        const match = details.match(/quantization\s+(Q\d+_[A-Z0-9_]+)/i);
        return match ? match[1] : 'Q4_K_M';
    }

    extractSizeGB(details) {
        const match = details.match(/size\s+(\d+\.?\d*)\s*GB/i);
        return match ? parseFloat(match[1]) : 4.0;
    }

    extractModalities(details) {
        const modalities = ['text'];
        if (details.toLowerCase().includes('vision') || details.toLowerCase().includes('image')) {
            modalities.push('vision');
        }
        return modalities;
    }

    extractTags(details) {
        const tags = [];
        const lowerDetails = details.toLowerCase();
        
        if (lowerDetails.includes('instruct')) tags.push('instruct');
        if (lowerDetails.includes('chat')) tags.push('chat');
        if (lowerDetails.includes('code')) tags.push('coder');
        if (lowerDetails.includes('vision')) tags.push('vision');
        // Only mark as embedding if it's explicitly an embedding model
        if (lowerDetails.includes('embed-text') || 
            lowerDetails.includes('nomic-embed') || 
            lowerDetails.includes('bge-') ||
            lowerDetails.includes('all-minilm')) tags.push('embedding');
        
        return tags;
    }

    extractLicense(details) {
        const match = details.match(/license\s+([^\n\r]+)/i);
        return match ? match[1].trim().toLowerCase() : 'unknown';
    }

    extractDigest(details) {
        const match = details.match(/digest\s+([a-f0-9:]+)/i);
        return match ? match[1].trim().toLowerCase() : 'unknown';
    }

    async runOllamaCommand(args) {
        return new Promise((resolve, reject) => {
            try {
                const proc = spawn('ollama', args, { stdio: 'pipe' });
                let output = '';
                let error = '';
                
                proc.stdout.on('data', (data) => output += data);
                proc.stderr.on('data', (data) => error += data);
                
                proc.on('close', (code) => {
                    if (code === 0) {
                        resolve(output);
                    } else {
                        reject(new Error(`Ollama command failed: ${error}`));
                    }
                });
                
                proc.on('error', (err) => {
                    // Handle ENOENT and other spawn errors gracefully
                    if (err.code === 'ENOENT') {
                        reject(new Error('Ollama not found. Please install Ollama from https://ollama.ai'));
                    } else {
                        reject(new Error(`Ollama spawn error: ${err.message}`));
                    }
                });
            } catch (spawnError) {
                // Handle synchronous spawn errors
                reject(new Error(`Failed to start Ollama: ${spawnError.message}`));
            }
        });
    }

    // ============================================================================
    // PHASE 1: ESTIMATION FILTER
    // ============================================================================

    /**
     * Main model selection function
     */
    async selectModels(category = 'general', options = {}) {
        const {
            targetCtx = this.targetContexts[category],
            topN = 5,
            enableProbe = false,
            silent = false
        } = options;

        if (!silent) {
            console.log(`🔍 Selecting models for category: ${category}`);
        }
        
        // Phase 0: Gather data
        const hardware = await this.getHardware();
        const installed = await this.getInstalledModels();
        const catalog = await this.loadCatalog();
        
        if (!silent) {
            console.log(`Found ${installed.length} installed, ${catalog.length} catalog models`);
            console.log(`Hardware: ${hardware.cpu.cores} cores, ${hardware.memory.totalGB}GB RAM, ${hardware.gpu.type}`);
        }
        
        // Combine and dedupe models (prefer installed versions)
        const pool = this.combineModels(installed, catalog);
        const filtered = this.filterByCategory(pool, category);
        
        if (!silent) {
            console.log(`Evaluating ${filtered.length} models for ${category} category`);
        }
        
        // Phase 1: Estimation filter
        const candidates = [];
        const budget = hardware.gpu.unified ? hardware.usableMemGB : 
                      (hardware.gpu.vramGB || hardware.usableMemGB);

        for (const model of filtered) {
            const result = this.evaluateModel(model, hardware, category, targetCtx, budget);
            if (result) {
                candidates.push(result);
            }
        }

        // Sort by score
        candidates.sort((a, b) => b.score - a.score);
        const topCandidates = candidates.slice(0, topN);
        
        if (!silent) {
            console.log(`✨ Selected ${topCandidates.length} top candidates`);
        }

        // Phase 2: Quick probe (optional)
        if (enableProbe && topCandidates.length > 0) {
            if (!silent) {
                console.log(`🔬 Running quick probes...`);
            }
            await this.runQuickProbes(topCandidates, hardware, category);
            // Re-sort after probing
            topCandidates.sort((a, b) => b.score - a.score);
        }

        return {
            category,
            hardware,
            candidates: topCandidates,
            total_evaluated: filtered.length,
            timestamp: new Date().toISOString()
        };
    }

    combineModels(installed, catalog) {
        const combined = [...installed];
        const installedNames = new Set(installed.map(m => m.model_identifier));
        
        // Add catalog models that aren't installed
        for (const model of catalog) {
            if (!installedNames.has(model.model_identifier)) {
                combined.push(model);
            }
        }
        
        return combined;
    }

    filterByCategory(models, category) {
        return models.filter(model => {
            switch (category) {
                case 'coding':
                    return model.tags.some(tag => ['coder', 'code', 'instruct'].includes(tag)) ||
                           model.name.toLowerCase().includes('code');
                           
                case 'multimodal':
                    return model.modalities.includes('vision') ||
                           model.tags.includes('vision');
                           
                case 'embeddings':
                    return model.tags.includes('embedding') ||
                           model.tags.includes('embeddings') ||
                           model.name.toLowerCase().includes('embed') ||
                           model.name.toLowerCase().includes('bge-') ||
                           model.name.toLowerCase().includes('nomic-embed') ||
                           model.name.toLowerCase().includes('all-minilm') ||
                           model.specialization === 'embeddings';
                           
                case 'reasoning':
                    return model.tags.includes('instruct') || 
                           model.paramsB >= 7; // Prefer larger models for reasoning
                           
                default: // general, reading, summarization
                    return true; // Most models can handle these
            }
        });
    }

    evaluateModel(model, hardware, category, targetCtx, budget) {
        // 1. Select best fitting quantization
        const bestQuant = this.selectBestQuantization(model, budget, targetCtx);
        if (!bestQuant) return null;

        // 2. Calculate required memory
        const requiredGB = this.estimateRequiredGB(model, bestQuant.quant, targetCtx);
        if (requiredGB > budget) return null;

        // 3. Calculate component scores
        const Q = this.calculateQualityPrior(model, bestQuant.quant, category);
        const S = this.estimateSpeed(hardware, model, bestQuant.quant, category);
        const F = this.calculateFitScore(requiredGB, budget);
        const C = this.calculateContextScore(model, targetCtx);

        // 4. Calculate final weighted score
        const weights = this.categoryWeights[category];
        const score = Math.round((Q * weights[0] + S * weights[1] + F * weights[2] + C * weights[3]) * 10) / 10;

        // 5. Build rationale
        const rationale = this.buildRationale(hardware, model, bestQuant.quant, requiredGB, budget, category, Q, S);

        return {
            meta: model,
            quant: bestQuant.quant,
            requiredGB: Math.round(requiredGB * 10) / 10,
            estTPS: S,
            score,
            rationale,
            components: { Q, S, F, C }
        };
    }

    selectBestQuantization(model, budget, targetCtx) {
        // Try quantizations from best to worst quality
        for (const quant of this.quantHierarchy) {
            const requiredGB = this.estimateRequiredGB(model, quant, targetCtx);
            if (requiredGB <= budget) {
                return { quant, sizeGB: requiredGB };
            }
        }
        
        // If nothing fits at target context, try halving context once
        const halfCtx = Math.floor(targetCtx / 2);
        if (halfCtx >= 1024) {
            for (const quant of this.quantHierarchy) {
                const requiredGB = this.estimateRequiredGB(model, quant, halfCtx);
                if (requiredGB <= budget) {
                    return { quant, sizeGB: requiredGB };
                }
            }
        }
        
        return null; // Model doesn't fit
    }

    estimateRequiredGB(model, quant, ctx) {
        // Bytes per parameter by quantization level (calibrated to real Ollama sizes)
        // 7B Q4_K_M=~4.5GB, 14B Q4_K_M=~9GB, 32B Q4_K_M=~19GB
        const bytesPerParam = {
            'Q8_0': 1.05,
            'Q6_K': 0.80,
            'Q5_K_M': 0.68,
            'Q4_K_M': 0.58,
            'Q3_K': 0.48,
            'Q2_K': 0.37
        };
        const bpp = bytesPerParam[quant] || 0.63;
        const modelMemGB = model.paramsB * bpp;

        // KV cache: ~2 * numLayers * hiddenDim * 2bytes * ctx / 1e9
        // Simplified: ~0.000008 GB per billion params per context token
        const kvCacheGB = 0.000008 * model.paramsB * ctx;

        // Runtime overhead (Metal/CUDA context, buffers)
        const runtimeOverhead = 0.5;

        return modelMemGB + kvCacheGB + runtimeOverhead;
    }

    calculateQualityPrior(model, quant, category) {
        // Base quality by parameter count
        let Q = this.getBaseQuality(model.paramsB);
        
        // Family bump
        const familyBump = this.familyBumps[model.family] || 0;
        Q += familyBump;
        
        // Quantization penalty
        const quantPenalty = this.quantPenalties[quant] || -5;
        Q += quantPenalty;
        
        // Task alignment bump
        const taskBump = this.getTaskAlignmentBump(model, category);
        Q += taskBump;
        
        // Reasoning bonus for larger models
        if (category === 'reasoning' && model.paramsB >= 13) {
            Q += 5;
        }
        
        // Coding penalty for non-instruct models
        if (category === 'coding' && !model.tags.some(tag => ['coder', 'instruct'].includes(tag))) {
            Q -= 15;
        }
        
        return Math.max(0, Math.min(100, Q));
    }

    getBaseQuality(paramsB) {
        // Find closest parameter count in our table
        const keys = Object.keys(this.baseQualityByParams).map(Number).sort((a, b) => a - b);
        
        for (let i = 0; i < keys.length; i++) {
            if (paramsB <= keys[i]) {
                return this.baseQualityByParams[keys[i]];
            }
        }
        
        // If larger than our table, return the largest
        return this.baseQualityByParams[keys[keys.length - 1]];
    }

    getTaskAlignmentBump(model, category) {
        const name = model.name.toLowerCase();
        const tags = model.tags;
        
        switch (category) {
            case 'coding':
                if (tags.includes('coder') || name.includes('code')) return 6;
                if (tags.includes('instruct')) return 2;
                return 0;
                
            case 'multimodal':
                if (model.modalities.includes('vision')) return 6;
                return 0;
                
            case 'general':
                if (tags.includes('chat') || tags.includes('instruct')) return 4;
                if (name.includes('code')) return 2;
                return 0;
                
            default:
                return 0;
        }
    }

    estimateSpeed(hardware, model, quant, category) {
        // Determine backend
        let backend = 'cpu_x86';
        if (hardware.acceleration.supports_metal) backend = 'metal';
        else if (hardware.acceleration.supports_cuda) backend = 'cuda';
        else if (hardware.cpu.architecture === 'arm64') backend = 'cpu_arm';
        
        // Base speed calculation
        const K = this.backendK[backend];
        let base = K / model.paramsB;
        
        // Quantization multiplier
        const quantMultiplier = this.quantSpeedMultipliers[quant] || 1.0;
        base *= quantMultiplier;
        
        // Threading multiplier
        if (hardware.cpu.cores >= 8) base *= 1.1;
        if (hardware.acceleration.supports_metal || hardware.acceleration.supports_cuda) base *= 1.2;
        
        // Normalize to 0-100 score
        const target = this.targetSpeeds[category];
        return Math.min(100, Math.round((100 * base / target) * 10) / 10);
    }

    calculateFitScore(requiredGB, budgetGB) {
        const ratio = requiredGB / budgetGB;
        if (ratio <= 0.9) return 100;
        if (ratio <= 1.0) return 70;
        return 0; // Should be filtered out earlier
    }

    calculateContextScore(model, targetCtx) {
        if (model.ctxMax >= targetCtx) return 100;
        if (model.ctxMax >= targetCtx * 0.5) return 70;
        return 0; // Should be filtered out earlier
    }

    buildRationale(hardware, model, quant, requiredGB, budget, category, Q, S) {
        const parts = [];
        
        // Memory fit
        parts.push(`fits in ${requiredGB}/${budget}GB`);
        
        // Quantization
        parts.push(quant);
        
        // Special attributes  
        if (model.tags.includes('coder')) parts.push('coder-tuned');
        if (model.modalities.includes('vision')) parts.push('vision-capable');
        
        // Size sweet spot
        if (model.paramsB >= 7 && model.paramsB <= 13) {
            parts.push(`${model.paramsB}B is sweet spot`);
        }
        
        // Backend
        if (hardware.acceleration.supports_metal) parts.push('Metal backend');
        else if (hardware.acceleration.supports_cuda) parts.push('CUDA backend');
        
        return parts.join(', ');
    }

    // ============================================================================
    // PHASE 2: QUICK PROBE (Optional)
    // ============================================================================

    async runQuickProbes(candidates, hardware, category) {
        // Load cached results
        const cache = this.loadBenchCache();
        const hardwareFingerprint = this.getHardwareFingerprint(hardware);
        
        for (const candidate of candidates) {
            const cacheKey = `${hardwareFingerprint}_${candidate.meta.model_identifier}@${candidate.quant}`;
            
            // Check cache first
            if (cache[cacheKey] && this.isCacheValid(cache[cacheKey])) {
                const cachedTPS = cache[cacheKey].tps;
                this.updateCandidateWithMeasuredSpeed(candidate, cachedTPS, category);
                candidate.rationale += ` | measured ${cachedTPS.toFixed(1)} t/s (cached)`;
                continue;
            }
            
            // Run probe
            try {
                const measuredTPS = await this.runSingleProbe(candidate.meta.model_identifier, category);
                this.updateCandidateWithMeasuredSpeed(candidate, measuredTPS, category);
                candidate.rationale += ` | measured ${measuredTPS.toFixed(1)} t/s`;
                
                // Cache result
                cache[cacheKey] = {
                    tps: measuredTPS,
                    timestamp: Date.now(),
                    category
                };
                this.saveBenchCache(cache);
                
            } catch (error) {
                console.warn(`Probe failed for ${candidate.meta.name}: ${error.message}`);
            }
        }
    }

    async runSingleProbe(modelId, category) {
        const prompts = {
            'coding': 'Write 3 bullet points about the benefits of unit tests.',
            'general': 'Explain the benefits of regular exercise in 3 sentences.',
            'reasoning': 'What are the steps to solve a quadratic equation?',
            'multimodal': 'Describe what you see in this image.', // Text-only fallback
            'summarization': 'Summarize the key points of effective communication.',
            'reading': 'What are the main themes in classic literature?'
        };
        
        const prompt = prompts[category] || prompts['general'];
        const targetTokens = 128;
        
        const startTime = Date.now();
        
        // Make HTTP request to Ollama API
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelId,
                prompt: prompt,
                stream: false,
                options: {
                    num_predict: targetTokens
                }
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        
        // Estimate tokens generated (simplified)
        const tokensGenerated = result.response ? result.response.split(' ').length * 1.3 : targetTokens;
        
        return tokensGenerated / elapsedSeconds;
    }

    updateCandidateWithMeasuredSpeed(candidate, measuredTPS, category) {
        const normalizedS = this.normalizeTPSToScore(measuredTPS, category);
        
        // Recalculate final score with measured speed
        const weights = this.categoryWeights[category];
        const { Q, F, C } = candidate.components;
        
        candidate.estTPS = measuredTPS;
        candidate.components.S = normalizedS;
        candidate.score = Math.round((Q * weights[0] + normalizedS * weights[1] + F * weights[2] + C * weights[3]) * 10) / 10;
    }

    normalizeTPSToScore(tps, category) {
        const target = this.targetSpeeds[category];
        return Math.min(100, Math.round((100 * tps / target) * 10) / 10);
    }

    loadBenchCache() {
        try {
            if (fs.existsSync(this.benchCachePath)) {
                return JSON.parse(fs.readFileSync(this.benchCachePath, 'utf8'));
            }
        } catch (error) {
            console.warn('Failed to load benchmark cache:', error.message);
        }
        return {};
    }

    saveBenchCache(cache) {
        try {
            const dir = path.dirname(this.benchCachePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.benchCachePath, JSON.stringify(cache, null, 2));
        } catch (error) {
            console.warn('Failed to save benchmark cache:', error.message);
        }
    }

    isCacheValid(cacheEntry) {
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
        return (Date.now() - cacheEntry.timestamp) < maxAge;
    }

    getHardwareFingerprint(hardware) {
        return `${hardware.cpu.architecture}_${hardware.cpu.cores}c_${hardware.memory.totalGB}gb_${hardware.gpu.type}`;
    }

    // ============================================================================
    // FORMAT HELPERS (migrated from enhanced-selector.js)
    // ============================================================================

    /**
     * Map a candidate to the legacy format expected by callers
     */
    mapCandidateToLegacyFormat(candidate) {
        const provenance = candidate.meta.provenance || {
            source: candidate.meta.source || 'unknown',
            registry: candidate.meta.registry || 'unknown',
            version: candidate.meta.version || 'unknown',
            license: candidate.meta.license || 'unknown',
            digest: candidate.meta.digest || 'unknown'
        };

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
            reasoning: candidate.rationale,
            source: provenance.source,
            registry: provenance.registry,
            version: provenance.version,
            license: provenance.license,
            digest: provenance.digest,
            provenance
        };
    }

    mapHardwareTier(hardware) {
        let ram, cores;

        if (hardware.memory && hardware.memory.totalGB) {
            ram = hardware.memory.totalGB;
        } else if (hardware.memory && hardware.memory.total) {
            ram = hardware.memory.total;
        } else if (hardware.total_ram_gb) {
            ram = hardware.total_ram_gb;
        } else {
            ram = 8;
        }

        if (hardware.cpu && hardware.cpu.cores) {
            cores = hardware.cpu.cores;
        } else if (hardware.cpu_cores) {
            cores = hardware.cpu_cores;
        } else {
            cores = 4;
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
        if (tags.includes('vision') || (model.modalities && model.modalities.includes('vision'))) return 'multimodal';
        if (tags.includes('embed')) return 'embeddings';
        if (name.includes('creative') || name.includes('wizard')) return 'creative';

        return 'general';
    }

    formatModelSize(model) {
        if (model.paramsB) return `${model.paramsB}B`;
        if (model.size) return `${model.size}B`;
        return 'Unknown';
    }

    /**
     * Generate recommendations by category (main API, replaces EnhancedModelSelector)
     */
    async getBestModelsForHardware(hardware, allModels) {
        const categories = ['coding', 'reasoning', 'multimodal', 'creative', 'talking', 'reading', 'general'];
        const recommendations = {};

        for (const category of categories) {
            try {
                const result = await this.selectModels(category, {
                    topN: 3,
                    enableProbe: false,
                    silent: true
                });

                recommendations[category] = {
                    tier: this.mapHardwareTier(hardware),
                    bestModels: result.candidates.map(candidate => this.mapCandidateToLegacyFormat(candidate)),
                    totalEvaluated: result.total_evaluated,
                    category: this.getCategoryInfo(category)
                };
            } catch (error) {
                recommendations[category] = {
                    tier: this.mapHardwareTier(hardware),
                    bestModels: [],
                    totalEvaluated: 0,
                    category: this.getCategoryInfo(category)
                };
            }
        }

        return recommendations;
    }

    /**
     * Generate recommendation summary
     */
    generateRecommendationSummary(recommendations, hardware) {
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

        Object.entries(recommendations).forEach(([category, data]) => {
            const bestModel = data.bestModels[0];
            if (bestModel) {
                summary.by_category[category] = {
                    name: bestModel.model_name || bestModel.name,
                    identifier: bestModel.model_identifier,
                    score: Math.round(bestModel.categoryScore || bestModel.score),
                    command: `ollama pull ${bestModel.model_identifier}`,
                    size: this.formatModelSize(bestModel),
                    pulls: bestModel.pulls || 0,
                    source: bestModel.source || bestModel.provenance?.source || 'unknown',
                    registry: bestModel.registry || bestModel.provenance?.registry || 'unknown',
                    version: bestModel.version || bestModel.provenance?.version || 'unknown',
                    license: bestModel.license || bestModel.provenance?.license || 'unknown',
                    digest: bestModel.digest || bestModel.provenance?.digest || 'unknown',
                    provenance: bestModel.provenance || {
                        source: bestModel.source || 'unknown',
                        registry: bestModel.registry || 'unknown',
                        version: bestModel.version || 'unknown',
                        license: bestModel.license || 'unknown',
                        digest: bestModel.digest || 'unknown'
                    }
                };

                summary.quick_commands.push(`ollama pull ${bestModel.model_identifier}`);

                const isGeneralCategory = ['general', 'coding', 'talking', 'reading'].includes(category);
                const score = bestModel.categoryScore || bestModel.score || 0;

                if (isGeneralCategory && (score > bestOverallScore || !bestOverallModel)) {
                    bestOverallScore = score;
                    bestOverallModel = bestModel;
                    bestOverallCategory = category;
                }
            }
        });

        if (bestOverallModel) {
            summary.best_overall = {
                name: bestOverallModel.model_name || bestOverallModel.name,
                identifier: bestOverallModel.model_identifier,
                category: bestOverallCategory,
                score: Math.round(bestOverallScore),
                command: `ollama pull ${bestOverallModel.model_identifier}`,
                source: bestOverallModel.source || bestOverallModel.provenance?.source || 'unknown',
                registry: bestOverallModel.registry || bestOverallModel.provenance?.registry || 'unknown',
                version: bestOverallModel.version || bestOverallModel.provenance?.version || 'unknown',
                license: bestOverallModel.license || bestOverallModel.provenance?.license || 'unknown',
                digest: bestOverallModel.digest || bestOverallModel.provenance?.digest || 'unknown',
                provenance: bestOverallModel.provenance || {
                    source: bestOverallModel.source || 'unknown',
                    registry: bestOverallModel.registry || 'unknown',
                    version: bestOverallModel.version || 'unknown',
                    license: bestOverallModel.license || 'unknown',
                    digest: bestOverallModel.digest || 'unknown'
                }
            };
        }

        return summary;
    }

    // ============================================================================
    // PUBLIC API
    // ============================================================================

    async recommend(category = 'general', options = {}) {
        const result = await this.selectModels(category, options);
        return this.formatRecommendations(result);
    }

    formatRecommendations(result) {
        const { category, hardware, candidates, total_evaluated } = result;
        
        console.log(`\n${category.toUpperCase()} RECOMMENDATIONS`);
        console.log(`Hardware: ${hardware.cpu.cores} cores, ${hardware.memory.totalGB}GB RAM, ${hardware.gpu.type}`);
        console.log(`Evaluated ${total_evaluated} models\n`);
        
        if (candidates.length === 0) {
            console.log('❌ No suitable models found for your hardware');
            return result;
        }
        
        // Table header
        console.log('┌─────────────────────────────┬────────┬───────┬─────────┬──────────┬───────┬─────────────────────────────┐');
        console.log('│ Model                       │ Params │ Quant │ Est t/s │ Mem GB   │ Score │ Why                         │');
        console.log('├─────────────────────────────┼────────┼───────┼─────────┼──────────┼───────┼─────────────────────────────┤');
        
        candidates.forEach((candidate, index) => {
            const isInstalled = candidate.meta.installed ? 'INSTALLED' : 'CLOUD';
            const name = candidate.meta.name.padEnd(26);
            const params = `${candidate.meta.paramsB}B`.padEnd(5);
            const quant = candidate.quant.padEnd(6);
            const tps = candidate.estTPS.toFixed(1).padStart(7);
            const mem = `${candidate.requiredGB}/${hardware.usableMemGB}`.padEnd(9);
            const score = candidate.score.toFixed(1).padStart(5);
            const why = candidate.rationale.substring(0, 29);
            
            console.log(`│ ${isInstalled}${name} │ ${params} │ ${quant} │ ${tps} │ ${mem} │ ${score} │ ${why} │`);
        });
        
        console.log('└─────────────────────────────┴────────┴───────┴─────────┴──────────┴───────┴─────────────────────────────┘');
        
        // Best pick
        const best = candidates[0];
        console.log(`\nBEST PICK: ${best.meta.name}`);
        console.log(`Command: ollama pull ${best.meta.model_identifier}`);
        console.log(`Why: ${best.rationale}`);
        console.log(`Score: ${best.score} (Q:${best.components.Q} S:${best.components.S} F:${best.components.F} C:${best.components.C})`);
        
        return result;
    }
}

module.exports = DeterministicModelSelector;
