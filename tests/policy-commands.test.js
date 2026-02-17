const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

function run() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-policy-'));

    try {
        const policyPath = path.join(tempDir, 'policy.yaml');
        const customPolicyPath = path.join(tempDir, 'configs', 'policy-custom.yaml');

        const initResult = runCli(['policy', 'init'], tempDir);
        assert.strictEqual(initResult.status, 0, stripAnsi(initResult.stderr || initResult.stdout));
        assert.ok(fs.existsSync(policyPath), 'policy.yaml should be created by policy init');

        const initAgainResult = runCli(['policy', 'init'], tempDir);
        assert.notStrictEqual(initAgainResult.status, 0, 'policy init should fail if file already exists');
        assert.ok(
            stripAnsi(initAgainResult.stderr).includes('already exists'),
            'policy init error should mention existing file'
        );

        const validateResult = runCli(['policy', 'validate'], tempDir);
        assert.strictEqual(validateResult.status, 0, stripAnsi(validateResult.stderr || validateResult.stdout));
        assert.ok(
            stripAnsi(validateResult.stdout).toLowerCase().includes('policy is valid'),
            'validation success message should be shown'
        );

        const customInitResult = runCli(['policy', 'init', '--file', 'configs/policy-custom.yaml'], tempDir);
        assert.strictEqual(customInitResult.status, 0, stripAnsi(customInitResult.stderr || customInitResult.stdout));
        assert.ok(fs.existsSync(customPolicyPath), 'custom policy path should be created');

        fs.writeFileSync(policyPath, `version: "x"
org: ""
mode: invalid
rules: "bad"
reporting:
  formats: ["json", "xml"]
`, 'utf8');

        const invalidResult = runCli(['policy', 'validate'], tempDir);
        assert.notStrictEqual(invalidResult.status, 0, 'invalid policy should fail validation');
        const invalidOutput = `${stripAnsi(invalidResult.stdout)}\n${stripAnsi(invalidResult.stderr)}`;
        assert.ok(invalidOutput.includes('mode'), 'validation output should include mode error');
        assert.ok(invalidOutput.includes('rules'), 'validation output should include rules error');

        const invalidJsonResult = runCli(['policy', 'validate', '--json'], tempDir);
        assert.notStrictEqual(invalidJsonResult.status, 0, 'invalid policy should fail in JSON mode');
        const payload = JSON.parse(invalidJsonResult.stdout);
        assert.strictEqual(payload.valid, false, 'JSON payload should mark policy as invalid');
        assert.ok(payload.errorCount >= 1, 'JSON payload should include one or more errors');
        assert.ok(Array.isArray(payload.errors), 'JSON payload should include errors array');

        console.log('policy-commands.test.js: OK');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('policy-commands.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
