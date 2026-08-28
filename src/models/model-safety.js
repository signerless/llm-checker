/**
 * Shared default-safety policy for model recommendation surfaces.
 *
 * Models explicitly labelled uncensored, abliterated, or heretic are excluded
 * unless the caller opts in with `includeUncensored: true`. Identity fields and
 * tags are treated as authoritative. Free-form descriptions are also inspected,
 * while simple negated phrases (for example, "not uncensored") are ignored to
 * avoid hiding aligned models that only mention the term comparatively.
 */

const RESTRICTED_MODEL_MARKERS = Object.freeze([
    'uncensored',
    'abliterated',
    'heretic'
]);

const MARKER_PATTERN = /(^|[^a-z0-9])(uncensored|abliterated|heretic)(?=$|[^a-z0-9])/gi;

function collectText(value) {
    if (Array.isArray(value)) {
        return value.flatMap(collectText);
    }
    if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value).trim();
        return text ? [text] : [];
    }
    return [];
}

function markerMatches(text) {
    const value = String(text || '');
    const matches = [];
    MARKER_PATTERN.lastIndex = 0;
    let match;
    while ((match = MARKER_PATTERN.exec(value)) !== null) {
        matches.push({
            marker: match[2].toLowerCase(),
            index: match.index + match[1].length
        });
    }
    return matches;
}

function isNegatedDescriptionMatch(text, index) {
    const prefix = String(text || '')
        .slice(Math.max(0, index - 80), index)
        .replace(/[-_:]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trimEnd();
    const negation = prefix.match(/(?:^|\b)(?:not|never|without|neither)\b([\s\S]*)$/i);
    const negatedMarkerList = Boolean(negation) && negation[1]
        .replace(/\b(?:a|an|and|or|nor|uncensored|abliterated|heretic)\b/gi, '')
        .replace(/[\s,]+/g, '') === '';

    return (
        /(?:^|\b)(?:not|never|without|non)(?:\s+an?)?\s*$/i.test(prefix) ||
        /(?:^|\b)(?:is|are|was|were|be|being|remains?|seems?)\s+not(?:\s+an?)?\s*$/i.test(prefix) ||
        negatedMarkerList ||
        /(?:^|\b)(?:does|do|did)\s+not\s+(?:allow|enable|permit|provide|support)\s*$/i.test(prefix)
    );
}

function collectIdentityAliases(model = {}) {
    const value = typeof model === 'string' ? { model_identifier: model } : (model || {});
    const artifact = value.artifact && typeof value.artifact === 'object' ? value.artifact : {};
    const matchedModel = value.matchedModel && typeof value.matchedModel === 'object' ? value.matchedModel : {};
    const recommendationModel = value.model && typeof value.model === 'object' ? value.model : {};
    const identifiers = [
        value.model_identifier,
        value.model_id,
        value.modelId,
        value.id,
        value.repo_id,
        value.canonical_model_id,
        artifact.model_identifier,
        artifact.model_id,
        artifact.repo_id,
        artifact.canonical_model_id,
        matchedModel.model_identifier,
        matchedModel.model_id,
        matchedModel.modelId,
        matchedModel.id,
        recommendationModel.model_identifier,
        recommendationModel.model_id,
        recommendationModel.modelId,
        recommendationModel.id
    ].flatMap(collectText);

    // Some source rows only expose a display name. Use it as a last resort,
    // but prefer stable identifiers whenever one is available.
    if (identifiers.length === 0) {
        identifiers.push(...[
            value.model_name,
            value.name,
            artifact.model_name,
            artifact.name,
            matchedModel.model_name,
            matchedModel.name,
            recommendationModel.model_name,
            recommendationModel.name
        ].flatMap(collectText));
    }

    const aliases = new Set();
    for (const identifier of identifiers) {
        let normalized = String(identifier)
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^(?:www\.)?ollama\.com\/library\//, '')
            .replace(/^hf\.co\//, '')
            .replace(/\/+$/, '');
        if (!normalized) continue;

        aliases.add(normalized);
        const tagSeparator = normalized.lastIndexOf(':');
        if (tagSeparator > normalized.lastIndexOf('/')) {
            normalized = normalized.slice(0, tagSeparator);
            if (normalized) aliases.add(normalized);
        }
    }
    return aliases;
}

function modelsShareIdentity(left, right) {
    const leftAliases = collectIdentityAliases(left);
    const rightAliases = collectIdentityAliases(right);
    for (const alias of leftAliases) {
        if (rightAliases.has(alias)) return true;
    }
    return false;
}

function classifyModelSafety(model = {}) {
    const value = typeof model === 'string' ? { model_identifier: model } : (model || {});
    const artifact = value.artifact && typeof value.artifact === 'object' ? value.artifact : {};
    const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
    const repoMetadata = value.repo_metadata && typeof value.repo_metadata === 'object'
        ? value.repo_metadata
        : {};
    const artifactMetadata = artifact.metadata && typeof artifact.metadata === 'object'
        ? artifact.metadata
        : {};
    const matchedModel = value.matchedModel && typeof value.matchedModel === 'object' ? value.matchedModel : {};
    const recommendationModel = value.model && typeof value.model === 'object' ? value.model : {};

    const identityValues = [
        value.model_identifier,
        value.model_name,
        value.model_id,
        value.modelId,
        value.name,
        value.tag,
        value.repo_id,
        value.canonical_model_id,
        value.artifact_name,
        value.filename,
        artifact.model_identifier,
        artifact.model_name,
        artifact.repo_id,
        artifact.canonical_model_id,
        artifact.artifact_name,
        artifact.filename,
        matchedModel.model_identifier,
        matchedModel.model_name,
        matchedModel.model_id,
        matchedModel.modelId,
        matchedModel.name,
        recommendationModel.model_identifier,
        recommendationModel.model_name,
        recommendationModel.model_id,
        recommendationModel.modelId,
        recommendationModel.name,
        value.tags,
        value.sourceTags,
        value.source_tags,
        value.repoTags,
        value.repo_tags,
        value.labels,
        artifact.tags,
        metadata.tags,
        metadata.labels,
        repoMetadata.tags,
        repoMetadata.labels,
        artifactMetadata.tags,
        artifactMetadata.labels,
        matchedModel.tags,
        matchedModel.sourceTags,
        matchedModel.repoTags,
        recommendationModel.tags,
        recommendationModel.sourceTags,
        recommendationModel.repoTags
    ].flatMap(collectText);

    const evidence = [];
    for (const text of identityValues) {
        for (const match of markerMatches(text)) {
            evidence.push({ marker: match.marker, field: 'identity', text });
        }
    }

    const descriptionValues = [
        value.description,
        value.detailed_description,
        value.repo_description,
        metadata.description,
        repoMetadata.description,
        artifactMetadata.description,
        matchedModel.description,
        matchedModel.detailed_description,
        recommendationModel.description,
        recommendationModel.detailed_description
    ].flatMap(collectText);

    for (const text of descriptionValues) {
        for (const match of markerMatches(text)) {
            if (!isNegatedDescriptionMatch(text, match.index)) {
                evidence.push({ marker: match.marker, field: 'description', text });
            }
        }
    }

    return {
        restricted: evidence.length > 0,
        markers: [...new Set(evidence.map((item) => item.marker))],
        evidence
    };
}

function isUncensoredModel(model = {}) {
    return classifyModelSafety(model).restricted;
}

function filterModelsBySafety(models, options = {}) {
    const list = Array.isArray(models) ? models : [];
    if (options.includeUncensored === true) return [...list];
    const restrictedReferenceAliases = new Set();
    for (const reference of Array.isArray(options.referenceModels) ? options.referenceModels : []) {
        if (!isUncensoredModel(reference)) continue;
        for (const alias of collectIdentityAliases(reference)) {
            restrictedReferenceAliases.add(alias);
        }
    }

    return list.filter((model) => {
        if (isUncensoredModel(model)) return false;
        if (restrictedReferenceAliases.size === 0) return true;

        // Compute each candidate's aliases once. The previous implementation
        // recalculated aliases for every (candidate, restricted reference) pair,
        // which became tens of millions of allocations on a synced registry.
        for (const alias of collectIdentityAliases(model)) {
            if (restrictedReferenceAliases.has(alias)) return false;
        }
        return true;
    });
}

module.exports = {
    RESTRICTED_MODEL_MARKERS,
    classifyModelSafety,
    isUncensoredModel,
    modelsShareIdentity,
    filterModelsBySafety
};
