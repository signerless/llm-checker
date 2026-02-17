const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const { spawnSync } = require('child_process');

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'enhanced_cli.js');
const DOC_FIXTURES_DIR = path.resolve(__dirname, '..', 'docs', 'fixtures', 'calibration');

function stripAnsi(text = '') {
    return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function runCli(args, cwd, homeDir) {
    return spawnSync(process.execPath, [BIN_PATH, ...args], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
            NO_COLOR: '1'
        }
    });
}

function writeDeterministicOllamaCache(homeDir) {
    const cacheDir = path.join(homeDir, '.llm-checker', 'cache', 'ollama');
    fs.mkdirSync(cacheDir, { recursive: true });

    const models = [
        {
            model_identifier: 'qwen2.5-coder',
            model_name: 'qwen2.5-coder',
            description: 'Synthetic coding model for calibration E2E',
            primary_category: 'coding',
            context_length: '32K',
            variants: [
                {
                    tag: 'qwen2.5-coder:7b',
                    size: '7b',
                    quantization: 'Q4_0',
                    real_size_gb: 4.9,
                    categories: ['coding'],
                    family: 'qwen2.5'
                }
            ],
            tags: ['qwen2.5-coder:7b'],
            use_cases: ['coding', 'programming']
        },
        {
            model_identifier: 'llama3.2',
            model_name: 'llama3.2',
            description: 'Synthetic general model for calibration E2E',
            primary_category: 'general',
            context_length: '8K',
            variants: [
                {
                    tag: 'llama3.2:3b',
                    size: '3b',
                    quantization: 'Q4_0',
                    real_size_gb: 2.2,
                    categories: ['general'],
                    family: 'llama3.2'
                }
            ],
            tags: ['llama3.2:3b'],
            use_cases: ['general', 'chat']
        }
    ];

    const payload = {
        models,
        total_count: models.length,
        cached_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    };

    fs.writeFileSync(
        path.join(cacheDir, 'ollama-detailed-models.json'),
        JSON.stringify(payload, null, 2),
        'utf8'
    );
}

function copyFixtureSuite(tempDir) {
    const fixturePath = path.join(DOC_FIXTURES_DIR, 'sample-suite.jsonl');
    const suitePath = path.join(tempDir, 'sample-suite.jsonl');
    fs.copyFileSync(fixturePath, suitePath);
    return suitePath;
}

function run() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-calibration-e2e-'));
    const homeDir = path.join(tempDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });

    try {
        const suitePath = copyFixtureSuite(tempDir);
        writeDeterministicOllamaCache(homeDir);

        const resultPath = path.join(tempDir, 'calibration-result.json');
        const policyPath = path.join(tempDir, 'calibration-policy.yaml');

        const calibrateResult = runCli(
            [
                'calibrate',
                '--suite',
                suitePath,
                '--models',
                'qwen2.5-coder:7b,llama3.2:3b',
                '--runtime',
                'ollama',
                '--objective',
                'balanced',
                '--dry-run',
                '--output',
                resultPath,
                '--policy-out',
                policyPath
            ],
            tempDir,
            homeDir
        );

        assert.strictEqual(
            calibrateResult.status,
            0,
            `calibrate command should succeed\nSTDOUT:\n${stripAnsi(calibrateResult.stdout)}\nSTDERR:\n${stripAnsi(calibrateResult.stderr)}`
        );
        assert.ok(fs.existsSync(resultPath), 'calibration result artifact should exist');
        assert.ok(fs.existsSync(policyPath), 'calibration policy artifact should exist');

        const generatedPolicy = YAML.parse(fs.readFileSync(policyPath, 'utf8'));
        assert.strictEqual(generatedPolicy.schema_version, '1.0');
        assert.ok(generatedPolicy.routing.coding, 'generated policy should include coding route');
        assert.ok(generatedPolicy.routing.general, 'generated policy should include general route');

        const recommendResult = runCli(
            [
                'recommend',
                '--calibrated',
                policyPath,
                '--category',
                'coding',
                '--no-verbose'
            ],
            tempDir,
            homeDir
        );

        assert.strictEqual(
            recommendResult.status,
            0,
            `recommend with calibrated policy should succeed\nSTDOUT:\n${stripAnsi(recommendResult.stdout)}\nSTDERR:\n${stripAnsi(recommendResult.stderr)}`
        );

        const recommendOutput = stripAnsi(`${recommendResult.stdout}\n${recommendResult.stderr}`);
        assert.ok(
            recommendOutput.includes('CALIBRATED ROUTING'),
            'recommend output should include calibrated routing block'
        );
        assert.ok(
            recommendOutput.includes('Source: --calibrated'),
            'recommend output should report calibrated source'
        );
        assert.ok(
            /Route primary:\s+qwen2\.5-coder:7b/.test(recommendOutput),
            'recommend output should show policy route primary model'
        );
        assert.ok(
            /Selected model:\s+qwen2\.5-coder:7b/.test(recommendOutput),
            'recommend output should resolve selected model from calibrated route'
        );

        console.log('calibration-e2e-integration.test.js: OK');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('calibration-e2e-integration.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
