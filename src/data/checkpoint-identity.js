// Family names define comparison cohorts. They are not checkpoint identities.
function checkpointIdentity(name, paramsB, model = {}) {
    const artifact = model.artifact || {};
    const tags = [...(model.repoTags || []), ...(artifact.repo_tags || [])];
    const quantizedBase = tags.find(tag => /^base_model:quantized:/i.test(tag));
    let reference = quantizedBase ? quantizedBase.replace(/^base_model:quantized:/i, '') :
        (artifact.source_id !== 'ollama' && artifact.repo_id?.includes('/') ? artifact.repo_id : name);
    reference = String(reference || '').toLowerCase().replace(/^https:\/\/huggingface.co\//, '').replace(/\/$/, '');
    const slash = reference.indexOf('/');
    const provider = slash >= 0 ? reference.slice(0, slash) : null;
    let label = slash >= 0 ? reference.slice(slash + 1) : reference;
    const declaredSize = label.match(/(?:^|[-_:])(\d+(?:\.\d+)?)\s*(b|m)(?:\b|_)/i);
    const size = declaredSize ? Number(declaredSize[1]) / (declaredSize[2] === 'm' ? 1000 : 1) : Number(paramsB);
    const roleMatch = label.match(/(?:^|[-_:])(instruct|chat|it|base)(?:\b|_)/);
    const isOllama = String(model.source || artifact.source_id || '').includes('ollama') || (!provider && reference.includes(':'));
    const metadataRole = !provider && (model.tags || []).includes('instruct') ? 'instruct' : isOllama ? 'unknown' : 'base';
    const role = roleMatch ? (roleMatch[1] === 'it' ? 'instruct' : roleMatch[1]) : metadataRole;
    label = label
        .replace(/\.(gguf|safetensors|bin)$/, '')
        .replace(/(?:^|[-_.:])(?:i?q\d[\w]*|fp(?:8|16|32)|bf16|f16|int[248]|gguf|awq|gptq|hf)(?=$|[-_.:])/g, '-')
        .replace(/\b\d+(?:\.\d+)?[bm]\b/, '')
        .replace(/\b(instruct|chat|it|base|latest)\b/g, '')
        .replace(/^(meta|google|microsoft|mistralai|alibaba|nvidia|ibm|openai|anthropic)-/, '')
        .replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        .replace(/-(?=\d)/g, '');
    const conflictingSize = declaredSize && Number(paramsB) > 0 && Math.abs(Number(paramsB) - size) / Math.max(Number(paramsB), size) > 0.2;
    return { label, provider, role, size: !conflictingSize && size > 0 && Number.isFinite(size) ? size : null };
}

function sameCheckpoint(wanted, measured) {
    // Boards often omit the org. Only known publisher namespaces can bridge
    // that omission; a community repo with the same basename is not an alias.
    const publishers = {
        qwen: /^qwen/, 'meta-llama': /^(llama|codellama)/,
        google: /^gemma/, microsoft: /^phi/, 'deepseek-ai': /^deepseek/,
        mistralai: /^(mistral|mixtral|codestral|ministral)/,
        huggingfacetb: /^smollm/, 'ibm-granite': /^granite/,
        tiiuae: /^falcon/, allenai: /^olmo/
    };
    if (Boolean(wanted.provider) !== Boolean(measured.provider)) {
        const qualified = wanted.provider ? wanted : measured;
        if (!publishers[qualified.provider]?.test(qualified.label)) return false;
    }
    return wanted.label === measured.label && wanted.role === measured.role &&
        wanted.size != null && measured.size != null && wanted.size === measured.size &&
        (!wanted.provider || !measured.provider || wanted.provider === measured.provider);
}

module.exports = { checkpointIdentity, sameCheckpoint };
