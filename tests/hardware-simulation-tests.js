/**
 * Hardware Simulation Tests
 * Tests the scoring engine with different simulated hardware profiles
 * to validate that speed/scoring calculations make sense.
 */

const ScoringEngine = require('../src/models/scoring-engine');

// Mock hardware profiles for different systems
const HARDWARE_PROFILES = {
    // NVIDIA Data Center (Extreme)
    h100: {
        summary: {
            bestBackend: 'cuda',
            gpuModel: 'NVIDIA H100 80GB',
            effectiveMemory: 80,
            systemRAM: 256,
            totalVRAM: 80
        },
        cpu: { capabilities: { avx512: true, avx2: true } }
    },

    a100: {
        summary: {
            bestBackend: 'cuda',
            gpuModel: 'NVIDIA A100 80GB',
            effectiveMemory: 80,
            systemRAM: 128,
            totalVRAM: 80
        },
        cpu: { capabilities: { avx512: true, avx2: true } }
    },

    // NVIDIA Consumer (High-End)
    rtx4090: {
        summary: {
            bestBackend: 'cuda',
            gpuModel: 'NVIDIA GeForce RTX 4090',
            effectiveMemory: 24,
            systemRAM: 64,
            totalVRAM: 24
        },
        cpu: { capabilities: { avx2: true } }
    },

    rtx3090: {
        summary: {
            bestBackend: 'cuda',
            gpuModel: 'NVIDIA GeForce RTX 3090',
            effectiveMemory: 24,
            systemRAM: 64,
            totalVRAM: 24
        },
        cpu: { capabilities: { avx2: true } }
    },

    rtx3060: {
        summary: {
            bestBackend: 'cuda',
            gpuModel: 'NVIDIA GeForce RTX 3060',
            effectiveMemory: 12,
            systemRAM: 32,
            totalVRAM: 12
        },
        cpu: { capabilities: { avx2: true } }
    },

    // Apple Silicon
    m4Pro: {
        summary: {
            bestBackend: 'metal',
            gpuModel: 'Apple M4 Pro',
            effectiveMemory: 24,
            systemRAM: 24,
            totalVRAM: 24
        },
        cpu: { capabilities: { neon: true } }
    },

    m4Max: {
        summary: {
            bestBackend: 'metal',
            gpuModel: 'Apple M4 Max',
            effectiveMemory: 48,
            systemRAM: 48,
            totalVRAM: 48
        },
        cpu: { capabilities: { neon: true } }
    },

    m1: {
        summary: {
            bestBackend: 'metal',
            gpuModel: 'Apple M1',
            effectiveMemory: 16,
            systemRAM: 16,
            totalVRAM: 16
        },
        cpu: { capabilities: { neon: true } }
    },

    // AMD
    rx7900xtx: {
        summary: {
            bestBackend: 'rocm',
            gpuModel: 'AMD Radeon RX 7900 XTX',
            effectiveMemory: 24,
            systemRAM: 64,
            totalVRAM: 24
        },
        cpu: { capabilities: { avx2: true } }
    },

    // CPU-only (Low-end)
    cpuOnly: {
        summary: {
            bestBackend: 'cpu',
            gpuModel: '',
            effectiveMemory: 16,
            systemRAM: 16,
            totalVRAM: 0
        },
        cpu: { capabilities: { avx2: true } }
    },

    cpuLowEnd: {
        summary: {
            bestBackend: 'cpu',
            gpuModel: '',
            effectiveMemory: 8,
            systemRAM: 8,
            totalVRAM: 0
        },
        cpu: { capabilities: { avx: true } }
    }
};

// Test model variants
const MODEL_VARIANTS = {
    // Small models
    'tinyllama-1b': { model_id: 'tinyllama', params_b: 1.1, quant: 'Q4_K_M', size_gb: 0.6, context_length: 2048 },
    'phi2-3b': { model_id: 'phi-2', params_b: 2.7, quant: 'Q4_K_M', size_gb: 1.6, context_length: 2048 },
    'llama3.2-3b': { model_id: 'llama3.2', params_b: 3, quant: 'Q4_K_M', size_gb: 2.0, context_length: 8192 },

    // Medium models
    'llama3-7b': { model_id: 'llama3', params_b: 7, quant: 'Q4_K_M', size_gb: 4.1, context_length: 8192 },
    'qwen2.5-7b': { model_id: 'qwen2.5', params_b: 7, quant: 'Q4_K_M', size_gb: 4.4, context_length: 32768 },
    'qwen2.5-coder-7b': { model_id: 'qwen2.5-coder', params_b: 7, quant: 'Q4_K_M', size_gb: 4.4, context_length: 32768 },

    // Large models
    'llama3.1-13b': { model_id: 'llama3.1', params_b: 13, quant: 'Q4_K_M', size_gb: 7.9, context_length: 32768 },
    'qwen2.5-14b': { model_id: 'qwen2.5', params_b: 14, quant: 'Q4_K_M', size_gb: 8.9, context_length: 32768 },

    // XL models
    'deepseek-r1-32b': { model_id: 'deepseek-r1', params_b: 32, quant: 'Q4_K_M', size_gb: 19, context_length: 65536 },
    'mixtral-8x7b': { model_id: 'mixtral', params_b: 46, quant: 'Q4_K_M', size_gb: 26, context_length: 32768, is_moe: true },

    // XXL models
    'llama3.1-70b': { model_id: 'llama3.1', params_b: 70, quant: 'Q4_K_M', size_gb: 40, context_length: 32768 },
    'deepseek-v3-671b': { model_id: 'deepseek-v3', params_b: 671, quant: 'Q4_K_M', size_gb: 404, context_length: 65536, is_moe: true },

    // Different quantizations for same model
    'llama3-7b-fp16': { model_id: 'llama3', params_b: 7, quant: 'FP16', size_gb: 14, context_length: 8192 },
    'llama3-7b-q8': { model_id: 'llama3', params_b: 7, quant: 'Q8_0', size_gb: 7.5, context_length: 8192 },
    'llama3-7b-q2': { model_id: 'llama3', params_b: 7, quant: 'Q2_K', size_gb: 2.8, context_length: 8192 },
};

// Expected TPS ranges (realistic based on Ollama benchmarks)
// These ranges account for the new formula with diminishing returns
// Model size scaling: ~1.5x for 3B, 1.0x for 7B, 0.5x for 13B
const EXPECTED_TPS_RANGES = {
    // Hardware -> Model Size -> [minTPS, maxTPS]
    h100: {
        '1b': [150, 260],    // ~2x baseline (capped by overhead)
        '3b': [140, 200],    // ~1.5x baseline (120 * 1.47 = 176)
        '7b': [100, 140],    // Baseline: 120 TPS
        '13b': [55, 80],     // ~0.5x baseline
        '32b': [20, 35],     // ~0.25x with efficiency boost
        '70b': [8, 18],      // Memory bandwidth limited
    },
    rtx4090: {
        '1b': [100, 160],    // ~2x baseline (capped)
        '3b': [85, 120],     // ~1.5x baseline (70 * 1.47 = 103)
        '7b': [60, 85],      // Baseline: 70 TPS
        '13b': [32, 50],     // ~0.5x baseline
        '32b': [12, 25],     // Memory limited on 24GB
        '70b': [1, 10],      // Won't fit well
    },
    m4Pro: {
        '1b': [60, 105],     // ~2x baseline (capped)
        '3b': [55, 80],      // ~1.5x baseline (45 * 1.47 = 66)
        '7b': [38, 55],      // Baseline: 45 TPS
        '13b': [20, 35],     // ~0.5x baseline
        '32b': [1, 15],      // Memory limited on 24GB
        '70b': [1, 5],       // Won't fit
    },
    cpuOnly: {
        '1b': [6, 14],       // ~2x baseline (capped)
        '3b': [5, 12],       // ~1.5x baseline (5 * 1.47 = 7.4)
        '7b': [4, 7],        // Baseline: 5 TPS
        '13b': [2, 4],       // ~0.4x baseline
        '32b': [1, 2],       // Very slow
        '70b': [1, 1],       // Barely runs
    }
};

class HardwareSimulationTest {
    constructor() {
        this.engine = new ScoringEngine();
        this.results = [];
        this.failures = [];
    }

    log(message, type = 'info') {
        const colors = {
            info: '\x1b[36m',
            pass: '\x1b[32m',
            fail: '\x1b[31m',
            warn: '\x1b[33m',
            reset: '\x1b[0m'
        };
        console.log(`${colors[type]}${message}${colors.reset}`);
    }

    // Test TPS estimation for a hardware/model combo
    testTPSEstimation(hwName, hardware, modelName, model, expectedRange) {
        const tps = this.engine.estimateTPS(model, hardware);
        const [minTPS, maxTPS] = expectedRange;
        const passed = tps >= minTPS && tps <= maxTPS;

        const result = {
            hardware: hwName,
            model: modelName,
            params: model.params_b,
            quant: model.quant,
            estimatedTPS: tps,
            expectedRange: `${minTPS}-${maxTPS}`,
            passed
        };

        this.results.push(result);

        if (!passed) {
            this.failures.push(result);
            this.log(`FAIL: ${hwName} + ${modelName} (${model.params_b}B ${model.quant})`, 'fail');
            this.log(`  TPS: ${tps}, Expected: ${minTPS}-${maxTPS}`, 'fail');
        } else {
            this.log(`PASS: ${hwName} + ${modelName} -> ${tps} TPS`, 'pass');
        }

        return passed;
    }

    // Test all hardware/model combinations
    runAllTPSTests() {
        this.log('\n=== TPS Estimation Tests ===\n', 'info');

        const testCases = [
            // H100 tests
            ['h100', HARDWARE_PROFILES.h100, 'tinyllama-1b', MODEL_VARIANTS['tinyllama-1b'], EXPECTED_TPS_RANGES.h100['1b']],
            ['h100', HARDWARE_PROFILES.h100, 'llama3.2-3b', MODEL_VARIANTS['llama3.2-3b'], EXPECTED_TPS_RANGES.h100['3b']],
            ['h100', HARDWARE_PROFILES.h100, 'llama3-7b', MODEL_VARIANTS['llama3-7b'], EXPECTED_TPS_RANGES.h100['7b']],
            ['h100', HARDWARE_PROFILES.h100, 'llama3.1-13b', MODEL_VARIANTS['llama3.1-13b'], EXPECTED_TPS_RANGES.h100['13b']],
            ['h100', HARDWARE_PROFILES.h100, 'deepseek-r1-32b', MODEL_VARIANTS['deepseek-r1-32b'], EXPECTED_TPS_RANGES.h100['32b']],
            ['h100', HARDWARE_PROFILES.h100, 'llama3.1-70b', MODEL_VARIANTS['llama3.1-70b'], EXPECTED_TPS_RANGES.h100['70b']],

            // RTX 4090 tests
            ['rtx4090', HARDWARE_PROFILES.rtx4090, 'tinyllama-1b', MODEL_VARIANTS['tinyllama-1b'], EXPECTED_TPS_RANGES.rtx4090['1b']],
            ['rtx4090', HARDWARE_PROFILES.rtx4090, 'llama3.2-3b', MODEL_VARIANTS['llama3.2-3b'], EXPECTED_TPS_RANGES.rtx4090['3b']],
            ['rtx4090', HARDWARE_PROFILES.rtx4090, 'llama3-7b', MODEL_VARIANTS['llama3-7b'], EXPECTED_TPS_RANGES.rtx4090['7b']],
            ['rtx4090', HARDWARE_PROFILES.rtx4090, 'llama3.1-13b', MODEL_VARIANTS['llama3.1-13b'], EXPECTED_TPS_RANGES.rtx4090['13b']],

            // M4 Pro tests
            ['m4Pro', HARDWARE_PROFILES.m4Pro, 'tinyllama-1b', MODEL_VARIANTS['tinyllama-1b'], EXPECTED_TPS_RANGES.m4Pro['1b']],
            ['m4Pro', HARDWARE_PROFILES.m4Pro, 'llama3.2-3b', MODEL_VARIANTS['llama3.2-3b'], EXPECTED_TPS_RANGES.m4Pro['3b']],
            ['m4Pro', HARDWARE_PROFILES.m4Pro, 'llama3-7b', MODEL_VARIANTS['llama3-7b'], EXPECTED_TPS_RANGES.m4Pro['7b']],
            ['m4Pro', HARDWARE_PROFILES.m4Pro, 'llama3.1-13b', MODEL_VARIANTS['llama3.1-13b'], EXPECTED_TPS_RANGES.m4Pro['13b']],

            // CPU-only tests
            ['cpuOnly', HARDWARE_PROFILES.cpuOnly, 'tinyllama-1b', MODEL_VARIANTS['tinyllama-1b'], EXPECTED_TPS_RANGES.cpuOnly['1b']],
            ['cpuOnly', HARDWARE_PROFILES.cpuOnly, 'llama3.2-3b', MODEL_VARIANTS['llama3.2-3b'], EXPECTED_TPS_RANGES.cpuOnly['3b']],
            ['cpuOnly', HARDWARE_PROFILES.cpuOnly, 'llama3-7b', MODEL_VARIANTS['llama3-7b'], EXPECTED_TPS_RANGES.cpuOnly['7b']],
        ];

        for (const [hwName, hardware, modelName, model, expected] of testCases) {
            this.testTPSEstimation(hwName, hardware, modelName, model, expected);
        }
    }

    // Test full scoring for a hardware profile
    testFullScoring(hwName, hardware) {
        this.log(`\n=== Full Scoring Test: ${hwName} ===\n`, 'info');

        const models = Object.entries(MODEL_VARIANTS);
        const scored = [];

        for (const [name, model] of models) {
            const result = this.engine.score(model, hardware, { useCase: 'general' });
            scored.push({
                model: name,
                final: result.final,
                Q: result.components.quality,
                S: result.components.speed,
                F: result.components.fit,
                C: result.components.context,
                tps: result.meta.estimatedTPS
            });
        }

        // Sort by final score
        scored.sort((a, b) => b.final - a.final);

        console.log(`\nTop 5 recommendations for ${hwName}:`);
        console.log('Model                  | Score | Q  | S  | F  | C  | TPS');
        console.log('-'.repeat(60));

        for (const s of scored.slice(0, 5)) {
            const name = s.model.padEnd(22);
            console.log(`${name} | ${String(s.final).padStart(5)} | ${String(s.Q).padStart(2)} | ${String(s.S).padStart(2)} | ${String(s.F).padStart(2)} | ${String(s.C).padStart(2)} | ${s.tps}`);
        }

        return scored;
    }

    // Validate that extreme hardware doesn't recommend tiny models as top choice
    testHardwareModelMatching() {
        this.log('\n=== Hardware-Model Matching Tests ===\n', 'info');

        const tests = [
            {
                name: 'H100 should NOT recommend 1B as #1',
                hardware: HARDWARE_PROFILES.h100,
                check: (scored) => scored[0].model !== 'tinyllama-1b',
                message: 'H100 top recommendation should not be a 1B model'
            },
            {
                name: 'RTX 4090 should recommend 7B-14B range',
                hardware: HARDWARE_PROFILES.rtx4090,
                check: (scored) => {
                    const top = scored[0];
                    const params = MODEL_VARIANTS[top.model]?.params_b || 7;
                    return params >= 7 && params <= 14;
                },
                message: 'RTX 4090 should recommend 7-14B models'
            },
            {
                name: 'CPU-only should recommend small models',
                hardware: HARDWARE_PROFILES.cpuOnly,
                check: (scored) => {
                    const top = scored[0];
                    const params = MODEL_VARIANTS[top.model]?.params_b || 7;
                    return params <= 7;
                },
                message: 'CPU-only should recommend 7B or smaller'
            },
            {
                name: 'M4 Pro should recommend models that fit in memory',
                hardware: HARDWARE_PROFILES.m4Pro,
                check: (scored) => {
                    const top = scored[0];
                    const size = MODEL_VARIANTS[top.model]?.size_gb || 0;
                    return size <= 22; // 24GB - 2GB headroom
                },
                message: 'M4 Pro should recommend models under 22GB'
            }
        ];

        for (const test of tests) {
            const scored = [];
            for (const [name, model] of Object.entries(MODEL_VARIANTS)) {
                const result = this.engine.score(model, test.hardware, { useCase: 'general' });
                scored.push({ model: name, final: result.final, ...result.components });
            }
            scored.sort((a, b) => b.final - a.final);

            const passed = test.check(scored);
            if (passed) {
                this.log(`PASS: ${test.name}`, 'pass');
            } else {
                this.log(`FAIL: ${test.name}`, 'fail');
                this.log(`  ${test.message}`, 'fail');
                this.log(`  Top result: ${scored[0].model}`, 'fail');
                this.failures.push({ test: test.name, topResult: scored[0].model });
            }
        }
    }

    // Test quantization impact on speed
    // NOTE: The new scoring uses Q4_K_M as baseline (1.0x), not FP16
    // Lower quantization = faster (Q2 > Q4 > Q8 > FP16)
    testQuantizationSpeedImpact() {
        this.log('\n=== Quantization Speed Tests ===\n', 'info');

        const hardware = HARDWARE_PROFILES.rtx4090;
        const baseModel = MODEL_VARIANTS['llama3-7b'];

        // New expected multipliers relative to Q4_K_M = 1.0
        const quantTests = [
            { quant: 'FP16', expectedMult: 0.5 },     // 2x slower than Q4
            { quant: 'Q8_0', expectedMult: 0.7 },     // 30% slower than Q4
            { quant: 'Q4_K_M', expectedMult: 1.0 },   // Baseline
            { quant: 'Q2_K', expectedMult: 1.22 },    // 22% faster than Q4
        ];

        let q4TPS = null;

        for (const test of quantTests) {
            const model = { ...baseModel, quant: test.quant };
            const tps = this.engine.estimateTPS(model, hardware);

            if (test.quant === 'Q4_K_M') {
                q4TPS = tps;
                this.log(`Q4_K_M baseline: ${tps} TPS`, 'info');
            }
        }

        // Now test all relative to Q4
        for (const test of quantTests) {
            const model = { ...baseModel, quant: test.quant };
            const tps = this.engine.estimateTPS(model, hardware);
            const actualMult = tps / q4TPS;
            const expectedMult = test.expectedMult;
            const tolerance = 0.15;

            const passed = Math.abs(actualMult - expectedMult) <= tolerance;

            if (passed) {
                this.log(`PASS: ${test.quant} -> ${tps} TPS (${actualMult.toFixed(2)}x vs expected ${expectedMult}x)`, 'pass');
            } else {
                this.log(`FAIL: ${test.quant} -> ${tps} TPS (${actualMult.toFixed(2)}x vs expected ${expectedMult}x)`, 'fail');
                this.failures.push({ test: `Quant ${test.quant}`, actual: actualMult, expected: expectedMult });
            }
        }
    }

    // Display raw TPS calculations for debugging
    debugTPSCalculations() {
        this.log('\n=== Debug: Raw TPS Calculations ===\n', 'warn');

        const testCases = [
            ['H100', HARDWARE_PROFILES.h100, 'llama3.2-3b', MODEL_VARIANTS['llama3.2-3b']],
            ['RTX 4090', HARDWARE_PROFILES.rtx4090, 'llama3-7b', MODEL_VARIANTS['llama3-7b']],
            ['M4 Pro', HARDWARE_PROFILES.m4Pro, 'qwen2.5-7b', MODEL_VARIANTS['qwen2.5-7b']],
            ['CPU', HARDWARE_PROFILES.cpuOnly, 'llama3.2-3b', MODEL_VARIANTS['llama3.2-3b']],
        ];

        for (const [hwName, hardware, modelName, model] of testCases) {
            const backendKey = this.engine.getBackendKey(hardware);
            const baseSpeed = this.engine.backendSpeed[backendKey];
            const quantMult = this.engine.quantSpeedMult[model.quant];
            const params = model.params_b;

            const tps = this.engine.estimateTPS(model, hardware);

            console.log(`\n${hwName} + ${modelName}:`);
            console.log(`  Backend key: ${backendKey}`);
            console.log(`  Base speed coefficient: ${baseSpeed}`);
            console.log(`  Model params: ${params}B`);
            console.log(`  Quant: ${model.quant} (mult: ${quantMult})`);
            console.log(`  Formula: (${baseSpeed} / ${params}) * ${quantMult} = ${((baseSpeed / params) * quantMult).toFixed(1)}`);
            console.log(`  Result TPS: ${tps}`);
        }
    }

    // Run all tests
    runAll() {
        console.log('\n' + '='.repeat(60));
        console.log('LLM-CHECKER HARDWARE SIMULATION TEST SUITE');
        console.log('='.repeat(60));

        this.debugTPSCalculations();
        this.runAllTPSTests();
        this.testQuantizationSpeedImpact();
        this.testHardwareModelMatching();

        // Test full scoring for each hardware
        for (const [name, hw] of Object.entries(HARDWARE_PROFILES)) {
            this.testFullScoring(name, hw);
        }

        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('TEST SUMMARY');
        console.log('='.repeat(60));

        const totalTests = this.results.length;
        const passedTests = this.results.filter(r => r.passed).length;
        const failedTests = this.failures.length;

        this.log(`\nTotal TPS tests: ${totalTests}`, 'info');
        this.log(`Passed: ${passedTests}`, 'pass');
        this.log(`Failed: ${failedTests}`, failedTests > 0 ? 'fail' : 'pass');

        if (this.failures.length > 0) {
            this.log('\nFailed tests:', 'fail');
            for (const f of this.failures) {
                console.log(`  - ${JSON.stringify(f)}`);
            }
        }

        return this.failures.length === 0;
    }
}

// Run tests
const test = new HardwareSimulationTest();
const success = test.runAll();
process.exit(success ? 0 : 1);
