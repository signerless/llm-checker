const assert = require('assert');
const { Command } = require('commander');
const {
    __private: {
        tokenizeArgString,
        getRequiredOptionPrompts,
        buildRequiredOptionArgs,
        normalizeVariadicValue,
        buildCommandCatalog,
        buildPrimaryCommands,
        getVisibleCommands,
        truncateText,
        shouldEnableBannerPulse,
        getPanelWidth,
        getMaxCommandRows,
        shouldUseCompactPanelLayout
    }
} = require('../src/ui/interactive-panel');
const {
    __private: {
        drawTextBanner,
        getSafeTerminalWidth,
        getTerminalClearSequence
    }
} = require('../src/ui/cli-theme');

function stripAnsi(value) {
    return String(value).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function captureConsoleLogs(callback) {
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => {
        logs.push(args.join(' '));
    };

    try {
        callback();
    } finally {
        console.log = originalLog;
    }

    return logs;
}

function createMockCommand(name, description) {
    return {
        name: () => name,
        description: () => description
    };
}

function run() {
    const parsed = tokenizeArgString('--json --limit 5 --name "llama 3.2" --path \'./my file.txt\'');
    assert.deepStrictEqual(parsed, [
        '--json',
        '--limit',
        '5',
        '--name',
        'llama 3.2',
        '--path',
        './my file.txt'
    ]);

    assert.strictEqual(truncateText('short', 10), 'short');
    assert.strictEqual(truncateText('abcdefghij', 6), 'abc...');
    assert.deepStrictEqual(
        normalizeVariadicValue('qwen2.5-coder:7b llama3.2:3b,mistral:7b'),
        ['qwen2.5-coder:7b', 'llama3.2:3b', 'mistral:7b']
    );

    const calibrateCommand = new Command('calibrate');
    calibrateCommand.requiredOption('--suite <file>', 'Prompt suite path');
    calibrateCommand.requiredOption('--models <identifiers...>', 'Models');
    calibrateCommand.requiredOption('--output <file>', 'Output path');
    calibrateCommand.option('--runtime <runtime>', 'Runtime backend', 'ollama');
    calibrateCommand.option('--dry-run', 'Dry run mode');

    const requiredOptionPrompts = getRequiredOptionPrompts({ command: calibrateCommand });
    assert.deepStrictEqual(
        requiredOptionPrompts.map((entry) => entry.optionFlags),
        ['--suite <file>', '--models <identifiers...>', '--output <file>'],
        'only mandatory options should be discovered for interactive prompts'
    );

    const requiredOptionArgs = buildRequiredOptionArgs(requiredOptionPrompts, {
        required_suite: './suite.jsonl',
        required_models: 'qwen2.5-coder:7b, llama3.2:3b',
        required_output: './calibration.json'
    });
    assert.deepStrictEqual(
        requiredOptionArgs,
        [
            '--suite',
            './suite.jsonl',
            '--models',
            'qwen2.5-coder:7b',
            'llama3.2:3b',
            '--output',
            './calibration.json'
        ],
        'required prompt answers should translate to runnable CLI args'
    );

    const mockProgram = {
        commands: [
            createMockCommand('recommend', 'Recommend models'),
            createMockCommand('check', 'Check compatibility'),
            createMockCommand('help', 'Show all commands and how to use them'),
            createMockCommand('search', 'Search models'),
            createMockCommand('sync', 'Sync database')
        ]
    };

    const catalog = buildCommandCatalog(mockProgram);
    assert.strictEqual(catalog[0].name, 'check', 'catalog should be sorted alphabetically');

    const primary = buildPrimaryCommands(catalog);
    assert.strictEqual(primary[0].name, 'check', 'primary ordering should prioritize check');
    assert.strictEqual(primary[1].name, 'help', 'primary ordering should prioritize help');
    assert.strictEqual(primary[2].name, 'recommend', 'primary ordering should prioritize recommend');

    const stateClosed = { paletteOpen: false, query: '', selected: 0 };
    const visibleClosed = getVisibleCommands(stateClosed, catalog, primary);
    assert.deepStrictEqual(
        visibleClosed.map((item) => item.name),
        primary.map((item) => item.name),
        'closed palette should show primary commands'
    );

    const stateOpen = { paletteOpen: true, query: 'sea', selected: 0 };
    const visibleOpen = getVisibleCommands(stateOpen, catalog, primary);
    assert.deepStrictEqual(
        visibleOpen.map((item) => item.name),
        ['search'],
        'open palette should filter commands by query'
    );

    assert.strictEqual(
        shouldEnableBannerPulse({ isTTY: true, platform: 'linux', disableAnimation: '0' }),
        true,
        'pulse should run on non-Windows TTY terminals'
    );
    assert.strictEqual(
        shouldEnableBannerPulse({ isTTY: true, platform: 'win32', disableAnimation: '0' }),
        false,
        'pulse should be disabled on Windows by default to avoid redraw flicker'
    );
    assert.strictEqual(
        shouldEnableBannerPulse({
            isTTY: true,
            platform: 'win32',
            disableAnimation: '0',
            forcePulse: '1'
        }),
        true,
        'pulse can be explicitly re-enabled on Windows when requested'
    );
    assert.strictEqual(
        shouldEnableBannerPulse({ isTTY: false, platform: 'linux', disableAnimation: '0' }),
        false,
        'pulse should stay off for non-TTY outputs'
    );
    assert.strictEqual(
        shouldEnableBannerPulse({ isTTY: true, platform: 'linux', disableAnimation: '1' }),
        false,
        'pulse should respect disable animation env'
    );

    assert.strictEqual(
        getSafeTerminalWidth(207, 'win32'),
        206,
        'Windows rendering should stay one cell inside the reported terminal width'
    );
    assert.strictEqual(
        getSafeTerminalWidth(207, 'linux'),
        207,
        'Non-Windows rendering can use the reported terminal width'
    );
    assert.strictEqual(
        getTerminalClearSequence('win32'),
        '\x1b[1;1H\x1b[0J',
        'Windows clear sequence should move home before clearing below'
    );
    assert.strictEqual(
        getPanelWidth({ columns: 207, platform: 'win32' }),
        128,
        'wide Windows panel should still respect the 128-column design cap'
    );
    assert.strictEqual(
        getPanelWidth({ columns: 60, platform: 'win32' }),
        59,
        'narrow Windows panel should not force the old 76-column minimum'
    );
    assert.strictEqual(
        shouldUseCompactPanelLayout({ rows: 50, platform: 'win32' }),
        true,
        'Windows terminals under 64 rows should use the compact panel header'
    );
    assert.strictEqual(
        shouldUseCompactPanelLayout({ rows: 50, platform: 'linux' }),
        false,
        'non-Windows terminals at 50 rows can keep the full banner'
    );
    assert.strictEqual(
        getMaxCommandRows({ rows: 50, compact: true }),
        16,
        'compact panel should leave enough room for the command list at 50 rows'
    );
    assert.strictEqual(
        getMaxCommandRows({ rows: 50, compact: false }),
        3,
        'full banner layout should not overflow a 50-row terminal'
    );

    const bannerLogs = captureConsoleLogs(() => {
        drawTextBanner(
            [
                ' +------+ ',
                ' | █████████████████████████████████████████████████████████████████████████████ | ',
                ' | INTELLIGENT OLLAMA MODEL SELECTOR | ',
                ' +------+ '
            ],
            { columns: 207, platform: 'win32', hasDarkBackground: true }
        );
    }).map(stripAnsi);

    assert.ok(bannerLogs.length > 0, 'banner layout test should capture rendered lines');
    assert.ok(
        bannerLogs.every((line) => line.length <= 206),
        `Windows banner lines should not exceed safe width: ${bannerLogs.map((line) => line.length).join(', ')}`
    );
    assert.strictEqual(
        bannerLogs[0].length,
        206,
        'top border should match safe Windows width'
    );
    assert.strictEqual(
        bannerLogs[bannerLogs.length - 1].length,
        206,
        'bottom border should match safe Windows width'
    );

    console.log('cli-interactive-panel.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('cli-interactive-panel.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
