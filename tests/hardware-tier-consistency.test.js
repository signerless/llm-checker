const assert = require('assert');

const UnifiedDetector = require('../src/hardware/unified-detector');
const LLMChecker = require('../src/index');
const DeterministicModelSelector = require('../src/models/deterministic-selector');

function buildWindowsIntegratedAssistResult() {
    return {
        platform: 'win32',
        cpu: { brand: 'AMD Ryzen AI 9 HX 370 w/ Radeon 890M', speedCoefficient: 55 },
        primary: { type: 'cpu', name: 'CPU', info: { speedCoefficient: 55 } },
        systemGpu: {
            available: true,
            hasDedicated: false,
            gpus: [
                {
                    name: 'AMD Radeon(TM) 890M Graphics',
                    type: 'integrated',
                    memory: { total: 48 }
                }
            ],
            totalVRAM: 0,
            isMultiGPU: false
        }
    };
}

function buildConflictingHardwareProfile() {
    return {
        cpu: {
            brand: 'AMD Ryzen AI 9 HX 370 w/ Radeon 890M',
            architecture: 'x86_64',
            cores: 24,
            physicalCores: 12,
            speed: 2.0
        },
        memory: { total: 48 },
        gpu: {
            model: 'AMD Radeon(TM) 890M Graphics',
            vendor: 'AMD',
            vram: 0,
            dedicated: false
        },
        os: { platform: 'win32' },
        summary: {
            bestBackend: 'cpu',
            backendName: 'CPU',
            runtimeBackend: 'vulkan',
            runtimeBackendName: 'Vulkan',
            bestBackendLabel: 'CPU + Vulkan assist',
            hardwareTier: 'medium_low',
            effectiveMemory: 34,
            speedCoefficient: 55,
            hasIntegratedGPU: true,
            hasDedicatedGPU: false
        }
    };
}

function testSummaryExposesCanonicalTierAndBackendLabel() {
    const detector = new UnifiedDetector();
    const summary = detector.buildSummary(buildWindowsIntegratedAssistResult());

    assert.strictEqual(summary.runtimeBackend, 'vulkan');
    assert.strictEqual(summary.hasRuntimeAssist, true);
    assert.strictEqual(summary.bestBackendLabel, 'CPU + Vulkan assist');
    assert.strictEqual(summary.hardwareTier, 'medium_low');
}

function testLlmCheckerPrefersCanonicalHardwareTier() {
    const checker = new LLMChecker({ verbose: false });
    const hardware = buildConflictingHardwareProfile();

    assert.strictEqual(
        checker.getHardwareTier(hardware),
        'medium_low',
        'LLMChecker should honor the unified detector tier before optimistic heuristics'
    );
}

function testDeterministicSelectorPrefersCanonicalHardwareTier() {
    const selector = new DeterministicModelSelector();
    const hardware = buildConflictingHardwareProfile();

    assert.strictEqual(
        selector.mapHardwareTier(hardware),
        'medium_low',
        'Deterministic selector should honor the unified detector tier when it is available'
    );
}

function run() {
    testSummaryExposesCanonicalTierAndBackendLabel();
    testLlmCheckerPrefersCanonicalHardwareTier();
    testDeterministicSelectorPrefersCanonicalHardwareTier();
    console.log('hardware-tier-consistency.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('hardware-tier-consistency.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
