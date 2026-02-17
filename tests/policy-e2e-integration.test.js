const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const YAML = require('yaml');

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

function readPolicy(policyPath) {
    return YAML.parse(fs.readFileSync(policyPath, 'utf8'));
}

function writePolicy(policyPath, policy) {
    fs.writeFileSync(policyPath, YAML.stringify(policy), 'utf8');
}

function initPolicyFile(tempDir) {
    const policyPath = path.join(tempDir, 'policy.yaml');
    const initResult = runCli(['policy', 'init', '--file', policyPath], tempDir);
    assert.strictEqual(initResult.status, 0, stripAnsi(initResult.stderr || initResult.stdout));
    assert.ok(fs.existsSync(policyPath), 'policy.yaml should be created');
    return policyPath;
}

function runEnforceModeExportTest(tempDir, policyPath) {
    const outFile = path.join(tempDir, 'enforce-report.json');
    const result = runCli(
        [
            'audit',
            'export',
            '--policy',
            policyPath,
            '--command',
            'check',
            '--format',
            'json',
            '--runtime',
            'ollama',
            '--no-verbose',
            '--out',
            outFile
        ],
        tempDir
    );

    assert.strictEqual(
        result.status,
        3,
        `enforce mode should exit with configured non-zero code\nSTDOUT:\n${stripAnsi(result.stdout)}\nSTDERR:\n${stripAnsi(result.stderr)}`
    );
    assert.ok(fs.existsSync(outFile), 'enforce mode should still export a report');

    const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.strictEqual(report.policy.mode, 'enforce');
    assert.strictEqual(report.enforcement.should_block, true);
    assert.ok(report.summary.fail_count > 0, 'enforce report should contain blocking failures');
}

function runAuditAllFormatsTest(tempDir, policyPath) {
    const policy = readPolicy(policyPath);
    policy.mode = 'audit';
    writePolicy(policyPath, policy);

    const outDir = path.join(tempDir, 'audit-all');
    const result = runCli(
        [
            'audit',
            'export',
            '--policy',
            policyPath,
            '--command',
            'check',
            '--format',
            'all',
            '--runtime',
            'ollama',
            '--no-verbose',
            '--out-dir',
            outDir
        ],
        tempDir
    );

    assert.strictEqual(
        result.status,
        0,
        `audit mode should exit with code 0\nSTDOUT:\n${stripAnsi(result.stdout)}\nSTDERR:\n${stripAnsi(result.stderr)}`
    );

    const files = fs.readdirSync(outDir);
    const jsonReport = files.find((file) => file.endsWith('.json') && !file.endsWith('.sarif.json'));
    const csvReport = files.find((file) => file.endsWith('.csv'));
    const sarifReport = files.find((file) => file.endsWith('.sarif.json'));

    assert.ok(jsonReport, 'audit export should produce a JSON report');
    assert.ok(csvReport, 'audit export should produce a CSV report');
    assert.ok(sarifReport, 'audit export should produce a SARIF report');

    const jsonPayload = JSON.parse(fs.readFileSync(path.join(outDir, jsonReport), 'utf8'));
    assert.strictEqual(jsonPayload.policy.mode, 'audit');
    assert.ok(Array.isArray(jsonPayload.findings), 'json report should include findings array');

    if (jsonPayload.findings.length > 0) {
        const finding = jsonPayload.findings[0];
        assert.ok(typeof finding.source === 'string' && finding.source.length > 0, 'finding.source is required');
        assert.ok(typeof finding.registry === 'string' && finding.registry.length > 0, 'finding.registry is required');
        assert.ok(typeof finding.version === 'string' && finding.version.length > 0, 'finding.version is required');
        assert.ok(typeof finding.license === 'string' && finding.license.length > 0, 'finding.license is required');
        assert.ok(typeof finding.digest === 'string' && finding.digest.length > 0, 'finding.digest is required');
    }

    const csvHeader = fs.readFileSync(path.join(outDir, csvReport), 'utf8').split('\n')[0];
    assert.ok(csvHeader.includes('source'), 'csv report should include source column');
    assert.ok(csvHeader.includes('registry'), 'csv report should include registry column');
    assert.ok(csvHeader.includes('version'), 'csv report should include version column');
    assert.ok(csvHeader.includes('license'), 'csv report should include license column');
    assert.ok(csvHeader.includes('digest'), 'csv report should include digest column');

    const sarifPayload = JSON.parse(fs.readFileSync(path.join(outDir, sarifReport), 'utf8'));
    assert.strictEqual(sarifPayload.version, '2.1.0', 'sarif report should use SARIF v2.1.0');
}

function runExceptionsSuppressionTest(tempDir, policyPath) {
    const policy = readPolicy(policyPath);
    policy.mode = 'enforce';
    policy.enforcement = {
        ...(policy.enforcement || {}),
        allow_exceptions: true
    };
    policy.exceptions = [
        {
            model: '*',
            reason: 'CI blanket exception for policy pipeline test',
            approver: 'qa@example.com'
        }
    ];
    writePolicy(policyPath, policy);

    const outFile = path.join(tempDir, 'exceptions-report.json');
    const result = runCli(
        [
            'audit',
            'export',
            '--policy',
            policyPath,
            '--command',
            'check',
            '--format',
            'json',
            '--runtime',
            'ollama',
            '--no-verbose',
            '--out',
            outFile
        ],
        tempDir
    );

    assert.strictEqual(
        result.status,
        0,
        `exception-suppressed enforce run should exit with code 0\nSTDOUT:\n${stripAnsi(result.stdout)}\nSTDERR:\n${stripAnsi(result.stderr)}`
    );

    const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.strictEqual(report.enforcement.should_block, false);
    assert.strictEqual(report.summary.fail_count, 0, 'exceptions should clear active failures');

    if (report.summary.total_checked > 0) {
        assert.ok(report.summary.exceptions_applied > 0, 'exceptions should be applied to findings');
        assert.ok(report.summary.suppressed_violations > 0, 'violations should be marked as suppressed');
        assert.ok(
            report.findings.some((finding) => finding.status === 'suppressed'),
            'suppressed findings should be present'
        );
    }
}

function run() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-policy-e2e-'));

    try {
        const policyPath = initPolicyFile(tempDir);
        runEnforceModeExportTest(tempDir, policyPath);
        runAuditAllFormatsTest(tempDir, policyPath);
        runExceptionsSuppressionTest(tempDir, policyPath);
        console.log('policy-e2e-integration.test.js: OK');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('policy-e2e-integration.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
