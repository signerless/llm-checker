const ModelDatabase = require('./model-database');
const DeterministicModelSelector = require('../models/deterministic-selector');

function toArray(value) {
    return Array.isArray(value) ? value : [];
}

function parseParamsB(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return value;
        }
        const text = String(value || '').replace(/,/g, '');
        const match = text.match(/(\d+(?:\.\d+)?)\s*([bmt])\b/i);
        if (!match) continue;
        const amount = Number(match[1]);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const unit = match[2].toLowerCase();
        if (unit === 't') return amount * 1000;
        if (unit === 'm') return amount / 1000;
        return amount;
    }
    return null;
}

function inferFamily(identifier = '') {
    const text = String(identifier || '').toLowerCase();
    const families = [
        ['deepseek-r1', /deepseek[-_ ]?r1/],
        ['deepseek-coder', /deepseek[-_ ]?coder/],
        ['deepseek', /deepseek/],
        ['qwen3', /qwen3/],
        ['qwen2.5', /qwen2\.5/],
        ['qwen2', /qwen2/],
        ['qwen', /qwen/],
        ['llama3.2', /llama3\.2|llama-?3\.2/],
        ['llama3.1', /llama3\.1|llama-?3\.1/],
        ['llama3', /llama3|llama-?3/],
        ['llama2', /llama2|llama-?2/],
        ['mistral', /mistral/],
        ['mixtral', /mixtral/],
        ['gemma3', /gemma3/],
        ['gemma2', /gemma2/],
        ['gemma', /gemma/],
        ['phi4', /phi-?4/],
        ['phi3', /phi-?3/],
        ['phi', /phi/],
        ['codellama', /codellama|code-?llama/],
        ['starcoder', /starcoder/],
        ['llava', /llava/],
        ['nomic-embed', /nomic-embed/],
        ['bge', /\bbge\b/]
    ];

    for (const [family, pattern] of families) {
        if (pattern.test(text)) return family;
    }
    return 'other';
}

function normalizeQuantization(row = {}) {
    const raw = row.quantization || row.precision || '';
    if (raw) return raw;
    if (row.format === 'safetensors' || row.format === 'pytorch' || row.format === 'pytorch_bin') {
        return 'FP16';
    }
    return 'Q4_K_M';
}

function isShardedWeightFile(filename = '') {
    return /-\d{5,}-of-\d{5,}\.(safetensors|bin)$/i.test(String(filename || ''));
}

function choosePreferredRuntime(runtimeSupport = [], format = '', sourceId = '') {
    const runtimes = toArray(runtimeSupport).map((runtime) => String(runtime).toLowerCase());
    const normalizedFormat = String(format || '').toLowerCase();
    const source = String(sourceId || '').toLowerCase();

    if (source === 'ollama' || runtimes.includes('ollama')) return 'ollama';
    if (normalizedFormat === 'mlx' || runtimes.includes('mlx')) return 'mlx';
    if (normalizedFormat === 'gguf' || runtimes.includes('llama.cpp')) return 'llama.cpp';
    if (runtimes.includes('vllm')) return 'vllm';
    if (runtimes.includes('transformers')) return 'transformers';
    return runtimes[0] || 'transformers';
}

function artifactToSelectorModel(row) {
    const shardedFile = row.source_id === 'huggingface' && isShardedWeightFile(row.filename || row.artifact_name);
    const identifier = shardedFile
        ? (row.canonical_model_id || row.repo_id)
        : (row.artifact_name || row.filename || row.canonical_model_id || row.repo_id);
    const displayName = row.canonical_model_id || row.repo_display_name || identifier;
    const quant = normalizeQuantization(row);
    const paramsB = parseParamsB(
        row.active_parameter_count_b,
        row.parameter_count_b,
        row.artifact_name,
        row.filename,
        row.canonical_model_id,
        row.repo_id
    );

    if (!identifier || !Number.isFinite(paramsB) || paramsB <= 0) {
        return null;
    }

    const runtimeSupport = toArray(row.runtime_support);
    const preferredRuntime = choosePreferredRuntime(runtimeSupport, row.format, row.source_id);
    const tasks = toArray(row.tasks);
    const modalities = toArray(row.modalities);
    const tags = [
        row.source_id,
        row.format,
        quant,
        ...runtimeSupport,
        ...tasks
    ]
        .filter(Boolean)
        .map((tag) => String(tag).toLowerCase());

    const sizeGB = Number(row.size_gb);
    const sizeByQuant = Number.isFinite(sizeGB) && sizeGB > 0
        ? { [quant]: sizeGB }
        : {};

    return {
        name: displayName,
        model_identifier: identifier,
        family: inferFamily(`${displayName} ${identifier}`),
        paramsB,
        quant,
        availableQuantizations: [quant],
        sizeGB: Number.isFinite(sizeGB) && sizeGB > 0 ? sizeGB : undefined,
        sizeByQuant,
        ctxMax: Number(row.context_length) > 0 ? Number(row.context_length) : 4096,
        tags,
        modalities: modalities.length > 0 ? modalities : ['text'],
        pulls: Number(row.downloads) || 0,
        source: row.source_id,
        registry: row.source_name || row.source_id,
        version: shardedFile ? (row.repo_id || identifier) : (row.artifact_name || row.filename || identifier),
        license: row.license || 'unknown',
        digest: row.sha256 || row.etag || 'unknown',
        installCommand: shardedFile && row.repo_id ? `hf download ${row.repo_id}` : (row.install_command || ''),
        downloadUrl: shardedFile ? (row.repo_url || '') : (row.download_url || ''),
        preferredRuntime,
        artifact: row,
        provenance: {
            source: row.source_id,
            registry: row.source_name || row.source_id,
            version: shardedFile ? (row.repo_id || identifier) : (row.artifact_name || row.filename || identifier),
            license: row.license || 'unknown',
            digest: row.sha256 || row.etag || 'unknown',
            download_url: shardedFile ? (row.repo_url || '') : (row.download_url || ''),
            install_command: shardedFile && row.repo_id ? `hf download ${row.repo_id}` : (row.install_command || ''),
            repo_url: row.repo_url || ''
        }
    };
}

function dedupeRecommendationPool(models) {
    const deduped = new Map();
    for (const model of models) {
        const artifact = model.artifact || {};
        const key = [
            model.source,
            artifact.repo_id || model.name,
            model.model_identifier,
            model.preferredRuntime
        ].join('|');

        const existing = deduped.get(key);
        if (!existing) {
            deduped.set(key, model);
            continue;
        }

        const existingSize = Number(existing.sizeGB || existing.artifact?.size_gb || Number.MAX_SAFE_INTEGER);
        const size = Number(model.sizeGB || model.artifact?.size_gb || Number.MAX_SAFE_INTEGER);
        if (size < existingSize) {
            deduped.set(key, model);
        }
    }
    return [...deduped.values()];
}

function candidateToRecommendation(candidate) {
    const artifact = candidate.meta.artifact || {};
    return {
        model: candidate.meta.name,
        artifact: candidate.meta.model_identifier,
        source: candidate.meta.source,
        registry: candidate.meta.registry,
        score: candidate.score,
        params_b: candidate.meta.paramsB,
        quantization: candidate.quant,
        size_gb: candidate.meta.sizeGB || artifact.size_gb || null,
        required_gb: candidate.requiredGB,
        estimated_tps: candidate.estTPS,
        runtime: candidate.runtime,
        install_command: candidate.meta.installCommand || artifact.install_command || '',
        download_url: candidate.meta.downloadUrl || artifact.download_url || '',
        license: candidate.meta.license,
        gated: Boolean(artifact.gated),
        requires_auth: Boolean(artifact.requires_auth),
        tasks: toArray(artifact.tasks),
        modalities: toArray(artifact.modalities),
        rationale: candidate.rationale,
        components: candidate.components,
        memory: candidate.memory,
        speed: candidate.speed
    };
}

function normalizeHardwareForSelector(hardware = {}) {
    if (hardware.memory?.totalGB && hardware.gpu && hardware.acceleration) {
        return hardware;
    }

    const summary = hardware.summary || {};
    const cpuInfo = hardware.cpu || hardware.backends?.cpu?.info || {};
    const cpuCores = cpuInfo.cores || {};
    const bestBackend = summary.bestBackend || hardware.primary?.type || 'cpu';
    const systemRAM = Number(summary.systemRAM || summary.effectiveMemory || 8);
    const totalVRAM = Number(summary.totalVRAM || 0);
    const gpuModel = summary.gpuModel || summary.gpuInventory || hardware.primary?.name || '';
    const isMetal = bestBackend === 'metal';
    const isCuda = bestBackend === 'cuda';
    const isRocm = bestBackend === 'rocm';

    return {
        cpu: {
            architecture: cpuInfo.architecture || process.arch,
            cores: Number(cpuCores.logical || cpuCores.physical || cpuInfo.cores || 4),
            model: cpuInfo.brand || summary.cpuModel || ''
        },
        gpu: {
            type: isMetal ? 'apple_silicon' : (isCuda ? 'nvidia' : (isRocm ? 'amd' : 'cpu_only')),
            model: gpuModel,
            vramGB: totalVRAM,
            totalVRAM,
            gpuCount: Math.max(1, Number(summary.gpuCount || 1)),
            unified: Boolean(isMetal || (summary.hasIntegratedGPU && !summary.hasDedicatedGPU)),
            isMultiGPU: Boolean(summary.isMultiGPU)
        },
        memory: {
            totalGB: systemRAM,
            total: systemRAM
        },
        acceleration: {
            supports_metal: isMetal,
            supports_cuda: isCuda,
            supports_rocm: isRocm
        },
        usableMemGB: Number(summary.effectiveMemory) > 0 ? Number(summary.effectiveMemory) : undefined
    };
}

class RegistryRecommender {
    constructor(options = {}) {
        this.database = options.database || new ModelDatabase(options.databaseOptions || {});
        this.selector = options.selector || new DeterministicModelSelector();
    }

    async initialize() {
        await this.database.initialize();
    }

    async recommend(options = {}) {
        const selection = await this.selectCategory(options);
        return {
            category: selection.category,
            runtime: selection.runtime,
            optimizeFor: selection.result.optimizeFor,
            total_artifacts: selection.rows.length,
            total_candidates: selection.modelPool.length,
            total_evaluated: selection.result.total_evaluated,
            recommendations: selection.result.candidates.map(candidateToRecommendation),
            registry: this.database.getRegistryStats(),
            generated_at: new Date().toISOString()
        };
    }

    async selectCategory(options = {}) {
        const category = options.category || 'general';
        const runtime = options.runtime || 'auto';
        const runtimeFilter = ['auto', 'all', '*'].includes(String(runtime).toLowerCase()) ? undefined : runtime;
        const limit = Number(options.limit) > 0 ? Number(options.limit) : 10;
        const poolLimit = Number(options.poolLimit) > 0 ? Number(options.poolLimit) : 20000;
        const targetCtx = Number(options.targetContext) > 0 ? Number(options.targetContext) : undefined;

        const rows = this.database.searchModelArtifacts(options.query || '', {
            source: options.source,
            format: options.format,
            runtime: runtimeFilter,
            quantization: options.quantization,
            maxSizeGB: options.maxSizeGB,
            minParamsB: options.minParamsB,
            maxParamsB: options.maxParamsB,
            localOnly: options.localOnly !== false,
            limit: poolLimit
        });
        const modelPool = dedupeRecommendationPool(rows.map(artifactToSelectorModel).filter(Boolean));

        const selectorHardware = normalizeHardwareForSelector(options.hardware || {});
        const normalizedRuntime = runtimeFilter || 'auto';
        const result = runtimeFilter
            ? await this.selector.selectModels(category, {
                topN: limit,
                enableProbe: false,
                silent: true,
                optimizeFor: options.optimizeFor || 'balanced',
                runtime: runtimeFilter,
                targetCtx,
                hardware: selectorHardware,
                installedModels: [],
                modelPool
            })
            : this.scoreAutoRuntimePool({
                category,
                limit,
                targetCtx,
                optimizeFor: options.optimizeFor || 'balanced',
                hardware: selectorHardware,
                modelPool
            });

        return {
            category,
            runtime: normalizedRuntime,
            rows,
            modelPool,
            result
        };
    }

    async getBestModelsForHardware(hardware, options = {}) {
        const categories = options.categories || ['coding', 'reasoning', 'multimodal', 'creative', 'talking', 'reading', 'general'];
        const recommendations = {};
        const runtime = options.runtime || 'auto';
        const optimizeFor = options.optimizeFor || options.optimize || 'balanced';
        const limit = Number(options.limit) > 0 ? Number(options.limit) : 3;
        const registryStats = this.database.getRegistryStats();
        const analyzedModels = new Set();

        for (const category of categories) {
            try {
                const selection = await this.selectCategory({
                    ...options,
                    category,
                    runtime,
                    optimizeFor,
                    limit,
                    hardware
                });
                for (const model of selection.modelPool) {
                    const artifact = model.artifact || {};
                    analyzedModels.add([
                        artifact.artifact_id || artifact.id || artifact.filename || model.model_identifier,
                        model.source,
                        model.preferredRuntime
                    ].filter(Boolean).join('|'));
                }
                const normalizedHardware = this.selector.normalizeHardwareProfile(
                    normalizeHardwareForSelector(hardware || {})
                );
                recommendations[category] = {
                    tier: this.selector.mapHardwareTier(normalizedHardware),
                    optimizeFor: selection.result.optimizeFor,
                    runtime: selection.runtime,
                    source: 'registry',
                    bestModels: selection.result.candidates.map((candidate) => this.selector.mapCandidateToLegacyFormat(candidate)),
                    totalEvaluated: selection.result.total_evaluated,
                    totalArtifacts: selection.rows.length,
                    totalCandidates: selection.modelPool.length,
                    category: this.selector.getCategoryInfo(category)
                };
            } catch (error) {
                recommendations[category] = {
                    tier: 'unknown',
                    optimizeFor,
                    runtime,
                    source: 'registry',
                    bestModels: [],
                    totalEvaluated: 0,
                    totalArtifacts: 0,
                    totalCandidates: 0,
                    error: error.message,
                    category: this.selector.getCategoryInfo(category)
                };
            }
        }

        return {
            recommendations,
            registryStats,
            totalModelsAnalyzed: analyzedModels.size
        };
    }

    scoreAutoRuntimePool({ category, limit, targetCtx, optimizeFor, hardware, modelPool }) {
        const normalizedHardware = this.selector.normalizeHardwareProfile(hardware);
        const objective = this.selector.normalizeOptimizationObjective(optimizeFor);
        const ctx = targetCtx || this.selector.targetContexts[category] || this.selector.targetContexts.general;
        const totalMem = normalizedHardware?.memory?.totalGB ?? normalizedHardware?.memory?.total ?? 8;
        const usableMem = typeof normalizedHardware.usableMemGB === 'number'
            ? normalizedHardware.usableMemGB
            : Math.max(1, Math.min(0.8 * totalMem, totalMem - 2));
        const isUnified = Boolean(normalizedHardware?.gpu?.unified) || normalizedHardware?.gpu?.type === 'apple_silicon';
        const vram = normalizedHardware?.gpu?.vramGB ?? normalizedHardware?.gpu?.vram ?? 0;
        const budget = isUnified ? usableMem : (vram || usableMem);
        const filtered = this.selector.filterByCategory(modelPool, category);
        const candidates = [];

        for (const model of filtered) {
            const runtime = model.preferredRuntime || choosePreferredRuntime(
                model.artifact?.runtime_support,
                model.artifact?.format,
                model.source
            );
            const candidate = this.selector.evaluateModel(
                model,
                normalizedHardware,
                category,
                ctx,
                budget,
                objective,
                runtime
            );
            if (candidate) candidates.push(candidate);
        }

        candidates.sort((a, b) => b.score - a.score);

        return {
            category,
            optimizeFor: objective,
            runtime: 'auto',
            hardware: normalizedHardware,
            candidates: candidates.slice(0, limit),
            total_evaluated: filtered.length,
            timestamp: new Date().toISOString()
        };
    }

    close() {
        this.database.close();
    }
}

module.exports = {
    RegistryRecommender,
    artifactToSelectorModel,
    candidateToRecommendation,
    normalizeHardwareForSelector,
    choosePreferredRuntime,
    dedupeRecommendationPool
};
