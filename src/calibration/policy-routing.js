const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const { calibrationPolicySchema } = require('./schemas');

const DEFAULT_CALIBRATION_POLICY_FILENAMES = [
    'calibration-policy.yaml',
    'calibration-policy.yml',
    'calibration-policy.json'
];

const TASK_ALIASES = {
    code: 'coding',
    coder: 'coding',
    programming: 'coding',
    chat: 'talking',
    conversation: 'talking',
    talk: 'talking',
    summarize: 'reading',
    summary: 'reading',
    summarization: 'reading',
    vision: 'multimodal',
    image: 'multimodal'
};

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function formatValidationError(error) {
    if (!error || !Array.isArray(error.issues)) {
        return String(error?.message || 'validation failed');
    }

    return error.issues
        .map((issue) => {
            const location = Array.isArray(issue.path) && issue.path.length > 0
                ? issue.path.join('.')
                : 'root';
            return `${location}: ${issue.message}`;
        })
        .join('; ');
}

function resolvePolicyPath(policyPath, cwd = process.cwd()) {
    if (!isNonEmptyString(policyPath)) {
        throw new Error('Calibration policy path must be a non-empty string.');
    }

    return path.isAbsolute(policyPath)
        ? policyPath
        : path.resolve(cwd, policyPath);
}

function parseCalibrationPolicyPayload(payloadText, policyPath) {
    const extension = path.extname(policyPath).toLowerCase();
    let parsed;

    try {
        if (extension === '.json') {
            parsed = JSON.parse(payloadText);
        } else {
            parsed = YAML.parse(payloadText);
        }
    } catch (error) {
        throw new Error(`Failed to parse calibration policy file: ${error.message}`);
    }

    try {
        return calibrationPolicySchema.parse(parsed);
    } catch (error) {
        throw new Error(`Invalid calibration policy payload: ${formatValidationError(error)}`);
    }
}

function loadCalibrationPolicyFile(policyPath, options = {}) {
    const resolvedPath = resolvePolicyPath(policyPath, options.cwd);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Calibration policy file not found: ${resolvedPath}`);
    }

    const stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) {
        throw new Error(`Calibration policy path must be a file: ${resolvedPath}`);
    }

    const payloadText = fs.readFileSync(resolvedPath, 'utf8');
    const policy = parseCalibrationPolicyPayload(payloadText, resolvedPath);
    return {
        policyPath: resolvedPath,
        policy
    };
}

function tryLoadCalibrationPolicy(policyPath, options = {}) {
    const resolvedPath = resolvePolicyPath(policyPath, options.cwd);

    try {
        const loaded = loadCalibrationPolicyFile(resolvedPath, options);
        return {
            ok: true,
            ...loaded
        };
    } catch (error) {
        return {
            ok: false,
            resolvedPath,
            error
        };
    }
}

function getDefaultCalibrationPolicyCandidates(homeDir = os.homedir()) {
    const baseDir = path.join(homeDir, '.llm-checker');
    return DEFAULT_CALIBRATION_POLICY_FILENAMES.map((fileName) => path.join(baseDir, fileName));
}

function discoverDefaultCalibrationPolicyPath(homeDir = os.homedir()) {
    const candidates = getDefaultCalibrationPolicyCandidates(homeDir);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return null;
}

function normalizeTaskName(task) {
    const normalized = String(task || 'general').trim().toLowerCase();
    if (!normalized) return 'general';
    return TASK_ALIASES[normalized] || normalized;
}

function inferTaskFromPrompt(prompt) {
    const text = String(prompt || '').toLowerCase();
    if (!text.trim()) return 'general';

    if (/\b(code|coding|refactor|function|bug|debug|typescript|javascript|python|java|rust|go)\b/.test(text)) {
        return 'coding';
    }
    if (/\b(reason|reasoning|analy[sz]e|logic|prove|derive|step by step)\b/.test(text)) {
        return 'reasoning';
    }
    if (/\b(vision|image|photo|diagram|screenshot)\b/.test(text)) {
        return 'multimodal';
    }
    if (/\b(summarize|summary|read|reading|article|document)\b/.test(text)) {
        return 'reading';
    }
    if (/\b(creative|story|poem|brainstorm|marketing copy)\b/.test(text)) {
        return 'creative';
    }
    if (/\b(chat|talk|conversation|assistant)\b/.test(text)) {
        return 'talking';
    }

    return 'general';
}

function buildTaskCandidates(requestedTask) {
    const normalized = normalizeTaskName(requestedTask);
    const candidates = [normalized];

    if (normalized === 'talking') {
        candidates.push('chat');
    } else if (normalized === 'chat') {
        candidates.push('talking');
    }

    if (!candidates.includes('general')) {
        candidates.push('general');
    }

    return [...new Set(candidates)];
}

function resolveCalibrationRoute(policy, requestedTask) {
    const routing = policy && typeof policy.routing === 'object' ? policy.routing : null;
    if (!routing) return null;

    const routeKeys = Object.keys(routing);
    if (routeKeys.length === 0) return null;

    const normalizedTask = normalizeTaskName(requestedTask);
    const taskCandidates = buildTaskCandidates(normalizedTask);

    for (const taskName of taskCandidates) {
        if (Object.prototype.hasOwnProperty.call(routing, taskName)) {
            return {
                requestedTask: normalizedTask,
                resolvedTask: taskName,
                usedTaskFallback: taskName !== normalizedTask,
                route: routing[taskName]
            };
        }
    }

    const fallbackTask = routeKeys[0];
    return {
        requestedTask: normalizedTask,
        resolvedTask: fallbackTask,
        usedTaskFallback: true,
        route: routing[fallbackTask]
    };
}

function getRouteModelCandidates(route) {
    if (!route || !isNonEmptyString(route.primary)) return [];

    const merged = [route.primary, ...(Array.isArray(route.fallbacks) ? route.fallbacks : [])];
    const unique = [];
    for (const item of merged) {
        if (!isNonEmptyString(item)) continue;
        const trimmed = item.trim();
        if (!unique.includes(trimmed)) {
            unique.push(trimmed);
        }
    }

    return unique;
}

function normalizeModelIdentifier(value) {
    return String(value || '').trim().toLowerCase();
}

function splitModelIdentifier(value) {
    const normalized = normalizeModelIdentifier(value);
    if (!normalized) return { full: '', base: '' };

    const [base] = normalized.split(':');
    return { full: normalized, base: base || normalized };
}

function modelIdentifiersMatch(left, right) {
    const leftId = splitModelIdentifier(left);
    const rightId = splitModelIdentifier(right);

    if (!leftId.full || !rightId.full) return false;
    if (leftId.full === rightId.full) return true;
    if (leftId.base === rightId.base) return true;
    if (leftId.full.startsWith(`${rightId.base}:`)) return true;
    if (rightId.full.startsWith(`${leftId.base}:`)) return true;

    return false;
}

function selectModelFromRoute(route, availableModels = []) {
    const routeCandidates = getRouteModelCandidates(route);
    if (routeCandidates.length === 0) return null;

    if (!Array.isArray(availableModels) || availableModels.length === 0) {
        return {
            selectedModel: routeCandidates[0],
            matchedRouteModel: routeCandidates[0],
            usedFallback: false,
            routeCandidates
        };
    }

    for (const routeModel of routeCandidates) {
        const matched = availableModels.find((candidate) =>
            modelIdentifiersMatch(routeModel, candidate)
        );

        if (matched) {
            return {
                selectedModel: matched,
                matchedRouteModel: routeModel,
                usedFallback: routeModel !== routeCandidates[0],
                routeCandidates
            };
        }
    }

    return null;
}

function resolveRoutingPolicyPreference({
    policyOption,
    calibratedOption,
    loadEnterprisePolicy,
    cwd = process.cwd(),
    homeDir = os.homedir()
} = {}) {
    const result = {
        enterprisePolicy: null,
        calibratedPolicy: null,
        warnings: []
    };

    const calibratedRequested = calibratedOption !== undefined && calibratedOption !== false;

    if (isNonEmptyString(policyOption)) {
        const calibrationAttempt = tryLoadCalibrationPolicy(policyOption, { cwd });
        if (calibrationAttempt.ok) {
            result.calibratedPolicy = {
                policyPath: calibrationAttempt.policyPath,
                policy: calibrationAttempt.policy,
                source: '--policy'
            };
        } else {
            if (typeof loadEnterprisePolicy !== 'function') {
                throw calibrationAttempt.error;
            }
            result.enterprisePolicy = loadEnterprisePolicy(policyOption);
        }

        if (calibratedRequested) {
            result.warnings.push('Ignoring --calibrated because --policy takes precedence.');
        }

        return result;
    }

    if (!calibratedRequested) {
        return result;
    }

    if (isNonEmptyString(calibratedOption)) {
        const attempt = tryLoadCalibrationPolicy(calibratedOption, { cwd });
        if (attempt.ok) {
            result.calibratedPolicy = {
                policyPath: attempt.policyPath,
                policy: attempt.policy,
                source: '--calibrated'
            };
            return result;
        }

        result.warnings.push(
            `Unable to load calibrated policy from ${attempt.resolvedPath}: ${attempt.error.message}. Falling back to deterministic selector.`
        );
        return result;
    }

    const discoveredPath = discoverDefaultCalibrationPolicyPath(homeDir);
    if (!discoveredPath) {
        result.warnings.push(
            'No default calibrated policy found at ~/.llm-checker/calibration-policy.{yaml,yml,json}. Falling back to deterministic selector.'
        );
        return result;
    }

    const defaultAttempt = tryLoadCalibrationPolicy(discoveredPath, { cwd });
    if (defaultAttempt.ok) {
        result.calibratedPolicy = {
            policyPath: defaultAttempt.policyPath,
            policy: defaultAttempt.policy,
            source: 'default-discovery'
        };
        return result;
    }

    result.warnings.push(
        `Unable to load discovered calibrated policy ${defaultAttempt.resolvedPath}: ${defaultAttempt.error.message}. Falling back to deterministic selector.`
    );
    return result;
}

module.exports = {
    DEFAULT_CALIBRATION_POLICY_FILENAMES,
    getDefaultCalibrationPolicyCandidates,
    discoverDefaultCalibrationPolicyPath,
    loadCalibrationPolicyFile,
    tryLoadCalibrationPolicy,
    normalizeTaskName,
    inferTaskFromPrompt,
    resolveCalibrationRoute,
    getRouteModelCandidates,
    modelIdentifiersMatch,
    selectModelFromRoute,
    resolveRoutingPolicyPreference
};
