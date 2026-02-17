const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    resolveRoutingPolicyPreference,
    resolveCalibrationRoute,
    selectModelFromRoute
} = require('../src/calibration/policy-routing');

const FIXTURES_DIR = path.resolve(__dirname, 'calibration-fixtures');

function copyCalibrationFixture(tempDir, targetFileName = 'calibration-policy.yaml') {
    const fixturePath = path.join(FIXTURES_DIR, 'calibration-policy-valid.yaml');
    const targetPath = path.join(tempDir, targetFileName);
    fs.copyFileSync(fixturePath, targetPath);
    return targetPath;
}

function run() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-calibration-routing-'));
    const tempHome = path.join(tempDir, 'home');
    fs.mkdirSync(tempHome, { recursive: true });

    try {
        const calibrationPolicyPath = copyCalibrationFixture(tempDir, 'calibration-policy.yaml');

        const preferenceFromPolicy = resolveRoutingPolicyPreference({
            policyOption: calibrationPolicyPath,
            calibratedOption: true,
            cwd: tempDir,
            homeDir: tempHome
        });
        assert.ok(preferenceFromPolicy.calibratedPolicy, 'policy option should resolve calibrated policy');
        assert.strictEqual(preferenceFromPolicy.calibratedPolicy.source, '--policy');
        assert.strictEqual(preferenceFromPolicy.calibratedPolicy.policyPath, calibrationPolicyPath);
        assert.ok(
            preferenceFromPolicy.warnings.some((warning) => warning.includes('Ignoring --calibrated')),
            'policy option should take precedence over --calibrated'
        );

        const enterprisePolicyPath = path.join(tempDir, 'enterprise-policy.yaml');
        fs.writeFileSync(enterprisePolicyPath, 'mode: enforce\n', 'utf8');
        let enterpriseLoadCalled = false;
        const preferenceEnterprise = resolveRoutingPolicyPreference({
            policyOption: enterprisePolicyPath,
            calibratedOption: calibrationPolicyPath,
            cwd: tempDir,
            homeDir: tempHome,
            loadEnterprisePolicy: (filePath) => {
                enterpriseLoadCalled = true;
                return { policyPath: filePath, policy: { mode: 'enforce' } };
            }
        });
        assert.ok(enterpriseLoadCalled, 'enterprise loader should run when policy is not a calibration policy');
        assert.ok(preferenceEnterprise.enterprisePolicy, 'enterprise policy should be returned');
        assert.ok(!preferenceEnterprise.calibratedPolicy, 'enterprise policy fallback should not set calibrated policy');
        assert.ok(
            preferenceEnterprise.warnings.some((warning) => warning.includes('Ignoring --calibrated')),
            'policy precedence warning should still be emitted'
        );

        const defaultPolicyDir = path.join(tempHome, '.llm-checker');
        fs.mkdirSync(defaultPolicyDir, { recursive: true });
        const discoveredPath = copyCalibrationFixture(defaultPolicyDir, 'calibration-policy.yaml');

        const preferenceDiscovered = resolveRoutingPolicyPreference({
            calibratedOption: true,
            cwd: tempDir,
            homeDir: tempHome
        });
        assert.ok(preferenceDiscovered.calibratedPolicy, 'default discovery should load calibrated policy');
        assert.strictEqual(preferenceDiscovered.calibratedPolicy.source, 'default-discovery');
        assert.strictEqual(preferenceDiscovered.calibratedPolicy.policyPath, discoveredPath);

        const preferenceMissingExplicit = resolveRoutingPolicyPreference({
            calibratedOption: path.join(tempDir, 'missing-policy.yaml'),
            cwd: tempDir,
            homeDir: tempHome
        });
        assert.ok(!preferenceMissingExplicit.calibratedPolicy, 'missing explicit calibrated policy should not resolve');
        assert.ok(
            preferenceMissingExplicit.warnings.some((warning) => warning.includes('Unable to load calibrated policy')),
            'missing explicit policy should emit fallback warning'
        );

        const routeCoding = resolveCalibrationRoute(preferenceFromPolicy.calibratedPolicy.policy, 'coding');
        assert.ok(routeCoding, 'coding route should resolve');
        assert.strictEqual(routeCoding.resolvedTask, 'coding');
        assert.ok(!routeCoding.usedTaskFallback, 'coding should not need task fallback');

        const fallbackModelSelection = selectModelFromRoute(routeCoding.route, [
            'llama3.2:3b',
            'mistral:7b'
        ]);
        assert.ok(fallbackModelSelection, 'fallback model should be selected from available models');
        assert.strictEqual(fallbackModelSelection.selectedModel, 'llama3.2:3b');
        assert.strictEqual(fallbackModelSelection.matchedRouteModel, 'llama3.2:3b');
        assert.strictEqual(fallbackModelSelection.usedFallback, true);

        const routeCreative = resolveCalibrationRoute(preferenceFromPolicy.calibratedPolicy.policy, 'creative');
        assert.ok(routeCreative, 'route fallback should still return a route');
        assert.strictEqual(routeCreative.resolvedTask, 'general');
        assert.strictEqual(routeCreative.usedTaskFallback, true);

        console.log('calibration-routing-policy.test.js: OK');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('calibration-routing-policy.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
