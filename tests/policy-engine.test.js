const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PolicyEngine = require('../src/policy/policy-engine');
const PolicyManager = require('../src/policy/policy-manager');
const IntelligentSelector = require('../src/models/intelligent-selector');

function createModel(overrides = {}) {
    return {
        model_id: 'qwen2.5-coder',
        tag: 'qwen2.5-coder:7b-instruct-q4_k_m',
        params_b: 7,
        quant: 'Q4_K_M',
        size_gb: 4.2,
        license: 'mit',
        type: 'local',
        ...overrides
    };
}

class StubDetector {
    constructor(hardware = null) {
        this.hardware = hardware || {
            summary: {
                bestBackend: 'metal',
                effectiveMemory: 48,
                systemRAM: 64,
                totalVRAM: 24,
                gpuCount: 1,
                isMultiGPU: false,
                speedCoefficient: 50,
                gpuModel: 'Apple M4 Max'
            }
        };
    }

    async detect() {
        return this.hardware;
    }

    getHardwareDescription() {
        return 'Stub Hardware';
    }

    getHardwareTier() {
        return 'stub_tier';
    }

    getMaxModelSize() {
        return 48;
    }
}

function runAllowDenyTests() {
    const model = createModel();

    const engine = new PolicyEngine({
        mode: 'enforce',
        rules: {
            models: {
                allow: ['qwen2.5-coder:*'],
                deny: ['*uncensored*']
            }
        }
    });

    const pass = engine.evaluateModel(model);
    assert.strictEqual(pass.pass, true);
    assert.strictEqual(pass.violationCount, 0);

    const denied = engine.evaluateModel(createModel({
        tag: 'qwen2.5-coder:7b-uncensored-q4_k_m'
    }));
    assert.strictEqual(denied.pass, false);
    assert.ok(denied.violations.some((violation) => violation.code === 'MODEL_DENIED'));

    const notAllowed = new PolicyEngine({
        mode: 'enforce',
        rules: {
            models: {
                allow: ['llama3:*']
            }
        }
    }).evaluateModel(model);
    assert.strictEqual(notAllowed.pass, false);
    assert.ok(notAllowed.violations.some((violation) => violation.code === 'MODEL_NOT_ALLOWED'));
}

function runModelConstraintTests() {
    const engine = new PolicyEngine({
        mode: 'enforce',
        rules: {
            models: {
                max_size_gb: 4,
                max_params_b: 6,
                allowed_quantizations: ['Q5_K_M']
            }
        }
    });

    const result = engine.evaluateModel(createModel());
    const codes = result.violations.map((violation) => violation.code);

    assert.strictEqual(result.pass, false);
    assert.ok(codes.includes('MODEL_TOO_LARGE'));
    assert.ok(codes.includes('MODEL_TOO_MANY_PARAMS'));
    assert.ok(codes.includes('QUANTIZATION_NOT_ALLOWED'));
}

function runRuntimeAndComplianceTests() {
    const policy = {
        mode: 'enforce',
        rules: {
            runtime: {
                required_backends: ['metal', 'cuda'],
                min_ram_gb: 32,
                local_only: true
            },
            compliance: {
                approved_licenses: ['apache-2.0']
            }
        }
    };

    const engine = new PolicyEngine(policy);
    const result = engine.evaluateModel(createModel(), {
        backend: 'cpu',
        ramGB: 16,
        isLocal: false
    });

    const codes = result.violations.map((violation) => violation.code);
    assert.ok(codes.includes('BACKEND_NOT_ALLOWED'));
    assert.ok(codes.includes('INSUFFICIENT_RAM'));
    assert.ok(codes.includes('MODEL_NOT_LOCAL'));
    assert.ok(codes.includes('LICENSE_NOT_APPROVED'));

    const missingLicense = engine.evaluateModel(createModel({ license: undefined }), {
        backend: 'metal',
        ramGB: 64,
        isLocal: true
    });
    assert.ok(missingLicense.violations.some((violation) => violation.code === 'LICENSE_MISSING'));

    const normalizedEngine = new PolicyEngine({
        mode: 'enforce',
        rules: {
            compliance: {
                approved_licenses: ['MIT License', 'Apache 2.0']
            }
        }
    });

    const normalizedLicense = normalizedEngine.evaluateModel(
        createModel({ license: 'mit' }),
        {
            backend: 'metal',
            ramGB: 64,
            isLocal: true
        }
    );

    assert.strictEqual(
        normalizedLicense.pass,
        true,
        'license aliases should normalize to canonical values for policy evaluation'
    );
}

function runDeterministicAndAttachmentTests() {
    const model = createModel();
    const policy = {
        mode: 'audit',
        rules: {
            models: {
                max_params_b: 6
            }
        }
    };

    const engine = new PolicyEngine(policy);
    const context = { backend: 'metal', ramGB: 64 };

    const first = engine.evaluateModel(model, context);
    const second = engine.evaluateModel(model, context);
    assert.deepStrictEqual(second, first);

    const scoredVariants = [
        {
            variant: model,
            score: {
                final: 90,
                components: {
                    quality: 90,
                    speed: 80,
                    fit: 85,
                    context: 75
                }
            }
        }
    ];

    const evaluated = engine.evaluateScoredVariants(scoredVariants, context);
    assert.strictEqual(evaluated.length, 1);
    assert.ok(evaluated[0].policyResult);
    assert.ok(evaluated[0].variant.policyResult);
    assert.deepStrictEqual(evaluated[0].policyResult, evaluated[0].variant.policyResult);
    assert.strictEqual(evaluated[0].policyResult.pass, false);
}

async function runSelectorIntegrationTest() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-policy-engine-'));

    try {
        const policyPath = path.join(tempDir, 'policy.yaml');
        const policyManager = new PolicyManager();
        fs.writeFileSync(policyPath, policyManager.getTemplate(), 'utf8');

        const selector = new IntelligentSelector({ detector: new StubDetector() });
        const result = await selector.recommend([createModel()], {
            useCase: 'general',
            limit: 1,
            policyFile: policyPath
        });

        assert.strictEqual(result.policy.mode, 'enforce');
        assert.strictEqual(result.policy.active, true);
        assert.strictEqual(result.all.length, 1);
        assert.ok(result.all[0].policyResult);
        assert.ok(result.all[0].variant.policyResult);
        assert.deepStrictEqual(result.all[0].policyResult, result.all[0].variant.policyResult);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function runAll() {
    runAllowDenyTests();
    runModelConstraintTests();
    runRuntimeAndComplianceTests();
    runDeterministicAndAttachmentTests();
    await runSelectorIntegrationTest();
    console.log('policy-engine.test.js: OK');
}

if (require.main === module) {
    runAll().catch((error) => {
        console.error('policy-engine.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { runAll };
