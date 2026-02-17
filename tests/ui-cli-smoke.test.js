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

    const recommendHelp = runCli(['recommend', '--help']);
    assert.strictEqual(recommendHelp.status, 0, stripAnsi(recommendHelp.stderr || recommendHelp.stdout));
    assert.ok(
        stripAnsi(recommendHelp.stdout).includes('Get intelligent model recommendations for your hardware'),
        'recommend help should describe command purpose'
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
