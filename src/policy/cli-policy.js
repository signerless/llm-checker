function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toLowerString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim().toLowerCase();
}

function parseParamsB(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    const text = String(value || '');
    const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*b\b/i);
    if (!match) return null;

    return Number.parseFloat(match[1]);
}

function parseQuant(value) {
    if (!value) return null;

    const text = String(value).toLowerCase();
    const quantMatch = text.match(
        /(q\d(?:_[a-z0-9]+)+|q\d(?:\.[a-z0-9]+)+|q\d(?:_k)?|iq\d(?:_[a-z0-9]+)+|fp16|f16)/i
    );

    return quantMatch ? quantMatch[1].toUpperCase() : null;
}

function getModelKey(model) {
    if (!isPlainObject(model)) return null;

    const key =
        model.model_identifier ||
        model.modelIdentifier ||
        model.identifier ||
        model.tag ||
        model.model_id ||
        model.modelId ||
        model.name ||
        model.model_name;

    const normalized = toLowerString(key);
    return normalized || null;
}

function uniqueModels(models) {
    const deduped = new Map();

    (Array.isArray(models) ? models : []).forEach((model, index) => {
        if (!isPlainObject(model)) return;

        const key = getModelKey(model) || `idx:${index}`;
        if (!deduped.has(key)) {
            deduped.set(key, model);
        }
    });

    return Array.from(deduped.values());
}

function collectCandidatesFromAnalysis(analysis) {
    if (!isPlainObject(analysis)) return [];

    const all = []
        .concat(Array.isArray(analysis.compatible) ? analysis.compatible : [])
        .concat(Array.isArray(analysis.marginal) ? analysis.marginal : []);

    return uniqueModels(all);
}

function toPolicyCandidateFromSummary(modelSummary) {
    if (!isPlainObject(modelSummary)) return null;

    const identifier = modelSummary.identifier || modelSummary.model_identifier || modelSummary.name;
    if (!identifier) return null;

    const paramsB = parseParamsB(identifier) ?? parseParamsB(modelSummary.size);
    const quant = parseQuant(identifier) || parseQuant(modelSummary.name);

    return {
        model_identifier: identifier,
        tag: identifier,
        name: modelSummary.name || identifier,
        size: modelSummary.size || null,
        params_b: paramsB,
        quant: quant || undefined,
        source: 'local'
    };
}

function collectCandidatesFromRecommendationData(recommendationData) {
    const summary = recommendationData?.summary;
    if (!isPlainObject(summary)) return [];

    const candidates = [];

    if (isPlainObject(summary.by_category)) {
        Object.values(summary.by_category).forEach((categoryModel) => {
            const candidate = toPolicyCandidateFromSummary(categoryModel);
            if (candidate) candidates.push(candidate);
        });
    }

    if (isPlainObject(summary.best_overall)) {
        const candidate = toPolicyCandidateFromSummary(summary.best_overall);
        if (candidate) candidates.push(candidate);
    }

    return uniqueModels(candidates);
}

function buildPolicyRuntimeContext({ hardware, runtimeBackend } = {}) {
    const summary = hardware?.summary || {};
    const memory = hardware?.memory || {};

    const bestBackend = summary.bestBackend || null;
    const ramGB =
        (typeof memory.total === 'number' ? memory.total : null) ??
        (typeof summary.systemRAM === 'number' ? summary.systemRAM : null) ??
        (typeof summary.effectiveMemory === 'number' ? summary.effectiveMemory : null);

    return {
        backend: bestBackend,
        runtimeBackend: runtimeBackend || bestBackend,
        ramGB,
        totalRamGB: ramGB,
        hardware
    };
}

function evaluatePolicyCandidates(policyEngine, candidates, context = {}) {
    if (!policyEngine || typeof policyEngine.evaluateModels !== 'function') {
        throw new Error('Invalid policy engine instance.');
    }

    const evaluated = policyEngine.evaluateModels(Array.isArray(candidates) ? candidates : [], context);
    const totalChecked = evaluated.length;
    const passCount = evaluated.filter((item) => item?.policyResult?.pass === true).length;
    const failCount = totalChecked - passCount;

    const violationCounts = new Map();
    evaluated.forEach((item) => {
        const violations = Array.isArray(item?.policyResult?.violations) ? item.policyResult.violations : [];
        violations.forEach((violation) => {
            const code = violation?.code || 'UNKNOWN';
            violationCounts.set(code, (violationCounts.get(code) || 0) + 1);
        });
    });

    const topViolations = Array.from(violationCounts.entries())
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.code.localeCompare(b.code);
        });

    return {
        evaluated,
        totalChecked,
        passCount,
        failCount,
        topViolations
    };
}

function getPolicyMode(policy) {
    return policy?.mode === 'enforce' ? 'enforce' : 'audit';
}

function getOnViolationBehavior(policy) {
    if (policy?.enforcement?.on_violation === 'warn') return 'warn';
    return 'error';
}

function getViolationExitCode(policy) {
    const configured = policy?.enforcement?.exit_code;
    if (Number.isInteger(configured) && configured >= 1 && configured <= 255) {
        return configured;
    }
    return 1;
}

function resolvePolicyEnforcement(policy, evaluation) {
    const mode = getPolicyMode(policy);
    const onViolation = getOnViolationBehavior(policy);
    const failCount = evaluation?.failCount || 0;
    const hasFailures = failCount > 0;

    const shouldBlock = mode === 'enforce' && onViolation !== 'warn' && hasFailures;
    const exitCode = shouldBlock ? getViolationExitCode(policy) : 0;

    return {
        mode,
        onViolation,
        hasFailures,
        shouldBlock,
        exitCode
    };
}

module.exports = {
    collectCandidatesFromAnalysis,
    collectCandidatesFromRecommendationData,
    buildPolicyRuntimeContext,
    evaluatePolicyCandidates,
    resolvePolicyEnforcement
};
