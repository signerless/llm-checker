/**
 * Roadmap helper tests for issue #48 commands:
 * - gpu-plan
 * - verify-context
 * - amd-guard
 * - toolcheck
 */

const {
    buildAmdGuard,
    buildContextVerification,
    buildGpuPlan,
    evaluateToolCallingResult,
    extractContextWindow,
    parseModelSizeGB
} = require('../src/commands/roadmap-tools');

class RoadmapToolsTestSuite {
    constructor() {
        this.passed = 0;
        this.failed = 0;
    }

    log(msg) {
        console.log(msg);
    }

    assert(condition, title) {
        if (condition) {
            this.passed += 1;
            this.log(`  PASS: ${title}`);
            return;
        }
        this.failed += 1;
        this.log(`  FAIL: ${title}`);
    }

    testParseModelSize() {
        this.log('\n--- parseModelSizeGB ---');
        this.assert(Math.abs(parseModelSizeGB('14') - 7.7) < 1e-9, '14B converts to Q4-ish GB');
        this.assert(parseModelSizeGB('24GB') === 24, 'GB input stays in GB');
        this.assert(parseModelSizeGB(12) === 12, 'numeric input preserved');
        this.assert(parseModelSizeGB('nope') === null, 'invalid input returns null');
    }

    testGpuPlan() {
        this.log('\n--- buildGpuPlan ---');
        const hardware = {
            summary: { bestBackend: 'cuda', effectiveMemory: 48 },
            backends: {
                cuda: {
                    available: true,
                    info: {
                        gpus: [
                            { name: 'NVIDIA RTX 3090', memory: { total: 24 }, speedCoefficient: 200 },
                            { name: 'NVIDIA RTX 3090', memory: { total: 24 }, speedCoefficient: 200 }
                        ]
                    }
                }
            }
        };

        const plan = buildGpuPlan(hardware, { modelSizeGB: 20 });
        this.assert(plan.gpuCount === 2, 'multi-gpu count detected');
        this.assert(plan.strategy === 'distributed', 'multi-gpu strategy is distributed');
        this.assert(plan.fit.fitsPooled === true, '20GB target fits pooled envelope');
        this.assert(plan.env.OLLAMA_SCHED_SPREAD === '1', 'spread scheduling enabled for multi-gpu');
    }

    testContextVerification() {
        this.log('\n--- buildContextVerification / extractContextWindow ---');
        const showPayload = {
            model_info: {
                'llama.context_length': 32768
            }
        };
        const declared = extractContextWindow(showPayload);
        this.assert(declared === 32768, 'extracts declared context window');

        const verification = buildContextVerification({
            modelName: 'qwen2.5:14b',
            targetTokens: 8192,
            declaredContext: declared,
            modelSizeGB: 9.2,
            hardware: {
                summary: {
                    effectiveMemory: 32,
                    systemRAM: 32
                }
            }
        });

        this.assert(verification.status !== 'fail', 'reasonable target should not fail');
        this.assert(verification.recommendedContext > 0, 'recommended context generated');
    }

    testAmdGuard() {
        this.log('\n--- buildAmdGuard ---');
        const report = buildAmdGuard({
            platform: 'linux',
            rocmAvailable: false,
            rocmDetectionMethod: 'lspci',
            hardware: {
                summary: { bestBackend: 'cpu' },
                backends: {}
            }
        });

        this.assert(report.status === 'warn', 'fallback-only AMD detection produces warning');
        this.assert(report.recommendations.some((item) => item.includes('ROCm')), 'ROCm recommendation included');
    }

    testToolcheckEvaluation() {
        this.log('\n--- evaluateToolCallingResult ---');
        const supported = evaluateToolCallingResult({
            message: {
                tool_calls: [{ function: { name: 'add_numbers' } }]
            }
        });
        const partial = evaluateToolCallingResult({
            message: {
                content: 'The result is 5.'
            }
        });
        const unsupported = evaluateToolCallingResult(null, new Error('timeout'));

        this.assert(supported.status === 'supported', 'structured tool_calls detected as supported');
        this.assert(partial.status === 'partial', 'text-only answer detected as partial');
        this.assert(unsupported.status === 'unsupported', 'errors detected as unsupported');
    }

    run() {
        this.log('====================================');
        this.log('ROADMAP TOOLS TEST SUITE (#48)');
        this.log('====================================');

        this.testParseModelSize();
        this.testGpuPlan();
        this.testContextVerification();
        this.testAmdGuard();
        this.testToolcheckEvaluation();

        this.log('\n====================================');
        this.log(`Passed: ${this.passed}`);
        this.log(`Failed: ${this.failed}`);
        this.log('====================================');
        return this.failed === 0;
    }
}

const suite = new RoadmapToolsTestSuite();
process.exit(suite.run() ? 0 : 1);
