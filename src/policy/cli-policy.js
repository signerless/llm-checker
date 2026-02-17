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
        source: modelSummary.source || 'local',
        license: modelSummary.license,
        version: modelSummary.version,
        digest: modelSummary.digest,
        provenance: modelSummary.provenance
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

function getCandidateTargets(model) {
    if (!isPlainObject(model)) return [];

    const targets = [
        model.model_identifier,
        model.modelIdentifier,
        model.identifier,
        model.tag,
        model.model_id,
        model.modelId,
        model.name,
        model.model_name
    ]
        .map((entry) => toLowerString(entry))
        .filter(Boolean);

    return Array.from(new Set(targets));
}

function patternToRegex(pattern) {
    const escaped = String(pattern || '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

    return new RegExp(`^${escaped}$`, 'i');
}

function parseExceptionExpiry(expiresAt) {
    if (!expiresAt) return null;

    const raw = String(expiresAt).trim();
    if (!raw) return null;

    const hasTime = /t|\d{2}:\d{2}/i.test(raw);
    const candidate = hasTime ? raw : `${raw}T23:59:59.999Z`;
    const parsed = new Date(candidate);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isExceptionEntryActive(entry, now) {
    const expiry = parseExceptionExpiry(entry?.expires_at);
    if (!expiry) return true;
    return expiry.getTime() >= now.getTime();
}

function findMatchingException(policy, model, now = new Date()) {
    if (policy?.enforcement?.allow_exceptions !== true) return null;
    if (!Array.isArray(policy?.exceptions) || policy.exceptions.length === 0) return null;

    const targets = getCandidateTargets(model);
    if (targets.length === 0) return null;

    for (const entry of policy.exceptions) {
        if (!isPlainObject(entry)) continue;
        const pattern = String(entry.model || '').trim();
        if (!pattern) continue;
        if (!isExceptionEntryActive(entry, now)) continue;

        const matcher = patternToRegex(pattern);
        if (targets.some((target) => matcher.test(target))) {
            return {
                model: pattern,
                reason: entry.reason || '',
                approver: entry.approver || '',
                expires_at: entry.expires_at || '',
                matched_target: targets.find((target) => matcher.test(target)) || targets[0]
            };
        }
    }

    return null;
}

function applyPolicyExceptions(policy, evaluated) {
    const now = new Date();
    let exceptionsAppliedCount = 0;
    let suppressedViolationCount = 0;

    const updated = (Array.isArray(evaluated) ? evaluated : []).map((item) => {
        if (!isPlainObject(item)) return item;

        const policyResult = isPlainObject(item.policyResult) ? item.policyResult : null;
        const violations = Array.isArray(policyResult?.violations) ? policyResult.violations : [];

        if (!policyResult || violations.length === 0) {
            return item;
        }

        const matchedException = findMatchingException(policy, item, now);
        if (!matchedException) {
            return item;
        }

        exceptionsAppliedCount += 1;
        suppressedViolationCount += violations.length;

        const rationale = Array.isArray(policyResult.rationale) ? [...policyResult.rationale] : [];
        rationale.push(
            `EXCEPTION_APPLIED: ${matchedException.model}` +
                (matchedException.reason ? ` (${matchedException.reason})` : '')
        );

        return {
            ...item,
            policyResult: {
                ...policyResult,
                pass: true,
                violationCount: 0,
                violations: [],
                suppressedViolations: violations,
                exceptionApplied: matchedException,
                rationale
            }
        };
    });

    return {
        evaluated: updated,
        exceptionsAppliedCount,
        suppressedViolationCount
    };
}

function flattenFindings(evaluated) {
    const findings = [];

    (Array.isArray(evaluated) ? evaluated : []).forEach((item) => {
        if (!isPlainObject(item)) return;

        const modelIdentifier =
            item.model_identifier ||
            item.modelIdentifier ||
            item.identifier ||
            item.tag ||
            item.model_id ||
            item.modelId ||
            item.name ||
            item.model_name ||
            'unknown:model';

        const modelName = item.name || item.model_name || modelIdentifier;
        const policyResult = isPlainObject(item.policyResult) ? item.policyResult : {};
        const activeViolations = Array.isArray(policyResult.violations) ? policyResult.violations : [];
        const suppressedViolations = Array.isArray(policyResult.suppressedViolations)
            ? policyResult.suppressedViolations
            : [];

        const baseFinding = {
            model_identifier: modelIdentifier,
            model_name: modelName,
            source: item.source || item?.provenance?.source || 'unknown',
            registry: item.registry || item?.provenance?.registry || 'unknown',
            version: item.version || item?.provenance?.version || 'unknown',
            license: item.license || item?.provenance?.license || 'unknown',
            digest: item.digest || item?.provenance?.digest || 'unknown',
            exception: policyResult.exceptionApplied || null
        };

        activeViolations.forEach((violation) => {
            findings.push({
                ...baseFinding,
                status: 'active',
                violation
            });
        });

        suppressedViolations.forEach((violation) => {
            findings.push({
                ...baseFinding,
                status: 'suppressed',
                violation
            });
        });
    });

    return findings;
}

function evaluatePolicyCandidates(policyEngine, candidates, context = {}, policy = null) {
    if (!policyEngine || typeof policyEngine.evaluateModels !== 'function') {
        throw new Error('Invalid policy engine instance.');
    }

    const evaluatedRaw = policyEngine.evaluateModels(Array.isArray(candidates) ? candidates : [], context);
    const activePolicy = isPlainObject(policy) ? policy : policyEngine.policy;

    const exceptionResult = applyPolicyExceptions(activePolicy, evaluatedRaw);
    const evaluated = exceptionResult.evaluated;

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

    const findings = flattenFindings(evaluated);

    return {
        evaluated,
        findings,
        totalChecked,
        passCount,
        failCount,
        topViolations,
        exceptionsAppliedCount: exceptionResult.exceptionsAppliedCount,
        suppressedViolationCount: exceptionResult.suppressedViolationCount
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
