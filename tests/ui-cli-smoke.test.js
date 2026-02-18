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
    assert.ok(stripAnsi(help.stdout).includes('mcp-setup'), 'top-level help should list mcp-setup command');

    const commandHelp = runCli(['help']);
    assert.strictEqual(commandHelp.status, 0, stripAnsi(commandHelp.stderr || commandHelp.stdout));
    assert.ok(
        stripAnsi(commandHelp.stdout).includes('Show all commands and how to use them'),
        'help command should be listed and described'
    );

    const commandHelpRecommend = runCli(['help', 'recommend']);
    assert.strictEqual(
        commandHelpRecommend.status,
        0,
        stripAnsi(commandHelpRecommend.stderr || commandHelpRecommend.stdout)
    );
    assert.ok(
        stripAnsi(commandHelpRecommend.stdout).includes('Usage: llm-checker recommend'),
        'help <command> should show detailed usage for that command'
    );

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

    const mcpSetupHelp = runCli(['mcp-setup', '--help']);
    assert.strictEqual(mcpSetupHelp.status, 0, stripAnsi(mcpSetupHelp.stderr || mcpSetupHelp.stdout));
    assert.ok(
        stripAnsi(mcpSetupHelp.stdout).includes('Show or apply Claude MCP setup for llm-checker'),
        'mcp-setup help should describe command purpose'
    );

    const mcpSetupJson = runCli(['mcp-setup', '--json']);
    assert.strictEqual(mcpSetupJson.status, 0, stripAnsi(mcpSetupJson.stderr || mcpSetupJson.stdout));
    const parsedMcpSetup = JSON.parse(stripAnsi(mcpSetupJson.stdout));
    assert.strictEqual(parsedMcpSetup.recommended.command, 'claude', 'mcp-setup json should target claude CLI');
    assert.ok(
        Array.isArray(parsedMcpSetup.recommended.args) &&
            parsedMcpSetup.recommended.args.slice(0, 2).join(' ') === 'mcp add',
        'mcp-setup json should include claude mcp add args'
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
