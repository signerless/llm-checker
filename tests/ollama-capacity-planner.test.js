const assert = require('assert');
const OllamaCapacityPlanner = require('../src/ollama/capacity-planner');

function createHardware(overrides = {}) {
    const summaryOverrides = overrides.summary || {};
    const memoryOverrides = overrides.memory || {};

    return {
        summary: {
            bestBackend: 'cuda',
            backendName: 'NVIDIA CUDA',
            effectiveMemory: 24,
            totalVRAM: 24,
            systemRAM: 32,
            ...summaryOverrides
        },
        memory: {
            total: 32,
            ...memoryOverrides
        }
    };
}

function runConstraintReductionTest() {
    const planner = new OllamaCapacityPlanner();
    const hardware = createHardware();

    const plan = planner.plan({
        hardware,
        models: [
            { name: 'llama3.1:8b', size: '8B', fileSizeGB: 4.7 },
            { name: 'qwen2.5:7b', size: '7B', fileSizeGB: 4.4 }
        ],
        targetContext: 32768,
        targetConcurrency: 4,
        objective: 'throughput'
    });

    assert.strictEqual(plan.objective, 'throughput');
    assert.ok(plan.recommendation.num_ctx <= 32768, 'recommended context should not exceed requested context');
    assert.ok(plan.recommendation.num_parallel <= 4, 'recommended parallelism should not exceed requested value');
    assert.ok(
        plan.memory.recommendedEstimatedGB <= plan.memory.budgetGB + 0.2,
        'recommended memory should fit the budget'
    );
}

function runObjectiveNormalizationTest() {
    const planner = new OllamaCapacityPlanner();
    const hardware = createHardware();

    const plan = planner.plan({
        hardware,
        models: [{ name: 'llama3.2:3b', size: '3B', fileSizeGB: 2.1 }],
        objective: 'invalid-objective'
    });

    assert.strictEqual(plan.objective, 'balanced');
}

function runEmptyModelValidationTest() {
    const planner = new OllamaCapacityPlanner();
    const hardware = createHardware();

    assert.throws(
        () => planner.plan({ hardware, models: [] }),
        /At least one model is required/
    );
}

function runSizeInferenceTest() {
    const planner = new OllamaCapacityPlanner();
    const hardware = createHardware();

    const plan = planner.plan({
        hardware,
        models: [{ name: 'deepseek-r1:14b', size: '14B' }],
        objective: 'latency'
    });

    assert.ok(plan.models[0].paramsB >= 13.5 && plan.models[0].paramsB <= 14.5);
}

function runRiskEscalationTest() {
    const planner = new OllamaCapacityPlanner();
    const hardware = createHardware({
        summary: {
            effectiveMemory: 8,
            totalVRAM: 8,
            systemRAM: 16
        },
        memory: {
            total: 16
        }
    });

    const plan = planner.plan({
        hardware,
        models: [{ name: 'llama3.1:13b', size: '13B', fileSizeGB: 8.5 }],
        targetContext: 32768,
        targetConcurrency: 8,
        objective: 'throughput'
    });

    assert.ok(
        ['medium', 'high', 'critical'].includes(plan.risk.level),
        'aggressive settings on low memory should produce elevated risk'
    );
}

function runAll() {
    runConstraintReductionTest();
    runObjectiveNormalizationTest();
    runEmptyModelValidationTest();
    runSizeInferenceTest();
    runRiskEscalationTest();
    console.log('ollama-capacity-planner.test.js: OK');
}

if (require.main === module) {
    try {
        runAll();
    } catch (error) {
        console.error('ollama-capacity-planner.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { runAll };
