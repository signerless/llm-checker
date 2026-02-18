const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const OllamaClient = require('../src/ollama/client');
const fetch = require('../src/utils/fetch');
const DeterministicModelSelector = require('../src/models/deterministic-selector');
const AICheckSelector = require('../src/models/ai-check-selector');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.resolve(ROOT, 'bin', 'enhanced_cli.js');

function stripAnsi(text = '') {
    return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function roundToSingleDecimal(value) {
    return Math.round(Number(value || 0) * 10) / 10;
}

function isCloudPlaceholder(model) {
    const name = String(model?.name || '').toLowerCase();
    const source = String(model?.source || '').toLowerCase();
    const type = String(model?.type || model?.model_type || '').toLowerCase();
    const fileSizeGB = Number(model?.fileSizeGB) || 0;

    const cloudTagged = (
        name.includes('-cloud') ||
        name.endsWith(':cloud') ||
        source.includes('cloud') ||
        type === 'cloud' ||
        type === 'remote' ||
        type === 'hosted'
    );

    return cloudTagged && fileSizeGB <= 0;
}

function parseModelSizeB(sizeLabel = '') {
    const match = String(sizeLabel).trim().toUpperCase().match(/^(\d+\.?\d*)\s*([BM])$/);
    if (!match) return 1;
    const value = parseFloat(match[1]);
    return match[2] === 'M' ? value / 1000 : value;
}

function runCli(args) {
    return spawnSync(process.execPath, [CLI, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' }
    });
}

async function run() {
    const client = new OllamaClient('http://localhost:11434');
    const availability = await client.checkOllamaAvailability();
    assert.strictEqual(
        availability.available,
        true,
        `Ollama must be available for real integration test. Details: ${JSON.stringify(availability)}`
    );

    const versionResponse = await fetch('http://localhost:11434/api/version', {
        headers: { 'Content-Type': 'application/json' }
    });
    assert(versionResponse.ok, `Expected /api/version to return HTTP 200, got ${versionResponse.status}`);
    const versionBody = await versionResponse.json();
    assert(versionBody.version, 'Expected version payload from Ollama');

    const fallbackFetchScript = `
globalThis.fetch = undefined;
const fetch = require('./src/utils/fetch');
fetch('http://localhost:11434/api/version', { headers: { 'Content-Type': 'application/json' } })
  .then(async (res) => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    if (!body.version) throw new Error('Missing version');
    process.stdout.write(body.version);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
`;
    const fallbackFetchResult = spawnSync(process.execPath, ['-e', fallbackFetchScript], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' }
    });
    assert.strictEqual(
        fallbackFetchResult.status,
        0,
        `node-fetch fallback path failed: ${fallbackFetchResult.stderr || fallbackFetchResult.stdout}`
    );

    const localModels = await client.getLocalModels();
    assert(localModels.length > 0, 'Expected at least one local Ollama model');
    const runnableModels = localModels.filter((model) => !isCloudPlaceholder(model) && Number(model.fileSizeGB) > 0);
    assert(runnableModels.length > 0, 'Expected at least one runnable local model (non-cloud)');

    const probeModel = [...runnableModels].sort((a, b) => a.fileSizeGB - b.fileSizeGB)[0];
    const probeModelSizeB = parseModelSizeB(probeModel.size);

    const generationPrompt = 'Explica en 80 palabras por que las pruebas de integracion son utiles.';
    const generationRequest = {
        model: probeModel.name,
        prompt: generationPrompt,
        stream: false,
        options: { num_predict: 120, temperature: 0.2 }
    };

    const generationStartMs = Date.now();
    const generationResponse = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(generationRequest)
    });
    assert(generationResponse.ok, `Expected /api/generate to return 200, got ${generationResponse.status}`);
    const generationData = await generationResponse.json();
    const totalTimeMs = Date.now() - generationStartMs;

    assert((Number(generationData.eval_count) || 0) > 0, 'Expected eval_count > 0 from real generation');

    const speed = client.calculateTokensPerSecond(generationData, totalTimeMs);
    const expectedEvalTokensPerSecond = Number(generationData.eval_duration) > 0
        ? roundToSingleDecimal(Number(generationData.eval_count) / (Number(generationData.eval_duration) / 1_000_000_000))
        : 0;
    const expectedEndToEndTokensPerSecond = roundToSingleDecimal(
        Number(generationData.eval_count) / Math.max(totalTimeMs / 1000, 0.001)
    );
    const expectedPreferred = expectedEvalTokensPerSecond > 0
        ? expectedEvalTokensPerSecond
        : expectedEndToEndTokensPerSecond;

    assert.strictEqual(
        speed.evalTokensPerSecond,
        expectedEvalTokensPerSecond,
        `Eval throughput mismatch. Expected ${expectedEvalTokensPerSecond}, got ${speed.evalTokensPerSecond}`
    );
    assert.strictEqual(
        speed.endToEndTokensPerSecond,
        expectedEndToEndTokensPerSecond,
        `End-to-end throughput mismatch. Expected ${expectedEndToEndTokensPerSecond}, got ${speed.endToEndTokensPerSecond}`
    );
    assert.strictEqual(
        speed.tokensPerSecond,
        expectedPreferred,
        `Preferred throughput mismatch. Expected ${expectedPreferred}, got ${speed.tokensPerSecond}`
    );

    const performance = await client.testModelPerformance(probeModel.name, 'Responde solo: ok');
    assert.strictEqual(performance.success, true, 'Expected testModelPerformance success');
    assert(performance.tokensPerSecond > 0, `Expected positive tokensPerSecond, got ${performance.tokensPerSecond}`);
    assert(
        Number.isFinite(performance.evalTokensPerSecond) && Number.isFinite(performance.endToEndTokensPerSecond),
        'Expected evalTokensPerSecond and endToEndTokensPerSecond in performance result'
    );
    if (performance.evalTokensPerSecond > 0) {
        assert.strictEqual(
            performance.tokensPerSecond,
            performance.evalTokensPerSecond,
            'When eval throughput exists, tokensPerSecond must match eval throughput'
        );
    }

    const deterministicSelector = new DeterministicModelSelector();
    const probeTPS = await deterministicSelector.runSingleProbe(probeModel.name, 'general');
    assert(Number.isFinite(probeTPS) && probeTPS > 0, `Expected positive real probe TPS, got ${probeTPS}`);

    const aiCheckSelector = new AICheckSelector();
    const aiResult = await aiCheckSelector.callOllamaEvaluator(probeModel.name, {
        hardware: { category: 'general' },
        candidates: [
            {
                name: probeModel.name,
                paramsB: probeModelSizeB,
                quant: String(probeModel.quantization || 'Q4'),
                requiredGB: Math.max(1, Number(probeModel.fileSizeGB) || 1),
                budgetGB: 24,
                installed: true
            }
        ]
    });
    assert.strictEqual(aiResult.winner, probeModel.name, `Expected evaluator winner to be ${probeModel.name}`);
    assert(Array.isArray(aiResult.ranking), 'Expected ranking array in evaluator response');
    assert.strictEqual(aiResult.ranking.length, 1, 'Expected single ranking entry with one candidate');
    assert.strictEqual(aiResult.ranking[0].name, probeModel.name, 'Expected ranking to include selected probe model');

    const planResult = runCli(['ollama-plan', '--json']);
    assert.strictEqual(
        planResult.status,
        0,
        `ollama-plan --json failed: ${stripAnsi(planResult.stderr || planResult.stdout)}`
    );
    const planPayload = JSON.parse(planResult.stdout);
    const selectedModels = planPayload.selection?.selected || [];
    assert(selectedModels.length > 0, 'Expected selected models from ollama-plan');
    assert(
        selectedModels.every((name) => !/-cloud|:cloud$/i.test(String(name))),
        `Cloud placeholder models should be excluded from default plan selection: ${selectedModels.join(', ')}`
    );

    const cloudPlaceholder = localModels.find((model) => isCloudPlaceholder(model));
    if (cloudPlaceholder) {
        assert(
            !selectedModels.includes(cloudPlaceholder.name),
            `Cloud placeholder model ${cloudPlaceholder.name} must not be in default selected models`
        );

        const cloudOnlyResult = runCli(['ollama-plan', '--models', cloudPlaceholder.name, '--json']);
        assert.notStrictEqual(
            cloudOnlyResult.status,
            0,
            'Expected non-zero exit when planning only a cloud placeholder model'
        );
        const cloudOutput = stripAnsi(`${cloudOnlyResult.stdout}\n${cloudOnlyResult.stderr}`);
        assert(
            cloudOutput.includes('No matching local models found'),
            `Expected cloud-only selection to fail with local model message. Output: ${cloudOutput}`
        );
    }

    const singleModelPlanResult = runCli(['ollama-plan', '--models', probeModel.name, '--json']);
    assert.strictEqual(
        singleModelPlanResult.status,
        0,
        `ollama-plan for ${probeModel.name} failed: ${stripAnsi(singleModelPlanResult.stderr || singleModelPlanResult.stdout)}`
    );
    const singleModelPlan = JSON.parse(singleModelPlanResult.stdout);
    assert.deepStrictEqual(singleModelPlan.selection.selected, [probeModel.name]);
    assert(
        singleModelPlan.plan?.memory?.recommendedEstimatedGB <= (singleModelPlan.plan?.memory?.budgetGB + 0.2),
        'Expected recommended memory to fit within budget for single-model plan'
    );

    console.log('ollama-client-speed-metrics.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('ollama-client-speed-metrics.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
