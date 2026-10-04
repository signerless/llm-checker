const crypto = require('crypto');
const fetch = require('../utils/fetch');
const { precisionProfile } = require('../models/ranking-contract');

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
    },
    docker: {
        id: 'docker',
        name: 'Docker Hub AI models',
        base_url: 'https://hub.docker.com/u/ai',
        source_type: 'runtime_registry'
    }
};

const DOCKER_HUB_API = 'https://hub.docker.com/v2/repositories';
// Docker's `ai/` namespace also packages image, video and speech models.
const DOCKER_NON_LANGUAGE_REPO = /stable-diffusion|flux|diffusion|cosmos|whisper|kokoro|tts|speech|wan2/i;

const HUGGING_FACE_BASE_URL = 'https://huggingface.co';
const HUGGING_FACE_MODEL_API = `${HUGGING_FACE_BASE_URL}/api/models`;
const GPT4ALL_MODELS_URL = 'https://gpt4all.io/models/models3.json';

// `full=true` omits the fields that carry exact metadata. `expand[]` returns
// parameter counts and dtypes (safetensors), GGUF headers (parameters,
// architecture, context length), card licenses, and model lineage.
const HUGGING_FACE_EXPAND_FIELDS = [
    'siblings', 'safetensors', 'gguf', 'cardData', 'baseModels', 'tags', 'downloads',
    'likes', 'pipeline_tag', 'library_name', 'sha', 'lastModified', 'createdAt', 'gated'
];

// The Hub's download ranking is dominated by ASR, diffusion and classifier
// repos. Spending the limit per task keeps it on models the recommender can use.
const HUGGING_FACE_TASK_PLAN = [
    { task: 'text-generation', share: 0.7 },
    { task: 'image-text-to-text', share: 0.22 },
    { task: 'feature-extraction', share: 0.04 },
    { task: 'sentence-similarity', share: 0.04 }
];

// Model makers that publish first-party checkpoints, plus the official GGUF
// organizations of llama.cpp and LM Studio. Their catalogs are swept by author
// so new or less-downloaded official releases are not lost below the cutoff.
const OFFICIAL_HUGGING_FACE_PUBLISHERS = [
    'meta-llama', 'Qwen', 'google', 'mistralai', 'microsoft', 'deepseek-ai', 'nvidia',
    'ibm-granite', 'allenai', 'HuggingFaceTB', 'tiiuae', 'CohereLabs', '01-ai', 'zai-org',
    'internlm', 'OpenGVLab', 'openbmb', 'moonshotai', 'MiniMaxAI', 'baidu', 'tencent',
    'LiquidAI', 'ai21labs', 'stepfun-ai', 'openai', 'apple', 'Snowflake', 'nomic-ai', 'BAAI',
    'jinaai', 'intfloat', 'mixedbread-ai', 'swiss-ai', 'inclusionAI', 'ByteDance-Seed',
    'XiaomiMiMo', 'meituan-longcat', 'arcee-ai', 'Salesforce', 'amazon', 'ServiceNow-AI',
    'upstage', 'LGAI-EXAONE', 'naver-hyperclovax', 'kakaocorp', 'sarvamai', 'NousResearch',
    'ggml-org', 'lmstudio-community'
];

// A weight-file extension alone also matches diffusion models and asset bundles.
// Require an explicit language/vision-language task, including older Hub tags.
const LANGUAGE_MODEL_TASKS = new Set([
    'text-generation', 'text2text-generation', 'conversational',
    'image-text-to-text', 'image-to-text', 'visual-question-answering',
    'document-question-answering', 'feature-extraction', 'sentence-similarity'
]);

// Runtimes whose repos often omit `pipeline_tag` (official Mistral releases are
// tagged only `vllm` + `mistral-common`). They are accepted when nothing marks
// the repo as speech, image generation or another non-language task.
const LANGUAGE_MODEL_LIBRARIES = new Set(['vllm', 'mistral-common', 'mlx', 'gguf']);
const NON_LANGUAGE_TASK_PATTERN = /^(automatic-speech-recognition|text-to-speech|text-to-audio|audio-to-audio|audio-classification|text-to-image|image-to-image|image-to-video|text-to-video|image-classification|image-segmentation|object-detection|depth-estimation|token-classification|text-classification|fill-mask|translation|time-series-forecasting)$/;

function isSupportedHuggingFaceModel(model = {}) {
    const library = String(model.library_name || '').toLowerCase();
    if (/^(diffusers|diffusion-single-file|timm|peft|adapter-transformers)$/.test(library)) return false;
    const pipeline = String(model.pipeline_tag || '').toLowerCase();
    if (pipeline) return LANGUAGE_MODEL_TASKS.has(pipeline);
    const tags = toArray(model.tags).map((tag) => String(tag).toLowerCase());
    if (tags.some((tag) => LANGUAGE_MODEL_TASKS.has(tag))) return true;
    if (tags.some((tag) => NON_LANGUAGE_TASK_PATTERN.test(tag))) return false;
    const languageRuntime = LANGUAGE_MODEL_LIBRARIES.has(library) || tags.includes('mistral-common');
    const ggufArchitecture = String(model.gguf?.architecture || model.gguf_architecture || '').toLowerCase();
    return languageRuntime || Boolean(ggufArchitecture && !/^(whisper|clip|t5encoder|bert|nomic-bert-moe)$/.test(ggufArchitecture));
}

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

    // Some exporters write the decimal point as an underscore ("qwen2-1_5b").
    const text = String(rawValue).replace(/,/g, '').replace(/(\d)_(\d+\s*[bm]\b)/gi, '$1.$2').trim().toLowerCase();
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
    // Note: F16/FP16/BF16 are PRECISIONS, not quantizations — they're handled by
    // inferPrecision so a full-precision model isn't mislabeled as "quantized".
    const ggufQuant = text.match(/\b(IQ\d(?:_[A-Z0-9]+)?|Q\d(?:_[A-Z0-9]+){0,2}|Q8_0)\b/i);
    if (ggufQuant) return ggufQuant[1].toUpperCase();

    // MLX/AWQ/GPTQ repos name the bit width ("-4bit", "-8bit", "int4"); an INT
    // label is what the precision profile can size.
    const bitQuant = text.match(/\b([234568])\s*[-_ ]?bits?\b/i) || text.match(/\bw([48])a16\b/i);
    if (bitQuant) return `INT${bitQuant[1]}`;

    return '';
}

function inferPrecision(...values) {
    const text = values.map((value) => String(value || '')).join(' ').toLowerCase();
    if (/\bbf16\b/.test(text)) return 'BF16';
    if (/\bfp16\b|\bf16\b/.test(text)) return 'FP16';
    if (/\bfp32\b|\bf32\b/.test(text)) return 'FP32';
    if (/\b(?:mx|nv)fp4\b/.test(text)) return 'FP4';
    if (/\bfp8\b|\bf8_e[45]m[23]\b/.test(text)) return 'FP8';
    if (/\bint8\b|\b8bit\b/.test(text)) return 'INT8';
    if (/\bint4\b|\b4bit\b/.test(text)) return 'INT4';
    return '';
}

// Safetensors headers publish exact per-dtype parameter counts. A repo's dtype
// is only reported when one dtype holds nearly all weights; packed quantized
// checkpoints (I32/U8 blocks plus F16 scales) are left to their names and tags.
const SAFETENSORS_DTYPE_PRECISION = {
    BF16: 'BF16', F16: 'FP16', F32: 'FP32', F8_E4M3: 'FP8', F8_E5M2: 'FP8'
};

function dominantSafetensorsPrecision(safetensors) {
    const parameters = safetensors && typeof safetensors === 'object' ? safetensors.parameters : null;
    if (!parameters || typeof parameters !== 'object') return '';
    const entries = Object.entries(parameters)
        .map(([dtype, count]) => [String(dtype).toUpperCase(), Number(count)])
        .filter(([, count]) => Number.isFinite(count) && count > 0);
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    if (total <= 0) return '';
    const [dtype, count] = entries.sort((a, b) => b[1] - a[1])[0];
    return count / total >= 0.9 ? (SAFETENSORS_DTYPE_PRECISION[dtype] || '') : '';
}

// Quantized safetensors checkpoints label their method in tags and names.
function inferQuantizationMethod(...values) {
    const text = values.map((value) => String(value || '')).join(' ').toLowerCase();
    const method = text.match(/\b(awq|gptq|exl2|bitsandbytes|hqq|mxfp4|nvfp4|fp8|compressed-tensors)\b/);
    return method ? method[1] : '';
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

    // Bounded patterns: bare substrings tagged `vllm` repos as vision, `encoder`
    // repos as coding, and every `nomic-ai` repo as an embedding model.
    if (CODING_PATTERN.test(text.replace(NOT_CODING_WORDS, ' '))) tasks.add('coding');
    if (/chat|instruct|assistant|conversation/.test(text)) tasks.add('chat');
    if (REASONING_PATTERN.test(text)) tasks.add('reasoning');
    if (EMBEDDING_PATTERN.test(text) || /^(feature-extraction|sentence-similarity)$/.test(String(pipelineTag || ''))) {
        tasks.add('embeddings');
    }
    if (VISION_PATTERN.test(text) || /^(image-text-to-text|image-to-text|visual-question-answering)$/.test(String(pipelineTag || ''))) {
        tasks.add('multimodal');
    }
    if (/creative|writing|story|roleplay/.test(text)) tasks.add('creative');
    if (tasks.size === 0) tasks.add('general');
    return [...tasks];
}

// Standalone encoder/decoder words describe architectures, not code models;
// `opencoder` and `codeqwen` still count.
const NOT_CODING_WORDS = /(?:^|[^a-z])(?:en|de)cod(?:er|ers|ing)(?=[^a-z]|$)|unicode|barcode|qrcode/g;
const CODING_PATTERN = /code|coder|coding|devstral|programming/;
const REASONING_PATTERN = /reason|thinking|(?:^|[^a-z])(?:math\w*|logic|r1|qwq)(?:[^a-z0-9]|$)/;
const EMBEDDING_PATTERN = /embed|retriev|(?:^|[^a-z])(?:bge|e5|gte)(?:[^a-z]|$)/;
const VISION_PATTERN = /vision|multimodal|llava|pixtral|moondream|minicpm-v|internvl|smolvlm|idefics|paligemma|image-text|(?:^|[^a-z])vlm?(?:[^a-z]|$)|\dvl(?:[^a-z]|$)/;
const AUDIO_PATTERN = /audio|speech|whisper|voxtral/;

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
    const pipelineTag = String(model.pipeline_tag || '').toLowerCase();
    const modalities = new Set(['text']);
    if (VISION_PATTERN.test(text) || /^(image-text-to-text|image-to-text|visual-question-answering|any-to-any)$/.test(pipelineTag)) {
        modalities.add('vision');
    }
    if (AUDIO_PATTERN.test(text)) modalities.add('audio');
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

// The tree API reports `lfs.oid` (the SHA-256 of the file); older payloads used
// `lfs.sha256`. A git blob id is not a content hash and is kept as the etag.
function getSiblingSha256(sibling = {}) {
    const value = sibling.lfs?.sha256 || sibling.lfs?.oid || '';
    return /^[a-f0-9]{64}$/i.test(String(value)) ? String(value).toLowerCase() : '';
}

function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) =>
        entry !== undefined && entry !== null && entry !== ''));
}

function isModelArtifactFile(filename) {
    const lower = String(filename || '').toLowerCase();
    if (!lower) return false;
    // Exclude non-model weight files that would otherwise be ingested as standalone
    // "models": LoRA/PEFT adapters (a few MB but inherit the repo's param count) and
    // optimizer/training state.
    if (/(^|[/_-])adapter[_-]?(model|config)/.test(lower)) return false;
    if (/(^|[/_.-])(lora|optimizer|scheduler|rng_state|trainer_state|training_args)/.test(lower)) return false;
    // Speculative-decoding heads (MTP, DFlash, DSpark, EAGLE, draft) and
    // stand-alone vision towers ship next to a model but are not the model.
    if (/(^|[/_.-])(mtp|draft|dflash\d*|dspark|eagle\d*|value_head)([/_.-]|$)/.test(lower)) return false;
    if (/(^|[/_.-])(vision|audio|speech)[-_]?(encoder|tower)([/_.-]|$)/.test(lower) || /[-_]vision\.safetensors$/.test(lower)) return false;
    // Training checkpoints, adapters and evaluation artifacts live in subfolders.
    if (/(^|\/)(checkpoints?|checkpoint-\d+|adapters?|mm_projector|eval|layers)\//.test(lower)) return false;
    // Vision projectors and importance matrices are companions of a GGUF model,
    // not runnable models. OpenVINO/ONNX exports and Meta's `original/` native
    // checkpoint duplicate the repo's weights in formats no listed runtime loads.
    if (/(^|[/_.-])(mmproj|imatrix)/.test(lower)) return false;
    if (/(^|[/])(original|metal|openvino|onnx|coreml|tflite)\//.test(lower) || /openvino_model/.test(lower)) return false;
    if (lower.endsWith('.gguf')) return true;
    if (lower.endsWith('.safetensors')) return true;
    if (/pytorch_model.*\.(bin)$/.test(lower)) return true;
    // Mistral-style consolidated weights (consolidated.00.pth) were being dropped.
    if (/(^|[/])consolidated.*\.(pt|pth|bin)$/.test(lower)) return true;
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

// Most exporters zero-pad shard numbers to five digits; Kimi-K2 writes
// `model-1-of-61.safetensors`.
const SHARD_PATTERN = /^(.*)-(\d+)-of-(\d+)\.(safetensors|bin|gguf)$/i;

function extractBaseModel(model = {}) {
    const lineage = model.baseModels;
    const relation = lineage && typeof lineage === 'object' && lineage.relation ? String(lineage.relation) : '';
    const fromLineage = toArray(lineage?.models).map((entry) => entry?.id).find(Boolean);
    const fromCard = toArray(model.cardData?.base_model).find((entry) => typeof entry === 'string');
    return { baseModel: fromLineage || fromCard || '', baseRelation: relation };
}

// Weight files that belong to one checkpoint: a complete `-0000N-of-0000M` set
// becomes one runnable artifact; an incomplete set cannot be downloaded or sized.
function groupWeightFiles(files) {
    const singles = [];
    const groups = new Map();
    for (const file of files) {
        const match = file.filename.match(SHARD_PATTERN);
        if (!match) {
            singles.push({ ...file, shardFiles: null });
            continue;
        }
        const key = `${match[1]}|${match[3]}|${match[4].toLowerCase()}`;
        if (!groups.has(key)) {
            groups.set(key, { prefix: match[1], countText: match[3], count: Number(match[3]), ext: match[4], parts: new Map() });
        }
        groups.get(key).parts.set(Number(match[2]), file);
    }
    for (const group of groups.values()) {
        const parts = [...group.parts.entries()].sort((a, b) => a[0] - b[0]);
        // Most exporters number shards 1..N; gpt-oss numbers them 0..N.
        const first = parts[0]?.[0];
        const expected = first === 0 ? group.count + 1 : group.count;
        if (parts.length !== expected || parts.some(([index], i) => index !== first + i) || first > 1) continue;
        const sizes = parts.map(([, file]) => file.sizeBytes);
        singles.push({
            ...parts[0][1],
            sizeBytes: sizes.every((size) => Number.isFinite(size) && size > 0) ? sizes.reduce((a, b) => a + b, 0) : null,
            sha256: '',
            shardFiles: parts.map(([, file]) => file.filename),
            shardPattern: `${group.prefix}-*-of-${group.countText}.${group.ext}`
        });
    }
    return singles;
}

// Repos often ship one checkpoint several times: Hugging Face safetensors plus
// legacy PyTorch `.bin` files, or Mistral's `consolidated.safetensors` beside the
// sharded Transformers layout. Keep the safetensors set the listed runtimes load.
function dropDuplicateWeightSets(files) {
    const isTransformersSafetensors = (file) => /\.safetensors$/i.test(file.filename) &&
        !/(^|\/)consolidated[^/]*$/i.test(file.filename) && !/mlx/i.test(file.filename);
    if (!files.some(isTransformersSafetensors)) return files;
    return files.filter((file) => !/\.(bin|pt|pth)$/i.test(file.filename) || /\.gguf$|ggml/i.test(file.filename))
        .filter((file) => !/(^|\/)consolidated[^/]*\.safetensors$/i.test(file.filename));
}

// A size in the file's own name describes that file; collection repos hold
// several models and the repo-level count belongs to the largest. The exact
// header count is kept when it agrees with the name.
function fileParameterCountB(filename, repoParamsB) {
    const basename = String(filename || '').split('/').pop();
    const fileParamsB = parseParamsB(basename);
    if (!fileParamsB) return repoParamsB || null;
    if (!repoParamsB) return fileParamsB;
    return Math.abs(fileParamsB - repoParamsB) / Math.max(fileParamsB, repoParamsB) <= 0.25 ? repoParamsB : fileParamsB;
}

// Lowest plausible bytes per parameter: a quarter of the precision profile's
// nominal size (mixed FP8/FP4 checkpoints and mislabeled AWQ repos sit near
// half), or below 1-bit packing when the precision is unknown. Partial files
// such as one layer or one shard of a set fall far below either.
function sizeMatchesParameters(sizeBytes, paramsB, precision) {
    if (!(Number(sizeBytes) > 0) || !(Number(paramsB) > 0)) return true;
    const nominal = precisionProfile(precision).bytes;
    const floor = nominal ? nominal * 0.25 : 0.08;
    return Number(sizeBytes) / (Number(paramsB) * 1e9) >= floor;
}

function normalizeHuggingFaceModel(model) {
    const repoId = model.id || model.modelId || model.model_id;
    if (!repoId || !isSupportedHuggingFaceModel(model)) return null;

    const namespace = repoId.includes('/') ? repoId.split('/')[0] : '';
    const tags = toArray(model.tags);
    const tagText = tags.join(' ');
    const configInfo = model.config_info || {};
    // A vision tower in config.json marks a VLM even when the repo has no
    // `image-text-to-text` pipeline tag (official Mistral releases).
    const tasks = inferTasks(configInfo.has_vision ? { ...model, tags: [...tags, 'vision'] } : model);
    const modalities = inferModalities(configInfo.has_vision ? { ...model, tags: [...tags, 'vision'] } : model);
    const license = extractLicense(model);
    const gated = Boolean(model.gated && model.gated !== 'false');
    const repoKey = makeScopedId('huggingface', repoId);
    const gguf = model.gguf && typeof model.gguf === 'object' ? model.gguf : {};
    const { baseModel, baseRelation } = extractBaseModel(model);
    const siblingNames = toArray(model.siblings).map(getSiblingName);
    const visionProjectors = siblingNames.filter((name) => /(^|[/_.-])mmproj[^/]*\.gguf$/i.test(name));
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
        modalities: visionProjectors.length && !modalities.includes('vision') ? [...modalities, 'vision'] : modalities,
        last_modified: model.lastModified || model.last_modified || '',
        sha: model.sha || '',
        // Only fields the recommender reads are stored; whole model cards and
        // sibling listings multiplied the packaged snapshot without being used.
        metadata: compactObject({
            pipeline_tag: model.pipeline_tag || '',
            library_name: model.library_name || '',
            description: model.description || model.cardData?.description || '',
            base_model: baseModel,
            base_relation: baseRelation,
            gguf_architecture: gguf.architecture || '',
            model_type: configInfo.model_type || model.config?.model_type || '',
            official_publisher: OFFICIAL_HUGGING_FACE_PUBLISHERS.includes(namespace) || undefined,
            created_at: model.createdAt || '',
            vision_projectors: visionProjectors.length ? visionProjectors : undefined
        })
    };

    const nameTotalB = parseParamsB(repoId, tagText);
    const ggufParamsB = Number(gguf.total) > 0 ? Number(gguf.total) / 1e9 : null;
    const metadataParamsB =
        sumSafetensorsParams(model.safetensors) ||
        ggufParamsB ||
        parseParamsB(model.config?.num_parameters, model.cardData?.params);
    // Prefer the larger of metadata vs the MoE-aware name total, so an MoE whose
    // safetensors/config under-reports (or is absent) still stores the full total.
    // Packed 4-bit safetensors also count fewer "parameters" than the model has.
    const repoParamsB = parseParamsB(Math.max(metadataParamsB || 0, nameTotalB || 0)) || null;
    const activeParamsB = parseActiveParamsB(repoId, tagText);
    const contextLength = Number(
        gguf.context_length ||
        configInfo.context_length ||
        model.config?.max_position_embeddings ||
        model.config?.model_max_length ||
        model.config?.max_sequence_length ||
        model.cardData?.context_length ||
        0
    ) || null;
    const quantMethod = configInfo.quant_method || inferQuantizationMethod(repoId, tagText);
    // Exact header dtypes first, then the declared quantization format, then the
    // name and tags; `torch_dtype` is only the compute dtype of the checkpoint.
    const repoPrecision = dominantSafetensorsPrecision(model.safetensors) ||
        ({ fp8: 'FP8', mxfp4: 'FP4', nvfp4: 'FP4' })[configInfo.quant_method] ||
        inferPrecision(repoId, tagText) || inferPrecision(configInfo.torch_dtype);
    // FP8/FP4 checkpoints are low-precision floats; a tag like `8-bit` on them
    // is not an integer quantization.
    const floatFormat = /^FP[48]$/.test(repoPrecision);
    const repoQuantization = floatFormat ? '' : (inferQuantization(repoId, tagText) ||
        (configInfo.bits && /^(awq|gptq|bitsandbytes|hqq|exl2)$/.test(quantMethod) ? `INT${configInfo.bits}` : ''));
    const revision = model.sha || 'main';
    const artifacts = [];

    const weightFiles = toArray(model.siblings)
        .map((sibling) => ({
            filename: getSiblingName(sibling),
            sizeBytes: getSiblingSizeBytes(sibling),
            sha256: getSiblingSha256(sibling),
            etag: sibling.oid || sibling.blobId || sibling.lfs?.oid || ''
        }))
        .filter((file) => isModelArtifactFile(file.filename));

    for (const file of dropDuplicateWeightSets(groupWeightFiles(weightFiles))) {
        const { filename, sizeBytes } = file;
        const format = inferFormat(filename, tags);
        const isGguf = format === 'gguf' || format === 'ggml';
        // A repo-level dtype or quantization describes its safetensors weights,
        // never the GGUF files a repo may ship alongside them.
        const quantization = inferQuantization(filename) || (isGguf ? inferQuantization(tagText) : repoQuantization);
        const precision = inferPrecision(filename) || (isGguf ? inferPrecision(tagText, quantization) : repoPrecision);
        const parameterCountB = fileParameterCountB(filename, repoParamsB);
        // A file far too small for its stated parameters at its precision is
        // another model (a distill in a collection repo, a draft head); its
        // size would make a large model look like it fits small hardware.
        if (!sizeMatchesParameters(sizeBytes, parameterCountB, quantization || precision)) continue;
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
            parameter_count_b: parameterCountB,
            active_parameter_count_b: activeParamsB,
            size_bytes: sizeBytes,
            size_gb: bytesToGB(sizeBytes),
            context_length: contextLength,
            runtime_support: inferRuntimeSupport(format, tags, 'huggingface'),
            tasks,
            modalities: (isGguf && visionProjectors.length) || configInfo.has_vision ? repo.modalities : inferModalities(model, filename),
            download_url: buildHuggingFaceDownloadUrl(repoId, filename, revision),
            install_command: !file.shardFiles
                ? `hf download ${repoId} ${filename}`
                : (isGguf ? `hf download ${repoId} --include "${file.shardPattern}"` : `hf download ${repoId}`),
            sha256: file.sha256 || '',
            etag: file.shardFiles ? '' : (file.etag || ''),
            license,
            gated,
            requires_auth: gated,
            downloads: repo.downloads,
            likes: repo.likes,
            updated_at: repo.last_modified,
            metadata: compactObject({
                repo_sha: model.sha || '',
                shard_files: file.shardFiles || undefined,
                quant_method: isGguf ? undefined : (quantMethod || undefined)
            })
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
    // When the download points at a Hugging Face repo, use that repo id as the
    // canonical model id so the same model lines up across sources for dedup.
    const canonicalModelId = repoMatch ? repoMatch[1] : name;
    const filename = repoMatch ? decodeURIComponent(repoMatch[3]) : (filenameCandidate || url.split('/').filter(Boolean).pop());
    const repoKey = makeScopedId('gpt4all', repoId);
    const tags = ['gpt4all', entry.type, entry.quant].filter(Boolean);
    const paramsB = parseParamsB(entry.parameters, name, filename);
    // Sizes can arrive as comma-formatted strings ("8,000,000,000"); strip non-digits.
    const sizeBytes = Number(String(entry.filesize ?? entry.fileSize ?? entry.size ?? 0).replace(/[^0-9.]/g, '')) || null;
    const format = inferFormat(filename, tags);

    return {
        source: SOURCE_DEFINITIONS.gpt4all,
        repos: [{
            id: repoKey,
            source_id: 'gpt4all',
            repo_id: repoId,
            namespace: repoId.includes('/') ? repoId.split('/')[0] : 'gpt4all',
            canonical_model_id: canonicalModelId,
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
                md5sum: entry.md5sum || null,
                description: entry.description || ''
            }
        }],
        artifacts: [{
            id: makeArtifactId('gpt4all', repoId, filename || name),
            source_id: 'gpt4all',
            repo_key: repoKey,
            repo_id: repoId,
            canonical_model_id: canonicalModelId,
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

// The catalog's count is exact when it came from the registry (15.7B for a
// `:16b` tag). A tag that states a far larger size marks an older catalog that
// stored one expert of a mixture (7B for `8x7b`).
function ollamaParameterCountB(storedB, tag) {
    const stated = Number(storedB) > 0 ? Number(storedB) : 0;
    const fromTag = parseParamsB(tag) || 0;
    if (stated && !(fromTag > stated * 1.5)) return stated;
    return Math.max(stated, fromTag) || null;
}

/**
 * One Docker Model Runner tag (`ai/qwen3:8B-Q4_K_M`). Tags sharing a digest
 * are one download and arrive merged, with the others as aliases.
 */
function normalizeDockerTag(repository, tag, aliases = []) {
    const repoName = String(repository.name || '');
    const modelId = `ai/${repoName}`;
    const tagName = String(tag.name || '');
    const reference = `${modelId}:${tagName}`;
    const repoKey = makeScopedId('docker', modelId);
    const sizeBytes = Number(tag.full_size) > 0 ? Number(tag.full_size) : null;
    const nameText = [repoName, tagName, ...aliases].join(' ');
    // GGUF tags run on the llama.cpp engine; `-safetensors` tags and `-vllm`
    // repos on vLLM; `mlx` tags on MLX.
    const format = /mlx/i.test(tagName) ? 'mlx'
        : (/safetensors/i.test(tagName) || /-vllm$/i.test(repoName)) ? 'safetensors' : 'gguf';
    const quantization = inferQuantization(nameText);
    const precision = inferPrecision(nameText);
    const parameterCountB = parseParamsB(tagName, ...aliases, repoName);
    if (!sizeMatchesParameters(sizeBytes, parameterCountB, quantization || precision)) return null;
    const describe = { id: modelId, model_name: repoName, description: repository.description || '', tags: [tagName, ...aliases] };
    const tasks = inferTasks(describe);
    const modalities = inferModalities(describe);
    const updatedAt = tag.last_updated || repository.last_updated || '';
    return {
        source: SOURCE_DEFINITIONS.docker,
        repos: [{
            id: repoKey,
            source_id: 'docker',
            repo_id: modelId,
            namespace: 'ai',
            canonical_model_id: modelId,
            display_name: modelId,
            url: `https://hub.docker.com/r/${modelId}`,
            license: 'unknown',
            gated: false,
            requires_auth: false,
            downloads: Number(repository.pull_count) || 0,
            likes: Number(repository.star_count) || 0,
            tags: [],
            tasks,
            modalities,
            last_modified: repository.last_updated || '',
            metadata: compactObject({ description: repository.description || '' })
        }],
        artifacts: [{
            id: makeArtifactId('docker', modelId, tagName),
            source_id: 'docker',
            repo_key: repoKey,
            repo_id: modelId,
            canonical_model_id: modelId,
            artifact_name: reference,
            filename: '',
            format,
            quantization,
            precision,
            parameter_count_b: parameterCountB,
            active_parameter_count_b: parseActiveParamsB(tagName, repoName),
            size_bytes: sizeBytes,
            size_gb: bytesToGB(sizeBytes),
            context_length: null,
            runtime_support: ['docker'],
            tasks,
            modalities,
            download_url: `https://hub.docker.com/r/${modelId}`,
            install_command: `docker model pull ${reference}`,
            sha256: '',
            etag: tag.digest || '',
            license: 'unknown',
            gated: false,
            requires_auth: false,
            downloads: Number(repository.pull_count) || 0,
            updated_at: updatedAt,
            metadata: compactObject({ aliases: aliases.length ? aliases : undefined })
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
    const inputTypes = (() => {
        try {
            const parsed = typeof variant.input_types === 'string' ? JSON.parse(variant.input_types) : variant.input_types;
            return Array.isArray(parsed) ? parsed.map((type) => String(type).toLowerCase()) : [];
        } catch {
            return [];
        }
    })();
    // The tags page states each tag's inputs; the name-based guess is only a
    // fallback for catalogs synced before that was recorded.
    const modalities = inputTypes.includes('image')
        ? ['text', 'vision', ...(inputTypes.includes('audio') ? ['audio'] : [])]
        : inferModalities({ model_identifier: modelId, model_name: model.name, capabilities }, tag);
    const sizeBytes = Number(variant.size_bytes) > 0 ? Number(variant.size_bytes) : null;
    const blobSha256 = String(variant.blob_sha256 || '').replace(/^sha256:/, '');

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
            license: model.license || variant.license || 'unknown',
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
                source_updated_at: model.updated_at || '',
                description: model.description || ''
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
            parameter_count_b: ollamaParameterCountB(variant.params_b, tag),
            active_parameter_count_b: null,
            size_bytes: sizeBytes,
            size_gb: sizeBytes ? bytesToGB(sizeBytes) : (Number(variant.size_gb) || null),
            context_length: Number(variant.context_length) || null,
            runtime_support: ['ollama'],
            tasks,
            modalities,
            download_url: `ollama://library/${tag}`,
            install_command: `ollama pull ${tag}`,
            sha256: /^[a-f0-9]{64}$/.test(blobSha256) ? blobSha256 : '',
            etag: variant.digest || '',
            license: variant.license || 'unknown',
            gated: false,
            requires_auth: false,
            downloads: Number(model.pulls) || 0,
            updated_at: model.updated_at || model.last_updated || '',
            metadata: {
                input_types: variant.input_types || '["text"]',
                aliases: Array.isArray(variant.aliases) && variant.aliases.length ? variant.aliases : undefined,
                is_moe: Boolean(variant.is_moe),
                expert_count: variant.expert_count || null,
                description: model.description || ''
            }
        }]
    };
}

function parseRateLimitHeader(value) {
    const match = String(value || '').match(/r=(\d+);\s*t=(\d+)/);
    return match ? { remaining: Number(match[1]), resetSeconds: Number(match[2]) } : null;
}

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function mapWithConcurrency(items, concurrency, worker) {
    let index = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (index < items.length) {
            const current = items[index];
            index += 1;
            await worker(current);
        }
    });
    await Promise.all(runners);
}

function mergeTreeSizes(siblings, treeEntries) {
    const byPath = new Map(toArray(treeEntries)
        .filter((entry) => entry && entry.type !== 'directory' && entry.path)
        .map((entry) => [entry.path, entry]));
    return toArray(siblings).map((sibling) => {
        const entry = byPath.get(getSiblingName(sibling));
        if (!entry) return sibling;
        return {
            ...sibling,
            size: entry.lfs?.size || entry.size || sibling.size,
            oid: entry.oid || sibling.oid,
            lfs: entry.lfs ? { ...(sibling.lfs || {}), ...entry.lfs } : sibling.lfs
        };
    });
}

// Keep the handful of config.json fields the registry uses. Vision-language
// configs nest the language model under `text_config`.
function summarizeModelConfig(config) {
    if (!config || typeof config !== 'object') return {};
    const text = config.text_config && typeof config.text_config === 'object' ? config.text_config : {};
    const pick = (...keys) => {
        for (const source of [config, text]) {
            for (const key of keys) {
                const value = Number(source[key]);
                if (Number.isFinite(value) && value > 0) return value;
            }
        }
        return null;
    };
    const quantization = config.quantization_config || text.quantization_config || {};
    return compactObject({
        context_length: pick('max_position_embeddings', 'max_sequence_length', 'seq_length', 'n_positions', 'n_ctx'),
        model_type: config.model_type || '',
        torch_dtype: ({ bfloat16: 'bf16', float16: 'fp16', float32: 'fp32' })[
            String(config.torch_dtype || config.dtype || text.torch_dtype || text.dtype || '').toLowerCase()] || '',
        quant_method: String(quantization.quant_method || '').toLowerCase(),
        bits: Number(quantization.bits || quantization.w_bit) || null,
        has_vision: config.vision_config && typeof config.vision_config === 'object' ? true : undefined,
        num_experts: pick('num_local_experts', 'num_experts', 'n_routed_experts'),
        experts_per_token: pick('num_experts_per_tok', 'moe_topk')
    });
}

class RegistryIngestor {
    constructor(options = {}) {
        this.database = options.database;
        this.fetchImpl = options.fetchImpl || fetch;
        this.onProgress = options.onProgress || (() => {});
        // Authenticated requests get larger Hub rate-limit windows and can read
        // gated model metadata. It is only sent with requests to Hugging Face.
        this.huggingFaceToken = options.huggingFaceToken ?? (process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || '');
        this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 5;
        this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    async ingest(options = {}) {
        if (!this.database) {
            throw new Error('RegistryIngestor requires a database instance');
        }

        const sources = String(options.sources || 'ollama,huggingface,gpt4all,docker')
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
                    task: options.task,
                    publishers: options.publishers,
                    publisherLimit: options.publisherLimit,
                    fileSizes: options.fileSizes,
                    configs: options.configs,
                    concurrency: options.concurrency
                }));
            } else if (source === 'gpt4all') {
                collections.push(...await this.collectGpt4All({ limit: limits.gpt4all }));
            } else if (source === 'docker') {
                collections.push(...await this.collectDocker({ limit: options.dockerLimit }));
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

    huggingFaceHeaders() {
        const token = this.huggingFaceToken;
        return {
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        };
    }

    // The Hub answers 429 when a fixed window is spent and advertises the
    // window in `RateLimit: "api";r=<remaining>;t=<seconds>`. Waiting for the
    // reset keeps long seed builds from failing halfway.
    async fetchHuggingFace(url, { json = true, allowMissing = false } = {}) {
        for (let attempt = 0; ; attempt += 1) {
            const response = await this.fetchImpl(url, { headers: this.huggingFaceHeaders() });
            const rateLimit = parseRateLimitHeader(response.headers?.get?.('ratelimit'));
            if (response.status === 429 && attempt < this.maxRetries) {
                const waitSeconds = Number(response.headers?.get?.('retry-after')) || rateLimit?.resetSeconds || 60;
                this.onProgress({ source: 'huggingface', message: `Rate limited; waiting ${waitSeconds}s` });
                await this.sleep(Math.min(waitSeconds, 300) * 1000);
                continue;
            }
            if (allowMissing && [401, 403, 404].includes(response.status)) return null;
            if (!response.ok) {
                throw new Error(`Hugging Face request failed: HTTP ${response.status}`);
            }
            if (rateLimit && rateLimit.remaining <= 2 && rateLimit.resetSeconds > 0) {
                await this.sleep(Math.min(rateLimit.resetSeconds, 300) * 1000);
            }
            return { response, body: json ? await response.json() : await response.text() };
        }
    }

    async fetchHuggingFacePages(params, limit) {
        const models = [];
        let url = `${HUGGING_FACE_MODEL_API}?${params.toString()}`;
        while (url && models.length < limit) {
            this.onProgress({ source: 'huggingface', message: `Fetching ${url}` });
            const { response, body } = await this.fetchHuggingFace(url);
            const pageModels = toArray(body);
            models.push(...pageModels);
            if (pageModels.length === 0) break;
            url = models.length < limit ? extractNextLink(response.headers?.get?.('link')) : null;
        }
        return models.slice(0, limit);
    }

    huggingFaceListParams({ limit, query, task, pipelineTag, author }) {
        const params = new URLSearchParams({
            sort: 'downloads',
            direction: '-1',
            limit: String(Math.min(1000, limit))
        });
        for (const field of HUGGING_FACE_EXPAND_FIELDS) params.append('expand[]', field);
        if (query) params.set('search', query);
        if (task) params.set('filter', task);
        if (pipelineTag) params.set('pipeline_tag', pipelineTag);
        if (author) params.set('author', author);
        return params;
    }

    async collectHuggingFace(options = {}) {
        const requestedLimit = Number(options.limit) > 0 ? Number(options.limit) : 1000;
        // An explicit task/query keeps the old single-listing behavior. The
        // default plan splits the limit across the tasks the recommender ranks.
        const plan = options.task || options.query
            ? [{ task: options.task, limit: requestedLimit }]
            : HUGGING_FACE_TASK_PLAN.map((entry) => ({
                pipelineTag: entry.task,
                limit: Math.max(1, Math.round(requestedLimit * entry.share))
            }));

        const byId = new Map();
        const addModels = (models) => {
            for (const model of models) {
                const id = model?.id || model?.modelId;
                if (id && !byId.has(id)) byId.set(id, model);
            }
        };

        for (const entry of plan) {
            addModels(await this.fetchHuggingFacePages(this.huggingFaceListParams({
                limit: entry.limit,
                query: options.query,
                task: entry.task,
                pipelineTag: entry.pipelineTag
            }), entry.limit));
        }

        const publishers = options.publishers === true
            ? OFFICIAL_HUGGING_FACE_PUBLISHERS
            : toArray(options.publishers).filter(Boolean);
        const publisherLimit = Number(options.publisherLimit) > 0 ? Number(options.publisherLimit) : 500;
        for (const author of publishers) {
            addModels(await this.fetchHuggingFacePages(this.huggingFaceListParams({
                limit: publisherLimit,
                author
            }), publisherLimit));
        }

        const supported = [...byId.values()].filter(isSupportedHuggingFaceModel);
        if (options.fileSizes || options.configs) {
            await this.enrichHuggingFaceModels(supported, options);
        }

        return supported
            .map(normalizeHuggingFaceModel)
            .filter(Boolean);
    }

    /**
     * Optional per-repo requests for data the listing does not carry: observed
     * file sizes and SHA-256 hashes (tree API) and the context window, dtype and
     * quantization recorded in config.json. Missing data stays missing.
     */
    async enrichHuggingFaceModels(models, options = {}) {
        const concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : 4;
        let done = 0;
        await mapWithConcurrency(models, concurrency, async (model) => {
            const repoId = model.id || model.modelId;
            const revision = model.sha || 'main';
            try {
                const weights = toArray(model.siblings).filter((sibling) => isModelArtifactFile(getSiblingName(sibling)));
                if (options.fileSizes && weights.length > 0) {
                    model.siblings = mergeTreeSizes(model.siblings, await this.fetchHuggingFaceTree(repoId, revision));
                }
                const hasConfig = toArray(model.siblings).some((sibling) => getSiblingName(sibling) === 'config.json');
                if (options.configs && hasConfig && !(Number(model.gguf?.context_length) > 0)) {
                    const result = await this.fetchHuggingFace(
                        `${HUGGING_FACE_BASE_URL}/${repoId}/resolve/${revision}/config.json`,
                        { json: false, allowMissing: true }
                    );
                    if (result) model.config_info = summarizeModelConfig(safeJsonParse(result.body));
                }
            } catch (error) {
                this.onProgress({ source: 'huggingface', message: `Skipped enrichment for ${repoId}: ${error.message}` });
            }
            done += 1;
            if (done % 100 === 0 || done === models.length) {
                this.onProgress({ source: 'huggingface', message: `Enriched ${done}/${models.length} repositories` });
            }
        });
    }

    async fetchHuggingFaceTree(repoId, revision) {
        const entries = [];
        let url = `${HUGGING_FACE_MODEL_API}/${repoId}/tree/${encodeURIComponent(revision)}?recursive=true`;
        while (url) {
            const result = await this.fetchHuggingFace(url, { allowMissing: true });
            if (!result) break;
            entries.push(...toArray(result.body));
            url = extractNextLink(result.response.headers?.get?.('link'));
        }
        return entries;
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

    // Anonymous Docker Hub reads stop at an offset of 100, so each listing is
    // read in both name orders; the union covers up to 200 entries.
    async fetchDockerListing(url) {
        const entries = new Map();
        for (const ordering of ['name', '-name']) {
            const listingUrl = `${url}${url.includes('?') ? '&' : '?'}page_size=100&ordering=${ordering}`;
            let response;
            for (let attempt = 0; ; attempt += 1) {
                response = await this.fetchImpl(listingUrl, { headers: { Accept: 'application/json' } });
                if (response.status !== 429 || attempt >= this.maxRetries) break;
                // X-RateLimit-Reset is an epoch time in seconds.
                const reset = Number(response.headers?.get?.('x-ratelimit-reset'));
                const waitSeconds = Number(response.headers?.get?.('retry-after')) ||
                    (reset > 0 ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60);
                this.onProgress({ source: 'docker', message: `Rate limited; waiting ${waitSeconds}s` });
                await this.sleep(Math.min(waitSeconds, 300) * 1000);
            }
            if (!response.ok) throw new Error(`Docker Hub request failed: HTTP ${response.status}`);
            const payload = await response.json();
            for (const entry of toArray(payload.results)) {
                if (entry?.name && !entries.has(entry.name)) entries.set(entry.name, entry);
            }
            if (!(Number(payload.count) > 100)) break;
        }
        return [...entries.values()];
    }

    async collectDocker(options = {}) {
        const limit = Number(options.limit) > 0 ? Number(options.limit) : 1000;
        this.onProgress({ source: 'docker', message: 'Fetching Docker Hub ai/ models' });
        const repositories = (await this.fetchDockerListing(`${DOCKER_HUB_API}/ai/`))
            .filter((repository) => !DOCKER_NON_LANGUAGE_REPO.test(repository.name))
            .sort((a, b) => (Number(b.pull_count) || 0) - (Number(a.pull_count) || 0))
            .slice(0, limit);
        const collections = [];
        for (const repository of repositories) {
            const tags = await this.fetchDockerListing(`${DOCKER_HUB_API}/ai/${repository.name}/tags`);
            const byDigest = new Map();
            for (const tag of tags) {
                if (!(Number(tag.full_size) > 0)) continue;
                const key = tag.digest || tag.name;
                if (!byDigest.has(key)) byDigest.set(key, []);
                byDigest.get(key).push(tag);
            }
            // Docker re-pushed some tags with different capitalisation
            // (`4B-Q4_K_M` and `4b-q4_K_M`); the newest push of a name wins.
            const byName = new Map();
            for (const group of byDigest.values()) {
                // `latest` and the size-only tag are aliases of a quantized tag.
                const ranked = [...group].sort((a, b) =>
                    (a.name === 'latest') - (b.name === 'latest') || b.name.length - a.name.length);
                const [primary, ...rest] = ranked;
                const key = primary.name.toLowerCase();
                const existing = byName.get(key);
                if (existing && String(existing.primary.last_updated || '') >= String(primary.last_updated || '')) {
                    existing.aliases.push(...rest.map((tag) => tag.name));
                    continue;
                }
                byName.set(key, { primary, aliases: [...(existing?.aliases || []), ...rest.map((tag) => tag.name)] });
            }
            for (const { primary, aliases } of byName.values()) {
                const collection = normalizeDockerTag(repository, primary, aliases.sort());
                if (collection) collections.push(collection);
            }
        }
        return collections;
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
                v.expert_count,
                v.digest,
                v.size_bytes,
                v.blob_sha256,
                v.license AS variant_license
            FROM models m
            JOIN variants v ON v.model_id = m.id
            ORDER BY m.pulls DESC, v.params_b DESC, v.size_gb ASC
            LIMIT ?
        `, [limit]);

        // Tags sharing a manifest digest are one download (`llama3.1:latest`,
        // `llama3.1:8b`, `llama3.1:8b-instruct-q4_K_M`). Keep the most explicit
        // short name and record the others as aliases.
        const preferred = (a, b) => {
            const latest = (row) => /:latest$/.test(row.tag);
            if (latest(a) !== latest(b)) return latest(a) ? b : a;
            return a.tag.length <= b.tag.length ? a : b;
        };
        const byDigest = new Map();
        const unique = [];
        for (const row of rows) {
            if (!row.digest) {
                unique.push({ row, aliases: [] });
                continue;
            }
            const key = `${row.id}|${row.digest}`;
            const entry = byDigest.get(key);
            if (!entry) {
                const created = { row, aliases: [] };
                byDigest.set(key, created);
                unique.push(created);
            } else {
                const keep = preferred(entry.row, row);
                entry.aliases.push(keep === row ? entry.row.tag : row.tag);
                entry.row = keep;
            }
        }

        const licenseCounts = new Map();
        for (const { row } of unique) {
            if (!row.variant_license) continue;
            const counts = licenseCounts.get(row.id) || new Map();
            counts.set(row.variant_license, (counts.get(row.variant_license) || 0) + 1);
            licenseCounts.set(row.id, counts);
        }
        const modelLicense = (id) => [...(licenseCounts.get(id) || new Map()).entries()]
            .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

        return unique.map(({ row, aliases }) => {
            const model = {
                id: row.id,
                license: modelLicense(row.id),
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
                expert_count: row.expert_count,
                digest: row.digest,
                size_bytes: row.size_bytes,
                blob_sha256: row.blob_sha256,
                license: row.variant_license,
                aliases: aliases.sort()
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
    HUGGING_FACE_TASK_PLAN,
    OFFICIAL_HUGGING_FACE_PUBLISHERS,
    summarizeModelConfig,
    groupWeightFiles,
    inferTasks,
    inferModalities,
    normalizeHuggingFaceModel,
    isSupportedHuggingFaceModel,
    normalizeGpt4AllEntry,
    normalizeOllamaRows,
    normalizeDockerTag,
    inferFormat,
    inferQuantization,
    inferPrecision,
    inferRuntimeSupport,
    isModelArtifactFile,
    parseParamsB,
    buildHuggingFaceDownloadUrl
};
