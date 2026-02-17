const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const YAML = require('yaml');
const {
    SUPPORTED_CALIBRATION_OBJECTIVES,
    calibrationObjectiveSchema,
    calibrationExecutionModeSchema,
    promptSuiteEntrySchema,
    calibrationResultSchema,
    calibrationPolicySchema,
    DEFAULT_CALIBRATION_TASK
} = require('./schemas');
const { SUPPORTED_RUNTIMES, normalizeRuntime } = require('../runtime/runtime-support');

const SUPPORTED_FULL_MODE_RUNTIMES = ['ollama'];

function formatZodIssues(error) {
    if (!error || !Array.isArray(error.issues) || error.issues.length === 0) {
        return error?.message || 'Validation failed';
    }

    return error.issues
        .map((issue) => {
            const location = issue.path && issue.path.length > 0 ? issue.path.join('.') : 'root';
            return `${location}: ${issue.message}`;
        })
        .join('; ');
}

function toNonEmptyTaskName(task) {
    const raw = String(task || '').trim().toLowerCase();
    return raw || DEFAULT_CALIBRATION_TASK;
}

function isYamlPath(filePath = '') {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    return extension === '.yaml' || extension === '.yml';
}

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return parsed;
}

function percentile(values, p) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = values
        .map((value) => toNumber(value, 0))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

function median(values) {
    return percentile(values, 50);
}

function normalizeModelQuantization(modelIdentifier) {
    const value = String(modelIdentifier || '').toLowerCase();
    if (value.includes('q2')) return 0.25;
    if (value.includes('q3')) return 0.375;
    if (value.includes('q4')) return 0.5;
    if (value.includes('q5')) return 0.625;
    if (value.includes('q6')) return 0.75;
    if (value.includes('q8')) return 1.0;
    if (value.includes('fp16') || value.includes('f16') || value.includes('bf16')) return 2.0;
    return 1.0;
}

function extractParamsB(modelIdentifier) {
    const match = String(modelIdentifier || '')
        .toLowerCase()
        .match(/(\d+(?:\.\d+)?)\s*b/);
    if (!match) return null;
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : null;
}

function estimatePeakMemoryMb(modelIdentifier) {
    const paramsB = extractParamsB(modelIdentifier);
    if (!paramsB) return undefined;

    const bytesPerParam = normalizeModelQuantization(modelIdentifier);
    const bytes = paramsB * 1_000_000_000 * bytesPerParam;
    const withOverhead = bytes * 1.15;
    return Math.round(withOverhead / (1024 * 1024));
}

function countTokensApprox(text) {
    const source = String(text || '').trim();
    if (!source) return 0;
    return source.split(/\s+/).length;
}

function normalizeErrorCode(error) {
    const explicitCode = String(error?.code || '').trim();
    if (explicitCode) return explicitCode.toUpperCase();

    const message = String(error?.message || '').toLowerCase();
    if (message.includes('timed out')) return 'RUNTIME_TIMEOUT';
    if (message.includes('unsupported runtime')) return 'UNSUPPORTED_RUNTIME';
    if (message.includes('regex')) return 'QUALITY_REGEX_ERROR';
    return 'CALIBRATION_RUNTIME_ERROR';
}

class CalibrationManager {
    constructor(options = {}) {
        this.promptExecutor =
            typeof options.promptExecutor === 'function'
                ? options.promptExecutor
                : this.executePromptWithRuntime.bind(this);
    }

    resolvePath(filePath, cwd = process.cwd()) {
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('A file path is required.');
        }

        return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    }

    parsePromptSuite(suiteFilePath, options = {}) {
        const cwd = options.cwd || process.cwd();
        const resolvedPath = this.resolvePath(suiteFilePath, cwd);

        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`Prompt suite file not found: ${resolvedPath}`);
        }

        const source = fs.readFileSync(resolvedPath, 'utf8');
        const lines = source.split(/\r?\n/);
        const entries = [];
        const taskBreakdown = {};

        lines.forEach((line, index) => {
            const lineNumber = index + 1;
            const trimmed = line.trim();
            if (!trimmed) {
                return;
            }

            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            } catch (error) {
                throw new Error(`Invalid JSON in prompt suite at line ${lineNumber}: ${error.message}`);
            }

            let validated;
            try {
                validated = promptSuiteEntrySchema.parse(parsed);
            } catch (error) {
                throw new Error(
                    `Invalid prompt suite entry at line ${lineNumber}: ${formatZodIssues(error)}`
                );
            }

            const task = toNonEmptyTaskName(validated.task);
            const id = validated.id || `prompt-${entries.length + 1}`;

            entries.push({
                ...validated,
                id,
                task,
                checks: Array.isArray(validated.checks) ? validated.checks : []
            });

            taskBreakdown[task] = (taskBreakdown[task] || 0) + 1;
        });

        if (entries.length === 0) {
            throw new Error('Prompt suite must contain at least one JSONL entry.');
        }

        return {
            path: resolvedPath,
            entries,
            metadata: {
                path: resolvedPath,
                total_prompts: entries.length,
                task_breakdown: taskBreakdown
            }
        };
    }

    parseModelIdentifiers(modelInput) {
        const values = Array.isArray(modelInput) ? modelInput : [modelInput];
        const expanded = [];

        values.forEach((entry) => {
            String(entry || '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
                .forEach((value) => expanded.push(value));
        });

        const deduped = [...new Set(expanded)];
        if (deduped.length === 0) {
            throw new Error('At least one model identifier is required via --models.');
        }

        return deduped;
    }

    validateRuntime(runtime) {
        const raw = String(runtime || 'ollama').trim().toLowerCase();
        if (!SUPPORTED_RUNTIMES.includes(raw)) {
            throw new Error(
                `Unsupported runtime "${runtime}". Supported runtimes: ${SUPPORTED_RUNTIMES.join(', ')}`
            );
        }
        return normalizeRuntime(raw);
    }

    validateObjective(objective = 'balanced') {
        try {
            return calibrationObjectiveSchema.parse(String(objective || 'balanced').trim().toLowerCase());
        } catch (error) {
            throw new Error(
                `Unsupported objective "${objective}". Supported objectives: ${SUPPORTED_CALIBRATION_OBJECTIVES.join(', ')}`
            );
        }
    }

    resolveExecutionMode(options = {}) {
        const providedMode = options.mode ? String(options.mode).trim().toLowerCase() : null;
        const dryRun = Boolean(options.dryRun);

        if (dryRun && providedMode && providedMode !== 'dry-run') {
            throw new Error('Do not combine --dry-run with --mode other than "dry-run".');
        }

        const mode = dryRun ? 'dry-run' : providedMode || 'contract-only';

        try {
            return calibrationExecutionModeSchema.parse(mode);
        } catch (error) {
            throw new Error('Invalid execution mode. Use one of: dry-run, contract-only, full.');
        }
    }

    getLocalHardwareSummary() {
        const cpuModel = os.cpus()?.[0]?.model || os.arch();
        const totalRamGb = Math.round(os.totalmem() / (1024 ** 3));

        return {
            fingerprint: `${os.platform()}-${os.arch()}-${totalRamGb}gb`,
            description: `${cpuModel} | ${totalRamGb}GB RAM`
        };
    }

    buildDraftCalibrationResult({
        models,
        suiteMetadata,
        runtime,
        objective,
        executionMode,
        hardware,
        calibrationVersion
    }) {
        const modelResults = models.map((modelIdentifier) => ({
            model_identifier: modelIdentifier,
            status: 'pending'
        }));

        const summary = {
            total_models: modelResults.length,
            successful_models: 0,
            failed_models: 0,
            skipped_models: 0,
            pending_models: modelResults.length
        };

        const result = {
            schema_version: '1.0',
            generated_at: new Date().toISOString(),
            calibration_version:
                calibrationVersion || `contract-${new Date().toISOString().replace(/[:.]/g, '-')}`,
            execution_mode: executionMode,
            runtime,
            objective,
            hardware: hardware || this.getLocalHardwareSummary(),
            suite: suiteMetadata,
            models: modelResults,
            summary
        };

        return this.validateCalibrationResult(result);
    }

    ensureFullModeRuntime(runtime) {
        if (!SUPPORTED_FULL_MODE_RUNTIMES.includes(runtime)) {
            throw new Error(
                `Full calibration mode currently supports: ${SUPPORTED_FULL_MODE_RUNTIMES.join(', ')}.`
            );
        }
    }

    executePromptWithRuntime({ runtime, modelIdentifier, prompt, timeoutMs = 120000 }) {
        this.ensureFullModeRuntime(runtime);

        const started = process.hrtime.bigint();
        const result = spawnSync('ollama', ['run', modelIdentifier, prompt], {
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 20 * 1024 * 1024,
            env: {
                ...process.env,
                NO_COLOR: '1'
            }
        });
        const latencyMs = Number((process.hrtime.bigint() - started) / 1_000_000n);

        if (result.error) {
            const error = new Error(result.error.message || 'Failed to execute runtime prompt.');
            error.code = result.error.code || 'RUNTIME_EXECUTION_ERROR';
            throw error;
        }

        if (result.status !== 0) {
            const message = String(result.stderr || result.stdout || '')
                .trim()
                .slice(0, 500);
            const error = new Error(
                message || `Runtime command exited with status code ${result.status}`
            );
            error.code = 'RUNTIME_EXECUTION_ERROR';
            throw error;
        }

        const output = String(result.stdout || '').trim();

        return {
            output,
            latencyMs,
            ttftMs: latencyMs
        };
    }

    evaluatePromptChecks(responseText, checks = []) {
        if (!Array.isArray(checks) || checks.length === 0) {
            return {
                passedWeight: 0,
                totalWeight: 0,
                passRate: 1,
                checkResults: []
            };
        }

        let passedWeight = 0;
        let totalWeight = 0;
        const checkResults = [];

        checks.forEach((check) => {
            const weight = toNumber(check.weight, 1) > 0 ? toNumber(check.weight, 1) : 1;
            totalWeight += weight;

            let passed = false;
            let error = undefined;
            const response = String(responseText || '');
            const expected = String(check.expected || '');

            try {
                if (check.type === 'exact') {
                    passed = response.trim() === expected.trim();
                } else if (check.type === 'contains') {
                    passed = response.includes(expected);
                } else if (check.type === 'regex') {
                    const expression = new RegExp(expected);
                    passed = expression.test(response);
                }
            } catch (reason) {
                passed = false;
                error = String(reason.message || reason);
            }

            if (passed) {
                passedWeight += weight;
            }

            checkResults.push({
                type: check.type,
                expected: expected,
                weight,
                passed,
                error
            });
        });

        return {
            passedWeight,
            totalWeight,
            passRate: totalWeight > 0 ? passedWeight / totalWeight : 1,
            checkResults
        };
    }

    runPromptWithWarmup({
        runtime,
        modelIdentifier,
        prompt,
        warmupRuns,
        measuredIterations,
        timeoutMs
    }) {
        for (let index = 0; index < warmupRuns; index += 1) {
            this.promptExecutor({
                runtime,
                modelIdentifier,
                prompt,
                timeoutMs
            });
        }

        const measured = [];
        for (let iteration = 0; iteration < measuredIterations; iteration += 1) {
            const run = this.promptExecutor({
                runtime,
                modelIdentifier,
                prompt,
                timeoutMs
            });

            measured.push({
                output: String(run.output || ''),
                latencyMs: toNumber(run.latencyMs, 0),
                ttftMs:
                    run.ttftMs === undefined || run.ttftMs === null
                        ? undefined
                        : toNumber(run.ttftMs, 0)
            });
        }

        if (measured.length === 0) {
            throw new Error('Measured iterations must be >= 1.');
        }

        const latencies = measured.map((entry) => entry.latencyMs);
        const ttfts = measured
            .map((entry) => entry.ttftMs)
            .filter((value) => value !== undefined && Number.isFinite(value));
        const totalTokens = measured.reduce(
            (accumulator, entry) => accumulator + countTokensApprox(entry.output),
            0
        );
        const averageOutputTokens = Math.round(totalTokens / measured.length);
        const representativeResponse = measured[measured.length - 1].output;

        return {
            response: representativeResponse,
            latencies,
            ttfts,
            totalTokens,
            averageOutputTokens
        };
    }

    evaluateModel({
        modelIdentifier,
        suiteEntries,
        runtime,
        warmupRuns,
        measuredIterations,
        timeoutMs
    }) {
        const allLatencies = [];
        const allTtfts = [];
        let totalTokens = 0;
        let totalCheckWeight = 0;
        let passedCheckWeight = 0;
        const taskWeightMap = {};
        const taskPassedMap = {};
        const promptRuns = [];

        for (const entry of suiteEntries) {
            const execution = this.runPromptWithWarmup({
                runtime,
                modelIdentifier,
                prompt: entry.prompt,
                warmupRuns,
                measuredIterations,
                timeoutMs
            });

            const checkEvaluation = this.evaluatePromptChecks(execution.response, entry.checks);
            const task = toNonEmptyTaskName(entry.task);

            taskWeightMap[task] = (taskWeightMap[task] || 0) + checkEvaluation.totalWeight;
            taskPassedMap[task] = (taskPassedMap[task] || 0) + checkEvaluation.passedWeight;

            totalCheckWeight += checkEvaluation.totalWeight;
            passedCheckWeight += checkEvaluation.passedWeight;
            totalTokens += execution.totalTokens;

            allLatencies.push(...execution.latencies);
            allTtfts.push(...execution.ttfts);

            promptRuns.push({
                prompt_id: entry.id,
                task,
                latency_ms: median(execution.latencies),
                ttft_ms: execution.ttfts.length > 0 ? median(execution.ttfts) : undefined,
                output_tokens: execution.averageOutputTokens,
                response_excerpt: execution.response.slice(0, 400),
                check_results: checkEvaluation.checkResults,
                check_pass_rate: checkEvaluation.passRate
            });
        }

        const taskScores = {};
        Object.keys(taskWeightMap).forEach((task) => {
            const taskWeight = taskWeightMap[task];
            const taskPassed = taskPassedMap[task] || 0;
            taskScores[task] = taskWeight > 0 ? (taskPassed / taskWeight) * 100 : 100;
        });

        const checkPassRate = totalCheckWeight > 0 ? passedCheckWeight / totalCheckWeight : 1;
        const overallScore =
            Object.keys(taskScores).length > 0
                ? Object.values(taskScores).reduce((sum, value) => sum + value, 0) /
                  Object.values(taskScores).length
                : checkPassRate * 100;

        const totalLatencySec =
            allLatencies.reduce((sum, value) => sum + value, 0) > 0
                ? allLatencies.reduce((sum, value) => sum + value, 0) / 1000
                : 0;
        const tokensPerSecond = totalLatencySec > 0 ? totalTokens / totalLatencySec : 0;

        return {
            model_identifier: modelIdentifier,
            status: 'success',
            metrics: {
                ttft_ms: allTtfts.length > 0 ? percentile(allTtfts, 50) : percentile(allLatencies, 50),
                tokens_per_second: tokensPerSecond,
                latency_ms_p50: percentile(allLatencies, 50),
                latency_ms_p95: percentile(allLatencies, 95),
                peak_memory_mb: estimatePeakMemoryMb(modelIdentifier)
            },
            quality: {
                overall_score: overallScore,
                task_scores: taskScores,
                check_pass_rate: checkPassRate
            },
            traces: {
                warmup_runs: warmupRuns,
                measured_iterations: measuredIterations,
                prompt_runs: promptRuns
            }
        };
    }

    runFullCalibration({
        models,
        suite,
        runtime,
        objective,
        hardware,
        calibrationVersion,
        benchmarkConfig = {}
    }) {
        this.ensureFullModeRuntime(runtime);

        const warmupRuns = toPositiveInt(benchmarkConfig.warmupRuns, 1);
        const measuredIterations = Math.max(toPositiveInt(benchmarkConfig.measuredIterations, 2), 1);
        const timeoutMs = Math.max(toPositiveInt(benchmarkConfig.timeoutMs, 120000), 1000);

        const modelResults = models.map((modelIdentifier) => {
            try {
                return this.evaluateModel({
                    modelIdentifier,
                    suiteEntries: suite.entries,
                    runtime,
                    warmupRuns,
                    measuredIterations,
                    timeoutMs
                });
            } catch (error) {
                return {
                    model_identifier: modelIdentifier,
                    status: 'failed',
                    error: String(error.message || 'Calibration execution failed.'),
                    traces: {
                        warmup_runs: warmupRuns,
                        measured_iterations: measuredIterations,
                        error_code: normalizeErrorCode(error)
                    }
                };
            }
        });

        const summary = {
            total_models: modelResults.length,
            successful_models: modelResults.filter((entry) => entry.status === 'success').length,
            failed_models: modelResults.filter((entry) => entry.status === 'failed').length,
            skipped_models: modelResults.filter((entry) => entry.status === 'skipped').length,
            pending_models: modelResults.filter((entry) => entry.status === 'pending').length
        };

        const result = {
            schema_version: '1.0',
            generated_at: new Date().toISOString(),
            calibration_version:
                calibrationVersion || `full-${new Date().toISOString().replace(/[:.]/g, '-')}`,
            execution_mode: 'full',
            runtime,
            objective,
            hardware: hardware || this.getLocalHardwareSummary(),
            suite: suite.metadata,
            models: modelResults,
            summary
        };

        return this.validateCalibrationResult(result);
    }

    computeTaskCandidates({ task, successfulModels, objective }) {
        const candidates = successfulModels.map((model) => {
            const qualityScore = toNumber(
                model.quality?.task_scores?.[task],
                toNumber(model.quality?.overall_score, 0)
            );
            const speedRaw =
                toNumber(model.metrics?.tokens_per_second, 0) -
                toNumber(model.metrics?.latency_ms_p50, 0) / 1000;
            return {
                model_identifier: model.model_identifier,
                qualityScore,
                speedRaw
            };
        });

        const speedValues = candidates.map((entry) => entry.speedRaw);
        const minSpeed = Math.min(...speedValues);
        const maxSpeed = Math.max(...speedValues);
        const speedRange = maxSpeed - minSpeed;

        const weighted = candidates.map((entry) => {
            const speedScore =
                speedRange > 0 ? ((entry.speedRaw - minSpeed) / speedRange) * 100 : 50;
            let combinedScore = 0;
            if (objective === 'speed') {
                combinedScore = speedScore * 0.75 + entry.qualityScore * 0.25;
            } else if (objective === 'quality') {
                combinedScore = entry.qualityScore * 0.8 + speedScore * 0.2;
            } else {
                combinedScore = entry.qualityScore * 0.5 + speedScore * 0.5;
            }

            return {
                ...entry,
                speedScore,
                combinedScore
            };
        });

        return weighted.sort((left, right) => {
            if (right.combinedScore !== left.combinedScore) {
                return right.combinedScore - left.combinedScore;
            }
            if (right.qualityScore !== left.qualityScore) {
                return right.qualityScore - left.qualityScore;
            }
            return left.model_identifier.localeCompare(right.model_identifier);
        });
    }

    synthesizePolicyRoutes(calibrationResult) {
        const successfulModels = calibrationResult.models.filter(
            (entry) => entry.status === 'success'
        );

        if (successfulModels.length === 0) {
            throw new Error('Cannot synthesize policy: no successful model calibration results found.');
        }

        const tasks = Object.keys(calibrationResult.suite?.task_breakdown || {});
        const taskList = tasks.length > 0 ? tasks : [DEFAULT_CALIBRATION_TASK];
        const routing = {};

        taskList.forEach((task) => {
            const ranked = this.computeTaskCandidates({
                task,
                successfulModels,
                objective: calibrationResult.objective
            });

            const minimumQuality = 50;
            const eligible = ranked.filter((entry) => entry.qualityScore >= minimumQuality);
            const selected = eligible.length > 0 ? eligible : ranked;

            const primary = selected[0];
            const fallbacks = selected.slice(1).map((entry) => entry.model_identifier);

            routing[task] = {
                primary: primary.model_identifier,
                fallbacks,
                min_quality: minimumQuality,
                rationale: `objective=${calibrationResult.objective}; combined=${primary.combinedScore.toFixed(
                    2
                )}; quality=${primary.qualityScore.toFixed(2)}; speed=${primary.speedScore.toFixed(2)}`
            };
        });

        return routing;
    }

    buildDraftCalibrationPolicy({ calibrationResult, calibrationResultPath }) {
        const modelIdentifiers = calibrationResult.models.map((entry) => entry.model_identifier);
        if (modelIdentifiers.length === 0) {
            throw new Error('Calibration policy generation requires at least one model result.');
        }

        let routing;
        if (
            calibrationResult.execution_mode === 'full' &&
            calibrationResult.models.some((entry) => entry.status === 'success')
        ) {
            routing = this.synthesizePolicyRoutes(calibrationResult);
        } else {
            const tasks = Object.keys(calibrationResult.suite?.task_breakdown || {});
            const taskRoutes = tasks.length > 0 ? tasks : [DEFAULT_CALIBRATION_TASK];
            routing = {};
            taskRoutes.forEach((taskName) => {
                routing[taskName] = {
                    primary: modelIdentifiers[0],
                    fallbacks: modelIdentifiers.slice(1),
                    rationale: 'Draft routing generated from calibration contract output.'
                };
            });
        }

        const policy = {
            schema_version: '1.0',
            generated_at: new Date().toISOString(),
            objective: calibrationResult.objective,
            source: {
                calibration_version: calibrationResult.calibration_version,
                calibration_result_path: calibrationResultPath || undefined
            },
            routing,
            metadata: {
                runtime: calibrationResult.runtime,
                hardware_fingerprint: calibrationResult.hardware?.fingerprint || undefined
            }
        };

        return this.validateCalibrationPolicy(policy);
    }

    validateCalibrationResult(payload) {
        try {
            return calibrationResultSchema.parse(payload);
        } catch (error) {
            throw new Error(`Invalid calibration result payload: ${formatZodIssues(error)}`);
        }
    }

    validateCalibrationPolicy(payload) {
        try {
            return calibrationPolicySchema.parse(payload);
        } catch (error) {
            throw new Error(`Invalid calibration policy payload: ${formatZodIssues(error)}`);
        }
    }

    writeArtifact(filePath, payload, options = {}) {
        const cwd = options.cwd || process.cwd();
        const resolvedPath = this.resolvePath(filePath, cwd);

        if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
            throw new Error(`Output path must be a file, received directory: ${resolvedPath}`);
        }

        const serialized = isYamlPath(resolvedPath)
            ? `${YAML.stringify(payload)}`
            : `${JSON.stringify(payload, null, 2)}\n`;

        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
        fs.writeFileSync(resolvedPath, serialized, 'utf8');
        return resolvedPath;
    }
}

module.exports = {
    CalibrationManager
};
