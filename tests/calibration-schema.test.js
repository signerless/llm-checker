const assert = require('assert');
const {
    promptSuiteEntrySchema,
    calibrationResultSchema,
    calibrationPolicySchema
} = require('../src/calibration/schemas');

function runPromptSuiteSchemaTests() {
    const valid = promptSuiteEntrySchema.parse({
        id: 'prompt-1',
        task: 'coding',
        prompt: 'Write a sorting function',
        checks: [{ type: 'contains', expected: 'function' }]
    });

    assert.strictEqual(valid.id, 'prompt-1');
    assert.strictEqual(valid.task, 'coding');
    assert.strictEqual(valid.checks.length, 1);

    assert.throws(() => {
        promptSuiteEntrySchema.parse({
            task: 'coding',
            checks: [{ type: 'contains', expected: 'function' }]
        });
    }, /Required/);
}

function runCalibrationResultSchemaTests() {
    const validPayload = {
        schema_version: '1.0',
        generated_at: new Date().toISOString(),
        calibration_version: 'contract-2026-02-17',
        execution_mode: 'contract-only',
        runtime: 'ollama',
        objective: 'balanced',
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
            { model_identifier: 'qwen2.5-coder:7b', status: 'pending' },
            { model_identifier: 'llama3.2:3b', status: 'pending' }
        ],
        summary: {
            total_models: 2,
            successful_models: 0,
            failed_models: 0,
            skipped_models: 0,
            pending_models: 2
        }
    };

    const parsed = calibrationResultSchema.parse(validPayload);
    assert.strictEqual(parsed.summary.pending_models, 2);

    const invalidPayload = {
        ...validPayload,
        summary: {
            total_models: 2,
            successful_models: 1,
            failed_models: 0,
            skipped_models: 0,
            pending_models: 2
        }
    };

    assert.throws(() => {
        calibrationResultSchema.parse(invalidPayload);
    }, /total_models must equal/);
}

function runCalibrationPolicySchemaTests() {
    const validPolicy = {
        schema_version: '1.0',
        generated_at: new Date().toISOString(),
        objective: 'balanced',
        source: {
            calibration_version: 'contract-2026-02-17',
            calibration_result_path: '/tmp/calibration.json'
        },
        routing: {
            coding: {
                primary: 'qwen2.5-coder:7b',
                fallbacks: ['llama3.2:3b']
            }
        },
        metadata: {
            runtime: 'ollama',
            hardware_fingerprint: 'darwin-arm64-24gb'
        }
    };

    const parsed = calibrationPolicySchema.parse(validPolicy);
    assert.strictEqual(parsed.routing.coding.primary, 'qwen2.5-coder:7b');

    const invalidPolicy = {
        ...validPolicy,
        routing: {
            coding: {
                fallbacks: ['llama3.2:3b']
            }
        }
    };

    assert.throws(() => {
        calibrationPolicySchema.parse(invalidPolicy);
    }, /primary/);
}

function run() {
    runPromptSuiteSchemaTests();
    runCalibrationResultSchemaTests();
    runCalibrationPolicySchemaTests();
    console.log('calibration-schema.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('calibration-schema.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
