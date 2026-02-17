const assert = require('assert');

const {
    buildComplianceReport,
    serializeComplianceReport,
    deterministicRuleId
} = require('../src/policy/audit-reporter');

function run() {
    const generatedAt = '2026-02-17T00:00:00.000Z';
    const rulePath = 'rules.compliance.approved_licenses';

    const report = buildComplianceReport({
        commandName: 'check',
        policyPath: './policy.yaml',
        policy: {
            org: 'fixture-org',
            mode: 'enforce',
            enforcement: {
                on_violation: 'error',
                allow_exceptions: false
            },
            reporting: {
                formats: ['json', 'csv', 'sarif']
            }
        },
        evaluation: {
            totalChecked: 2,
            passCount: 0,
            failCount: 2,
            exceptionsAppliedCount: 0,
            topViolations: [{ code: 'LICENSE_NOT_APPROVED', count: 1 }],
            findings: [
                {
                    status: 'active',
                    model_identifier: 'qwen2.5-coder:7b-instruct-q4_k_m',
                    model_name: 'Qwen 2.5 Coder',
                    source: 'ollama_database',
                    registry: 'ollama.com',
                    version: 'qwen2.5-coder:7b-instruct-q4_k_m',
                    license: 'mit',
                    digest: 'sha256:abc123',
                    violation: {
                        code: 'LICENSE_NOT_APPROVED',
                        path: rulePath,
                        message: 'License is not in approved list.',
                        expected: 'apache-2.0',
                        actual: 'mit'
                    }
                },
                {
                    status: 'active',
                    model_identifier: 'mystery-model:latest',
                    model_name: 'Mystery Model',
                    violation: {
                        code: 'LICENSE_MISSING',
                        path: rulePath,
                        message: 'License metadata missing.'
                    }
                }
            ]
        },
        enforcement: {
            shouldBlock: true,
            exitCode: 3,
            hasFailures: true,
            mode: 'enforce',
            onViolation: 'error'
        },
        runtimeContext: {
            backend: 'metal',
            runtimeBackend: 'ollama',
            ramGB: 64
        },
        options: {
            command: 'check'
        },
        hardware: {
            cpu: { brand: 'Apple M4 Pro', cores: 12 },
            memory: { total: 64 },
            gpu: { model: 'Apple GPU', vram: 24 }
        },
        generatedAt
    });

    assert.strictEqual(report.findings.length, 2, 'expected two findings');
    assert.strictEqual(
        report.findings[0].rule_id,
        deterministicRuleId('LICENSE_NOT_APPROVED', rulePath),
        'rule_id should be deterministic for given code/path'
    );
    assert.strictEqual(
        report.findings[1].source,
        'unknown',
        'missing provenance source should be explicit unknown'
    );
    assert.strictEqual(
        report.findings[1].registry,
        'unknown',
        'missing provenance registry should be explicit unknown'
    );
    assert.strictEqual(
        report.findings[1].version,
        'unknown',
        'missing provenance version should be explicit unknown'
    );
    assert.strictEqual(
        report.findings[1].license,
        'unknown',
        'missing provenance license should be explicit unknown'
    );
    assert.strictEqual(
        report.findings[1].digest,
        'unknown',
        'missing provenance digest should be explicit unknown'
    );

    const json = JSON.parse(serializeComplianceReport(report, 'json'));
    assert.strictEqual(json.findings.length, 2, 'json export should include all findings');

    const csv = serializeComplianceReport(report, 'csv');
    const csvLines = csv.trim().split('\n');
    assert.ok(csvLines[0].includes('rule_id'), 'csv header should include rule_id');
    assert.strictEqual(csvLines.length, 3, 'csv should include header + two rows');

    const sarif = JSON.parse(serializeComplianceReport(report, 'sarif'));
    assert.strictEqual(sarif.version, '2.1.0', 'sarif version should be 2.1.0');
    assert.ok(Array.isArray(sarif.runs) && sarif.runs.length === 1, 'sarif should include one run');
    assert.strictEqual(
        sarif.runs[0].results.length,
        2,
        'sarif should include one result per finding'
    );
    assert.ok(
        sarif.runs[0].tool.driver.rules.every((rule) => rule.id.startsWith('LLMCHECK-')),
        'sarif rules should use deterministic LLMCHECK identifiers'
    );

    console.log('policy-audit-reporter.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('policy-audit-reporter.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
