/**
 * Unified test runner for current test suite.
 * Executes existing test files in separate Node processes to avoid side effects.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
    { name: 'AMD GPU detection', file: 'amd-gpu-detection.test.js', category: 'Hardware' },
    { name: 'CUDA Jetson detection', file: 'cuda-jetson-detection.test.js', category: 'Hardware' },
    { name: 'Hardware simulation scoring', file: 'hardware-simulation-tests.js', category: 'Hardware' },
    { name: 'Hardware detector regression', file: 'hardware-detector-regression.js', category: 'Hardware' },
    { name: 'Token speed estimation', file: 'token-speed-estimation.test.js', category: 'Performance' },
    { name: 'Deterministic model pool', file: 'deterministic-model-pool-check.js', category: 'Recommendations' },
    { name: 'Ollama capacity planner', file: 'ollama-capacity-planner.test.js', category: 'Ollama' },
    { name: 'Ollama speed metrics', file: 'ollama-client-speed-metrics.test.js', category: 'Ollama' },
    { name: 'Runtime + speculative decoding', file: 'runtime-specdec-tests.js', category: 'Runtime' },
    { name: 'CLI interface smoke', file: 'ui-cli-smoke.test.js', category: 'UI' },
    { name: 'CLI interactive panel helpers', file: 'cli-interactive-panel.test.js', category: 'UI' },
    { name: 'Local features end-to-end', file: 'local-features-e2e.test.js', category: 'E2E' },
    { name: 'Calibration schema', file: 'calibration-schema.test.js', category: 'Calibration' },
    { name: 'Calibration command', file: 'calibrate-command.test.js', category: 'Calibration' },
    { name: 'Calibration end-to-end', file: 'calibration-e2e-integration.test.js', category: 'Calibration' },
    { name: 'Calibration full mode', file: 'calibration-full-mode.test.js', category: 'Calibration' },
    { name: 'Calibration routing policy', file: 'calibration-routing-policy.test.js', category: 'Calibration' },
    { name: 'Policy commands', file: 'policy-commands.test.js', category: 'Policy' },
    { name: 'Policy CLI enforcement', file: 'policy-cli-enforcement.js', category: 'Policy' },
    { name: 'Policy engine', file: 'policy-engine.test.js', category: 'Policy' },
    { name: 'Policy audit reporter', file: 'policy-audit-reporter.test.js', category: 'Policy' },
    { name: 'Policy end-to-end', file: 'policy-e2e-integration.test.js', category: 'Policy' }
];

function runSingleTest(test) {
    const scriptPath = path.join(__dirname, test.file);
    const started = Date.now();
    const result = spawnSync(process.execPath, [scriptPath], {
        encoding: 'utf8',
        env: process.env
    });
    const durationMs = Date.now() - started;

    const success = result.status === 0;
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    return {
        ...test,
        success,
        durationMs,
        output
    };
}

function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

function printSummary(results, totalDurationMs) {
    const total = results.length;
    const passed = results.filter((r) => r.success).length;
    const failed = total - passed;

    console.log('\n' + '='.repeat(72));
    console.log('LLM-CHECKER TEST SUMMARY');
    console.log('='.repeat(72));
    console.log(`Total: ${total}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Duration: ${formatDuration(totalDurationMs)}`);
    console.log();

    const byCategory = new Map();
    for (const result of results) {
        const current = byCategory.get(result.category) || { total: 0, passed: 0 };
        current.total += 1;
        if (result.success) current.passed += 1;
        byCategory.set(result.category, current);
    }

    for (const [category, stats] of byCategory.entries()) {
        const pct = Math.round((stats.passed / stats.total) * 100);
        console.log(`${category}: ${stats.passed}/${stats.total} (${pct}%)`);
    }

    if (failed > 0) {
        console.log('\nFailed tests:');
        for (const result of results.filter((r) => !r.success)) {
            console.log(`- ${result.name} (${result.file})`);
            if (result.output) {
                const firstLine = result.output.split('\n')[0];
                console.log(`  ${firstLine}`);
            }
        }
    }
}

function runAllTests() {
    const started = Date.now();
    console.log('Running LLM-Checker test suite...\n');

    const results = [];
    for (const test of TESTS) {
        process.stdout.write(`- ${test.name}... `);
        const result = runSingleTest(test);
        results.push(result);
        if (result.success) {
            console.log(`OK (${formatDuration(result.durationMs)})`);
        } else {
            console.log(`FAIL (${formatDuration(result.durationMs)})`);
        }
    }

    const totalDurationMs = Date.now() - started;
    printSummary(results, totalDurationMs);

    const hasFailures = results.some((r) => !r.success);
    process.exit(hasFailures ? 1 : 0);
}

if (require.main === module) {
    runAllTests();
}

module.exports = { runAllTests };
