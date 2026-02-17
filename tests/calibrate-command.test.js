const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const { spawnSync } = require('child_process');

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'enhanced_cli.js');

function stripAnsi(text = '') {
    return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function runCli(args, cwd) {
    return spawnSync(process.execPath, [BIN_PATH, ...args], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            NO_COLOR: '1'
        }
    });
}

function writeSuiteFile(filePath, lines) {
    const content = lines.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
}

function run() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-calibrate-'));

    try {
        const suitePath = path.join(tempDir, 'suite.jsonl');
        const outputPath = path.join(tempDir, 'calibration-result.json');
        const policyPath = path.join(tempDir, 'calibration-policy.yaml');
        const invalidSuitePath = path.join(tempDir, 'suite-invalid.jsonl');

        writeSuiteFile(suitePath, [
            {
                id: 'p1',
                task: 'coding',
                prompt: 'Write a binary search in JavaScript'
            },
            {
                id: 'p2',
                task: 'general',
                prompt: 'Explain why the sky is blue'
            }
        ]);

        fs.writeFileSync(invalidSuitePath, '{"prompt":"valid line"}\n{"broken"\n', 'utf8');

        const helpResult = runCli(['calibrate', '--help'], tempDir);
        assert.strictEqual(helpResult.status, 0, stripAnsi(helpResult.stderr || helpResult.stdout));
        assert.ok(
            stripAnsi(helpResult.stdout).includes('Generate calibration contract artifacts'),
            'calibrate help should describe command purpose'
        );

        const successResult = runCli(
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
                '--output',
                outputPath,
                '--policy-out',
                policyPath,
                '--dry-run'
            ],
            tempDir
        );

        assert.strictEqual(successResult.status, 0, stripAnsi(successResult.stderr || successResult.stdout));
        assert.ok(fs.existsSync(outputPath), 'calibration result artifact should be written');
        assert.ok(fs.existsSync(policyPath), 'calibration policy artifact should be written');

        const calibrationResult = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.strictEqual(calibrationResult.schema_version, '1.0');
        assert.strictEqual(calibrationResult.execution_mode, 'dry-run');
        assert.strictEqual(calibrationResult.runtime, 'ollama');
        assert.strictEqual(calibrationResult.objective, 'balanced');
        assert.strictEqual(calibrationResult.models.length, 2);
        assert.strictEqual(calibrationResult.summary.total_models, 2);
        assert.strictEqual(calibrationResult.summary.pending_models, 2);

        const calibrationPolicy = YAML.parse(fs.readFileSync(policyPath, 'utf8'));
        assert.strictEqual(calibrationPolicy.schema_version, '1.0');
        assert.ok(calibrationPolicy.routing.coding, 'policy should include coding route');
        assert.ok(calibrationPolicy.routing.general, 'policy should include general route');
        assert.strictEqual(
            calibrationPolicy.routing.coding.primary,
            'qwen2.5-coder:7b',
            'policy primary should be first model identifier'
        );
        assert.strictEqual(
            calibrationPolicy.routing.coding.fallbacks[0],
            'llama3.2:3b',
            'policy fallback should include second model identifier'
        );

        const invalidRuntimeResult = runCli(
            [
                'calibrate',
                '--suite',
                suitePath,
                '--models',
                'qwen2.5-coder:7b',
                '--runtime',
                'invalid-runtime',
                '--output',
                outputPath
            ],
            tempDir
        );
        assert.notStrictEqual(invalidRuntimeResult.status, 0, 'invalid runtime should fail');
        const invalidRuntimeOutput = stripAnsi(
            `${invalidRuntimeResult.stdout}\n${invalidRuntimeResult.stderr}`
        );
        assert.ok(
            invalidRuntimeOutput.includes('Unsupported runtime'),
            'invalid runtime output should mention unsupported runtime'
        );

        const unsupportedFullModeResult = runCli(
            [
                'calibrate',
                '--suite',
                suitePath,
                '--models',
                'qwen2.5-coder:7b',
                '--runtime',
                'vllm',
                '--mode',
                'full',
                '--output',
                outputPath
            ],
            tempDir
        );
        assert.notStrictEqual(
            unsupportedFullModeResult.status,
            0,
            'full mode should reject unsupported runtimes'
        );
        const unsupportedFullModeOutput = stripAnsi(
            `${unsupportedFullModeResult.stdout}\n${unsupportedFullModeResult.stderr}`
        );
        assert.ok(
            unsupportedFullModeOutput.includes('Full calibration mode currently supports'),
            'full mode runtime guard should be actionable'
        );

        const invalidModeResult = runCli(
            [
                'calibrate',
                '--suite',
                suitePath,
                '--models',
                'qwen2.5-coder:7b',
                '--mode',
                'not-a-mode',
                '--output',
                outputPath
            ],
            tempDir
        );
        assert.notStrictEqual(invalidModeResult.status, 0, 'invalid mode should fail');
        const invalidModeOutput = stripAnsi(`${invalidModeResult.stdout}\n${invalidModeResult.stderr}`);
        assert.ok(
            invalidModeOutput.includes('Invalid execution mode'),
            'invalid mode should return actionable validation guidance'
        );

        const conflictingModeResult = runCli(
            [
                'calibrate',
                '--suite',
                suitePath,
                '--models',
                'qwen2.5-coder:7b',
                '--mode',
                'full',
                '--dry-run',
                '--output',
                outputPath
            ],
            tempDir
        );
        assert.notStrictEqual(conflictingModeResult.status, 0, 'conflicting mode flags should fail');
        const conflictingModeOutput = stripAnsi(
            `${conflictingModeResult.stdout}\n${conflictingModeResult.stderr}`
        );
        assert.ok(
            conflictingModeOutput.includes('Do not combine --dry-run with --mode'),
            'conflicting mode flags should produce actionable guidance'
        );

        const invalidOutputPathResult = runCli(
            [
                'calibrate',
                '--suite',
                suitePath,
                '--models',
                'qwen2.5-coder:7b',
                '--dry-run',
                '--output',
                tempDir
            ],
            tempDir
        );
        assert.notStrictEqual(invalidOutputPathResult.status, 0, 'directory output path should fail');
        const invalidOutputPathOutput = stripAnsi(
            `${invalidOutputPathResult.stdout}\n${invalidOutputPathResult.stderr}`
        );
        assert.ok(
            invalidOutputPathOutput.includes('Output path must be a file'),
            'directory output path should return actionable guidance'
        );

        const invalidSuiteResult = runCli(
            [
                'calibrate',
                '--suite',
                invalidSuitePath,
                '--models',
                'qwen2.5-coder:7b',
                '--output',
                outputPath
            ],
            tempDir
        );
        assert.notStrictEqual(invalidSuiteResult.status, 0, 'invalid suite should fail');
        const invalidSuiteOutput = stripAnsi(
            `${invalidSuiteResult.stdout}\n${invalidSuiteResult.stderr}`
        );
        assert.ok(
            invalidSuiteOutput.includes('Invalid JSON in prompt suite at line 2'),
            'invalid suite output should include JSON line validation error'
        );

        console.log('calibrate-command.test.js: OK');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('calibrate-command.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
