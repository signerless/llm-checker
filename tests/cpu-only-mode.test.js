const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const LLMChecker = require('../src/index');
const CompatibilityAnalyzer = require('../analyzer/compatibility');
const HardwareDetector = require('../src/hardware/detector');
const {
    CPU_ONLY_ENV,
    applyCpuOnlyOverride,
    getSystemRAMGB,
    resolveCpuOnlyMode
} = require('../src/hardware/cpu-only');
const { buildGpuPlan } = require('../src/commands/roadmap-tools');
const { buildFullHardwareObject } = require('../src/hardware/profiles');
const DeterministicModelSelector = require('../src/models/deterministic-selector');
const IntelligentSelector = require('../src/models/intelligent-selector');
const AICheckSelector = require('../src/models/ai-check-selector');
const AIModelSelector = require('../src/ai/model-selector');
const OllamaClient = require('../src/ollama/client');
const SpeculativeDecodingEstimator = require('../src/models/speculative-decoding-estimator');
const {
    RegistryRecommender,
    normalizeHardwareForSelector
} = require('../src/data/registry-recommender');
const { runtimeSupportedOnHardware } = require('../src/runtime/runtime-support');
const { estimateTokenSpeedFromHardware } = require('../src/utils/token-speed-estimator');
const { rankModels } = require('../src/models/scoring-core');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'enhanced_cli.js');

function buildGpuHardware(overrides = {}) {
    const hardware = {
        cpu: {
            brand: 'AMD Ryzen 9 7950X',
            manufacturer: 'AMD',
            architecture: 'x86_64',
            cores: 32,
            physicalCores: 16,
            speed: 4.5,
            score: 100,
            speedCoefficient: 110,
            capabilities: { avx2: true }
        },
        memory: { total: 64, totalGB: 64, free: 48 },
        gpu: {
            type: 'nvidia',
            model: 'NVIDIA GeForce RTX 4090',
            vendor: 'NVIDIA',
            backend: 'cuda',
            vram: 24,
            vramGB: 24,
            vramPerGPU: 24,
            totalVRAM: 24,
            dedicated: true,
            gpuCount: 1,
            isMultiGPU: false,
            hasDedicatedGPU: true,
            hasIntegratedGPU: false,
            dedicatedGpuModels: [{ name: 'NVIDIA GeForce RTX 4090', count: 1 }],
            integratedGpuModels: [],
            all: [{ model: 'NVIDIA GeForce RTX 4090', vendor: 'NVIDIA', vram: 24 }]
        },
        acceleration: {
            supports_cuda: true,
            supports_rocm: false,
            supports_metal: false,
            supports_vulkan: true
        },
        primary: {
            type: 'cuda',
            name: 'NVIDIA CUDA',
            info: { speedCoefficient: 250 }
        },
        summary: {
            bestBackend: 'cuda',
            backendName: 'NVIDIA CUDA',
            bestBackendLabel: 'NVIDIA CUDA',
            runtimeBackend: 'cuda',
            runtimeBackendName: 'NVIDIA CUDA',
            hasRuntimeAssist: false,
            totalVRAM: 24,
            effectiveMemory: 24,
            systemRAM: 64,
            speedCoefficient: 250,
            hardwareTier: 'high',
            cpuModel: 'AMD Ryzen 9 7950X',
            isMultiGPU: false,
            gpuCount: 1,
            gpuModel: 'NVIDIA GeForce RTX 4090',
            gpuInventory: 'NVIDIA GeForce RTX 4090',
            gpuModels: [{ name: 'NVIDIA GeForce RTX 4090', count: 1 }],
            hasHeterogeneousGPU: false,
            hasIntegratedGPU: false,
            hasDedicatedGPU: true,
            integratedGpuCount: 0,
            dedicatedGpuCount: 1,
            integratedGpuModels: [],
            dedicatedGpuModels: [{ name: 'NVIDIA GeForce RTX 4090', count: 1 }],
            integratedSharedMemory: 0
        },
        backends: {
            cpu: {
                available: true,
                info: {
                    brand: 'AMD Ryzen 9 7950X',
                    architecture: 'x86_64',
                    cores: { logical: 32, physical: 16 },
                    speedCoefficient: 110,
                    capabilities: { avx2: true }
                }
            },
            cuda: {
                available: true,
                info: {
                    totalVRAM: 24,
                    speedCoefficient: 250,
                    gpus: [{ name: 'NVIDIA GeForce RTX 4090', memory: { total: 24 } }]
                }
            }
        },
        os: { platform: 'linux' }
    };

    return {
        ...hardware,
        ...overrides,
        cpu: { ...hardware.cpu, ...(overrides.cpu || {}) },
        memory: { ...hardware.memory, ...(overrides.memory || {}) },
        summary: { ...hardware.summary, ...(overrides.summary || {}) }
    };
}

function stripAnsi(text = '') {
    return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function runCli(args, env = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 45000,
        env: {
            ...process.env,
            NO_COLOR: '1',
            [CPU_ONLY_ENV]: '',
            ...env
        }
    });
}

function runCliAsync(args, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...args], {
            cwd: ROOT,
            env: {
                ...process.env,
                NO_COLOR: '1',
                [CPU_ONLY_ENV]: '',
                ...env
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`CLI timed out: ${args.join(' ')}`));
        }, 45000);

        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('close', (status, signal) => {
            clearTimeout(timeout);
            resolve({ status, signal, stdout, stderr });
        });
    });
}

function testProjectionUsesCpuAndRamOnly() {
    const raw = buildGpuHardware();
    const projected = applyCpuOnlyOverride(raw, { cpuOnly: true, source: 'test' });

    assert.notStrictEqual(projected, raw);
    assert.strictEqual(raw.summary.bestBackend, 'cuda', 'the detected profile must remain unchanged');
    assert.strictEqual(projected.cpuOnly, true);
    assert.strictEqual(projected.primary.type, 'cpu');
    assert.strictEqual(projected.summary.bestBackend, 'cpu');
    assert.strictEqual(projected.summary.runtimeBackend, 'cpu');
    assert.strictEqual(projected.summary.totalVRAM, 0);
    assert.strictEqual(projected.summary.gpuCount, 0);
    assert.strictEqual(projected.summary.effectiveMemory, 45, '64GB RAM should expose a 45GB CPU model budget');
    assert.strictEqual(projected.summary.speedCoefficient, 110, 'CPU speed must replace the GPU coefficient');
    assert.strictEqual(projected.summary.hardwareTier, 'medium_high');
    assert.strictEqual(projected.gpu.vramGB, 0);
    assert.strictEqual(projected.gpu.gpuCount, 0);
    assert.strictEqual(projected.acceleration.supports_cuda, false);
    assert.strictEqual(projected.acceleration.supports_vulkan, false);
    assert.strictEqual(projected.detectedGpu.totalVRAM, 24, 'real VRAM remains diagnostic');
    assert.deepStrictEqual(
        projected.detectedGpu.dedicatedGpuModels,
        raw.summary.dedicatedGpuModels,
        'diagnostics preserve dedicated inventory separately'
    );
    assert.strictEqual(projected.backends.cuda.available, true, 'raw backend inventory remains available for diagnostics');
    assert.strictEqual(runtimeSupportedOnHardware('mlx', projected), false, 'CPU-only mode cannot advertise MLX GPU execution');

    assert.strictEqual(
        getSystemRAMGB({ summary: { systemRAM: null }, memory: { total: 64 } }),
        64,
        'null canonical fields must not become a false 0GB value'
    );
}

function testSimulatedProfileDiagnosticInference() {
    const rtx4090 = applyCpuOnlyOverride(buildFullHardwareObject('rtx4090'), {
        cpuOnly: true,
        source: 'test-simulation'
    });
    assert.deepStrictEqual(
        rtx4090.detectedGpu.dedicatedGpuModels,
        [{ name: 'NVIDIA GeForce RTX 4090', count: 1 }],
        'a real simulation profile must infer its dedicated diagnostic inventory from gpu.all'
    );
    assert.deepStrictEqual(rtx4090.detectedGpu.integratedGpuModels, []);

    const m4pro24 = applyCpuOnlyOverride(buildFullHardwareObject('m4pro24'), {
        cpuOnly: true,
        source: 'test-simulation'
    });
    assert.deepStrictEqual(m4pro24.detectedGpu.dedicatedGpuModels, []);
    assert.deepStrictEqual(
        m4pro24.detectedGpu.integratedGpuModels,
        [{ name: 'Apple M4 Pro', count: 1 }],
        'a real unified-memory simulation profile must retain its integrated GPU diagnostic'
    );
}

async function testDetectorCacheAndSimulationPrecedence() {
    const raw = buildGpuHardware();
    const cachedDetector = new HardwareDetector({ cpuOnly: true });
    cachedDetector.cache = raw;
    cachedDetector.cacheTime = Date.now();

    const cachedCpu = await cachedDetector.getSystemInfo();
    assert.strictEqual(cachedCpu.summary.bestBackend, 'cpu');
    assert.strictEqual(cachedCpu.detectedGpu.model, 'NVIDIA GeForce RTX 4090');

    const cachedGpu = await cachedDetector.getSystemInfo(false, { cpuOnly: false });
    assert.strictEqual(cachedGpu.summary.bestBackend, 'cuda', 'per-call false restores the raw cached profile');
    assert.strictEqual(cachedGpu.summary.totalVRAM, 24);

    const simulated = buildGpuHardware({
        cpu: { brand: 'Simulated Threadripper', speedCoefficient: 120 },
        memory: { total: 96, totalGB: 96 },
        summary: { systemRAM: 96, cpuModel: 'Simulated Threadripper' }
    });
    const checker = new LLMChecker({ verbose: false, cpuOnly: true });
    checker.setSimulatedHardware(simulated);

    const simulatedCpu = await checker.getSystemInfo();
    assert.strictEqual(simulatedCpu.cpu.brand, 'Simulated Threadripper');
    assert.strictEqual(simulatedCpu.memory.total, 96);
    assert.strictEqual(simulatedCpu.summary.effectiveMemory, 67);
    assert.strictEqual(simulatedCpu.detectedGpu.model, 'NVIDIA GeForce RTX 4090');

    const simulatedGpu = await checker.getSystemInfo({ cpuOnly: false });
    assert.strictEqual(simulatedGpu.summary.bestBackend, 'cuda');
    assert.strictEqual(simulatedGpu.memory.total, 96);
}

async function testEnvironmentOptInAndExplicitFalse() {
    const previous = process.env[CPU_ONLY_ENV];
    process.env[CPU_ONLY_ENV] = '1';
    try {
        assert.strictEqual(resolveCpuOnlyMode(), true);
        assert.strictEqual(resolveCpuOnlyMode(false), false, 'an explicit API false overrides the environment');

        const raw = buildGpuHardware();
        const detector = new HardwareDetector();
        detector.setSimulatedHardware(raw);
        assert.strictEqual((await detector.getSystemInfo()).cpuOnly, true);
        assert.strictEqual(
            (await detector.getSystemInfo(false, { cpuOnly: false })).summary.bestBackend,
            'cuda'
        );

        const checker = new LLMChecker({ verbose: false, cpuOnly: false });
        checker.setSimulatedHardware(raw);
        checker.runAnalysisFlow = async (hardware, options) => ({ hardware, options });
        const analysis = await checker.analyze();
        assert.strictEqual(analysis.hardware.summary.bestBackend, 'cuda');
        assert.strictEqual(
            analysis.options.cpuOnly,
            false,
            'constructor false must propagate through analyze even when the environment enables CPU-only'
        );

        const ranked = await rankModels(
            [{ model_identifier: 'tiny:1b', name: 'Tiny 1B', paramsB: 1, sizeGB: 1, tags: ['instruct'] }],
            raw,
            { category: 'general', topN: 1, cpuOnly: false }
        );
        assert.strictEqual(ranked.hardware.cpuOnly, false);
        assert.strictEqual(ranked.hardware.gpu.vramGB, 24);

        const selector = new DeterministicModelSelector();
        const gpuProfile = selector.normalizeHardwareProfile(raw, { cpuOnly: false });
        assert.strictEqual(gpuProfile.cpuOnly, false);
        assert.strictEqual(gpuProfile.gpu.vramGB, 24);
        assert.strictEqual(gpuProfile.acceleration.supports_cuda, true);
        assert.strictEqual(
            selector.normalizeHardwareProfile(gpuProfile).gpu.vramGB,
            24,
            'an explicit-false profile marker must keep suppressing the environment downstream'
        );

        const configuredCpuSelector = new DeterministicModelSelector({ cpuOnly: true });
        const configuredCpuProfile = configuredCpuSelector.normalizeHardwareProfile(raw);
        assert.strictEqual(configuredCpuProfile.cpuOnly, true);
        assert.strictEqual(configuredCpuProfile.gpu.vramGB, 0);
        assert.strictEqual(configuredCpuProfile.acceleration.supports_cuda, false);

        const configuredGpuSelector = new DeterministicModelSelector({ cpuOnly: false });
        const configuredGpuProfile = configuredGpuSelector.normalizeHardwareProfile(raw);
        assert.strictEqual(configuredGpuProfile.cpuOnly, false);
        assert.strictEqual(configuredGpuProfile.gpu.vramGB, 24);

        const configuredGpuSelection = await configuredGpuSelector.selectModels('general', {
            hardware: raw,
            installedModels: [],
            modelPool: [{
                model_identifier: 'tiny',
                model_name: 'Tiny',
                primary_category: 'general',
                context_length: '8K',
                variants: [{
                    tag: 'tiny:1b',
                    size: '1b',
                    quantization: 'Q4_K_M',
                    real_size_gb: 1,
                    categories: ['general']
                }],
                tags: ['tiny:1b'],
                use_cases: ['general']
            }],
            topN: 1,
            silent: true
        });
        assert.strictEqual(configuredGpuSelection.hardware.cpuOnly, false);
        assert.strictEqual(configuredGpuSelection.hardware.gpu.vramGB, 24);

        const aiRunSelector = new AIModelSelector({ cpuOnly: false });
        const gpuSpecs = aiRunSelector.normalizeSystemSpecs({
            total_ram_gb: 64,
            cpu_cores: 32,
            gpu_vram_gb: 24,
            gpu_model_normalized: 'rtx_4090'
        }, { cpuOnly: false });
        assert.strictEqual(gpuSpecs.gpu_vram_gb, 24);
        assert.strictEqual(gpuSpecs.gpu_model_normalized, 'rtx_4090');

        let smartDetectorCpuOnly = true;
        const smartDetector = {
            async detect(options = {}) {
                if (Object.prototype.hasOwnProperty.call(options, 'cpuOnly')) {
                    smartDetectorCpuOnly = resolveCpuOnlyMode(options.cpuOnly);
                }
                return smartDetectorCpuOnly
                    ? applyCpuOnlyOverride(raw, { cpuOnly: true, source: 'test-detector' })
                    : raw;
            },
            getHardwareDescription: () => smartDetectorCpuOnly ? 'CPU profile' : 'GPU profile',
            getHardwareTier: () => smartDetectorCpuOnly ? 'low' : 'high',
            getMaxModelSize: () => smartDetectorCpuOnly ? 10 : 22
        };
        const smartSelector = new IntelligentSelector({ cpuOnly: true, detector: smartDetector });
        const smartGpu = await smartSelector.recommend([], {
            cpuOnly: false,
            policyFile: null
        });
        assert.strictEqual(smartDetectorCpuOnly, false);
        assert.strictEqual(
            smartGpu.hardware.backend,
            'cuda',
            'smart-recommend explicit false must restore the detector GPU profile'
        );
    } finally {
        if (previous === undefined) delete process.env[CPU_ONLY_ENV];
        else process.env[CPU_ONLY_ENV] = previous;
    }
}

async function testRecommendationSurfaces() {
    const raw = buildGpuHardware();
    const projected = applyCpuOnlyOverride(raw, { cpuOnly: true });
    const deterministic = new DeterministicModelSelector();
    const normalized = deterministic.normalizeHardwareProfile(raw, { cpuOnly: true });

    assert.strictEqual(normalized.gpu.type, 'cpu_only');
    assert.strictEqual(normalized.gpu.vramGB, 0);
    assert.strictEqual(normalized.gpu.gpuCount, 0);
    assert.strictEqual(normalized.usableMemGB, 45);
    assert.strictEqual(
        deterministic.estimateSpeedProfile(
            normalized,
            { model_identifier: 'qwen:7b', paramsB: 7 },
            'Q4_K_M',
            'general'
        ).backend,
        'cpu_x86',
        'deterministic scoring must use a CPU speed backend'
    );

    const safetyPool = [
        {
            model_identifier: 'safe-tiny:1b',
            name: 'Safe Tiny 1B',
            paramsB: 1,
            sizeGB: 1,
            tags: ['instruct']
        },
        {
            model_identifier: 'dolphin-uncensored:1b',
            name: 'Dolphin Uncensored 1B',
            paramsB: 1,
            sizeGB: 1,
            tags: ['uncensored']
        }
    ];
    const safeCpuRanking = await rankModels(safetyPool, raw, {
        category: 'general',
        topN: 10,
        cpuOnly: true
    });
    assert.strictEqual(safeCpuRanking.hardware.cpuOnly, true);
    const rankedIdentity = (candidate) => String(
        candidate.meta?.model_identifier ||
        candidate.meta?.name ||
        candidate.model_identifier ||
        candidate.name ||
        ''
    );
    assert.ok(
        safeCpuRanking.candidates.every((candidate) => !rankedIdentity(candidate).includes('uncensored')),
        'CPU-only scoring must retain the default restricted-model filter'
    );
    const optedInCpuRanking = await rankModels(safetyPool, raw, {
        category: 'general',
        topN: 10,
        cpuOnly: true,
        includeUncensored: true
    });
    assert.ok(
        optedInCpuRanking.candidates.some((candidate) => rankedIdentity(candidate).includes('uncensored')),
        'the explicit safety opt-in must continue to work alongside CPU-only mode'
    );

    const registryHardware = normalizeHardwareForSelector(raw, { cpuOnly: true });
    assert.strictEqual(registryHardware.cpuOnly, true);
    assert.strictEqual(registryHardware.summary.hardwareTier, 'medium_high');
    assert.strictEqual(registryHardware.summary.speedCoefficient, 110);
    assert.strictEqual(registryHardware.cpu.speedCoefficient, 110);
    assert.strictEqual(registryHardware.cpu.capabilities.avx2, true);
    assert.strictEqual(registryHardware.gpu.vramGB, 0);
    assert.strictEqual(registryHardware.gpu.gpuCount, 0);
    assert.strictEqual(
        deterministic.normalizeHardwareProfile(registryHardware).summary.hardwareTier,
        'medium_high',
        'registry normalization must not erase the canonical CPU-only tier'
    );

    const simulatedCpuOnly = applyCpuOnlyOverride({
        cpu: {
            brand: 'Simulated CPU',
            architecture: 'x86_64',
            cores: 16,
            score: 98,
            capabilities: { avx2: true }
        },
        memory: { total: 64 },
        gpu: { model: 'NVIDIA GeForce RTX 4090', vram: 24 },
        summary: {
            bestBackend: 'cuda',
            systemRAM: 64,
            totalVRAM: 24,
            effectiveMemory: 24,
            speedCoefficient: 250,
            hasDedicatedGPU: true,
            dedicatedGpuModels: [{ name: 'NVIDIA GeForce RTX 4090', count: 1 }]
        }
    }, { cpuOnly: true });
    const registrySimulated = normalizeHardwareForSelector(simulatedCpuOnly);
    assert.strictEqual(registrySimulated.summary.speedCoefficient, 98);
    assert.strictEqual(registrySimulated.summary.hardwareTier, 'medium');
    assert.strictEqual(registrySimulated.cpu.score, 98);

    const autoRuntime = RegistryRecommender.prototype.scoreAutoRuntimePool.call(
        { selector: deterministic },
        {
            category: 'general',
            limit: 1,
            hardware: projected,
            modelPool: []
        }
    );
    assert.strictEqual(
        autoRuntime.hardware.cpuOnly,
        true,
        'auto-runtime scoring must preserve an inherited CPU-only hardware marker'
    );
    assert.strictEqual(runtimeSupportedOnHardware('mlx', autoRuntime.hardware), false);

    const smart = new IntelligentSelector({
        cpuOnly: true,
        detector: {
            detect: async () => raw,
            getHardwareDescription: () => 'GPU profile',
            getHardwareTier: () => 'high',
            getMaxModelSize: () => 22
        }
    });
    const smartResult = await smart.recommend([], { cpuOnly: true, policyFile: null });
    assert.strictEqual(smartResult.hardware.backend, 'cpu');
    assert.strictEqual(smartResult.hardware.tier, 'medium_high');
    assert.strictEqual(smartResult.hardware.maxSize, 43);
    assert.match(smartResult.hardware.description, /forced CPU-only/);

    const aiCheck = new AICheckSelector({
        cpuOnly: true,
        hardwareDetector: { getSystemInfo: async () => raw }
    });
    const aiHardware = await aiCheck.getDetectedHardwareProfile({ cpuOnly: true });
    assert.strictEqual(aiHardware.gpu.type, 'cpu_only');
    assert.strictEqual(aiHardware.gpu.vramGB, 0);
    assert.strictEqual(aiHardware.acceleration.supports_cuda, false);
    assert.strictEqual(aiHardware.usableMemGB, 45);

    const aiRun = new AIModelSelector({ cpuOnly: true });
    const cpuSpecs = aiRun.normalizeSystemSpecs({
        total_ram_gb: 64,
        cpu_cores: 32,
        gpu_vram_gb: 24,
        gpu_model_normalized: 'rtx_4090'
    });
    assert.strictEqual(cpuSpecs.cpu_only, true);
    assert.strictEqual(cpuSpecs.gpu_vram_gb, 0);
    assert.strictEqual(cpuSpecs.gpu_model_normalized, 'cpu_only');

    const appleCpuOnly = applyCpuOnlyOverride({
        cpu: {
            brand: 'Apple M4 Pro',
            architecture: 'Apple Silicon (ARM64)',
            cores: 12,
            physicalCores: 12,
            speed: 4.5,
            speedCoefficient: 100
        },
        memory: { total: 24 },
        gpu: { model: 'Apple M4 Pro', vram: 24, unified: true },
        summary: {
            bestBackend: 'metal',
            systemRAM: 24,
            totalVRAM: 24,
            effectiveMemory: 24,
            speedCoefficient: 180,
            hasIntegratedGPU: true,
            hasDedicatedGPU: false
        },
        os: { platform: 'darwin' }
    }, { cpuOnly: true });
    const speed = estimateTokenSpeedFromHardware(appleCpuOnly, { modelSizeB: 7 });
    assert.strictEqual(speed.backend, 'cpu', 'Apple CPU-only must not use the Metal estimator');
    assert.ok(speed.baselineTPS7B <= 18, `CPU baseline should not retain M4 Metal speed: ${speed.baselineTPS7B}`);

    const simulatedAppleProfile = deterministic.normalizeHardwareProfile(
        buildFullHardwareObject('m4pro24'),
        { cpuOnly: true }
    );
    assert.strictEqual(
        deterministic.estimateSpeedProfile(
            simulatedAppleProfile,
            { model_identifier: 'qwen:7b', paramsB: 7 },
            'Q4_K_M',
            'general'
        ).backend,
        'cpu_arm',
        'Apple Silicon CPU-only scoring must use the ARM CPU coefficient'
    );
    assert.strictEqual(
        new SpeculativeDecodingEstimator().estimate({
            model: { name: 'Llama 3.1 70B', params_b: 70 },
            candidates: [{ name: 'Llama 3.1 8B', params_b: 8 }],
            hardware: appleCpuOnly,
            runtime: 'mlx'
        }),
        null,
        'CPU-only mode must not advertise MLX speculative decoding'
    );

    const appleModel = {
        name: 'Llama Test 7B',
        size: '7B',
        type: 'local',
        requirements: { ram: 12, recommended_ram: 16, vram: 0, cpu_cores: 4 },
        frameworks: ['llama.cpp', 'ollama'],
        quantization: []
    };
    const compatibilityAnalyzer = new CompatibilityAnalyzer();
    const appleCompatibility = compatibilityAnalyzer.calculateModelCompatibility(
        simulatedAppleProfile,
        appleModel
    );
    assert.ok(
        ![...appleCompatibility.notes, ...appleCompatibility.modelSpecificRecommendations]
            .some((message) => /metal acceleration|unified memory architecture advantage/i.test(message)),
        'Apple CPU-only compatibility output must not advertise Metal or GPU unified-memory bonuses'
    );
    const appleRecommendations = compatibilityAnalyzer.generateRecommendations(
        simulatedAppleProfile,
        { compatible: [appleModel], marginal: [], incompatible: [] }
    );
    assert.ok(
        !appleRecommendations.some((message) => /metal acceleration/i.test(message)),
        'Apple CPU-only global recommendations must not advertise Metal acceleration'
    );

    const routeChecker = new LLMChecker({ verbose: false, cpuOnly: true });
    routeChecker.analyzeWithMathematicalHeuristics = async () => ({ route: 'mathematical' });
    const routed = await routeChecker.analyzeWithPlatformSpecificHeuristics(
        simulatedAppleProfile,
        [],
        {},
        'apple_silicon',
        { cpuOnly: true }
    );
    assert.strictEqual(
        routed.route,
        'mathematical',
        'Apple CPU-only analysis must skip optimistic Metal/unified-memory post-processing'
    );

    assert.strictEqual(projected.summary.bestBackend, 'cpu');
}

async function testMultiObjectiveFallbackStaysCpuOnlyOnApple() {
    const scoringCorePath = require.resolve('../src/models/scoring-core');
    const multiObjectivePath = require.resolve('../src/ai/multi-objective-selector');
    const scoringCore = require(scoringCorePath);
    const originalRankModels = scoringCore.rankModels;

    scoringCore.rankModels = async () => {
        throw new Error('forced canonical rank failure');
    };
    delete require.cache[multiObjectivePath];

    try {
        const MultiObjectiveSelector = require(multiObjectivePath);
        const selector = new MultiObjectiveSelector();
        const hardware = applyCpuOnlyOverride({
            cpu: {
                brand: 'Apple M4 Pro',
                architecture: 'Apple Silicon (ARM64)',
                cores: 12,
                physicalCores: 12,
                speed: 4.5,
                speedCoefficient: 100
            },
            memory: { total: 24 },
            gpu: { model: 'Apple M4 Pro', vram: 24, unified: true },
            summary: {
                bestBackend: 'metal',
                runtimeBackend: 'metal',
                systemRAM: 24,
                totalVRAM: 24,
                effectiveMemory: 24,
                speedCoefficient: 180,
                hardwareTier: 'high',
                hasIntegratedGPU: true,
                hasDedicatedGPU: false
            },
            os: { platform: 'darwin' }
        }, { cpuOnly: true });

        assert.strictEqual(hardware.summary.hardwareTier, 'medium_high');
        assert.strictEqual(selector.getHardwareTier(hardware), 'medium');
        assert.strictEqual(selector.getAvailableModelMemoryGB(hardware), 17);
        assert.strictEqual(
            selector.estimateTTFB(hardware, { name: 'Qwen 7B', size: '4GB' }),
            400,
            'legacy TTFB must use CPU load latency even though a projected gpu object exists'
        );
        assert.ok(
            selector.estimateTokensPerSecond(hardware, { name: 'Qwen 7B', size: '7B' }) <= 30,
            'legacy speed fallback must stay within the CPU ceiling'
        );

        const result = await selector.selectBestModels(
            hardware,
            [{ name: 'TinyLlama 1B', size: '1B', context: 4096, requirements: { ram: 2 } }],
            'general',
            5,
            { cpuOnly: true }
        );
        assert.strictEqual(
            result.compatible.length + result.marginal.length + result.incompatible.length,
            1,
            'forced canonical failure should complete through the CPU-only legacy path'
        );

        const rawGpu = buildGpuHardware();
        const rawFallback = await selector.selectBestModels(
            rawGpu,
            [{ name: 'Qwen 32B', size: '32B', context: 4096, requirements: { ram: 22 } }],
            'general',
            5,
            { cpuOnly: true }
        );
        assert.strictEqual(
            rawFallback.compatible.length,
            0,
            'legacy fallback must project raw GPU hardware when cpuOnly is requested per call'
        );
    } finally {
        scoringCore.rankModels = originalRankModels;
        delete require.cache[multiObjectivePath];
    }
}

function testCpuGpuPlan() {
    const plan = buildGpuPlan(buildGpuHardware(), { cpuOnly: true, modelSizeGB: 16 });
    assert.strictEqual(plan.cpuOnly, true);
    assert.strictEqual(plan.backend, 'cpu');
    assert.strictEqual(plan.memoryType, 'system_ram');
    assert.strictEqual(plan.memoryBudgetGB, 45);
    assert.strictEqual(plan.cpuMaxModelGB, 43);
    assert.strictEqual(plan.gpuCount, 0);
    assert.deepStrictEqual(plan.gpus, []);
    assert.strictEqual(plan.totalVRAM, 0);
    assert.strictEqual(plan.strategy, 'cpu_only');
    assert.strictEqual(plan.fit.fitsCPU, true);
    assert.strictEqual(plan.fit.fitsSingleGPU, false);
    assert.strictEqual(plan.env.OLLAMA_SCHED_SPREAD, '0');
    assert.strictEqual(plan.detectedGpu.totalVRAM, 24);
}

async function testProbeModeAndCacheIsolation() {
    const calls = [];
    const fakeClient = {
        cpuOnly: false,
        setCpuOnly(enabled) {
            this.cpuOnly = enabled;
            calls.push({ type: 'mode', enabled });
            return this;
        },
        async generate(model, prompt, options) {
            calls.push({ type: 'generate', model, options, cpuOnly: this.cpuOnly });
            return { tokensPerSecond: 7 };
        }
    };
    const selector = new DeterministicModelSelector({ cpuOnly: true, ollamaClient: fakeClient });
    let savedCache = null;
    selector.loadBenchCache = () => ({});
    selector.saveBenchCache = (cache) => { savedCache = cache; };

    const hardware = selector.normalizeHardwareProfile(buildGpuHardware(), { cpuOnly: true });
    const result = await selector.selectModels('general', {
        hardware: buildGpuHardware(),
        cpuOnly: true,
        enableProbe: true,
        installedModels: [],
        modelPool: [{
            model_identifier: 'tiny',
            model_name: 'Tiny',
            description: 'CPU probe fixture',
            primary_category: 'general',
            context_length: '8K',
            variants: [{
                tag: 'tiny:1b',
                size: '1b',
                quantization: 'Q4_K_M',
                real_size_gb: 1,
                categories: ['general']
            }],
            tags: ['tiny:1b'],
            use_cases: ['general']
        }],
        topN: 1,
        silent: true
    });
    assert.strictEqual(result.candidates.length, 1);
    const generation = calls.find((call) => call.type === 'generate');
    assert.ok(generation, 'enableProbe path should execute the Ollama generation probe');
    assert.strictEqual(generation.cpuOnly, true);
    assert.strictEqual(generation.options.generationOptions.num_gpu, 0);

    const cpuFingerprint = selector.getHardwareFingerprint(hardware);
    const gpuFingerprint = selector.getHardwareFingerprint(
        selector.normalizeHardwareProfile(buildGpuHardware(), { cpuOnly: false })
    );
    assert.match(cpuFingerprint, /cpu-only$/);
    assert.notStrictEqual(cpuFingerprint, gpuFingerprint, 'CPU-only and GPU probe cache keys must not collide');
    assert.ok(
        Object.keys(savedCache || {}).some((key) => key.startsWith(`${cpuFingerprint}_`)),
        'measured CPU-only TPS must be cached under the CPU-only fingerprint'
    );
}

async function testOllamaCpuOnlyEnforcement() {
    const requests = [];
    const server = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            if (request.url === '/api/version') {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ version: 'test' }));
                return;
            }
            if (request.url === '/api/tags') {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ models: [] }));
                return;
            }

            const payload = body ? JSON.parse(body) : {};
            requests.push({ url: request.url, payload });
            response.writeHead(200, { 'Content-Type': 'application/json' });
            if (request.url === '/api/chat' && payload.stream) {
                response.end(`${JSON.stringify({
                    message: { role: 'assistant', content: 'ok' },
                    done: true,
                    eval_count: 1,
                    eval_duration: 100000000
                })}\n`);
            } else if (request.url === '/api/chat') {
                response.end(JSON.stringify({
                    message: { content: '{"winner":"tiny:1b","ranking":[{"name":"tiny:1b","aiScore":90,"shortWhy":"fit"}]}' }
                }));
            } else {
                response.end(JSON.stringify({
                    response: 'ok',
                    eval_count: 1,
                    eval_duration: 100000000
                }));
            }
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-cpu-only-bin-'));
    const fakeOllamaPath = path.join(fakeBinDir, 'ollama');
    fs.writeFileSync(fakeOllamaPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    try {
        const port = server.address().port;
        const baseURL = `http://127.0.0.1:${port}`;
        const client = new OllamaClient({ baseURL, cpuOnly: true });

        await client.generate('tiny:1b', 'prompt', { generationOptions: { num_gpu: 99 } });
        await client.chat('tiny:1b', [{ role: 'user', content: 'prompt' }]);
        await client.streamChat('tiny:1b', [{ role: 'user', content: 'prompt' }]);
        await client.testModelPerformance('tiny:1b', 'benchmark');

        assert.strictEqual(requests.length, 4);
        for (const request of requests) {
            assert.strictEqual(
                request.payload.options?.num_gpu,
                0,
                `${request.url} must enforce num_gpu=0 in CPU-only mode`
            );
        }

        const explicitGpuAiCheck = new AICheckSelector({ cpuOnly: true, ollamaClient: client });
        await explicitGpuAiCheck.callOllamaEvaluator('tiny:1b', {
            hardware: { category: 'general', cpuOnly: false },
            candidates: [{ name: 'tiny:1b', paramsB: 1, quant: 'Q4', requiredGB: 1, installed: true }]
        });
        const explicitGpuRequest = requests[requests.length - 1];
        assert.strictEqual(explicitGpuRequest.url, '/api/chat');
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(explicitGpuRequest.payload.options || {}, 'num_gpu'),
            false,
            'AI Check per-call false must override a CPU-only selector/client'
        );

        let evaluatorOptions = null;
        const aiCheck = new AICheckSelector({
            cpuOnly: false,
            ollamaClient: {
                async chat(model, messages, options) {
                    evaluatorOptions = options;
                    return {
                        message: {
                            content: '{"winner":"tiny:1b","ranking":[{"name":"tiny:1b","aiScore":90,"shortWhy":"fit"}]}'
                        }
                    };
                }
            }
        });
        await aiCheck.callOllamaEvaluator('tiny:1b', {
            hardware: { category: 'general', cpuOnly: true },
            candidates: [{ name: 'tiny:1b', paramsB: 1, quant: 'Q4', requiredGB: 1, installed: true }]
        });
        assert.strictEqual(
            evaluatorOptions.generationOptions.num_gpu,
            0,
            'AI Check evaluator must force num_gpu=0 for a per-call CPU-only profile'
        );

        const cliEnv = {
            OLLAMA_HOST: baseURL,
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`
        };
        const requestsBeforeAiRun = requests.length;
        const benchmarkRun = await runCliAsync([
            'ai-run',
            '--models', 'tiny:1b',
            '--cpu-only',
            '--benchmark',
            '--reference-only'
        ], cliEnv);
        assert.strictEqual(
            benchmarkRun.status,
            0,
            stripAnsi(`${benchmarkRun.stdout}\n${benchmarkRun.stderr}`)
        );

        const promptRun = await runCliAsync([
            'ai-run',
            '--models', 'tiny:1b',
            '--cpu-only',
            '--prompt', 'say ok'
        ], cliEnv);
        assert.strictEqual(promptRun.status, 0, stripAnsi(`${promptRun.stdout}\n${promptRun.stderr}`));

        const aiRunRequests = requests.slice(requestsBeforeAiRun)
            .filter((request) => ['/api/generate', '/api/chat'].includes(request.url));
        assert.ok(
            aiRunRequests.some((request) => request.url === '/api/generate'),
            'ai-run --benchmark should reach the fake Ollama generate endpoint'
        );
        assert.ok(
            aiRunRequests.some((request) => request.url === '/api/chat' && request.payload.stream),
            'ai-run --prompt should reach the fake Ollama streaming chat endpoint'
        );
        assert.ok(
            aiRunRequests.every((request) => request.payload.options?.num_gpu === 0),
            'every ai-run inference request must carry num_gpu=0'
        );

        const humanRecommend = await runCliAsync([
            'recommend',
            '--simulate', 'rtx4090',
            '--cpu-only',
            '--runtime', 'mlx',
            '--no-registry',
            '--no-verbose',
            '--category', 'general'
        ], cliEnv);
        const humanOutput = stripAnsi(`${humanRecommend.stdout}\n${humanRecommend.stderr}`);
        assert.strictEqual(humanRecommend.status, 0, humanOutput);
        assert.match(humanOutput, /GPU:\s+Disabled by CPU-only mode/);
        assert.match(humanOutput, /Backend:\s+CPU/);
        assert.match(humanOutput, /VRAM:\s+Disabled \(CPU-only\)/);
        assert.ok(!humanOutput.includes('N/AGB (Integrated)'), humanOutput);
        assert.match(
            humanOutput,
            /Dedicated GPUs \(diagnostic\):\s+NVIDIA GeForce RTX 4090/,
            'the simulated RTX inventory must remain visible as diagnostics'
        );
        assert.match(humanOutput, /Runtime:\s+OLLAMA/);
        assert.ok(
            humanOutput.includes('MLX-LM is not compatible') && humanOutput.includes('using Ollama instead'),
            'human recommend output should explain the incompatible runtime fallback'
        );

        const humanAppleRecommend = await runCliAsync([
            'recommend',
            '--simulate', 'm4pro24',
            '--cpu-only',
            '--runtime', 'auto',
            '--no-registry',
            '--no-verbose',
            '--category', 'general'
        ], cliEnv);
        const appleOutput = stripAnsi(
            `${humanAppleRecommend.stdout}\n${humanAppleRecommend.stderr}`
        );
        assert.strictEqual(humanAppleRecommend.status, 0, appleOutput);
        assert.match(
            appleOutput,
            /Integrated GPUs \(diagnostic\):\s+Apple M4 Pro/,
            'the simulated unified GPU inventory must remain visible as diagnostics'
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
}

function testCliHelpAndJsonSmoke() {
    const commands = [
        'check',
        'recommend',
        'ai-check',
        'ai-run',
        'registry-recommend',
        'smart-recommend',
        'gpu-plan',
        'hw-detect'
    ];

    for (const command of commands) {
        const result = runCli([command, '--help']);
        const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
        assert.strictEqual(result.status, 0, `${command} --help failed: ${output}`);
        assert.ok(output.includes('--cpu-only'), `${command} --help must expose --cpu-only`);
    }

    const planResult = runCli(['gpu-plan', '--cpu-only', '--model-size', '1GB', '--json']);
    assert.strictEqual(planResult.status, 0, stripAnsi(planResult.stderr || planResult.stdout));
    const plan = JSON.parse(stripAnsi(planResult.stdout));
    assert.strictEqual(plan.cpuOnly, true);
    assert.strictEqual(plan.backend, 'cpu');
    assert.strictEqual(plan.gpuCount, 0);
    assert.strictEqual(plan.totalVRAM, 0);

    const detectResult = runCli(['hw-detect', '--json'], { [CPU_ONLY_ENV]: '1' });
    assert.strictEqual(detectResult.status, 0, stripAnsi(detectResult.stderr || detectResult.stdout));
    const detected = JSON.parse(stripAnsi(detectResult.stdout));
    assert.strictEqual(detected.cpuOnly, true);
    assert.strictEqual(detected.summary.bestBackend, 'cpu');
    assert.strictEqual(detected.summary.totalVRAM, 0);
    assert.ok(detected.detectedGpu, 'JSON diagnostics should retain the detected GPU record');

    const appleCheckResult = runCli([
        'check',
        '--simulate', 'm4pro24',
        '--cpu-only',
        '--no-verbose'
    ]);
    const appleCheckOutput = stripAnsi(
        `${appleCheckResult.stdout}\n${appleCheckResult.stderr}`
    );
    assert.strictEqual(appleCheckResult.status, 0, appleCheckOutput);
    assert.ok(!/metal acceleration/i.test(appleCheckOutput), appleCheckOutput);
    assert.ok(!/unified memory architecture advantage/i.test(appleCheckOutput), appleCheckOutput);

    const registryMlxResult = runCli([
        'registry-recommend',
        '--cpu-only',
        '--runtime', 'mlx',
        '--limit', '3',
        '--json'
    ]);
    assert.strictEqual(
        registryMlxResult.status,
        0,
        stripAnsi(registryMlxResult.stderr || registryMlxResult.stdout)
    );
    const registryMlx = JSON.parse(stripAnsi(registryMlxResult.stdout));
    assert.strictEqual(registryMlx.runtime, 'ollama');
    assert.ok(registryMlx.recommendations.length > 0);
    assert.ok(
        registryMlx.recommendations.every((recommendation) => recommendation.runtime === 'ollama'),
        'an explicit MLX registry request must fall back to CPU-compatible Ollama artifacts'
    );

    const registryAutoResult = runCli([
        'registry-recommend',
        '--cpu-only',
        '--runtime', 'auto',
        '--limit', '10',
        '--json'
    ]);
    assert.strictEqual(
        registryAutoResult.status,
        0,
        stripAnsi(registryAutoResult.stderr || registryAutoResult.stdout)
    );
    const registryAuto = JSON.parse(stripAnsi(registryAutoResult.stdout));
    assert.ok(registryAuto.recommendations.length > 0);
    assert.ok(
        registryAuto.recommendations.every((recommendation) => recommendation.runtime !== 'mlx'),
        'auto runtime must exclude MLX artifacts in CPU-only mode'
    );
}

async function run() {
    testProjectionUsesCpuAndRamOnly();
    testSimulatedProfileDiagnosticInference();
    await testDetectorCacheAndSimulationPrecedence();
    await testEnvironmentOptInAndExplicitFalse();
    await testRecommendationSurfaces();
    await testMultiObjectiveFallbackStaysCpuOnlyOnApple();
    testCpuGpuPlan();
    await testProbeModeAndCacheIsolation();
    await testOllamaCpuOnlyEnforcement();
    testCliHelpAndJsonSmoke();
    console.log('cpu-only-mode.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('cpu-only-mode.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
