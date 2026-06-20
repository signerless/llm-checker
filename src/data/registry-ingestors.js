const crypto = require('crypto');
const fetch = require('../utils/fetch');

const SOURCE_DEFINITIONS = {
    huggingface: {
        id: 'huggingface',
        name: 'Hugging Face Hub',
        base_url: 'https://huggingface.co',
        source_type: 'model_hub'
    },
    ollama: {
        id: 'ollama',
        name: 'Ollama Library',
        base_url: 'https://ollama.com/library',
        source_type: 'runtime_registry'
    },
    gpt4all: {
        id: 'gpt4all',
        name: 'GPT4All Catalog',
        base_url: 'https://github.com/nomic-ai/gpt4all',
        source_type: 'curated_catalog'
    }
};

const HUGGING_FACE_MODEL_API = 'https://huggingface.co/api/models';
const GPT4ALL_MODELS_URL = 'https://gpt4all.io/models/models3.json';

function extractNextLink(linkHeader = '') {
    const links = String(linkHeader || '').split(',');
    for (const link of links) {
        const match = link.match(/<([^>]+)>;\s*rel="next"/i);
        if (match) return match[1];
    }
    return null;
}

function toArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function normalizeIdPart(value) {
    return String(value || '')
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/[^a-zA-Z0-9._:/@-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

function hashShort(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function makeScopedId(...parts) {
    const normalized = parts.map(normalizeIdPart).filter(Boolean).join(':');
    if (normalized.length <= 180) return normalized;
    return `${normalized.slice(0, 140)}:${hashShort(normalized)}`;
}

function makeArtifactId(sourceId, repoId, artifactName) {
    return makeScopedId(sourceId, repoId, artifactName, hashShort(artifactName));
}

function bytesToGB(bytes) {
    const parsed = Number(bytes);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round((parsed / (1024 ** 3)) * 1000) / 1000;
}

function parseNumberWithUnit(rawValue) {
    if (rawValue === null || rawValue === undefined) return null;
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;

    const text = String(rawValue).replace(/,/g, '').trim().toLowerCase();
    if (!text) return null;

    if (/^\d+(?:\.\d+)?$/.test(text)) {
        return Number(text);
    }

    // Mixture-of-Experts "NxMB" naming (e.g. Mixtral 8x7B, 8x22B): the total
    // parameter footprint that must reside in memory is experts * per-expert
    // size. Without this, "8x7B" matches the bare "7b" below and is stored as 7B.
    const moe = text.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/i);
    if (moe) {
        const experts = Number(moe[1]);
        const perExpert = Number(moe[2]);
        if (experts > 0 && Number.isFinite(perExpert) && perExpert > 0) {
            return experts * perExpert;
        }
    }

    // Note: 'k'/'thousand' are intentionally NOT parameter units. Parameter
    // counts are never expressed in thousands-of-billions, and tokens like
    // "128k" (a context length) were being misread as ~0.0001B and rounded to 0.
    const match = text.match(/(\d+(?:\.\d+)?)\s*(trillion|billion|million|[tmb])\b/i);
    if (!match) return null;

    const value = Number(match[1]);
    if (!Number.isFinite(value)) return null;
    const unit = (match[2] || '').toLowerCase();
    if (unit === 't' || unit === 'trillion') return value * 1000;
    if (unit === 'm' || unit === 'million') return value / 1000;
    return value;
}

function sumSafetensorsParams(safetensors) {
    if (!safetensors || typeof safetensors !== 'object') return null;
    if (Number.isFinite(Number(safetensors.total))) {
        return Number(safetensors.total) / 1e9;
    }

    const parameters = safetensors.parameters;
    if (!parameters || typeof parameters !== 'object') return null;
    const total = Object.values(parameters).reduce((sum, value) => {
        const parsed = Number(value);
        return sum + (Number.isFinite(parsed) ? parsed : 0);
    }, 0);

    return total > 0 ? total / 1e9 : null;
}

function parseParamsB(...values) {
    for (const value of values) {
        const parsed = parseNumberWithUnit(value);
        if (parsed !== null && parsed > 0) {
            const rounded = Math.round(parsed * 1000) / 1000;
            // Never let a value that rounds to 0 escape the > 0 guard.
            if (rounded > 0) return rounded;
        }
    }
    return null;
}

function parseActiveParamsB(...values) {
    const text = values.map((value) => String(value || '')).join(' ');
    const active = text.match(/(?:^|[-_\s])a(\d+(?:\.\d+)?)([bm])(?:[-_\s]|$)/i);
    if (!active) return null;
    const value = Number(active[1]);
    if (!Number.isFinite(value)) return null;
    return active[2].toLowerCase() === 'm'
        ? Math.round((value / 1000) * 1000) / 1000
        : value;
}

function inferQuantization(...values) {
    const text = values.map((value) => String(value || '')).join(' ');
    const ggufQuant = text.match(/\b(IQ\d(?:_[A-Z0-9]+)?|Q\d(?:_[A-Z0-9]+){0,2}|F16|FP16|BF16|Q8_0)\b/i);
    if (ggufQuant) return ggufQuant[1].toUpperCase().replace(/^F16$/, 'FP16');

    const bitQuant = text.match(/\b([234568])\s*[-_ ]?bit\b/i);
    if (bitQuant) return `${bitQuant[1]}bit`;

    return '';
}

function inferPrecision(...values) {
    const text = values.map((value) => String(value || '')).join(' ').toLowerCase();
    if (/\bbf16\b/.test(text)) return 'BF16';
    if (/\bfp16\b|\bf16\b/.test(text)) return 'FP16';
    if (/\bfp32\b|\bf32\b/.test(text)) return 'FP32';
    if (/\bint8\b|\b8bit\b/.test(text)) return 'INT8';
    if (/\bint4\b|\b4bit\b/.test(text)) return 'INT4';
    return '';
}

function inferFormat(filename = '', tags = []) {
    const lower = String(filename || '').toLowerCase();
    const tagText = toArray(tags).join(' ').toLowerCase();
    if (lower.endsWith('.gguf')) return 'gguf';
    if (lower.endsWith('.safetensors')) return tagText.includes('mlx') || lower.includes('mlx') ? 'mlx' : 'safetensors';
    if (lower.endsWith('.bin')) return lower.includes('ggml') ? 'ggml' : 'pytorch_bin';
    if (lower.endsWith('.pt') || lower.endsWith('.pth')) return 'pytorch';
    if (tagText.includes('ollama')) return 'ollama';
    return 'unknown';
}

function inferRuntimeSupport(format, tags = [], sourceId = '') {
    const normalizedFormat = String(format || '').toLowerCase();
    const tagText = `${toArray(tags).join(' ')} ${sourceId}`.toLowerCase();
    const runtimes = new Set();

    if (normalizedFormat === 'gguf' || normalizedFormat === 'ggml') {
        runtimes.add('llama.cpp');
        runtimes.add('ollama');
    }
    if (normalizedFormat === 'ollama') {
        runtimes.add('ollama');
    }
    if (normalizedFormat === 'mlx' || tagText.includes('mlx')) {
        runtimes.add('mlx');
    }
    if (normalizedFormat === 'safetensors' || normalizedFormat === 'pytorch' || normalizedFormat === 'pytorch_bin') {
        runtimes.add('transformers');
        runtimes.add('vllm');
    }
    if (tagText.includes('exl2') || tagText.includes('exllama')) {
        runtimes.add('exllama');
    }

    return [...runtimes];
}

function inferTasks(model = {}) {
    const tags = toArray(model.tags || model.capabilities || model.categories || model.use_cases);
    const tasks = new Set();
    const pipelineTag = model.pipeline_tag || model.primary_category || model.category;
    if (pipelineTag) tasks.add(String(pipelineTag));

    const text = [
        model.id,
        model.modelId,
        model.model_identifier,
        model.model_name,
        model.description,
        ...tags
    ].filter(Boolean).join(' ').toLowerCase();

    if (/code|coder|programming/.test(text)) tasks.add('coding');
    if (/chat|instruct|assistant|conversation/.test(text)) tasks.add('chat');
    if (/reason|math|logic|r1|qwq/.test(text)) tasks.add('reasoning');
    if (/embed|retrieval|bge|e5|nomic/.test(text)) tasks.add('embeddings');
    if (/vision|vl|image|multimodal|llava/.test(text)) tasks.add('multimodal');
    if (/creative|writing|story|roleplay/.test(text)) tasks.add('creative');
    if (tasks.size === 0) tasks.add('general');
    return [...tasks];
}

function inferModalities(model = {}, filename = '') {
    const text = [
        model.id,
        model.modelId,
        model.model_identifier,
        model.model_name,
        model.description,
        filename,
        ...toArray(model.tags || model.capabilities || model.categories)
    ].filter(Boolean).join(' ').toLowerCase();
    const modalities = new Set(['text']);
    if (/vision|image|vl|multimodal|llava/.test(text)) modalities.add('vision');
    if (/audio|speech|whisper/.test(text)) modalities.add('audio');
    return [...modalities];
}

function extractLicense(model = {}) {
    const cardData = model.cardData || model.card_data || {};
    if (cardData.license) return Array.isArray(cardData.license) ? cardData.license.join(',') : String(cardData.license);
    const licenseTag = toArray(model.tags).find((tag) => String(tag).startsWith('license:'));
    return licenseTag ? String(licenseTag).replace(/^license:/, '') : 'unknown';
}

function getSiblingName(sibling = {}) {
    return sibling.rfilename || sibling.path || sibling.name || sibling.filename || '';
}

function getSiblingSizeBytes(sibling = {}) {
    const candidates = [
        sibling.size,
        sibling.sizeBytes,
        sibling.lfs?.size,
        sibling.blobSize
    ];
    for (const value of candidates) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function isModelArtifactFile(filename) {
    const lower = String(filename || '').toLowerCase();
    if (!lower) return false;
    if (lower.endsWith('.gguf')) return true;
    if (lower.endsWith('.safetensors')) return true;
    if (/pytorch_model.*\.bin$/.test(lower)) return true;
    if (/model.*\.(bin|pt|pth)$/.test(lower)) return true;
    if (/ggml.*\.bin$/.test(lower)) return true;
    return false;
}

function buildHuggingFaceDownloadUrl(repoId, filename, revision = 'main') {
    const encodedPath = String(filename || '')
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/');
    return `https://huggingface.co/${repoId}/resolve/${revision || 'main'}/${encodedPath}`;
}

function normalizeHuggingFaceModel(model) {
    const repoId = model.id || model.modelId || model.model_id;
    if (!repoId) return null;

    const namespace = repoId.includes('/') ? repoId.split('/')[0] : '';
    const tags = toArray(model.tags);
    const tasks = inferTasks(model);
    const modalities = inferModalities(model);
    const license = extractLicense(model);
    const gated = Boolean(model.gated && model.gated !== 'false');
    const repoKey = makeScopedId('huggingface', repoId);
    const repo = {
        id: repoKey,
        source_id: 'huggingface',
        repo_id: repoId,
        namespace,
        canonical_model_id: repoId,
        display_name: model.modelId || repoId,
        url: `https://huggingface.co/${repoId}`,
        license,
        gated,
        requires_auth: gated,
        downloads: Number(model.downloads) || 0,
        likes: Number(model.likes) || 0,
        tags,
        tasks,
        modalities,
        last_modified: model.lastModified || model.last_modified || '',
        sha: model.sha || '',
        metadata: {
            pipeline_tag: model.pipeline_tag || '',
            library_name: model.library_name || '',
            cardData: model.cardData || null
        }
    };

    const repoParamsB =
        sumSafetensorsParams(model.safetensors) ||
        parseParamsB(model.config?.num_parameters, model.cardData?.params, repoId, tags.join(' '));
    const activeParamsB = parseActiveParamsB(repoId, tags.join(' '));
    const contextLength = Number(
        model.config?.max_position_embeddings ||
        model.config?.model_max_length ||
        model.config?.max_sequence_length ||
        model.cardData?.context_length ||
        0
    ) || null;
    const revision = model.sha || 'main';
    const artifacts = [];

    for (const sibling of toArray(model.siblings)) {
        const filename = getSiblingName(sibling);
        if (!isModelArtifactFile(filename)) continue;

        const sizeBytes = getSiblingSizeBytes(sibling);
        const format = inferFormat(filename, tags);
        const quantization = inferQuantization(filename, tags.join(' '));
        const precision = inferPrecision(filename, tags.join(' '), quantization);
        const artifactName = filename;
        artifacts.push({
            id: makeArtifactId('huggingface', repoId, artifactName),
            source_id: 'huggingface',
            repo_key: repoKey,
            repo_id: repoId,
            canonical_model_id: repoId,
            artifact_name: artifactName,
            filename,
            format,
            quantization,
            precision,
            parameter_count_b: parseParamsB(filename) || repoParamsB,
            active_parameter_count_b: activeParamsB,
            size_bytes: sizeBytes,
            size_gb: bytesToGB(sizeBytes),
            context_length: contextLength,
            runtime_support: inferRuntimeSupport(format, tags, 'huggingface'),
            tasks,
            modalities: inferModalities(model, filename),
            download_url: buildHuggingFaceDownloadUrl(repoId, filename, revision),
            install_command: `hf download ${repoId} ${filename}`,
            sha256: sibling.lfs?.sha256 || '',
            etag: sibling.lfs?.oid || sibling.blobId || '',
            license,
            gated,
            requires_auth: gated,
            downloads: repo.downloads,
            likes: repo.likes,
            updated_at: repo.last_modified,
            metadata: {
                repo_sha: model.sha || '',
                sibling
            }
        });
    }

    return { source: SOURCE_DEFINITIONS.huggingface, repos: [repo], artifacts };
}

function normalizeGpt4AllEntry(entry) {
    const filenameCandidate = entry.filename || '';
    const url = entry.url || entry.downloadUrl || entry.download_url ||
        (filenameCandidate ? `https://gpt4all.io/models/gguf/${encodeURIComponent(filenameCandidate)}` : '');
    const name = entry.name || filenameCandidate || url.split('/').filter(Boolean).pop();
    if (!name || !url) return null;

    const repoMatch = url.match(/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/);
    const repoId = repoMatch ? repoMatch[1] : `gpt4all/${name}`;
    const filename = repoMatch ? decodeURIComponent(repoMatch[3]) : (filenameCandidate || url.split('/').filter(Boolean).pop());
    const repoKey = makeScopedId('gpt4all', repoId);
    const tags = ['gpt4all', entry.type, entry.quant].filter(Boolean);
    const paramsB = parseParamsB(entry.parameters, name, filename);
    const sizeBytes = Number(entry.filesize || entry.fileSize || entry.size || 0) || null;
    const format = inferFormat(filename, tags);

    return {
        source: SOURCE_DEFINITIONS.gpt4all,
        repos: [{
            id: repoKey,
            source_id: 'gpt4all',
            repo_id: repoId,
            namespace: repoId.includes('/') ? repoId.split('/')[0] : 'gpt4all',
            canonical_model_id: name,
            display_name: name,
            url: repoMatch ? `https://huggingface.co/${repoId}` : url,
            license: entry.license || 'unknown',
            gated: false,
            requires_auth: false,
            downloads: Number(entry.downloads) || 0,
            likes: 0,
            tags,
            tasks: inferTasks({ model_name: name, tags }),
            modalities: ['text'],
            metadata: {
                ramrequired: entry.ramrequired || null,
                type: entry.type || null,
                md5sum: entry.md5sum || null
            }
        }],
        artifacts: [{
            id: makeArtifactId('gpt4all', repoId, filename || name),
            source_id: 'gpt4all',
            repo_key: repoKey,
            repo_id: repoId,
            canonical_model_id: name,
            artifact_name: filename || name,
            filename: filename || '',
            format,
            quantization: inferQuantization(entry.quant, filename),
            precision: inferPrecision(entry.quant, filename),
            parameter_count_b: paramsB,
            active_parameter_count_b: null,
            size_bytes: sizeBytes,
            size_gb: bytesToGB(sizeBytes),
            runtime_support: inferRuntimeSupport(format, tags, 'gpt4all'),
            tasks: inferTasks({ model_name: name, tags }),
            modalities: ['text'],
            download_url: url,
            install_command: `curl -L ${url} -o ${filename || name}`,
            sha256: entry.sha256 || '',
            etag: entry.md5sum || '',
            license: entry.license || 'unknown',
            gated: false,
            requires_auth: false,
            metadata: {
                ramrequired: entry.ramrequired || null,
                description: entry.description || '',
                promptTemplate: entry.promptTemplate || ''
            }
        }]
    };
}

function normalizeOllamaRows(model, variant) {
    const modelId = model.id || model.model_identifier;
    const tag = variant.tag || modelId;
    const repoKey = makeScopedId('ollama', modelId);
    const capabilities = (() => {
        try {
            return JSON.parse(model.capabilities || '[]');
        } catch {
            return [];
        }
    })();
    const tasks = inferTasks({
        model_identifier: modelId,
        model_name: model.name,
        capabilities,
        categories: capabilities
    });
    const modalities = inferModalities({ model_identifier: modelId, model_name: model.name, capabilities }, tag);

    return {
        source: SOURCE_DEFINITIONS.ollama,
        repos: [{
            id: repoKey,
            source_id: 'ollama',
            repo_id: modelId,
            namespace: model.namespace || '',
            canonical_model_id: modelId,
            display_name: model.name || modelId,
            url: model.url || `https://ollama.com/library/${modelId}`,
            license: 'unknown',
            gated: false,
            requires_auth: false,
            downloads: Number(model.pulls) || 0,
            likes: 0,
            tags: capabilities,
            tasks,
            modalities,
            last_modified: model.last_updated || '',
            metadata: {
                tags_count: model.tags_count || 0,
                source_updated_at: model.updated_at || ''
            }
        }],
        artifacts: [{
            id: makeArtifactId('ollama', modelId, tag),
            source_id: 'ollama',
            repo_key: repoKey,
            repo_id: modelId,
            canonical_model_id: modelId,
            artifact_name: tag,
            filename: '',
            format: 'ollama',
            quantization: variant.quant || inferQuantization(tag),
            precision: inferPrecision(variant.quant, tag),
            parameter_count_b: Number(variant.params_b) || parseParamsB(tag),
            active_parameter_count_b: null,
            size_bytes: null,
            size_gb: Number(variant.size_gb) || null,
            context_length: Number(variant.context_length) || null,
            runtime_support: ['ollama'],
            tasks,
            modalities,
            download_url: `ollama://library/${tag}`,
            install_command: `ollama pull ${tag}`,
            license: 'unknown',
            gated: false,
            requires_auth: false,
            downloads: Number(model.pulls) || 0,
            updated_at: model.updated_at || model.last_updated || '',
            metadata: {
                input_types: variant.input_types || '["text"]',
                is_moe: Boolean(variant.is_moe),
                expert_count: variant.expert_count || null
            }
        }]
    };
}

class RegistryIngestor {
    constructor(options = {}) {
        this.database = options.database;
        this.fetchImpl = options.fetchImpl || fetch;
        this.onProgress = options.onProgress || (() => {});
    }

    async ingest(options = {}) {
        if (!this.database) {
            throw new Error('RegistryIngestor requires a database instance');
        }

        const sources = String(options.sources || 'ollama,huggingface,gpt4all')
            .split(',')
            .map((source) => source.trim().toLowerCase())
            .filter(Boolean);
        const genericLimit = Number(options.limit) > 0 ? Number(options.limit) : null;
        const limits = {
            huggingface: Number(options.hfLimit || options.huggingfaceLimit) > 0
                ? Number(options.hfLimit || options.huggingfaceLimit)
                : (genericLimit || 3000),
            gpt4all: Number(options.gpt4allLimit) > 0
                ? Number(options.gpt4allLimit)
                : (genericLimit || 1000),
            ollama: Number(options.ollamaLimit) > 0
                ? Number(options.ollamaLimit)
                : (genericLimit || 10000)
        };
        const collections = [];

        for (const source of sources) {
            if (source === 'huggingface' || source === 'hf') {
                collections.push(...await this.collectHuggingFace({
                    limit: limits.huggingface,
                    query: options.query,
                    task: options.task
                }));
            } else if (source === 'gpt4all') {
                collections.push(...await this.collectGpt4All({ limit: limits.gpt4all }));
            } else if (source === 'ollama') {
                collections.push(...this.collectOllamaFromDatabase({ limit: limits.ollama }));
            } else {
                throw new Error(`Unsupported registry source: ${source}`);
            }
        }

        if (!options.dryRun) {
            this.storeCollections(collections);
        }

        return this.summarizeCollections(collections, { dryRun: Boolean(options.dryRun) });
    }

    async collectHuggingFace(options = {}) {
        const requestedLimit = Number(options.limit) > 0 ? Number(options.limit) : 1000;
        const pageLimit = Math.min(1000, requestedLimit);
        const params = new URLSearchParams({
            sort: 'downloads',
            direction: '-1',
            limit: String(pageLimit),
            full: 'true',
            config: 'true'
        });
        if (options.query) params.set('search', options.query);
        if (options.task) params.set('filter', options.task);

        const models = [];
        let url = `${HUGGING_FACE_MODEL_API}?${params.toString()}`;
        while (url && models.length < requestedLimit) {
            this.onProgress({ source: 'huggingface', message: `Fetching ${url}` });
            const response = await this.fetchImpl(url, {
                headers: { 'Accept': 'application/json' }
            });

            if (!response.ok) {
                throw new Error(`Hugging Face request failed: HTTP ${response.status}`);
            }

            const payload = await response.json();
            const pageModels = toArray(payload);
            models.push(...pageModels);
            if (pageModels.length === 0) break;
            url = models.length < requestedLimit ? extractNextLink(response.headers?.get?.('link')) : null;
        }

        return models
            .slice(0, requestedLimit)
            .map(normalizeHuggingFaceModel)
            .filter(Boolean);
    }

    async collectGpt4All(options = {}) {
        this.onProgress({ source: 'gpt4all', message: 'Fetching GPT4All metadata' });
        const response = await this.fetchImpl(GPT4ALL_MODELS_URL, {
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`GPT4All request failed: HTTP ${response.status}`);
        }

        const payload = await response.json();
        const entries = Array.isArray(payload) ? payload : (payload.models || []);
        return entries
            .slice(0, options.limit || entries.length)
            .map(normalizeGpt4AllEntry)
            .filter(Boolean);
    }

    collectOllamaFromDatabase(options = {}) {
        const limit = Number(options.limit) > 0 ? Number(options.limit) : 1000;
        const rows = this.database.all(`
            SELECT
                m.*,
                v.tag,
                v.params_b,
                v.quant,
                v.size_gb,
                v.context_length,
                v.input_types,
                v.is_moe,
                v.expert_count
            FROM models m
            JOIN variants v ON v.model_id = m.id
            ORDER BY m.pulls DESC, v.params_b DESC, v.size_gb ASC
            LIMIT ?
        `, [limit]);

        return rows.map((row) => {
            const model = {
                id: row.id,
                name: row.name,
                capabilities: row.capabilities,
                namespace: row.namespace,
                url: row.url,
                pulls: row.pulls,
                tags_count: row.tags_count,
                last_updated: row.last_updated,
                updated_at: row.updated_at
            };
            const variant = {
                tag: row.tag,
                params_b: row.params_b,
                quant: row.quant,
                size_gb: row.size_gb,
                context_length: row.context_length,
                input_types: row.input_types,
                is_moe: row.is_moe,
                expert_count: row.expert_count
            };
            return normalizeOllamaRows(model, variant);
        });
    }

    storeCollections(collections) {
        this.database.beginBatch();
        try {
            for (const collection of collections) {
                if (collection.source) {
                    this.database.upsertRegistrySource({
                        ...collection.source,
                        last_ingested_at: new Date().toISOString()
                    });
                }
                for (const repo of collection.repos || []) {
                    this.database.upsertRegistryRepo(repo);
                }
                for (const artifact of collection.artifacts || []) {
                    this.database.upsertModelArtifact(artifact);
                }
            }
        } finally {
            this.database.endBatch();
        }
    }

    summarizeCollections(collections, options = {}) {
        const sources = new Set();
        const repoIds = new Set();
        let artifacts = 0;
        for (const collection of collections) {
            if (collection.source?.id) sources.add(collection.source.id);
            for (const repo of collection.repos || []) repoIds.add(repo.id);
            artifacts += (collection.artifacts || []).length;
        }

        return {
            dryRun: Boolean(options.dryRun),
            sources: sources.size,
            repos: repoIds.size,
            artifacts,
            collections: collections.length
        };
    }
}

module.exports = {
    RegistryIngestor,
    SOURCE_DEFINITIONS,
    normalizeHuggingFaceModel,
    normalizeGpt4AllEntry,
    normalizeOllamaRows,
    inferFormat,
    inferQuantization,
    inferRuntimeSupport,
    parseParamsB,
    buildHuggingFaceDownloadUrl
};
