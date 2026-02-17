const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CalibrationManager } = require('../src/calibration/calibration-manager');

function writeJsonl(filePath, entries) {
    const content = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
}

function buildSuite() {
    return {
        entries: [
            {
                id: 'prompt-1',
                task: 'coding',
                prompt: 'Prompt 1',
                checks: [{ type: 'contains', expected: 'function', weight: 1 }]
            },
            {
                id: 'prompt-2',
                task: 'general',
                prompt: 'Prompt 2',
                checks: [{ type: 'regex', expected: 'blue', weight: 1 }]
            }
        ],
        metadata: {
            path: '/tmp/calibration-suite.jsonl',
            total_prompts: 2,
            task_breakdown: {
                coding: 1,
                general: 1
            }
        }
    };
}

function createScriptedExecutor(script) {
    const callCounts = new Map();

    return ({ modelIdentifier, prompt }) => {
        const key = `${modelIdentifier}::${prompt}`;
        const callIndex = callCounts.get(key) || 0;
        callCounts.set(key, callIndex + 1);

        const sequence = script[key];
        const frame = sequence && sequence[callIndex];
        if (!frame) {
            throw new Error(`No scripted runtime frame for ${key} at call ${callIndex}.`);
        }

        if (frame.error) {
            const error = new Error(frame.error.message);
            if (frame.error.code) {
                error.code = frame.error.code;
            }
            throw error;
        }

        return {
            output: frame.output,
            latencyMs: frame.latencyMs,
            ttftMs: frame.ttftMs
        };
    };
}

function runPromptSuiteParsingTests() {
    const manager = new CalibrationManager();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-cal-suite-'));

    try {
        const suitePath = path.join(tempDir, 'suite.jsonl');
        writeJsonl(suitePath, [
            {
                prompt: 'Hello world'
            },
            {
                id: 'custom-id',
                task: 'coding',
                prompt: 'Write a loop',
                checks: [{ type: 'contains', expected: 'for' }]
            }
        ]);

        const parsed = manager.parsePromptSuite(suitePath);
        assert.strictEqual(parsed.entries.length, 2);
        assert.strictEqual(parsed.entries[0].id, 'prompt-1');
        assert.strictEqual(parsed.entries[0].task, 'general');
        assert.strictEqual(parsed.entries[1].id, 'custom-id');
        assert.strictEqual(parsed.entries[1].task, 'coding');
        assert.strictEqual(parsed.metadata.total_prompts, 2);
        assert.strictEqual(parsed.metadata.task_breakdown.general, 1);
        assert.strictEqual(parsed.metadata.task_breakdown.coding, 1);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function runRegexCheckErrorTests() {
    const manager = new CalibrationManager();
    const evaluation = manager.evaluatePromptChecks('abc', [
        { type: 'regex', expected: '[', weight: 1 }
    ]);

    assert.strictEqual(evaluation.passRate, 0);
    assert.strictEqual(evaluation.checkResults.length, 1);
    assert.strictEqual(evaluation.checkResults[0].passed, false);
    assert.ok(
        String(evaluation.checkResults[0].error || '').toLowerCase().includes('regular expression')
    );
}

function runFullCalibrationAggregationTests() {
    const suite = buildSuite();
    const manager = new CalibrationManager({
        promptExecutor: createScriptedExecutor({
            'model-alpha::Prompt 1': [
                { output: 'warmup function', latencyMs: 100, ttftMs: 30 },
                { output: 'function binary search', latencyMs: 120, ttftMs: 40 },
                { output: 'function returns index', latencyMs: 180, ttftMs: 60 }
            ],
            'model-alpha::Prompt 2': [
                { output: 'warmup sky is blue', latencyMs: 80, ttftMs: 35 },
                { output: 'the sky is blue', latencyMs: 160, ttftMs: 50 },
                { output: 'because molecules scatter blue light', latencyMs: 200, ttftMs: 70 }
            ]
        })
    });

    const result = manager.runFullCalibration({
        models: ['model-alpha'],
        suite,
        runtime: 'ollama',
        objective: 'balanced',
        benchmarkConfig: {
            warmupRuns: 1,
            measuredIterations: 2,
            timeoutMs: 60000
        }
    });

    assert.strictEqual(result.execution_mode, 'full');
    assert.strictEqual(result.summary.total_models, 1);
    assert.strictEqual(result.summary.successful_models, 1);
    assert.strictEqual(result.summary.failed_models, 0);

    const model = result.models[0];
    assert.strictEqual(model.status, 'success');
    assert.strictEqual(model.metrics.latency_ms_p50, 160);
    assert.strictEqual(model.metrics.latency_ms_p95, 200);
    assert.strictEqual(model.metrics.ttft_ms, 50);
    assert.ok(model.metrics.tokens_per_second > 20);
    assert.ok(model.metrics.tokens_per_second < 25);
    assert.strictEqual(model.quality.overall_score, 100);
    assert.strictEqual(model.quality.task_scores.coding, 100);
    assert.strictEqual(model.quality.task_scores.general, 100);
    assert.strictEqual(model.quality.check_pass_rate, 1);
    assert.strictEqual(model.traces.warmup_runs, 1);
    assert.strictEqual(model.traces.measured_iterations, 2);
    assert.strictEqual(model.traces.prompt_runs.length, 2);
}

function runFailureIsolationTests() {
    const suite = {
        entries: [
            {
                id: 'prompt-1',
                task: 'general',
                prompt: 'Single prompt',
                checks: [{ type: 'contains', expected: 'ok', weight: 1 }]
            }
        ],
        metadata: {
            path: '/tmp/suite.jsonl',
            total_prompts: 1,
            task_breakdown: { general: 1 }
        }
    };

    const manager = new CalibrationManager({
        promptExecutor: createScriptedExecutor({
            'model-ok::Single prompt': [
                { output: 'warmup ok', latencyMs: 50, ttftMs: 20 },
                { output: 'all ok', latencyMs: 90, ttftMs: 30 }
            ],
            'model-fail::Single prompt': [
                { error: { message: 'operation timed out after 30s', code: 'ETIMEDOUT' } }
            ]
        })
    });

    const result = manager.runFullCalibration({
        models: ['model-ok', 'model-fail'],
        suite,
        runtime: 'ollama',
        objective: 'speed',
        benchmarkConfig: {
            warmupRuns: 1,
            measuredIterations: 1,
            timeoutMs: 30000
        }
    });

    assert.strictEqual(result.summary.total_models, 2);
    assert.strictEqual(result.summary.successful_models, 1);
    assert.strictEqual(result.summary.failed_models, 1);

    const okModel = result.models.find((entry) => entry.model_identifier === 'model-ok');
    const failedModel = result.models.find((entry) => entry.model_identifier === 'model-fail');

    assert.strictEqual(okModel.status, 'success');
    assert.strictEqual(failedModel.status, 'failed');
    assert.ok(failedModel.error.includes('timed out'));
    assert.strictEqual(failedModel.traces.error_code, 'ETIMEDOUT');
}

function runPolicySynthesisTests() {
    const manager = new CalibrationManager();
    const calibrationResult = {
        schema_version: '1.0',
        generated_at: new Date().toISOString(),
        calibration_version: 'full-2026-02-17',
        execution_mode: 'full',
        runtime: 'ollama',
        objective: 'speed',
        hardware: {
            fingerprint: 'darwin-arm64-24gb',
            description: 'Apple M4 Pro | 24GB RAM'
        },
        suite: {
            path: '/tmp/prompts.jsonl',
            total_prompts: 2,
            task_breakdown: {
                coding: 1,
                general: 1
            }
        },
        models: [
            {
                model_identifier: 'model-fast-low',
                status: 'success',
                metrics: {
                    ttft_ms: 20,
                    tokens_per_second: 120,
                    latency_ms_p50: 80,
                    latency_ms_p95: 100,
                    peak_memory_mb: 3200
                },
                quality: {
                    overall_score: 45,
                    task_scores: { coding: 45, general: 45 },
                    check_pass_rate: 0.45
                }
            },
            {
                model_identifier: 'model-a',
                status: 'success',
                metrics: {
                    ttft_ms: 25,
                    tokens_per_second: 90,
                    latency_ms_p50: 90,
                    latency_ms_p95: 120,
                    peak_memory_mb: 3600
                },
                quality: {
                    overall_score: 85,
                    task_scores: { coding: 85, general: 85 },
                    check_pass_rate: 0.85
                }
            },
            {
                model_identifier: 'model-b',
                status: 'success',
                metrics: {
                    ttft_ms: 25,
                    tokens_per_second: 90,
                    latency_ms_p50: 90,
                    latency_ms_p95: 120,
                    peak_memory_mb: 3600
                },
                quality: {
                    overall_score: 85,
                    task_scores: { coding: 85, general: 85 },
                    check_pass_rate: 0.85
                }
            },
            {
                model_identifier: 'model-c',
                status: 'success',
                metrics: {
                    ttft_ms: 35,
                    tokens_per_second: 70,
                    latency_ms_p50: 130,
                    latency_ms_p95: 170,
                    peak_memory_mb: 4200
                },
                quality: {
                    overall_score: 92,
                    task_scores: { coding: 92, general: 92 },
                    check_pass_rate: 0.92
                }
            }
        ],
        summary: {
            total_models: 4,
            successful_models: 4,
            failed_models: 0,
            skipped_models: 0,
            pending_models: 0
        }
    };

    const policyA = manager.buildDraftCalibrationPolicy({
        calibrationResult,
        calibrationResultPath: '/tmp/calibration-result.json'
    });
    const policyB = manager.buildDraftCalibrationPolicy({
        calibrationResult,
        calibrationResultPath: '/tmp/calibration-result.json'
    });

    assert.deepStrictEqual(policyA.routing, policyB.routing);

    ['coding', 'general'].forEach((task) => {
        const route = policyA.routing[task];
        assert.strictEqual(route.primary, 'model-a');
        assert.deepStrictEqual(route.fallbacks, ['model-b', 'model-c']);
        assert.strictEqual(route.min_quality, 50);
        assert.ok(route.rationale.includes('objective=speed'));
        assert.ok(!route.fallbacks.includes('model-fast-low'));
    });
}

function run() {
    runPromptSuiteParsingTests();
    runRegexCheckErrorTests();
    runFullCalibrationAggregationTests();
    runFailureIsolationTests();
    runPolicySynthesisTests();
    console.log('calibration-full-mode.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('calibration-full-mode.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
