const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const PolicyEngine = require('../src/policy/policy-engine');
const {
    collectCandidatesFromAnalysis,
    collectCandidatesFromRecommendationData,
    buildPolicyRuntimeContext,
    evaluatePolicyCandidates,
    resolvePolicyEnforcement
} = require('../src/policy/cli-policy');

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'enhanced_cli.js');

function runCli(args) {
    return spawnSync(process.execPath, [BIN_PATH, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            NO_COLOR: '1'
        }
    });
}

function stripAnsi(text = '') {
    return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function runAnalysisCandidateCollectionTests() {
    const analysis = {
        compatible: [
            { model_identifier: 'qwen2.5-coder:7b-instruct-q4_k_m', name: 'Qwen Coding 7B' }
        ],
        marginal: [
            { model_identifier: 'llama3.2:3b-instruct-q4_k_m', name: 'Llama 3.2 3B' }
        ],
        incompatible: [
            { model_identifier: 'mistral:22b-instruct-q4_k_m', name: 'Should be ignored for check policy evaluation' }
        ]
    };

    const candidates = collectCandidatesFromAnalysis(analysis);
    assert.strictEqual(candidates.length, 2, 'analysis candidates should include only compatible and marginal models');
    assert.ok(
        candidates.some((model) => model.model_identifier === 'qwen2.5-coder:7b-instruct-q4_k_m'),
        'should include compatible model'
    );
    assert.ok(
        candidates.some((model) => model.model_identifier === 'llama3.2:3b-instruct-q4_k_m'),
        'should include marginal model'
    );
    assert.ok(
        !candidates.some((model) => model.model_identifier === 'mistral:22b-instruct-q4_k_m'),
        'should exclude incompatible models from check policy evaluation'
    );
}

function runRecommendationCandidateCollectionTests() {
    const recommendationData = {
        summary: {
            by_category: {
                coding: {
                    name: 'Qwen Coder',
                    identifier: 'qwen2.5-coder:14b-instruct-q4_k_m',
                    size: '14B'
                },
                general: {
                    name: 'Llama',
                    identifier: 'llama3.2:3b',
                    size: '3B'
                }
            },
            best_overall: {
                name: 'Qwen Coder',
                identifier: 'qwen2.5-coder:14b-instruct-q4_k_m'
            }
        }
    };

    const candidates = collectCandidatesFromRecommendationData(recommendationData);
    assert.strictEqual(candidates.length, 2, 'recommendation candidates should be deduplicated');

    const codingCandidate = candidates.find((item) =>
        item.model_identifier.includes('qwen2.5-coder:14b-instruct-q4_k_m')
    );
    assert.ok(codingCandidate, 'coding candidate should be present');
    assert.strictEqual(codingCandidate.params_b, 14, 'params should be parsed from identifier');
    assert.strictEqual(codingCandidate.quant, 'Q4_K_M', 'quantization should be parsed from identifier');
}

function runEnforcementResolutionTests() {
    const candidates = [
        { model_identifier: 'qwen2.5-coder:7b-instruct-q4_k_m' },
        { model_identifier: 'llama3.2:3b-instruct-q4_k_m' }
    ];

    const enforcePolicy = {
        mode: 'enforce',
        rules: {
            models: {
                allow: ['qwen2.5-coder:*']
            }
        },
        enforcement: {
            exit_code: 7
        }
    };

    const enforceEngine = new PolicyEngine(enforcePolicy);
    const enforceEvaluation = evaluatePolicyCandidates(enforceEngine, candidates, {});
    const enforceResolution = resolvePolicyEnforcement(enforcePolicy, enforceEvaluation);

    assert.strictEqual(enforceEvaluation.totalChecked, 2);
    assert.strictEqual(enforceEvaluation.passCount, 1);
    assert.strictEqual(enforceEvaluation.failCount, 1);
    assert.ok(
        enforceEvaluation.topViolations.some((entry) => entry.code === 'MODEL_NOT_ALLOWED'),
        'should expose top violation codes'
    );
    assert.strictEqual(enforceResolution.shouldBlock, true, 'enforce mode should block on violations');
    assert.strictEqual(enforceResolution.exitCode, 7, 'configured exit code should be applied');

    const auditPolicy = {
        ...enforcePolicy,
        mode: 'audit'
    };
    const auditResolution = resolvePolicyEnforcement(auditPolicy, enforceEvaluation);
    assert.strictEqual(auditResolution.shouldBlock, false, 'audit mode should never block');
    assert.strictEqual(auditResolution.exitCode, 0, 'audit mode should exit 0');

    const warnPolicy = {
        ...enforcePolicy,
        enforcement: {
            on_violation: 'warn',
            exit_code: 9
        }
    };
    const warnResolution = resolvePolicyEnforcement(warnPolicy, enforceEvaluation);
    assert.strictEqual(warnResolution.shouldBlock, false, 'warn behavior should not block');
    assert.strictEqual(warnResolution.exitCode, 0, 'warn behavior should exit 0');
}

function runContextBuilderTests() {
    const hardware = {
        summary: {
            bestBackend: 'metal',
            systemRAM: 32
        },
        memory: {
            total: 32
        }
    };

    const context = buildPolicyRuntimeContext({
        hardware,
        runtimeBackend: 'ollama'
    });

    assert.strictEqual(context.backend, 'metal');
    assert.strictEqual(context.runtimeBackend, 'ollama');
    assert.strictEqual(context.ramGB, 32);
    assert.strictEqual(context.totalRamGB, 32);
}

function runHelpExamplesTests() {
    const checkHelp = runCli(['check', '--help']);
    assert.strictEqual(checkHelp.status, 0, stripAnsi(checkHelp.stderr || checkHelp.stdout));
    const checkOutput = stripAnsi(`${checkHelp.stdout}\n${checkHelp.stderr}`);
    assert.ok(
        checkOutput.includes('Enterprise policy examples'),
        'check help should include enterprise policy examples section'
    );
    assert.ok(
        (checkOutput.match(/--policy/g) || []).length >= 3,
        'check help should include three policy examples'
    );

    const recommendHelp = runCli(['recommend', '--help']);
    assert.strictEqual(
        recommendHelp.status,
        0,
        stripAnsi(recommendHelp.stderr || recommendHelp.stdout)
    );
    const recommendOutput = stripAnsi(`${recommendHelp.stdout}\n${recommendHelp.stderr}`);
    assert.ok(
        recommendOutput.includes('Enterprise policy examples'),
        'recommend help should include enterprise policy examples section'
    );
    assert.ok(
        (recommendOutput.match(/--policy/g) || []).length >= 3,
        'recommend help should include three policy examples'
    );
}

function runAll() {
    runAnalysisCandidateCollectionTests();
    runRecommendationCandidateCollectionTests();
    runEnforcementResolutionTests();
    runContextBuilderTests();
    runHelpExamplesTests();
    console.log('policy-cli-enforcement.js: OK');
}

if (require.main === module) {
    try {
        runAll();
    } catch (error) {
        console.error('policy-cli-enforcement.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { runAll };
