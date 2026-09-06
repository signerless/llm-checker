// Shared by the selector and desktop. Bump when the public ranking contract changes.
const RANKING_CONTRACT_VERSION = 1;

function normalizePrecision(value) {
    const precision = String(value || 'UNKNOWN').trim().toUpperCase();
    return ({ F16: 'FP16', FLOAT16: 'FP16', FLOAT32: 'FP32', F32: 'FP32',
        BFLOAT16: 'BF16' })[precision] || precision;
}

// Profiles describe estimates; they never rename or manufacture an artifact.
function precisionProfile(value) {
    const precision = normalizePrecision(value);
    if (precision === 'FP32') return { bytes: 4, penalty: 0, speed: 0.35 };
    if (['FP16', 'BF16'].includes(precision)) return { bytes: 2, penalty: 0, speed: 0.55 };
    const bits = precision.match(/^(?:I?Q|INT|FP)([2-8])(?:\b|_)/)?.[1];
    return ({
        8: { bytes: 1.05, penalty: 0, speed: 0.8 },
        6: { bytes: 0.80, penalty: -1, speed: 0.95 },
        5: { bytes: 0.68, penalty: -2, speed: 1 },
        4: { bytes: 0.58, penalty: -5, speed: 1.15 },
        3: { bytes: 0.48, penalty: -8, speed: 1.25 },
        2: { bytes: 0.37, penalty: -12, speed: 1.35 }
    })[bits] || { bytes: null, penalty: -5, speed: 1 };
}

function capabilitiesOf(model = {}) {
    const values = ['capabilities', 'tasks', 'tags', 'repoTags', 'sourceTags']
        .flatMap(key => Array.isArray(model[key]) ? model[key] : [])
        .map(value => String(value).toLowerCase());
    const name = String(model.model_identifier || model.name || '').toLowerCase();
    const embedding = values.some(v => /^(embeddings?|feature-extraction|sentence-similarity)$/.test(v)) ||
        model.specialization === 'embeddings' || /(?:embed|\bbge-|all-minilm)/.test(name);
    const reranking = values.some(v => /rerank|text-ranking/.test(v)) || /rerank/.test(name);
    const generation = !embedding && !reranking && values.some(v =>
        /^(text-generation|text2text-generation|image-text-to-text|generation|completion|chat|instruct|coder|code|coding|reasoning|general|creative|talking|reading|summarization|vision|multimodal)$/.test(v));
    const vision = generation && (values.some(v => /^(vision|multimodal|image-text-to-text)$/.test(v)) ||
        model.modalities?.includes('vision'));
    return { generation, embedding, reranking, vision };
}

function detectedBackend(hardware = {}) {
    const acceleration = hardware.acceleration || {};
    if (!hardware.cpuOnly) {
        const preferred = hardware.summary?.bestBackend;
        if (['metal', 'cuda', 'rocm', 'vulkan', 'sycl'].includes(preferred) &&
            acceleration[`supports_${preferred}`] !== false) return preferred;
        for (const backend of ['metal', 'cuda', 'rocm', 'vulkan', 'sycl']) {
            if (acceleration[`supports_${backend}`]) return backend;
        }
    }
    return /arm64|aarch64|apple silicon/i.test(hardware.cpu?.architecture || '') ? 'cpu_arm' : 'cpu_x86';
}

function memoryBudgetGB(hardware = {}) {
    const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
    const ram = positive(hardware.memory?.totalGB ?? hardware.memory?.total ?? hardware.summary?.systemRAM);
    const usable = positive(hardware.usableMemGB ?? hardware.summary?.effectiveMemory) ??
        (ram ? Math.max(0, Math.min(ram * 0.8, ram - 2)) : null);
    const unified = hardware.gpu?.unified || hardware.gpu?.type === 'apple_silicon' ||
        (hardware.summary?.hasIntegratedGPU && !hardware.summary?.hasDedicatedGPU);
    if (unified || hardware.cpuOnly || detectedBackend(hardware).startsWith('cpu_')) return usable;
    return positive(hardware.gpu?.vramGB ?? hardware.gpu?.totalVRAM ?? hardware.summary?.totalVRAM) ?? usable;
}

function classifyFit(requiredGB, budgetGB) {
    if (!Number.isFinite(requiredGB) || requiredGB <= 0 || !Number.isFinite(budgetGB) || budgetGB <= 0) return 'unknown';
    return requiredGB > budgetGB ? 'over' : requiredGB > budgetGB * 0.9 ? 'tight' : 'fits';
}

module.exports = { RANKING_CONTRACT_VERSION, normalizePrecision, precisionProfile, capabilitiesOf,
    detectedBackend, memoryBudgetGB, classifyFit };
