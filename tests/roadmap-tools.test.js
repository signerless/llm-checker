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
        this.assert(plan.gpuCount === 2, 'two identical GPUs in one backend remain two devices');
        this.assert(plan.totalVRAM === 48, 'same-backend multi-GPU VRAM remains pooled');
        this.assert(plan.strategy === 'distributed', 'multi-gpu strategy is distributed');
        this.assert(plan.fit.fitsPooled === true, '20GB target fits pooled envelope');
        this.assert(plan.env.OLLAMA_SCHED_SPREAD === '1', 'spread scheduling enabled for multi-gpu');
    }

    testGpuPlanDeduplicatesCudaGenericAlias() {
        this.log('\n--- buildGpuPlan CUDA/generic deduplication ---');
        const hardware = {
            summary: { bestBackend: 'cuda', effectiveMemory: 24 },
            backends: {
                cuda: {
                    available: true,
                    info: {
                        gpus: [{
                            index: 0,
                            name: 'NVIDIA GeForce RTX 3090',
                            uuid: 'GPU-822c0482-9be5-example',
                            memory: { total: 24 },
                            speedCoefficient: 200
                        }]
                    }
                },
                generic: {
                    available: true,
                    info: {
                        gpus: [{
                            name: 'GA102 [GeForce RTX 3090]',
                            vendor: 'NVIDIA',
                            type: 'dedicated',
                            memory: { total: 24 }
                        }]
                    }
                }
            }
        };

        const plan = buildGpuPlan(hardware, { modelSizeGB: 16 });
        this.assert(plan.gpuCount === 1, 'CUDA and generic aliases collapse to one physical GPU');
        this.assert(plan.gpus[0]?.backend === 'cuda', 'specialized CUDA entry wins over generic fallback');
        this.assert(plan.totalVRAM === 24, 'duplicate generic VRAM is not pooled twice');
        this.assert(plan.singleMaxModelGB === 22, 'single-GPU safe envelope remains 22GB');
        this.assert(plan.pooledMaxModelGB === 22, 'pooled envelope remains 22GB for one GPU');
        this.assert(plan.strategy === 'single_gpu', 'deduplicated host uses single-GPU strategy');
        this.assert(plan.env.OLLAMA_SCHED_SPREAD === '0', 'spread scheduling stays disabled');
        this.assert(plan.env.OLLAMA_NUM_PARALLEL === '1', 'single-GPU parallel recommendation stays at one');
        this.assert(plan.env.OLLAMA_MAX_LOADED_MODELS === '1', 'single-GPU loaded-model limit stays at one');
    }

    testGpuPlanPreservesDistinctGenericIgpu() {
        this.log('\n--- buildGpuPlan distinct generic iGPU ---');
        const hardware = {
            summary: { bestBackend: 'cuda', effectiveMemory: 24 },
            backends: {
                generic: {
                    available: true,
                    info: {
                        gpus: [
                            {
                                name: 'GA102 [GeForce RTX 3090]',
                                vendor: 'NVIDIA',
                                type: 'dedicated',
                                memory: { total: 24 }
                            },
                            {
                                name: 'Intel Iris Xe Graphics',
                                vendor: 'Intel',
                                type: 'integrated',
                                memory: { total: 8 }
                            }
                        ]
                    }
                },
                cuda: {
                    available: true,
                    info: {
                        gpus: [{
                            name: 'NVIDIA GeForce RTX 3090',
                            memory: { total: 24 },
                            speedCoefficient: 200
                        }]
                    }
                }
            }
        };

        const plan = buildGpuPlan(hardware);
        this.assert(plan.gpuCount === 2, 'distinct generic iGPU remains visible beside CUDA GPU');
        this.assert(
            plan.gpus.filter((gpu) => gpu.name.includes('RTX 3090')).length === 1,
            'generic copy of CUDA GPU is still removed on a hybrid host'
        );
        this.assert(
            plan.gpus.some((gpu) => gpu.backend === 'generic' && gpu.name.includes('Iris Xe')),
            'distinct integrated GPU is preserved'
        );
    }

    testGpuPlanPreservesGenericOnlyInventory() {
        this.log('\n--- buildGpuPlan generic-only inventory ---');
        const hardware = {
            summary: { bestBackend: 'cpu', effectiveMemory: 32 },
            backends: {
                generic: {
                    available: true,
                    info: {
                        gpus: [{
                            name: 'AMD Radeon RX 7800 XT',
                            vendor: 'AMD',
                            type: 'dedicated',
                            memory: { total: 16 }
                        }]
                    }
                }
            }
        };

        const plan = buildGpuPlan(hardware);
        this.assert(plan.gpuCount === 1, 'generic-only GPU inventory is retained');
        this.assert(plan.gpus[0]?.backend === 'generic', 'generic-only entry keeps its backend label');
        this.assert(plan.totalVRAM === 16, 'generic-only VRAM remains available to the plan');
    }

    testGpuPlanDeduplicatesRocmGenericAlias() {
        this.log('\n--- buildGpuPlan ROCm/generic deduplication ---');
        const hardware = {
            summary: { bestBackend: 'rocm', effectiveMemory: 24 },
            backends: {
                rocm: {
                    available: true,
                    info: {
                        gpus: [{
                            name: 'AMD Radeon RX 7900 XTX',
                            memory: { total: 24 },
                            speedCoefficient: 180
                        }]
                    }
                },
                generic: {
                    available: true,
                    info: {
                        gpus: [{
                            name: 'Navi 31 [Radeon RX 7900 XTX]',
                            vendor: 'AMD',
                            type: 'dedicated',
                            memory: { total: 24 }
                        }]
                    }
                }
            }
        };

        const plan = buildGpuPlan(hardware);
        this.assert(plan.gpuCount === 1, 'ROCm and generic aliases collapse to one physical GPU');
        this.assert(plan.gpus[0]?.backend === 'rocm', 'specialized ROCm entry wins over generic fallback');
        this.assert(plan.totalVRAM === 24, 'ROCm VRAM is not double-counted');
        this.assert(plan.strategy === 'single_gpu', 'deduplicated ROCm host uses single-GPU strategy');
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
        this.testGpuPlanDeduplicatesCudaGenericAlias();
        this.testGpuPlanPreservesDistinctGenericIgpu();
        this.testGpuPlanPreservesGenericOnlyInventory();
        this.testGpuPlanDeduplicatesRocmGenericAlias();
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
