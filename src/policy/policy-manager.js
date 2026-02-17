const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const ALLOWED_POLICY_MODES = ['audit', 'enforce'];
const ALLOWED_ENFORCEMENT_BEHAVIOR = ['warn', 'error'];
const ALLOWED_REPORT_FORMATS = ['json', 'csv', 'sarif'];

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

class PolicyManager {
    getTemplate() {
        return `version: 1
org: your-org
mode: enforce # audit | enforce

rules:
  models:
    allow:
      - "qwen2.5-coder:*"
      - "llama3.1:*"
    deny:
      - "*uncensored*"
    max_size_gb: 24
    max_params_b: 32
    allowed_quantizations: ["Q4_K_M", "Q5_K_M", "Q8_0"]

  runtime:
    required_backends: ["metal", "cuda"]
    min_ram_gb: 32
    local_only: true

  compliance:
    approved_licenses: ["mit", "apache-2.0", "llama"]

enforcement:
  on_violation: error # warn | error
  exit_code: 3
  allow_exceptions: true

exceptions:
  - model: "deepseek-r1:32b"
    reason: "Approved PoC"
    approver: "security@example.com"
    expires_at: "2026-06-30"

reporting:
  formats: ["json", "csv", "sarif"]
`;
    }

    resolvePolicyPath(policyFile = 'policy.yaml', cwd = process.cwd()) {
        return path.isAbsolute(policyFile) ? policyFile : path.resolve(cwd, policyFile);
    }

    initPolicy(policyFile = 'policy.yaml', options = {}) {
        const { force = false, cwd = process.cwd() } = options;
        const targetPath = this.resolvePolicyPath(policyFile, cwd);

        const exists = fs.existsSync(targetPath);
        if (exists && !force) {
            throw new Error(`Policy file already exists at ${targetPath}. Use --force to overwrite.`);
        }

        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, this.getTemplate(), 'utf8');

        return {
            path: targetPath,
            overwritten: exists && force
        };
    }

    loadPolicy(policyFile = 'policy.yaml', options = {}) {
        const { cwd = process.cwd() } = options;
        const policyPath = this.resolvePolicyPath(policyFile, cwd);

        if (!fs.existsSync(policyPath)) {
            throw new Error(`Policy file not found: ${policyPath}`);
        }

        const source = fs.readFileSync(policyPath, 'utf8');
        const doc = YAML.parseDocument(source, { prettyErrors: true });

        if (doc.errors && doc.errors.length > 0) {
            const first = doc.errors[0];
            throw new Error(`Invalid YAML in ${policyPath}: ${String(first.message || first)}`);
        }

        const policy = doc.toJSON();
        if (!isPlainObject(policy)) {
            throw new Error(`Invalid YAML in ${policyPath}: root must be an object`);
        }

        return { path: policyPath, policy };
    }

    validatePolicyFile(policyFile = 'policy.yaml', options = {}) {
        const loaded = this.loadPolicy(policyFile, options);
        const validation = this.validatePolicyObject(loaded.policy);
        return {
            ...validation,
            path: loaded.path,
            policy: loaded.policy
        };
    }

    validatePolicyObject(policy) {
        const errors = [];
        const addError = (fieldPath, message) => {
            errors.push({ path: fieldPath, message });
        };

        if (!isPlainObject(policy)) {
            addError('root', 'Policy must be an object.');
            return { valid: false, errors };
        }

        if (!Number.isInteger(policy.version) || policy.version < 1) {
            addError('version', 'Version must be an integer >= 1.');
        }

        if (!isNonEmptyString(policy.org)) {
            addError('org', 'Organization must be a non-empty string.');
        }

        if (!isNonEmptyString(policy.mode) || !ALLOWED_POLICY_MODES.includes(policy.mode)) {
            addError('mode', `Mode must be one of: ${ALLOWED_POLICY_MODES.join(', ')}.`);
        }

        if (!isPlainObject(policy.rules)) {
            addError('rules', 'Rules section is required and must be an object.');
        } else {
            this.validateModelsRules(policy.rules.models, addError);
            this.validateRuntimeRules(policy.rules.runtime, addError);
            this.validateComplianceRules(policy.rules.compliance, addError);
        }

        this.validateEnforcement(policy.enforcement, addError);
        this.validateExceptions(policy.exceptions, addError);
        this.validateReporting(policy.reporting, addError);

        return {
            valid: errors.length === 0,
            errors
        };
    }

    validateModelsRules(models, addError) {
        if (models === undefined) return;

        if (!isPlainObject(models)) {
            addError('rules.models', 'Must be an object.');
            return;
        }

        this.validateStringArray(models.allow, 'rules.models.allow', addError);
        this.validateStringArray(models.deny, 'rules.models.deny', addError);
        this.validateStringArray(
            models.allowed_quantizations,
            'rules.models.allowed_quantizations',
            addError
        );

        if (models.max_size_gb !== undefined && !isPositiveNumber(models.max_size_gb)) {
            addError('rules.models.max_size_gb', 'Must be a positive number.');
        }

        if (models.max_params_b !== undefined && !isPositiveNumber(models.max_params_b)) {
            addError('rules.models.max_params_b', 'Must be a positive number.');
        }
    }

    validateRuntimeRules(runtime, addError) {
        if (runtime === undefined) return;

        if (!isPlainObject(runtime)) {
            addError('rules.runtime', 'Must be an object.');
            return;
        }

        this.validateStringArray(runtime.required_backends, 'rules.runtime.required_backends', addError);

        if (runtime.min_ram_gb !== undefined && !isPositiveNumber(runtime.min_ram_gb)) {
            addError('rules.runtime.min_ram_gb', 'Must be a positive number.');
        }

        if (runtime.local_only !== undefined && typeof runtime.local_only !== 'boolean') {
            addError('rules.runtime.local_only', 'Must be a boolean.');
        }
    }

    validateComplianceRules(compliance, addError) {
        if (compliance === undefined) return;

        if (!isPlainObject(compliance)) {
            addError('rules.compliance', 'Must be an object.');
            return;
        }

        this.validateStringArray(
            compliance.approved_licenses,
            'rules.compliance.approved_licenses',
            addError
        );
    }

    validateEnforcement(enforcement, addError) {
        if (enforcement === undefined) return;

        if (!isPlainObject(enforcement)) {
            addError('enforcement', 'Must be an object.');
            return;
        }

        if (
            enforcement.on_violation !== undefined &&
            !ALLOWED_ENFORCEMENT_BEHAVIOR.includes(enforcement.on_violation)
        ) {
            addError(
                'enforcement.on_violation',
                `Must be one of: ${ALLOWED_ENFORCEMENT_BEHAVIOR.join(', ')}.`
            );
        }

        if (enforcement.exit_code !== undefined) {
            if (!Number.isInteger(enforcement.exit_code) || enforcement.exit_code < 1 || enforcement.exit_code > 255) {
                addError('enforcement.exit_code', 'Must be an integer between 1 and 255.');
            }
        }

        if (enforcement.allow_exceptions !== undefined && typeof enforcement.allow_exceptions !== 'boolean') {
            addError('enforcement.allow_exceptions', 'Must be a boolean.');
        }
    }

    validateExceptions(exceptions, addError) {
        if (exceptions === undefined) return;

        if (!Array.isArray(exceptions)) {
            addError('exceptions', 'Must be an array.');
            return;
        }

        exceptions.forEach((entry, index) => {
            const basePath = `exceptions[${index}]`;
            if (!isPlainObject(entry)) {
                addError(basePath, 'Each exception must be an object.');
                return;
            }

            if (!isNonEmptyString(entry.model)) {
                addError(`${basePath}.model`, 'Model must be a non-empty string.');
            }

            if (entry.reason !== undefined && !isNonEmptyString(entry.reason)) {
                addError(`${basePath}.reason`, 'Reason must be a non-empty string.');
            }

            if (entry.approver !== undefined && !isNonEmptyString(entry.approver)) {
                addError(`${basePath}.approver`, 'Approver must be a non-empty string.');
            }

            if (entry.expires_at !== undefined && !isNonEmptyString(entry.expires_at)) {
                addError(`${basePath}.expires_at`, 'expires_at must be a non-empty string.');
            }
        });
    }

    validateReporting(reporting, addError) {
        if (reporting === undefined) return;

        if (!isPlainObject(reporting)) {
            addError('reporting', 'Must be an object.');
            return;
        }

        if (reporting.formats !== undefined) {
            if (!Array.isArray(reporting.formats)) {
                addError('reporting.formats', 'Must be an array.');
            } else {
                reporting.formats.forEach((format, index) => {
                    if (!isNonEmptyString(format)) {
                        addError(`reporting.formats[${index}]`, 'Format must be a non-empty string.');
                        return;
                    }

                    if (!ALLOWED_REPORT_FORMATS.includes(format)) {
                        addError(
                            `reporting.formats[${index}]`,
                            `Unsupported format "${format}". Allowed: ${ALLOWED_REPORT_FORMATS.join(', ')}.`
                        );
                    }
                });
            }
        }
    }

    validateStringArray(value, fieldPath, addError) {
        if (value === undefined) return;
        if (!Array.isArray(value)) {
            addError(fieldPath, 'Must be an array of strings.');
            return;
        }

        value.forEach((entry, index) => {
            if (!isNonEmptyString(entry)) {
                addError(`${fieldPath}[${index}]`, 'Must be a non-empty string.');
            }
        });
    }
}

module.exports = PolicyManager;
