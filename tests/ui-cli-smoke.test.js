const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'enhanced_cli.js');

function stripAnsi(text = '') {
    return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function runCli(args) {
    return spawnSync(process.execPath, [BIN_PATH, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            NO_COLOR: '1'
        }
    });
}

function run() {
    const help = runCli(['--help']);
    assert.strictEqual(help.status, 0, stripAnsi(help.stderr || help.stdout));
    assert.ok(stripAnsi(help.stdout).includes('Usage: llm-checker'), 'top-level help should include CLI usage');
    assert.ok(stripAnsi(help.stdout).includes('recommend'), 'top-level help should list recommend command');
    assert.ok(stripAnsi(help.stdout).includes('calibrate'), 'top-level help should list calibrate command');
    assert.ok(stripAnsi(help.stdout).includes('ollama-plan'), 'top-level help should list ollama-plan command');

    const recommendHelp = runCli(['recommend', '--help']);
    assert.strictEqual(recommendHelp.status, 0, stripAnsi(recommendHelp.stderr || recommendHelp.stdout));
    assert.ok(
        stripAnsi(recommendHelp.stdout).includes('Get intelligent model recommendations for your hardware'),
        'recommend help should describe command purpose'
    );
    assert.ok(
        stripAnsi(recommendHelp.stdout).includes('--calibrated [file]'),
        'recommend help should expose calibrated routing option'
    );

    const calibrateHelp = runCli(['calibrate', '--help']);
    assert.strictEqual(calibrateHelp.status, 0, stripAnsi(calibrateHelp.stderr || calibrateHelp.stdout));
    assert.ok(
        stripAnsi(calibrateHelp.stdout).includes('Generate calibration contract artifacts from a JSONL prompt suite'),
        'calibrate help should describe command purpose'
    );

    const aiRunHelp = runCli(['ai-run', '--help']);
    assert.strictEqual(aiRunHelp.status, 0, stripAnsi(aiRunHelp.stderr || aiRunHelp.stdout));
    assert.ok(
        stripAnsi(aiRunHelp.stdout).includes('--policy <file>'),
        'ai-run help should expose policy option'
    );
    assert.ok(
        stripAnsi(aiRunHelp.stdout).includes('--calibrated [file]'),
        'ai-run help should expose calibrated routing option'
    );

    const ollamaPlanHelp = runCli(['ollama-plan', '--help']);
    assert.strictEqual(ollamaPlanHelp.status, 0, stripAnsi(ollamaPlanHelp.stderr || ollamaPlanHelp.stdout));
    assert.ok(
        stripAnsi(ollamaPlanHelp.stdout).includes('Plan safe Ollama runtime settings for selected local models'),
        'ollama-plan help should describe command purpose'
    );
    assert.ok(
        stripAnsi(ollamaPlanHelp.stdout).includes('--objective <mode>'),
        'ollama-plan help should expose objective option'
    );

    console.log('ui-cli-smoke.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('ui-cli-smoke.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
