const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PolicyManager = require('../src/policy/policy-manager');
const PolicyEngine = require('../src/policy/policy-engine');
const {
    attachStructuralVerification,
    resolveOllamaBlobPath
} = require('../src/policy/structural-validation');
const {
    evaluatePolicyCandidatesAsync,
    resolvePolicyEnforcement
} = require('../src/policy/cli-policy');
const { buildComplianceReport, serializeComplianceReport } = require('../src/policy/audit-reporter');
const modelvet = require('../src/security/modelvet-verifier');

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'enhanced_cli.js');

// Isolate HOME so the spawned CLI resolves its model DB under a throwaway dir.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-home-'));

function runCli(args, cwd) {
    return spawnSync(process.execPath, [BIN_PATH, ...args], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            NO_COLOR: '1',
            HOME: TEST_HOME,
            USERPROFILE: TEST_HOME
        }
    });
}

function buildGguf({ version = 3, tensors = 0n, kvs = 0n } = {}) {
    const buf = Buffer.alloc(24);
    buf.write('GGUF', 0, 'ascii');
    buf.writeUInt32LE(version, 4);
    buf.writeBigUInt64LE(tensors, 8);
    buf.writeBigUInt64LE(kvs, 16);
    return buf;
}

const FAKE_DIGESTS = {
    ok: 'a'.repeat(64),
    bad: 'b'.repeat(64)
};

function writeFakeOllamaModel(modelsDir, name, tag, digest, blobBytes) {
    const manifestDir = path.join(
        modelsDir,
        'manifests',
        'registry.ollama.ai',
        'library',
        name
    );
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
        path.join(manifestDir, tag),
        JSON.stringify({
            schemaVersion: 2,
            mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            layers: [
                {
                    mediaType: 'application/vnd.ollama.image.model',
                    digest: `sha256:${digest}`,
                    size: blobBytes.length
                }
            ]
        }),
        'utf8'
    );

    const blobsDir = path.join(modelsDir, 'blobs');
    fs.mkdirSync(blobsDir, { recursive: true });
    const blobPath = path.join(blobsDir, `sha256-${digest}`);
    fs.writeFileSync(blobPath, blobBytes);
    return blobPath;
}

// Synthesize a fake Ollama layout: fake-ok:latest (valid GGUF v3 -> ACCEPT)
// and fake-bad:latest (GGUF version 99 -> REJECT, code 101).
function makeFakeOllama(rootDir) {
    const modelsDir = path.join(rootDir, 'models');
    const okBlob = writeFakeOllamaModel(modelsDir, 'fake-ok', 'latest', FAKE_DIGESTS.ok, buildGguf());
    const badBlob = writeFakeOllamaModel(
        modelsDir,
        'fake-bad',
        'latest',
        FAKE_DIGESTS.bad,
        buildGguf({ version: 99 })
    );
    return { modelsDir, okBlob, badBlob, env: { OLLAMA_MODELS: modelsDir } };
}

function basePolicy(overrides = {}) {
    return {
        version: 1,
        org: 'structural-test',
        mode: 'audit',
        rules: {},
        ...overrides
    };
}

function structuralPolicy(mode, structuralRules = { enabled: true }, extra = {}) {
    return basePolicy({
        mode,
        rules: { structural_validation: structuralRules },
        ...extra
    });
}

function makeCandidates() {
    return [
        {
            model_identifier: 'fake-ok:latest',
            tag: 'fake-ok:latest',
            name: 'fake-ok:latest',
            source: 'ollama'
        },
        {
            model_identifier: 'fake-bad:latest',
            tag: 'fake-bad:latest',
            name: 'fake-bad:latest',
            source: 'ollama'
        },
        {
            model_identifier: 'ghost:latest',
            tag: 'ghost:latest',
            name: 'ghost:latest',
            source: 'static_database'
        }
    ];
}

function testSchemaValidation() {
    const manager = new PolicyManager();

    const valid = manager.validatePolicyObject(
        structuralPolicy('enforce', { enabled: true, on_unverifiable: 'fail' })
    );
    assert.strictEqual(valid.valid, true, `expected valid policy, got: ${JSON.stringify(valid.errors)}`);

    const warnDefault = manager.validatePolicyObject(structuralPolicy('audit', {}));
    assert.strictEqual(warnDefault.valid, true, 'empty structural_validation object should be valid');

    const badOnUnverifiable = manager.validatePolicyObject(
        structuralPolicy('audit', { on_unverifiable: 'ignore' })
    );
    assert.strictEqual(badOnUnverifiable.valid, false);
    assert.ok(
        badOnUnverifiable.errors.some(
            (entry) => entry.path === 'rules.structural_validation.on_unverifiable'
        ),
        'on_unverifiable outside warn|fail should be rejected'
    );

    const badEnabled = manager.validatePolicyObject(
        structuralPolicy('audit', { enabled: 'yes' })
    );
    assert.strictEqual(badEnabled.valid, false);
    assert.ok(
        badEnabled.errors.some((entry) => entry.path === 'rules.structural_validation.enabled'),
        'non-boolean enabled should be rejected'
    );

    const nonObject = manager.validatePolicyObject(
        basePolicy({ rules: { structural_validation: 'always' } })
    );
    assert.strictEqual(nonObject.valid, false);
    assert.ok(
        nonObject.errors.some((entry) => entry.path === 'rules.structural_validation'),
        'non-object structural_validation should be rejected'
    );

    // The `policy init` template must include the rule and remain valid.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-structural-template-'));
    try {
        const templatePath = path.join(tempDir, 'policy.yaml');
        fs.writeFileSync(templatePath, manager.getTemplate(), 'utf8');
        const templateValidation = manager.validatePolicyFile(templatePath);
        assert.strictEqual(
            templateValidation.valid,
            true,
            `init template should validate, got: ${JSON.stringify(templateValidation.errors)}`
        );
        assert.ok(
            templateValidation.policy.rules.structural_validation,
            'init template should include rules.structural_validation'
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function testCliValidate() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-structural-cli-'));
    try {
        const initResult = runCli(['policy', 'init'], tempDir);
        assert.strictEqual(initResult.status, 0, initResult.stderr);

        const validateResult = runCli(['policy', 'validate'], tempDir);
        assert.strictEqual(
            validateResult.status,
            0,
            `template with structural_validation should validate: ${validateResult.stderr}`
        );

        fs.writeFileSync(
            path.join(tempDir, 'policy.yaml'),
            [
                'version: 1',
                'org: structural-test',
                'mode: audit',
                'rules:',
                '  structural_validation:',
                '    on_unverifiable: explode',
                ''
            ].join('\n'),
            'utf8'
        );

        const invalidResult = runCli(['policy', 'validate'], tempDir);
        assert.notStrictEqual(
            invalidResult.status,
            0,
            'invalid on_unverifiable should fail policy validate'
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function testBlobResolution(fake) {
    assert.strictEqual(
        resolveOllamaBlobPath('fake-ok:latest', { env: fake.env }),
        fake.okBlob,
        'explicit tag should resolve to the blob'
    );
    assert.strictEqual(
        resolveOllamaBlobPath('fake-ok', { env: fake.env }),
        fake.okBlob,
        'missing tag should default to latest'
    );
    assert.strictEqual(
        resolveOllamaBlobPath('library/fake-ok:latest', { env: fake.env }),
        fake.okBlob,
        'explicit library namespace should resolve'
    );
    assert.strictEqual(
        resolveOllamaBlobPath('ghost:latest', { env: fake.env }),
        null,
        'uninstalled model should not resolve'
    );
}

async function testAttachAndCache(fake) {
    assert.strictEqual(modelvet.isAvailable(), true, 'modelvet.wasm artifact should exist');

    let verifyCalls = 0;
    const countingVerifier = {
        verifyFile: async (filePath) => {
            verifyCalls += 1;
            return modelvet.verifyFile(filePath);
        }
    };

    const candidates = [
        { model_identifier: 'fake-ok:latest', tag: 'fake-ok:latest' },
        { model_identifier: 'fake-ok:latest', tag: 'fake-ok:latest', name: 'duplicate' },
        { model_identifier: 'fake-bad:latest', tag: 'fake-bad:latest' },
        { model_identifier: 'ghost:latest', tag: 'ghost:latest' }
    ];

    const attached = await attachStructuralVerification(candidates, {
        env: fake.env,
        verifier: countingVerifier
    });

    assert.strictEqual(verifyCalls, 2, 'each unique file should be verified exactly once');

    assert.deepStrictEqual(attached[0].verification, {
        verdict: 'accept',
        violation_code: 0,
        violation_name: 'NONE',
        offset: 0
    });
    assert.deepStrictEqual(
        attached[1].verification,
        attached[0].verification,
        'shared blob should reuse the cached verification'
    );
    assert.deepStrictEqual(attached[2].verification, {
        verdict: 'reject',
        violation_code: 101,
        violation_name: 'VERSION_UNSUPPORTED',
        offset: 4
    });
    assert.strictEqual(attached[3].verification.verdict, 'not_applicable');
    assert.ok(
        typeof attached[3].verification.reason === 'string' &&
            attached[3].verification.reason.length > 0,
        'not_applicable should carry a reason'
    );
}

function testEngineEvaluation() {
    const engine = new PolicyEngine(structuralPolicy('enforce'));
    assert.strictEqual(engine.hasActiveRules(), true, 'structural rule should count as active');

    const rejected = engine.evaluateModel({
        model_identifier: 'fake-bad:latest',
        verification: {
            verdict: 'reject',
            violation_code: 101,
            violation_name: 'VERSION_UNSUPPORTED',
            offset: 4
        }
    });
    assert.strictEqual(rejected.pass, false);
    assert.ok(
        rejected.violations.some((v) => v.code === 'STRUCTURAL_VALIDATION_FAILED'),
        'reject verdict should produce STRUCTURAL_VALIDATION_FAILED'
    );

    const accepted = engine.evaluateModel({
        model_identifier: 'fake-ok:latest',
        verification: { verdict: 'accept', violation_code: 0, violation_name: 'NONE', offset: 0 }
    });
    assert.strictEqual(accepted.pass, true);
    assert.strictEqual(accepted.violationCount, 0);

    const notApplicable = engine.evaluateModel({
        model_identifier: 'ghost:latest',
        verification: { verdict: 'not_applicable', reason: 'no local model file resolved' }
    });
    assert.strictEqual(notApplicable.pass, true, 'catalog-only candidates must not violate');

    const unevaluated = engine.evaluateModel({ model_identifier: 'ghost:latest' });
    assert.strictEqual(
        unevaluated.pass,
        true,
        'candidates without attached verification must not violate'
    );

    const disabled = new PolicyEngine(structuralPolicy('enforce', { enabled: false }));
    assert.strictEqual(disabled.hasActiveRules(), false);
    const disabledResult = disabled.evaluateModel({
        model_identifier: 'fake-bad:latest',
        verification: {
            verdict: 'reject',
            violation_code: 101,
            violation_name: 'VERSION_UNSUPPORTED',
            offset: 4
        }
    });
    assert.strictEqual(disabledResult.pass, true, 'enabled: false should disable the rule');
}

async function testAuditAndEnforceModes(fake) {
    // Audit mode: violations are reported but never block.
    const auditPolicy = structuralPolicy('audit');
    const auditEngine = new PolicyEngine(auditPolicy);
    const auditEvaluation = await evaluatePolicyCandidatesAsync(
        auditEngine,
        makeCandidates(),
        {},
        auditPolicy,
        { env: fake.env }
    );

    assert.strictEqual(auditEvaluation.totalChecked, 3);
    assert.strictEqual(auditEvaluation.failCount, 1, 'only fake-bad should fail');
    assert.ok(
        auditEvaluation.topViolations.some((entry) => entry.code === 'STRUCTURAL_VALIDATION_FAILED'),
        'audit evaluation should surface the structural violation'
    );

    const auditEnforcement = resolvePolicyEnforcement(auditPolicy, auditEvaluation);
    assert.strictEqual(auditEnforcement.mode, 'audit');
    assert.strictEqual(auditEnforcement.hasFailures, true);
    assert.strictEqual(auditEnforcement.shouldBlock, false, 'audit mode must not block');
    assert.strictEqual(auditEnforcement.exitCode, 0, 'audit mode exits 0 even with violations');

    // Enforce mode: a REJECT verdict blocks with a non-zero exit code.
    const enforcePolicy = structuralPolicy('enforce', { enabled: true }, {
        enforcement: { on_violation: 'error', exit_code: 3 }
    });
    const enforceEngine = new PolicyEngine(enforcePolicy);
    const enforceEvaluation = await evaluatePolicyCandidatesAsync(
        enforceEngine,
        makeCandidates(),
        {},
        enforcePolicy,
        { env: fake.env }
    );

    const enforceResult = resolvePolicyEnforcement(enforcePolicy, enforceEvaluation);
    assert.strictEqual(enforceResult.mode, 'enforce');
    assert.strictEqual(enforceResult.shouldBlock, true, 'enforce mode must block on REJECT');
    assert.strictEqual(enforceResult.exitCode, 3, 'configured exit_code should be used');

    // Enforcement defaults to exit code 1 when none is configured.
    const defaultExitPolicy = structuralPolicy('enforce');
    const defaultExitEvaluation = await evaluatePolicyCandidatesAsync(
        new PolicyEngine(defaultExitPolicy),
        makeCandidates(),
        {},
        defaultExitPolicy,
        { env: fake.env }
    );
    const defaultExit = resolvePolicyEnforcement(defaultExitPolicy, defaultExitEvaluation);
    assert.strictEqual(defaultExit.shouldBlock, true);
    assert.strictEqual(defaultExit.exitCode, 1);

    // The catalog-only candidate is evaluated as not_applicable, not a violation.
    const ghost = auditEvaluation.evaluated.find(
        (item) => item.model_identifier === 'ghost:latest'
    );
    assert.strictEqual(ghost.verification.verdict, 'not_applicable');
    assert.strictEqual(ghost.policyResult.pass, true);

    // Findings for the rejected model carry the verification object.
    const badFinding = auditEvaluation.findings.find(
        (entry) => entry.model_identifier === 'fake-bad:latest'
    );
    assert.ok(badFinding, 'rejected model should appear in findings');
    assert.deepStrictEqual(badFinding.verification, {
        verdict: 'reject',
        violation_code: 101,
        violation_name: 'VERSION_UNSUPPORTED',
        offset: 4
    });
}

async function testOnUnverifiable(fake) {
    const failingVerifier = {
        verifyFile: async () => {
            const error = new Error('modelvet WASM artifact not found');
            error.code = 'MODELVET_WASM_MISSING';
            throw error;
        }
    };

    // Default (warn): verifier errors are warnings, never violations — even
    // in enforce mode.
    const warnPolicy = structuralPolicy('enforce');
    const warnEvaluation = await evaluatePolicyCandidatesAsync(
        new PolicyEngine(warnPolicy),
        [{ model_identifier: 'fake-ok:latest', tag: 'fake-ok:latest' }],
        {},
        warnPolicy,
        { env: fake.env, verifier: failingVerifier }
    );

    const warnItem = warnEvaluation.evaluated[0];
    assert.strictEqual(warnItem.verification.verdict, 'error');
    assert.ok(
        warnItem.verification.reason.includes('MODELVET_WASM_MISSING'),
        'error verification should retain the verifier error code in the reason'
    );
    assert.strictEqual(warnItem.policyResult.pass, true, 'on_unverifiable=warn must not fail');
    assert.strictEqual(warnItem.policyResult.violationCount, 0);
    assert.ok(
        warnItem.policyResult.warnings.some(
            (entry) => entry.code === 'STRUCTURAL_VALIDATION_UNVERIFIABLE'
        ),
        'warn mode should surface a STRUCTURAL_VALIDATION_UNVERIFIABLE warning'
    );

    const warnEnforcement = resolvePolicyEnforcement(warnPolicy, warnEvaluation);
    assert.strictEqual(warnEnforcement.shouldBlock, false, 'warn mode must not block in enforce');
    assert.strictEqual(warnEnforcement.exitCode, 0);

    // fail: verifier errors become blocking violations.
    const failPolicy = structuralPolicy('enforce', { enabled: true, on_unverifiable: 'fail' });
    const failEvaluation = await evaluatePolicyCandidatesAsync(
        new PolicyEngine(failPolicy),
        [{ model_identifier: 'fake-ok:latest', tag: 'fake-ok:latest' }],
        {},
        failPolicy,
        { env: fake.env, verifier: failingVerifier }
    );

    const failItem = failEvaluation.evaluated[0];
    assert.strictEqual(failItem.policyResult.pass, false);
    assert.ok(
        failItem.policyResult.violations.some(
            (entry) => entry.code === 'STRUCTURAL_VALIDATION_UNVERIFIABLE'
        ),
        'on_unverifiable=fail should produce a violation'
    );

    const failEnforcement = resolvePolicyEnforcement(failPolicy, failEvaluation);
    assert.strictEqual(failEnforcement.shouldBlock, true, 'fail mode should block in enforce');
    assert.notStrictEqual(failEnforcement.exitCode, 0);
}

async function testAuditExportFields(fake) {
    const policy = structuralPolicy('audit');
    const evaluation = await evaluatePolicyCandidatesAsync(
        new PolicyEngine(policy),
        makeCandidates(),
        {},
        policy,
        { env: fake.env }
    );
    const enforcement = resolvePolicyEnforcement(policy, evaluation);

    const report = buildComplianceReport({
        commandName: 'check',
        policyPath: './policy.yaml',
        policy,
        evaluation,
        enforcement,
        runtimeContext: { backend: 'ollama', runtimeBackend: 'ollama', ramGB: 64 },
        options: {},
        hardware: {},
        generatedAt: '2026-08-04T00:00:00.000Z'
    });

    // JSON findings carry the verification object.
    const jsonFinding = report.findings.find(
        (entry) => entry.model_identifier === 'fake-bad:latest'
    );
    assert.ok(jsonFinding, 'expected a finding for fake-bad:latest');
    assert.deepStrictEqual(jsonFinding.verification, {
        verdict: 'reject',
        violation_code: 101,
        violation_name: 'VERSION_UNSUPPORTED',
        offset: 4
    });
    assert.strictEqual(jsonFinding.violation_code, 'STRUCTURAL_VALIDATION_FAILED');
    assert.strictEqual(jsonFinding.severity, 'high');

    const parsed = JSON.parse(serializeComplianceReport(report, 'json'));
    assert.deepStrictEqual(
        parsed.findings.find((entry) => entry.model_identifier === 'fake-bad:latest')
            .verification,
        { verdict: 'reject', violation_code: 101, violation_name: 'VERSION_UNSUPPORTED', offset: 4 },
        'serialized JSON should include the verification object'
    );

    // CSV gains deterministic verification columns.
    const csv = serializeComplianceReport(report, 'csv');
    const csvLines = csv.split('\n');
    const headers = csvLines[0].split(',');
    const expectedColumns = [
        'verification_verdict',
        'verification_violation_code',
        'verification_violation_name',
        'verification_offset',
        'verification_reason'
    ];
    expectedColumns.forEach((column) => {
        assert.ok(headers.includes(column), `CSV should include ${column}`);
    });
    const badRow = csvLines.find((line) => line.includes('fake-bad:latest'));
    assert.ok(badRow, 'CSV should have a row for fake-bad:latest');
    const rowCells = badRow.split(',');
    assert.strictEqual(rowCells[headers.indexOf('verification_verdict')], 'reject');
    assert.strictEqual(rowCells[headers.indexOf('verification_violation_code')], '101');
    assert.strictEqual(rowCells[headers.indexOf('verification_violation_name')], 'VERSION_UNSUPPORTED');
    assert.strictEqual(rowCells[headers.indexOf('verification_offset')], '4');
    assert.strictEqual(rowCells[headers.indexOf('verification_reason')], 'unknown');

    // SARIF results carry the verification object in properties.
    const sarif = JSON.parse(serializeComplianceReport(report, 'sarif'));
    const sarifResult = sarif.runs[0].results.find((result) =>
        result.locations[0].physicalLocation.artifactLocation.uri.includes('fake-bad:latest')
    );
    assert.ok(sarifResult, 'SARIF should have a result for fake-bad:latest');
    assert.deepStrictEqual(sarifResult.properties.verification, {
        verdict: 'reject',
        violation_code: 101,
        violation_name: 'VERSION_UNSUPPORTED',
        offset: 4
    });

    // Findings without verification data fall back to explicit "unknown"
    // values instead of omitting fields.
    const unknownReport = buildComplianceReport({
        commandName: 'check',
        policyPath: './policy.yaml',
        policy,
        evaluation: {
            totalChecked: 1,
            passCount: 0,
            failCount: 1,
            findings: [
                {
                    status: 'active',
                    model_identifier: 'plain:model',
                    model_name: 'plain:model',
                    violation: { code: 'MODEL_DENIED', path: 'rules.models.deny', message: 'denied' }
                }
            ]
        },
        enforcement,
        runtimeContext: {},
        options: {},
        hardware: {},
        generatedAt: '2026-08-04T00:00:00.000Z'
    });
    assert.deepStrictEqual(unknownReport.findings[0].verification, {
        verdict: 'unknown',
        reason: 'unknown'
    });
}

async function run() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-structural-'));

    try {
        const fake = makeFakeOllama(tempDir);

        testSchemaValidation();
        testCliValidate();
        testBlobResolution(fake);
        await testAttachAndCache(fake);
        testEngineEvaluation();
        await testAuditAndEnforceModes(fake);
        await testOnUnverifiable(fake);
        await testAuditExportFields(fake);

        console.log('policy-structural-validation.test.js: OK');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    run().catch((error) => {
        console.error('policy-structural-validation.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
