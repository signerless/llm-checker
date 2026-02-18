const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'enhanced_cli.js');
const SAMPLE_SUITE = path.resolve(
    __dirname,
    '..',
    'docs',
    'fixtures',
    'calibration',
    'sample-suite.jsonl'
);

function stripAnsi(text = '') {
    return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function runCli(args, options = {}) {
    const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
        cwd: options.cwd || process.cwd(),
        encoding: 'utf8',
        timeout: options.timeoutMs || 120000,
        env: {
            ...process.env,
            NO_COLOR: '1'
        }
    });
    return {
        ...result,
        stdout: stripAnsi(result.stdout || ''),
        stderr: stripAnsi(result.stderr || '')
    };
}

function assertExitOk(result, context) {
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    assert.strictEqual(result.status, 0, `${context}\n${combined}`);
}

function run() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-local-e2e-'));
    try {
        const calibrationOutput = path.join(tempDir, 'calibration-result.json');
        const policyPath = path.join(tempDir, 'policy.yaml');
        const auditPath = path.join(tempDir, 'audit.json');

        const mcpSetupResult = runCli(['mcp-setup', '--json']);
        assertExitOk(mcpSetupResult, 'mcp-setup --json failed');
        const mcpSetup = JSON.parse(mcpSetupResult.stdout);
        assert.strictEqual(mcpSetup.recommended.command, 'claude');
        assert.ok(Array.isArray(mcpSetup.recommended.args) && mcpSetup.recommended.args.length >= 4);

        const hwDetectResult = runCli(['hw-detect', '--json']);
        assertExitOk(hwDetectResult, 'hw-detect --json failed');
        const hardware = JSON.parse(hwDetectResult.stdout);
        assert.ok(hardware && hardware.summary, 'hardware summary should exist');

        const checkResult = runCli(['check', '--use-case', 'general', '--limit', '1', '--runtime', 'ollama', '--no-verbose']);
        assertExitOk(checkResult, 'check command failed');
        assert.ok(checkResult.stdout.includes('RECOMMENDED MODEL'), 'check output should include recommendation block');

        const recommendResult = runCli(['recommend', '--no-verbose']);
        assertExitOk(recommendResult, 'recommend command failed');
        assert.ok(
            recommendResult.stdout.includes('INTELLIGENT RECOMMENDATIONS BY CATEGORY'),
            'recommend output should include recommendations section'
        );

        const calibrateResult = runCli([
            'calibrate',
            '--suite',
            SAMPLE_SUITE,
            '--models',
            'qwen2.5-coder:7b,llama3.2:3b',
            '--output',
            calibrationOutput,
            '--dry-run'
        ]);
        assertExitOk(calibrateResult, 'calibrate command failed');
        assert.ok(fs.existsSync(calibrationOutput), 'calibration output should exist');
        const calibrationJson = JSON.parse(fs.readFileSync(calibrationOutput, 'utf8'));
        assert.strictEqual(calibrationJson.execution_mode, 'dry-run');

        const policyInitResult = runCli(['policy', 'init', '--file', policyPath, '--force']);
        assertExitOk(policyInitResult, 'policy init failed');
        assert.ok(fs.existsSync(policyPath), 'policy file should exist');

        let policyContent = fs.readFileSync(policyPath, 'utf8');
        policyContent = policyContent.replace(/mode:\s*enforce/g, 'mode: audit');
        fs.writeFileSync(policyPath, policyContent, 'utf8');

        const policyValidateResult = runCli(['policy', 'validate', '--file', policyPath]);
        assertExitOk(policyValidateResult, 'policy validate failed');

        const auditResult = runCli([
            'audit',
            'export',
            '--policy',
            policyPath,
            '--command',
            'recommend',
            '--format',
            'json',
            '--out',
            auditPath,
            '--runtime',
            'ollama',
            '--optimize',
            'balanced',
            '--no-verbose'
        ]);
        assertExitOk(auditResult, 'audit export failed');
        assert.ok(fs.existsSync(auditPath), 'audit output should exist');
        const auditJson = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
        assert.strictEqual(auditJson.command, 'recommend');

        console.log('local-features-e2e.test.js: OK');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('local-features-e2e.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
