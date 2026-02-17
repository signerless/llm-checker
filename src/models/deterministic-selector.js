/**
 * LLM-Checker: Deterministic Model Selection Algorithm (Spec v1.0)
 * 
 * A two-phase selector that picks the best Ollama model + quantization
 * for a given machine and task category.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { DETERMINISTIC_WEIGHTS } = require('./scoring-config');

class DeterministicModelSelector {
    constructor() {
        this.catalogPath = path.join(__dirname, 'catalog.json');
        this.benchCachePath = path.join(os.homedir(), '.llm-checker', 'bench.json');
        this.ollamaCachePaths = [
            path.join(os.homedir(), '.llm-checker', 'cache', 'ollama', 'ollama-detailed-models.json'),
            path.join(__dirname, '../ollama/.cache/ollama-detailed-models.json')
        ];
        
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
            'qwen3': 4,
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

        // User optimization profile overrides [Q, S, F, C]
        this.optimizationProfiles = {
            balanced: null,
            speed: [0.25, 0.55, 0.15, 0.05],
            quality: [0.65, 0.10, 0.15, 0.10],
            context: [0.30, 0.10, 0.20, 0.40],
            coding: [0.55, 0.25, 0.10, 0.10]
        };

        this.freshnessThresholds = {
            staleDays: 365,
            veryStaleDays: 730,
            indexCadenceDays: 14
        };

        this.modelIndexStatus = {
            source: 'unknown',
            ageDays: null,
            isStale: false,
            cachedAt: null
        };
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

    /**
     * Normalize hardware shape coming from different detectors/callers.
     * Ensures deterministic selector always has:
     * - memory.totalGB
     * - gpu.vramGB
     * - acceleration.supports_*
     */
    normalizeHardwareProfile(input = {}) {
        const toNumber = (value) => {
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
                return Number(value);
            }
            return null;
        };

        const cpu = input.cpu || {};
        const gpu = input.gpu || {};
        const memory = input.memory || {};
        const acceleration = input.acceleration || {};
        const gpuEntries = Array.isArray(gpu.all) ? gpu.all : [];

        const totalMemGB =
            toNumber(memory.totalGB) ??
            toNumber(memory.total) ??
            toNumber(input.total_ram_gb) ??
            toNumber(input.memoryGB) ??
            8;

        const modelHints = `${gpu.model || ''} ${gpu.vendor || ''} ${gpu.type || ''}`.toLowerCase();
        const inferredUnified =
            Boolean(gpu.unified) ||
            /apple|m1|m2|m3|m4|unified/.test(modelHints);

        const utilizationFactor = inferredUnified ? 0.85 : 0.8;
        const memoryHeadroomGB = inferredUnified ? 1.5 : 2;
        const usableMemGB =
            toNumber(input.usableMemGB) ??
            Math.max(1, Math.min(utilizationFactor * totalMemGB, totalMemGB - memoryHeadroomGB));

        const gpuCount =
            toNumber(gpu.gpuCount) ??
            toNumber(gpu.count) ??
            (gpuEntries.length > 0 ? gpuEntries.length : null) ??
            toNumber(input.gpuCount) ??
            1;

        const vramPerGPU =
            toNumber(gpu.vramPerGPU) ??
            toNumber(input.vramPerGPU) ??
            null;

        const summedEntryVRAM = gpuEntries.reduce((sum, entry) => {
            return sum + (
                toNumber(entry?.vramGB) ??
                toNumber(entry?.vram) ??
                toNumber(entry?.totalVRAM) ??
                0
            );
        }, 0);

        const explicitTotalVRAM =
            toNumber(gpu.totalVRAM) ??
            toNumber(input.totalVRAM) ??
            toNumber(input.gpuTotalVRAM) ??
            (summedEntryVRAM > 0 ? summedEntryVRAM : null);

        const directVRAM =
            toNumber(gpu.vramGB) ??
            toNumber(gpu.vram) ??
            null;

        let vramGB =
            explicitTotalVRAM ??
            directVRAM ??
            0;

        // Multi-GPU fallback when only per-GPU memory is known.
        if (!explicitTotalVRAM && gpuCount > 1) {
            if (vramPerGPU) {
                vramGB = vramPerGPU * gpuCount;
            } else if (directVRAM && Boolean(gpu.isMultiGPU || input.isMultiGPU)) {
                vramGB = Math.max(directVRAM, directVRAM * gpuCount);
            }
        }

        let gpuType = gpu.type;
        if (!gpuType) {
            if (inferredUnified) gpuType = 'apple_silicon';
            else if (/nvidia|rtx|gtx|tesla|quadro/.test(modelHints)) gpuType = 'nvidia';
            else if (/amd|radeon|rx |instinct/.test(modelHints)) gpuType = 'amd';
            else gpuType = 'cpu_only';
        }

        const normalizedAcceleration = {
            supports_metal:
                typeof acceleration.supports_metal === 'boolean'
                    ? acceleration.supports_metal
                    : gpuType === 'apple_silicon',
            supports_cuda:
                typeof acceleration.supports_cuda === 'boolean'
                    ? acceleration.supports_cuda
                    : gpuType === 'nvidia',
            supports_rocm:
                typeof acceleration.supports_rocm === 'boolean'
                    ? acceleration.supports_rocm
                    : gpuType === 'amd'
        };

        return {
            ...input,
            cpu: {
                ...cpu,
                architecture: cpu.architecture || cpu.arch || process.arch || 'x86_64',
                cores: toNumber(cpu.cores) ?? toNumber(cpu.physicalCores) ?? 4
            },
            gpu: {
                ...gpu,
                type: gpuType,
                vramGB,
                vramPerGPU: vramPerGPU ?? (gpuCount > 0 ? (vramGB > 0 ? vramGB / gpuCount : 0) : 0),
                gpuCount,
                isMultiGPU: Boolean(gpu.isMultiGPU || gpuCount > 1),
                unified: inferredUnified
            },
            memory: {
                ...memory,
                totalGB: totalMemGB
            },
            acceleration: normalizedAcceleration,
            usableMemGB
        };
    }

    normalizeOptimizationObjective(objective) {
        if (!objective) return 'balanced';
        const normalized = String(objective).toLowerCase().trim();
        if (['balanced', 'default', 'auto'].includes(normalized)) return 'balanced';
        if (['speed', 'fast', 'latency', 'throughput'].includes(normalized)) return 'speed';
        if (['quality', 'accurate', 'accuracy'].includes(normalized)) return 'quality';
        if (['context', 'long-context', 'long_context', 'memory'].includes(normalized)) return 'context';
        if (['coding', 'code', 'developer'].includes(normalized)) return 'coding';
        return 'balanced';
    }

    getScoringWeights(category, optimizeFor = 'balanced') {
        const base = this.categoryWeights[category] || this.categoryWeights.general;
        const objective = this.normalizeOptimizationObjective(optimizeFor);
        const objectiveWeights = this.optimizationProfiles[objective];

        if (!objectiveWeights) {
            return base;
        }

        // Blend category semantics with requested profile, but keep explicit
        // user intent dominant (especially for quality/context priorities).
        const objectivePriorities = {
            speed: 0.8,
            quality: 0.95,
            context: 0.85,
            coding: 0.8
        };
        const objectivePriority = objectivePriorities[objective] || 0.75;
        const categoryPriority = 1 - objectivePriority;

        return base.map((weight, idx) => {
            const blended = (weight * categoryPriority) + (objectiveWeights[idx] * objectivePriority);
            return Math.round(blended * 1000) / 1000;
        });
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

    /**
     * Full model pool loader:
     * 1) Prefer complete Ollama scraped cache (all families/sizes)
     * 2) Fallback to static curated catalog
     */
    async loadModelPool() {
        const cacheModels = await this.loadOllamaCacheModels();
        if (cacheModels.length > 0) {
            return cacheModels;
        }
        return this.loadCatalog();
    }

    async loadOllamaCacheModels() {
        for (const cachePath of this.ollamaCachePaths) {
            try {
                if (!fs.existsSync(cachePath)) continue;
                const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
                const sourceModels = Array.isArray(raw) ? raw : (raw.models || []);
                const indexMeta = this.extractModelIndexMetadata(raw, cachePath);
                const normalized = this.normalizeExternalModels(sourceModels, { indexMeta });
                if (normalized.length > 0) return normalized;
            } catch (error) {
                // Ignore broken cache files and keep trying fallbacks
            }
        }
        return [];
    }

    extractModelIndexMetadata(raw, sourcePath = '') {
        const cachedAtRaw = raw?.cached_at || raw?.generated_at || raw?.last_updated || null;
        const cachedAt = this.parseDateSafe(cachedAtRaw);
        const ageDays = cachedAt
            ? Math.max(0, (Date.now() - cachedAt.getTime()) / (1000 * 60 * 60 * 24))
            : null;
        const isStale = Number.isFinite(ageDays) && ageDays > this.freshnessThresholds.indexCadenceDays;

        const status = {
            source: sourcePath || 'cache',
            ageDays: Number.isFinite(ageDays) ? Math.round(ageDays * 10) / 10 : null,
            isStale: Boolean(isStale),
            cachedAt: cachedAt ? cachedAt.toISOString() : null
        };

        this.modelIndexStatus = status;
        return status;
    }

    normalizeExternalModels(models = [], context = {}) {
        const normalized = [];
        const indexMeta = context.indexMeta || this.modelIndexStatus || {};

        for (const model of models) {
            if (!model || typeof model !== 'object') continue;

            const alreadyNormalized =
                typeof model.paramsB === 'number' &&
                typeof model.ctxMax === 'number' &&
                model.model_identifier;

            const freshness = this.computeFreshnessMetadata(model, indexMeta);
            const quantizations = this.extractAvailableQuantizations(model, model.variants || []);

            if (alreadyNormalized) {
                normalized.push({
                    ...model,
                    tags: Array.isArray(model.tags) ? model.tags : [],
                    modalities: Array.isArray(model.modalities) ? model.modalities : ['text'],
                    installed: Boolean(model.installed),
                    availableQuantizations: model.availableQuantizations || quantizations,
                    sizeByQuant: model.sizeByQuant || {},
                    source: model.source || 'ollama_database',
                    registry: model.registry || 'ollama.com',
                    version: model.version || model.model_identifier,
                    license: model.license || 'unknown',
                    digest: model.digest || 'unknown',
                    ...freshness,
                    provenance: model.provenance || {
                        source: model.source || 'ollama_database',
                        registry: model.registry || 'ollama.com',
                        version: model.version || model.model_identifier,
                        license: model.license || 'unknown',
                        digest: model.digest || 'unknown'
                    }
                });
                continue;
            }

            const converted = this.convertOllamaModelToDeterministicModels(model, { indexMeta });
            normalized.push(...converted);
        }

        const deduped = new Map();
        for (const model of normalized) {
            const key = model.model_identifier || model.name;
            if (!key || deduped.has(key)) continue;
            deduped.set(key, model);
        }

        return [...deduped.values()];
    }

    convertOllamaModelToDeterministicModels(ollamaModel, context = {}) {
        const baseIdentifier = ollamaModel.model_identifier || ollamaModel.model_name || 'unknown';
        const fallbackTag = `${baseIdentifier}:latest`;
        const variants = Array.isArray(ollamaModel.variants) && ollamaModel.variants.length > 0
            ? ollamaModel.variants
            : [{ tag: ollamaModel.model_identifier || fallbackTag }];
        const indexMeta = context.indexMeta || this.modelIndexStatus || {};
        const freshness = this.computeFreshnessMetadata(ollamaModel, indexMeta);

        const contextLength = this.parseContextLength(
            ollamaModel.context_length ||
            ollamaModel.contextLength ||
            ollamaModel.ctxMax
        );

        const baseText = [
            ollamaModel.model_identifier,
            ollamaModel.model_name,
            ollamaModel.description,
            ollamaModel.detailed_description,
            ollamaModel.primary_category,
            ...(Array.isArray(ollamaModel.use_cases) ? ollamaModel.use_cases : []),
            ...(Array.isArray(ollamaModel.categories) ? ollamaModel.categories : [])
        ].filter(Boolean).join(' ').toLowerCase();

        const derivedTags = new Set();
        if (baseText.includes('code') || baseText.includes('coder')) derivedTags.add('coder');
        if (baseText.includes('instruct')) derivedTags.add('instruct');
        if (baseText.includes('chat') || baseText.includes('assistant') || baseText.includes('conversation')) derivedTags.add('chat');
        if (baseText.includes('embed')) derivedTags.add('embedding');
        if (baseText.includes('vision') || baseText.includes('vl') || baseText.includes('multimodal') || baseText.includes('image')) derivedTags.add('vision');
        if (baseText.includes('reason') || baseText.includes('math') || baseText.includes('logic')) derivedTags.add('reasoning');
        if (baseText.includes('creative') || baseText.includes('story') || baseText.includes('roleplay')) derivedTags.add('creative');

        if (ollamaModel.primary_category === 'coding') derivedTags.add('coder');
        if (ollamaModel.primary_category === 'chat') derivedTags.add('chat');
        if (ollamaModel.primary_category === 'embeddings') derivedTags.add('embedding');
        if (ollamaModel.primary_category === 'multimodal') derivedTags.add('vision');
        if (ollamaModel.primary_category === 'reasoning') derivedTags.add('reasoning');
        if (ollamaModel.primary_category === 'creative') derivedTags.add('creative');

        return variants.map((variant) => {
            const variantTag = variant.tag || fallbackTag;
            const paramsB = this.extractParamsFromString(
                variant.size,
                variantTag,
                ollamaModel.main_size,
                ollamaModel.model_identifier
            );
            const quant = this.normalizeQuantization(
                variant.quantization ||
                this.extractQuantizationFromTag(variantTag) ||
                'Q4_K_M'
            );

            const variantSizeGB = this.extractVariantSizeGB(variant, paramsB);
            const modalities = this.inferModalities(ollamaModel, variantTag);
            const modelTags = this.inferTagsForVariant(derivedTags, variant, variantTag);
            const sizeByQuant = {};

            for (const sibling of variants) {
                const siblingParams = this.extractParamsFromString(
                    sibling.size,
                    sibling.tag,
                    ollamaModel.main_size,
                    ollamaModel.model_identifier
                );

                // Keep quantization map parameter-aware: don't blend 8B/70B/405B sizes.
                if (Math.abs(siblingParams - paramsB) > 0.25) continue;

                const siblingQuant = this.normalizeQuantization(
                    sibling.quantization ||
                    this.extractQuantizationFromTag(sibling.tag || '') ||
                    quant
                );
                const siblingSize = this.extractVariantSizeGB(sibling, siblingParams);
                if (!Number.isFinite(sizeByQuant[siblingQuant]) || siblingSize < sizeByQuant[siblingQuant]) {
                    sizeByQuant[siblingQuant] = siblingSize;
                }
            }

            const availableQuantizations = this.getQuantizationCandidates({
                availableQuantizations: this.extractAvailableQuantizations(ollamaModel, variants),
                sizeByQuant
            });

            const source = ollamaModel.source || 'ollama_database';
            const registry = ollamaModel.registry || 'ollama.com';
            const version = ollamaModel.version || variantTag;
            const license = ollamaModel.license || 'unknown';
            const digest = ollamaModel.digest || 'unknown';

            return {
                name: variantTag,
                family: this.extractFamily(baseIdentifier),
                paramsB,
                ctxMax: contextLength,
                quant,
                sizeGB: variantSizeGB,
                modalities,
                tags: modelTags,
                model_identifier: variantTag,
                installed: false,
                pulls: ollamaModel.actual_pulls || ollamaModel.pulls || 0,
                availableQuantizations,
                sizeByQuant,
                ...freshness,
                source,
                registry,
                version,
                license,
                digest,
                provenance: {
                    source,
                    registry,
                    version,
                    license,
                    digest
                }
            };
        });
    }

    parseDateSafe(value) {
        if (!value || typeof value !== 'string') return null;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return null;
        return parsed;
    }

    extractAvailableQuantizations(model, variants = []) {
        const quantSet = new Set();
        const candidateStrings = [];

        if (Array.isArray(model?.quantizations)) {
            candidateStrings.push(...model.quantizations);
        }
        if (typeof model?.quantization === 'string') {
            candidateStrings.push(model.quantization);
        }
        for (const variant of variants) {
            if (variant?.quantization) candidateStrings.push(variant.quantization);
            if (variant?.tag) candidateStrings.push(variant.tag);
        }

        for (const value of candidateStrings) {
            const inferred = this.normalizeQuantization(
                this.extractQuantizationFromTag(String(value)) || String(value)
            );
            if (inferred) quantSet.add(inferred);
        }

        if (quantSet.size === 0 && model?.quant) {
            quantSet.add(this.normalizeQuantization(model.quant));
        }
        if (quantSet.size === 0) {
            quantSet.add('Q4_K_M');
        }

        return [...quantSet].sort((a, b) => {
            const aIdx = this.quantHierarchy.indexOf(a);
            const bIdx = this.quantHierarchy.indexOf(b);
            const safeA = aIdx === -1 ? Number.MAX_SAFE_INTEGER : aIdx;
            const safeB = bIdx === -1 ? Number.MAX_SAFE_INTEGER : bIdx;
            return safeA - safeB;
        });
    }

    computeFreshnessMetadata(model = {}, indexMeta = {}) {
        const dateCandidates = [
            model.last_updated,
            model.lastUpdated,
            model.updated_at,
            model.updatedAt,
            model.release_date,
            model.released_at,
            model.created_at,
            model.detailed_scraped_at
        ];

        const updatedAt = dateCandidates
            .map((value) => this.parseDateSafe(value))
            .find(Boolean);

        const ageDays = updatedAt
            ? Math.max(0, (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24))
            : null;

        let freshnessScore = 55; // neutral fallback when timestamp is unknown
        if (Number.isFinite(ageDays)) {
            if (ageDays <= 30) freshnessScore = 100;
            else if (ageDays <= 90) freshnessScore = 90;
            else if (ageDays <= 180) freshnessScore = 75;
            else if (ageDays <= 365) freshnessScore = 60;
            else if (ageDays <= 540) freshnessScore = 40;
            else if (ageDays <= 720) freshnessScore = 25;
            else freshnessScore = 10;
        }

        const textBlob = [
            model.model_identifier,
            model.model_name,
            model.name,
            model.description,
            model.detailed_description,
            model.status,
            ...(Array.isArray(model.tags) ? model.tags : [])
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        const isDeprecatedByText =
            /\bdeprecated\b|\bobsolete\b|\blegacy\b|\barchived\b|\breplaced by\b|\buse .+ instead\b/.test(textBlob);
        const isDeprecated = Boolean(model.deprecated || model.is_deprecated || model.archived || isDeprecatedByText);
        const isStale = Number.isFinite(ageDays) && ageDays > this.freshnessThresholds.staleDays;
        const veryStale = Number.isFinite(ageDays) && ageDays > this.freshnessThresholds.veryStaleDays;
        const indexStale = Boolean(indexMeta?.isStale);

        if (isDeprecated) freshnessScore = Math.min(freshnessScore, 15);
        if (veryStale) freshnessScore = Math.min(freshnessScore, 20);
        if (indexStale && !updatedAt) freshnessScore = Math.max(0, freshnessScore - 10);

        return {
            lastUpdatedAt: updatedAt ? updatedAt.toISOString() : null,
            modelAgeDays: Number.isFinite(ageDays) ? Math.round(ageDays * 10) / 10 : null,
            freshnessScore,
            isStale,
            isDeprecated,
            indexAgeDays: Number.isFinite(indexMeta?.ageDays) ? indexMeta.ageDays : null,
            indexStale
        };
    }

    parseContextLength(contextValue) {
        if (typeof contextValue === 'number' && Number.isFinite(contextValue) && contextValue > 0) {
            return Math.round(contextValue);
        }

        if (typeof contextValue === 'string') {
            const match = contextValue.match(/(\d+\.?\d*)\s*([KkMm]?)/);
            if (match) {
                const value = parseFloat(match[1]);
                const unit = (match[2] || '').toUpperCase();
                if (unit === 'M') return Math.round(value * 1024 * 1024);
                if (unit === 'K') return Math.round(value * 1024);
                return Math.round(value);
            }
        }

        return 4096;
    }

    extractParamsFromString(...values) {
        for (const value of values) {
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                return value;
            }
            if (typeof value !== 'string') continue;

            const match = value.match(/(\d+\.?\d*)\s*([BbMm])/);
            if (!match) continue;
            const n = parseFloat(match[1]);
            const unit = match[2].toUpperCase();
            return unit === 'M' ? n / 1000 : n;
        }

        return 7;
    }

    extractQuantizationFromTag(tag = '') {
        const match = String(tag).match(/\b(q\d+[_\w]*)\b/i);
        return match ? match[1].toUpperCase() : null;
    }

    normalizeQuantization(quant = 'Q4_K_M') {
        const q = String(quant).toUpperCase();
        if (q.startsWith('Q8')) return 'Q8_0';
        if (q.startsWith('Q6')) return 'Q6_K';
        if (q.startsWith('Q5')) return 'Q5_K_M';
        if (q.startsWith('Q4')) return 'Q4_K_M';
        if (q.startsWith('Q3')) return 'Q3_K';
        if (q.startsWith('Q2')) return 'Q2_K';
        return 'Q4_K_M';
    }

    extractVariantSizeGB(variant, paramsB) {
        const candidate = Number(variant.real_size_gb ?? variant.estimated_size_gb ?? NaN);
        if (Number.isFinite(candidate) && candidate > 0) return candidate;
        return Math.max(0.5, Math.round((paramsB * 0.58 + 0.5) * 10) / 10);
    }

    inferModalities(model, variantTag = '') {
        const inputTypes = Array.isArray(model.input_types) ? model.input_types.map((x) => String(x).toLowerCase()) : [];
        const text = [
            model.model_identifier,
            model.model_name,
            model.description,
            model.detailed_description,
            variantTag
        ].filter(Boolean).join(' ').toLowerCase();

        const hasVision = inputTypes.includes('image') ||
            inputTypes.includes('vision') ||
            /vision|vl\b|llava|pixtral|moondream|image|multimodal/.test(text);

        return hasVision ? ['text', 'vision'] : ['text'];
    }

    inferTagsForVariant(baseTags, variant, variantTag = '') {
        const tags = new Set(baseTags);

        if (Array.isArray(variant.categories)) {
            for (const cat of variant.categories) {
                const c = String(cat).toLowerCase();
                if (c.includes('code')) tags.add('coder');
                if (c.includes('chat')) tags.add('chat');
                if (c.includes('embed')) tags.add('embedding');
                if (c.includes('vision') || c.includes('multimodal')) tags.add('vision');
                if (c.includes('reason')) tags.add('reasoning');
                if (c.includes('creative')) tags.add('creative');
            }
        }

        const lowerTag = String(variantTag).toLowerCase();
        if (lowerTag.includes('code') || lowerTag.includes('coder')) tags.add('coder');
        if (lowerTag.includes('instruct')) tags.add('instruct');
        if (lowerTag.includes('chat')) tags.add('chat');
        if (lowerTag.includes('embed')) tags.add('embedding');
        if (lowerTag.includes('vision') || lowerTag.includes('vl')) tags.add('vision');
        if (lowerTag.includes('reason') || lowerTag.includes('math')) tags.add('reasoning');

        return [...tags];
    }

    // ============================================================================
    // HELPER METHODS FOR PARSING OLLAMA OUTPUT  
    // ============================================================================

    extractFamily(modelName) {
        const name = modelName.toLowerCase();
        if (name.includes('qwen2.5')) return 'qwen2.5';
        if (name.includes('qwen3')) return 'qwen3';
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
            targetCtx = this.targetContexts[category] || this.targetContexts.general,
            topN = 5,
            enableProbe = false,
            silent = false,
            optimizeFor = 'balanced',
            hardware: providedHardware = null,
            installedModels = null,
            modelPool = null
        } = options;
        const optimizationObjective = this.normalizeOptimizationObjective(
            options.optimize || options.objective || optimizeFor
        );

        if (!silent) {
            console.log(`🔍 Selecting models for category: ${category}`);
            if (optimizationObjective !== 'balanced') {
                console.log(`⚙️  Optimization profile: ${optimizationObjective}`);
            }
        }
        
        // Phase 0: Gather data
        const detectedHardware = providedHardware || await this.getHardware();
        const hardware = this.normalizeHardwareProfile(detectedHardware);
        const installed = Array.isArray(installedModels) ? installedModels : await this.getInstalledModels();
        const externalPool = Array.isArray(modelPool) && modelPool.length > 0
            ? this.normalizeExternalModels(modelPool)
            : await this.loadModelPool();
        
        if (!silent) {
            const memoryGB = hardware?.memory?.totalGB ?? hardware?.memory?.total ?? 0;
            console.log(`Found ${installed.length} installed, ${externalPool.length} available models`);
            console.log(`Hardware: ${hardware.cpu.cores} cores, ${memoryGB}GB RAM, ${hardware.gpu.type}`);
        }
        
        // Combine and dedupe models (prefer installed versions)
        const pool = this.combineModels(installed, externalPool);
        const filtered = this.filterByCategory(pool, category);
        
        if (!silent) {
            console.log(`Evaluating ${filtered.length} models for ${category} category`);
        }
        
        // Phase 1: Estimation filter
        const candidates = [];
        const totalMem = hardware?.memory?.totalGB ?? hardware?.memory?.total ?? 8;
        const usableMem = typeof hardware.usableMemGB === 'number'
            ? hardware.usableMemGB
            : Math.max(1, Math.min(0.8 * totalMem, totalMem - 2));
        const isUnified = Boolean(hardware?.gpu?.unified) || hardware?.gpu?.type === 'apple_silicon';
        const vram = hardware?.gpu?.vramGB ?? hardware?.gpu?.vram ?? 0;
        const budget = isUnified ? usableMem : (vram || usableMem);

        for (const model of filtered) {
            const result = this.evaluateModel(
                model,
                hardware,
                category,
                targetCtx,
                budget,
                optimizationObjective
            );
            if (result) {
                candidates.push(result);
            }
        }

        // Sort by score
        candidates.sort((a, b) => b.score - a.score);
        let topCandidates = candidates.slice(0, topN);
        topCandidates = this.ensureFeasibleMidTierCoverage(
            topCandidates,
            candidates,
            category,
            hardware,
            optimizationObjective
        );
        
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
            optimizeFor: optimizationObjective,
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

    evaluateModel(model, hardware, category, targetCtx, budget, optimizeFor = 'balanced') {
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
        const weights = this.getScoringWeights(category, optimizeFor);
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

    getQuantizationCandidates(model) {
        const normalizedAvailable = Array.isArray(model?.availableQuantizations)
            ? model.availableQuantizations.map((quant) => this.normalizeQuantization(quant))
            : [];
        const fromSizeMap = model?.sizeByQuant && typeof model.sizeByQuant === 'object'
            ? Object.keys(model.sizeByQuant).map((quant) => this.normalizeQuantization(quant))
            : [];

        const seeded = (fromSizeMap.length > 0
            ? [...new Set(fromSizeMap)]
            : [...new Set(normalizedAvailable)])
            .filter(Boolean);

        let candidates = seeded.length > 0 ? seeded : [...this.quantHierarchy];

        // If we have at least one known quantization, allow extrapolating to
        // *more compressed* levels as an explicit feasibility assumption.
        if (seeded.length > 0) {
            const expanded = new Set();
            for (const quant of seeded) {
                const idx = this.quantHierarchy.indexOf(quant);
                if (idx === -1) {
                    expanded.add(quant);
                    continue;
                }
                for (let i = idx; i < this.quantHierarchy.length; i++) {
                    expanded.add(this.quantHierarchy[i]);
                }
            }
            candidates = [...expanded];
        }

        return candidates.sort((a, b) => {
            const aIdx = this.quantHierarchy.indexOf(a);
            const bIdx = this.quantHierarchy.indexOf(b);
            const safeA = aIdx === -1 ? Number.MAX_SAFE_INTEGER : aIdx;
            const safeB = bIdx === -1 ? Number.MAX_SAFE_INTEGER : bIdx;
            return safeA - safeB;
        });
    }

    selectBestQuantization(model, budget, targetCtx) {
        const quantizationCandidates = this.getQuantizationCandidates(model);

        // Try quantizations from best to worst quality
        for (const quant of quantizationCandidates) {
            const requiredGB = this.estimateRequiredGB(model, quant, targetCtx);
            if (requiredGB <= budget) {
                return { quant, sizeGB: requiredGB };
            }
        }
        
        // If nothing fits at target context, try halving context once
        const halfCtx = Math.floor(targetCtx / 2);
        if (halfCtx >= 1024) {
            for (const quant of quantizationCandidates) {
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
        const normalizedQuant = this.normalizeQuantization(quant);
        const bpp = bytesPerParam[normalizedQuant] || 0.63;
        const sizeByQuant = model?.sizeByQuant && typeof model.sizeByQuant === 'object' ? model.sizeByQuant : {};
        const observedFromSizeMap = Number(sizeByQuant[normalizedQuant]);
        const directVariantMatch =
            this.normalizeQuantization(model?.quant || '') === normalizedQuant
                ? Number(model?.sizeGB ?? model?.size)
                : NaN;

        const observedWeightGB = Number.isFinite(observedFromSizeMap) && observedFromSizeMap > 0
            ? observedFromSizeMap
            : (Number.isFinite(directVariantMatch) && directVariantMatch > 0 ? directVariantMatch : null);

        const modelMemGB = observedWeightGB ?? (model.paramsB * bpp);
        const effectiveCtx = Number.isFinite(Number(ctx)) && Number(ctx) > 0 ? Number(ctx) : 4096;

        // KV cache: ~2 * numLayers * hiddenDim * 2bytes * ctx / 1e9
        // Simplified: ~0.000008 GB per billion params per context token
        const kvCacheGB = 0.000008 * model.paramsB * effectiveCtx;

        // Runtime overhead (Metal/CUDA context, buffers)
        const runtimeOverhead = observedWeightGB ? 0.35 : 0.5;

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

        // Freshness/deprecation adjustment
        const freshnessAdjustment = this.calculateFreshnessAdjustment(model);
        Q += freshnessAdjustment;
        
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

    calculateFreshnessAdjustment(model = {}) {
        const freshnessScore = Number.isFinite(model.freshnessScore) ? model.freshnessScore : 55;
        const ageDays = Number.isFinite(model.modelAgeDays) ? model.modelAgeDays : null;
        const isDeprecated = Boolean(model.isDeprecated);
        const isStale = Boolean(model.isStale);

        if (isDeprecated) return -12;
        if (ageDays !== null && ageDays > this.freshnessThresholds.veryStaleDays) return -8;
        if (ageDays !== null && ageDays > this.freshnessThresholds.staleDays) return -4;
        if (isStale) return -3;
        if (freshnessScore >= 90) return 3;
        if (freshnessScore >= 75) return 2;
        if (freshnessScore >= 60) return 1;
        if (freshnessScore <= 25) return -4;
        return 0;
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
        const target = this.targetSpeeds[category] || this.targetSpeeds.general;
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

    ensureFeasibleMidTierCoverage(selectedCandidates, allCandidates, category, hardware, optimizeFor = 'balanced') {
        if (!Array.isArray(selectedCandidates) || selectedCandidates.length === 0) {
            return selectedCandidates;
        }

        const objective = this.normalizeOptimizationObjective(optimizeFor);
        if (objective === 'speed') {
            return selectedCandidates;
        }

        const enforceCategories = new Set(['general', 'talking', 'reading', 'coding', 'reasoning', 'multimodal']);
        if (!enforceCategories.has(category)) {
            return selectedCandidates;
        }

        const normalizedHardware = this.normalizeHardwareProfile(hardware || {});
        const budget = normalizedHardware.gpu.unified
            ? normalizedHardware.usableMemGB
            : (normalizedHardware.gpu.vramGB || normalizedHardware.usableMemGB);

        if (!Number.isFinite(budget) || budget < 16) {
            return selectedCandidates;
        }

        const minMidTierParams = budget >= 24 ? 7 : 6;
        const alreadyHasMidTier = selectedCandidates.some((candidate) => (candidate?.meta?.paramsB || 0) >= minMidTierParams);
        if (alreadyHasMidTier) {
            return selectedCandidates;
        }

        const practicalSpeedFloor = normalizedHardware.gpu.unified ? 25 : 20;
        const feasibleMidTier = allCandidates.find((candidate) => {
            const params = candidate?.meta?.paramsB || 0;
            const speedScore = candidate?.components?.S ?? candidate?.estTPS ?? 0;
            return params >= minMidTierParams && speedScore >= practicalSpeedFloor;
        });

        if (!feasibleMidTier) {
            return selectedCandidates;
        }

        if (selectedCandidates.some((candidate) => candidate?.meta?.model_identifier === feasibleMidTier?.meta?.model_identifier)) {
            return selectedCandidates;
        }

        const promoted = [...selectedCandidates];
        promoted[promoted.length - 1] = feasibleMidTier;
        promoted.sort((a, b) => b.score - a.score);
        return promoted;
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
        if (model.isDeprecated) parts.push('deprecated penalized');
        else if (model.isStale) parts.push('stale penalized');
        else if (model.freshnessScore >= 90) parts.push('fresh release');
        
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
        const target = this.targetSpeeds[category] || this.targetSpeeds.general;
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

    mapHardwareTier(hardware = {}) {
        let ram, cores;

        if (hardware?.memory?.totalGB) {
            ram = hardware.memory.totalGB;
        } else if (hardware?.memory?.total) {
            ram = hardware.memory.total;
        } else if (hardware?.total_ram_gb) {
            ram = hardware.total_ram_gb;
        } else {
            ram = 8;
        }

        if (hardware?.cpu?.cores) {
            cores = hardware.cpu.cores;
        } else if (hardware?.cpu_cores) {
            cores = hardware.cpu_cores;
        } else {
            cores = 4;
        }

        const gpu = hardware?.gpu || {};
        const gpuCount =
            (Number.isFinite(Number(gpu.gpuCount)) ? Number(gpu.gpuCount) : null) ??
            (Number.isFinite(Number(hardware?.gpuCount)) ? Number(hardware.gpuCount) : null) ??
            1;
        const totalVRAM =
            (Number.isFinite(Number(gpu.vramGB)) ? Number(gpu.vramGB) : null) ??
            (Number.isFinite(Number(gpu.vram)) ? Number(gpu.vram) : null) ??
            (Number.isFinite(Number(gpu.totalVRAM)) ? Number(gpu.totalVRAM) : null) ??
            0;
        const unifiedGPU = Boolean(gpu.unified) || gpu.type === 'apple_silicon';
        const effectiveAcceleratorMem = unifiedGPU ? Math.max(totalVRAM, ram) : totalVRAM;

        if (effectiveAcceleratorMem >= 80 || (ram >= 64 && cores >= 16)) return 'extreme';
        if (effectiveAcceleratorMem >= 48 || (ram >= 32 && cores >= 12)) return 'very_high';
        if (effectiveAcceleratorMem >= 24 || (ram >= 16 && cores >= 8)) return 'high';
        if (gpuCount >= 2 && effectiveAcceleratorMem >= 20) return 'high';
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
    async getBestModelsForHardware(hardware, allModels, options = {}) {
        const categories = ['coding', 'reasoning', 'multimodal', 'creative', 'talking', 'reading', 'general'];
        const recommendations = {};
        const normalizedPool = this.normalizeExternalModels(Array.isArray(allModels) ? allModels : []);
        const installedModels = await this.getInstalledModels();
        const normalizedHardware = this.normalizeHardwareProfile(hardware || await this.getHardware());
        const optimizationObjective = this.normalizeOptimizationObjective(
            options.optimizeFor || options.optimize || options.objective
        );

        for (const category of categories) {
            try {
                const result = await this.selectModels(category, {
                    topN: 3,
                    enableProbe: false,
                    silent: true,
                    optimizeFor: optimizationObjective,
                    hardware: normalizedHardware,
                    installedModels,
                    modelPool: normalizedPool
                });

                recommendations[category] = {
                    tier: this.mapHardwareTier(normalizedHardware),
                    optimizeFor: optimizationObjective,
                    bestModels: result.candidates.map(candidate => this.mapCandidateToLegacyFormat(candidate)),
                    totalEvaluated: result.total_evaluated,
                    category: this.getCategoryInfo(category)
                };
            } catch (error) {
                recommendations[category] = {
                    tier: this.mapHardwareTier(normalizedHardware),
                    optimizeFor: optimizationObjective,
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
    generateRecommendationSummary(recommendations, hardware, options = {}) {
        const summary = {
            hardware_tier: this.mapHardwareTier(hardware),
            optimize_for: this.normalizeOptimizationObjective(
                options.optimizeFor || options.optimize || options.objective
            ),
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
                    quantization: bestModel.quantization || bestModel.quant || 'Q4_K_M',
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
                quantization: bestOverallModel.quantization || bestOverallModel.quant || 'Q4_K_M',
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
