const NOOP_POLICY = {
    version: 1,
    org: 'default',
    mode: 'audit',
    rules: {}
};

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function toLowerString(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized.toLowerCase() : null;
}

function normalizePattern(pattern) {
    return typeof pattern === 'string' ? pattern.trim() : '';
}

class PolicyEngine {
    constructor(policy = null) {
        this.policy = isPlainObject(policy) ? policy : NOOP_POLICY;
        this.patternCache = new Map();
    }

    getMode() {
        return this.policy.mode || 'audit';
    }

    hasActiveRules() {
        const rules = this.policy.rules || {};

        return Boolean(
            (isPlainObject(rules.models) && Object.keys(rules.models).length > 0) ||
            (isPlainObject(rules.runtime) && Object.keys(rules.runtime).length > 0) ||
            (isPlainObject(rules.compliance) && Object.keys(rules.compliance).length > 0)
        );
    }

    evaluateModel(model, context = {}) {
        const target = isPlainObject(model) ? model : {};
        const violations = [];
        const rules = this.policy.rules || {};

        this.evaluateModelRules(target, rules.models || {}, violations);
        this.evaluateRuntimeRules(target, context, rules.runtime || {}, violations);
        this.evaluateComplianceRules(target, rules.compliance || {}, violations);

        return {
            pass: violations.length === 0,
            mode: this.getMode(),
            violationCount: violations.length,
            violations,
            rationale: this.buildRationale(violations)
        };
    }

    evaluateModels(models, context = {}) {
        return asArray(models).map((model) => {
            const policyResult = this.evaluateModel(model, context);
            return { ...model, policyResult };
        });
    }

    evaluateScoredVariants(scoredVariants, context = {}) {
        return asArray(scoredVariants).map((item) => {
            if (isPlainObject(item) && isPlainObject(item.variant)) {
                const policyResult = this.evaluateModel(item.variant, context);
                return {
                    ...item,
                    policyResult,
                    variant: {
                        ...item.variant,
                        policyResult
                    }
                };
            }

            const policyResult = this.evaluateModel(item, context);
            return {
                ...item,
                policyResult
            };
        });
    }

    evaluateModelRules(model, modelRules, violations) {
        if (!isPlainObject(modelRules)) return;

        const modelTargets = this.getModelTargets(model);
        const modelIdentifier = this.getModelIdentifier(model);

        const denyPatterns = asArray(modelRules.deny).map(normalizePattern).filter(Boolean);
        const allowPatterns = asArray(modelRules.allow).map(normalizePattern).filter(Boolean);

        const denyMatch = denyPatterns.find((pattern) => this.matchesAnyPattern(pattern, modelTargets));
        if (denyMatch) {
            this.pushViolation(
                violations,
                'MODEL_DENIED',
                'rules.models.deny',
                `Model is denied by pattern "${denyMatch}".`,
                denyMatch,
                modelIdentifier
            );
        }

        if (allowPatterns.length > 0) {
            const allowMatch = allowPatterns.find((pattern) => this.matchesAnyPattern(pattern, modelTargets));
            if (!allowMatch) {
                this.pushViolation(
                    violations,
                    'MODEL_NOT_ALLOWED',
                    'rules.models.allow',
                    'Model did not match any allow pattern.',
                    allowPatterns,
                    modelIdentifier
                );
            }
        }

        if (typeof modelRules.max_size_gb === 'number') {
            const sizeGB = this.getModelSizeGB(model);
            if (sizeGB === null) {
                this.pushViolation(
                    violations,
                    'MODEL_SIZE_UNKNOWN',
                    'rules.models.max_size_gb',
                    'Model size is missing and cannot be evaluated.',
                    `<= ${modelRules.max_size_gb}`,
                    null
                );
            } else if (sizeGB > modelRules.max_size_gb) {
                this.pushViolation(
                    violations,
                    'MODEL_TOO_LARGE',
                    'rules.models.max_size_gb',
                    'Model exceeds maximum allowed size.',
                    `<= ${modelRules.max_size_gb}`,
                    sizeGB
                );
            }
        }

        if (typeof modelRules.max_params_b === 'number') {
            const paramsB = this.getModelParamsB(model);
            if (paramsB === null) {
                this.pushViolation(
                    violations,
                    'MODEL_PARAMS_UNKNOWN',
                    'rules.models.max_params_b',
                    'Model parameter count is missing and cannot be evaluated.',
                    `<= ${modelRules.max_params_b}`,
                    null
                );
            } else if (paramsB > modelRules.max_params_b) {
                this.pushViolation(
                    violations,
                    'MODEL_TOO_MANY_PARAMS',
                    'rules.models.max_params_b',
                    'Model exceeds maximum allowed parameters.',
                    `<= ${modelRules.max_params_b}`,
                    paramsB
                );
            }
        }

        const allowedQuants = asArray(modelRules.allowed_quantizations)
            .map((quant) => toLowerString(quant))
            .filter(Boolean);

        if (allowedQuants.length > 0) {
            const quant = this.getModelQuantization(model);
            if (!quant) {
                this.pushViolation(
                    violations,
                    'QUANTIZATION_UNKNOWN',
                    'rules.models.allowed_quantizations',
                    'Model quantization is missing and cannot be evaluated.',
                    allowedQuants,
                    null
                );
            } else if (!allowedQuants.includes(quant)) {
                this.pushViolation(
                    violations,
                    'QUANTIZATION_NOT_ALLOWED',
                    'rules.models.allowed_quantizations',
                    'Model quantization is not in allowlist.',
                    allowedQuants,
                    quant
                );
            }
        }
    }

    evaluateRuntimeRules(model, context, runtimeRules, violations) {
        if (!isPlainObject(runtimeRules)) return;

        const backend = this.resolveBackend(model, context);
        const requiredBackends = asArray(runtimeRules.required_backends)
            .map((item) => toLowerString(item))
            .filter(Boolean);

        if (requiredBackends.length > 0) {
            if (!backend) {
                this.pushViolation(
                    violations,
                    'BACKEND_UNKNOWN',
                    'rules.runtime.required_backends',
                    'Runtime backend is missing and cannot be evaluated.',
                    requiredBackends,
                    null
                );
            } else if (!requiredBackends.includes(backend)) {
                this.pushViolation(
                    violations,
                    'BACKEND_NOT_ALLOWED',
                    'rules.runtime.required_backends',
                    'Runtime backend is not in the required backend list.',
                    requiredBackends,
                    backend
                );
            }
        }

        if (typeof runtimeRules.min_ram_gb === 'number') {
            const availableRam = this.resolveSystemRamGB(context);
            if (availableRam === null) {
                this.pushViolation(
                    violations,
                    'RAM_UNKNOWN',
                    'rules.runtime.min_ram_gb',
                    'System RAM is missing and cannot be evaluated.',
                    `>= ${runtimeRules.min_ram_gb}`,
                    null
                );
            } else if (availableRam < runtimeRules.min_ram_gb) {
                this.pushViolation(
                    violations,
                    'INSUFFICIENT_RAM',
                    'rules.runtime.min_ram_gb',
                    'System RAM is below policy minimum.',
                    `>= ${runtimeRules.min_ram_gb}`,
                    availableRam
                );
            }
        }

        if (runtimeRules.local_only === true) {
            const isLocal = this.resolveIsLocal(model, context);
            if (!isLocal) {
                this.pushViolation(
                    violations,
                    'MODEL_NOT_LOCAL',
                    'rules.runtime.local_only',
                    'Policy requires local execution, but model source is non-local.',
                    true,
                    isLocal
                );
            }
        }
    }

    evaluateComplianceRules(model, complianceRules, violations) {
        if (!isPlainObject(complianceRules)) return;

        const approvedLicenses = asArray(complianceRules.approved_licenses)
            .map((license) => toLowerString(license))
            .filter(Boolean);

        if (approvedLicenses.length === 0) return;

        const license = this.getModelLicense(model);
        if (!license) {
            this.pushViolation(
                violations,
                'LICENSE_MISSING',
                'rules.compliance.approved_licenses',
                'Model license metadata is missing.',
                approvedLicenses,
                null
            );
            return;
        }

        if (!approvedLicenses.includes(license)) {
            this.pushViolation(
                violations,
                'LICENSE_NOT_APPROVED',
                'rules.compliance.approved_licenses',
                'Model license is not in approved allowlist.',
                approvedLicenses,
                license
            );
        }
    }

    buildRationale(violations) {
        if (!Array.isArray(violations) || violations.length === 0) {
            return ['Policy evaluation passed with zero violations.'];
        }

        return violations.map((violation) => `${violation.code}: ${violation.message}`);
    }

    pushViolation(violations, code, rulePath, message, expected, actual) {
        violations.push({
            code,
            path: rulePath,
            message,
            expected,
            actual
        });
    }

    getModelTargets(model) {
        const values = [
            this.getModelIdentifier(model),
            toLowerString(model.model_id),
            toLowerString(model.modelId),
            toLowerString(model.tag),
            toLowerString(model.name),
            toLowerString(model.model_name),
            toLowerString(model.family)
        ].filter(Boolean);

        return Array.from(new Set(values));
    }

    getModelIdentifier(model) {
        const identifier =
            toLowerString(model.model_identifier) ||
            toLowerString(model.modelIdentifier) ||
            toLowerString(model.tag) ||
            toLowerString(model.name) ||
            toLowerString(model.model_name);

        if (identifier && identifier.includes(':')) return identifier;

        const modelId = toLowerString(model.model_id) || toLowerString(model.modelId);
        if (modelId && identifier) {
            return `${modelId}:${identifier}`;
        }

        return modelId || identifier || 'unknown:model';
    }

    getModelSizeGB(model) {
        const explicit = this.toNumber(model.size_gb) ?? this.toNumber(model.sizeGB);
        if (explicit !== null) return explicit;

        const rawSize = toLowerString(model.size);
        if (rawSize) {
            const mbMatch = rawSize.match(/([0-9]+(?:\.[0-9]+)?)\s*mb/);
            if (mbMatch) return parseFloat(mbMatch[1]) / 1024;

            const gbMatch = rawSize.match(/([0-9]+(?:\.[0-9]+)?)\s*gb/);
            if (gbMatch) return parseFloat(gbMatch[1]);
        }

        const paramsB = this.getModelParamsB(model);
        if (paramsB !== null) {
            const quant = this.getModelQuantization(model) || 'q4_k_m';
            if (quant.includes('q8') || quant.includes('f16') || quant.includes('fp16')) {
                return paramsB;
            }
            if (quant.includes('q6')) {
                return paramsB * 0.75;
            }
            if (quant.includes('q5')) {
                return paramsB * 0.6;
            }
            if (quant.includes('q3')) {
                return paramsB * 0.4;
            }
            if (quant.includes('q2')) {
                return paramsB * 0.3;
            }
            return paramsB * 0.5;
        }

        return null;
    }

    getModelParamsB(model) {
        const explicit = this.toNumber(model.params_b) ?? this.toNumber(model.paramsB);
        if (explicit !== null) return explicit;

        const identifier = this.getModelIdentifier(model);
        const match = identifier.match(/([0-9]+(?:\.[0-9]+)?)b\b/i);
        if (match) return parseFloat(match[1]);

        return null;
    }

    getModelQuantization(model) {
        const raw =
            toLowerString(model.quant) ||
            toLowerString(model.quantization) ||
            toLowerString(model.quant_type);

        return raw;
    }

    getModelLicense(model) {
        const raw =
            toLowerString(model.license) ||
            toLowerString(model.license_id) ||
            toLowerString(model.licenseId);

        return raw;
    }

    resolveBackend(model, context) {
        const fromContext = toLowerString(context.backend) || toLowerString(context.runtimeBackend);
        if (fromContext) return fromContext;

        const fromHardware =
            toLowerString(context?.hardware?.summary?.bestBackend) ||
            toLowerString(context?.hardware?.backend);
        if (fromHardware) return fromHardware;

        return toLowerString(model.backend);
    }

    resolveSystemRamGB(context) {
        const direct =
            this.toNumber(context.ramGB) ??
            this.toNumber(context.totalRamGB) ??
            this.toNumber(context?.hardware?.memory?.total) ??
            this.toNumber(context?.hardware?.summary?.systemRAM) ??
            this.toNumber(context?.hardware?.summary?.effectiveMemory);

        return direct;
    }

    resolveIsLocal(model, context) {
        if (typeof context.isLocal === 'boolean') {
            return context.isLocal;
        }

        if (typeof model.is_local === 'boolean') return model.is_local;
        if (typeof model.isLocal === 'boolean') return model.isLocal;
        if (typeof model.local === 'boolean') return model.local;

        const source = toLowerString(model.source);
        if (source) {
            return source === 'local' || source === 'ollama';
        }

        const type = toLowerString(model.type);
        if (type) {
            return type !== 'cloud' && type !== 'remote' && type !== 'hosted';
        }

        return true;
    }

    toNumber(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') {
            const normalized = value.trim();
            if (!normalized) return null;
            const parsed = Number.parseFloat(normalized);
            if (Number.isFinite(parsed)) return parsed;
        }
        return null;
    }

    matchesAnyPattern(pattern, targets) {
        if (!pattern || !Array.isArray(targets)) return false;
        const regex = this.getPatternRegex(pattern);
        return targets.some((target) => regex.test(target));
    }

    getPatternRegex(pattern) {
        if (this.patternCache.has(pattern)) {
            return this.patternCache.get(pattern);
        }

        const escaped = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');

        const regex = new RegExp(`^${escaped}$`, 'i');
        this.patternCache.set(pattern, regex);
        return regex;
    }
}

module.exports = PolicyEngine;
