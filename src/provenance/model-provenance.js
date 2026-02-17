const UNKNOWN_VALUE = 'unknown';

const UNKNOWN_MARKERS = new Set(['', 'unknown', 'n/a', 'na', 'none', 'unspecified', 'not-provided']);

const LICENSE_ALIASES = {
    mitlicense: 'mit',
    mit: 'mit',
    apache2: 'apache-2.0',
    'apache2.0': 'apache-2.0',
    'apache-2': 'apache-2.0',
    'apache-2.0': 'apache-2.0',
    'apache-2.0-license': 'apache-2.0',
    'llama2': 'llama',
    'llama3': 'llama',
    'llama3.1': 'llama',
    'llama3.2': 'llama',
    'meta-llama': 'llama'
};

function asString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function sanitizeValue(value) {
    const text = asString(value);
    if (!text) return UNKNOWN_VALUE;

    const normalized = text.toLowerCase();
    return UNKNOWN_MARKERS.has(normalized) ? UNKNOWN_VALUE : text;
}

function normalizeSource(value) {
    const normalized = sanitizeValue(value).toLowerCase();
    if (normalized === UNKNOWN_VALUE) return UNKNOWN_VALUE;

    const source = normalized.replace(/\s+/g, '_').replace(/-/g, '_');

    if (source === 'ollama_local') return 'ollama_local';
    if (source === 'ollama_database') return 'ollama_database';
    if (source === 'enhanced_with_ollama') return 'enhanced_with_ollama';
    if (source === 'static_database') return 'static_database';

    return source;
}

function normalizeRegistry(value, source = UNKNOWN_VALUE) {
    const registry = sanitizeValue(value);
    if (registry !== UNKNOWN_VALUE) return registry;

    if (source.includes('ollama')) {
        return 'ollama.com';
    }

    return UNKNOWN_VALUE;
}

function normalizeVersion(value) {
    return sanitizeValue(value);
}

function normalizeDigest(value) {
    return sanitizeValue(value);
}

function normalizeLicense(value) {
    const raw = sanitizeValue(value);
    if (raw === UNKNOWN_VALUE) return UNKNOWN_VALUE;

    const lowered = raw.toLowerCase();
    const canonicalKey = lowered.replace(/\s+/g, '').replace(/_/g, '-');
    if (LICENSE_ALIASES[canonicalKey]) return LICENSE_ALIASES[canonicalKey];

    const hyphenated = lowered.replace(/\s+/g, '-').replace(/_/g, '-');
    const aliasByHyphen = LICENSE_ALIASES[hyphenated];
    if (aliasByHyphen) return aliasByHyphen;

    return hyphenated;
}

function extractVersionFromIdentifier(identifier) {
    const text = asString(identifier);
    if (!text) return UNKNOWN_VALUE;

    if (text.includes(':')) {
        const [, tag] = text.split(':');
        return sanitizeValue(tag);
    }

    return UNKNOWN_VALUE;
}

function extractProvenance(model = {}, defaults = {}) {
    const source = normalizeSource(
        model?.provenance?.source ||
            model?.source ||
            defaults?.source
    );

    const registry = normalizeRegistry(
        model?.provenance?.registry ||
            model?.registry ||
            model?.source_registry ||
            defaults?.registry,
        source
    );

    const version = normalizeVersion(
        model?.provenance?.version ||
            model?.version ||
            model?.tag ||
            model?.model_tag ||
            defaults?.version ||
            extractVersionFromIdentifier(
                model?.model_identifier ||
                    model?.modelIdentifier ||
                    model?.identifier ||
                    model?.model_id ||
                    model?.modelId
            )
    );

    const license = normalizeLicense(
        model?.provenance?.license ||
            model?.license ||
            model?.license_id ||
            model?.licenseId ||
            defaults?.license
    );

    const digest = normalizeDigest(
        model?.provenance?.digest ||
            model?.digest ||
            model?.hash ||
            model?.sha256 ||
            defaults?.digest
    );

    return {
        source,
        registry,
        version,
        license,
        digest
    };
}

function attachModelProvenance(model, defaults = {}) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
        return model;
    }

    const provenance = extractProvenance(model, defaults);

    return {
        ...model,
        source: provenance.source,
        license: provenance.license,
        version: provenance.version,
        digest: provenance.digest,
        provenance
    };
}

function attachProvenanceToCollection(models, defaults = {}) {
    if (!Array.isArray(models)) return [];
    return models.map((model) => attachModelProvenance(model, defaults));
}

module.exports = {
    UNKNOWN_VALUE,
    normalizeLicense,
    extractProvenance,
    attachModelProvenance,
    attachProvenanceToCollection
};
