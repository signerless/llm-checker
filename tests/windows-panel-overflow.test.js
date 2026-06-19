const assert = require('assert');
const { EventEmitter } = require('events');

const interactivePanel = require('../src/ui/interactive-panel');
const {
    launchInteractivePanel,
    __private: {
        shouldUseCompactPanelLayout,
        getMaxCommandRows,
        getReservedRows,
        getBannerLineCount,
        getFullLayoutMinRows,
        FIXED_CHROME_LINES
    }
} = interactivePanel;
const {
    __private: {
        getSafeTerminalWidth,
        getTextBannerLineCount
    }
} = require('../src/ui/cli-theme');

// Total lines the renderer commits for a given terminal height + platform. The
// budget mirrors renderPanel(): fixed chrome (banner-or-compact-header + panel
// chrome) plus the windowed command list. If this ever exceeds the viewport the
// panel scrolls and re-introduces the issue #86 flicker.
function renderedLineBudget(rows, platform) {
    const compact = shouldUseCompactPanelLayout({ rows, platform });
    const reserved = getReservedRows(compact);
    const commandRows = getMaxCommandRows({ rows, compact });
    return reserved + commandRows;
}

async function run() {
    // (b) reservedRows (full) is derived from the real banner asset, not a magic
    // literal, so layout budgeting tracks the banner automatically.
    const bannerLines = getBannerLineCount();
    assert.strictEqual(
        bannerLines,
        getTextBannerLineCount(),
        'panel banner line count should come from the real banner loader'
    );
    assert.strictEqual(
        getReservedRows(false),
        bannerLines + FIXED_CHROME_LINES,
        'full-layout reserved rows must equal banner lines + FIXED_CHROME_LINES (no magic-number drift)'
    );
    assert.strictEqual(
        getFullLayoutMinRows(),
        getReservedRows(false) + 3,
        'full-layout minimum height must leave room for at least 3 command rows'
    );

    // (a) For the previously-broken band (46-49) and a spread of other heights,
    // the rendered budget must never overflow the viewport on either platform.
    const heights = [20, 24, 30, 40, 45, 46, 47, 48, 49, 50, 51, 60, 64, 80, 120];
    for (const platform of ['win32', 'linux']) {
        for (const rows of heights) {
            const budget = renderedLineBudget(rows, platform);
            assert.ok(
                budget <= rows,
                `rendered line budget ${budget} must not exceed terminal height ${rows} (${platform})`
            );
        }
    }

    // Regression guard for the exact band called out in issue #86: at 46-49 rows
    // the full layout used to be chosen yet emitted ~49+ lines. It must now pick
    // the compact header so the panel fits.
    for (const rows of [46, 47, 48]) {
        assert.strictEqual(
            shouldUseCompactPanelLayout({ rows, platform: 'linux' }),
            true,
            `non-Windows ${rows}-row terminal must use the compact layout to avoid overflow`
        );
    }

    // (c) getSafeTerminalWidth reserves one trailing cell on BOTH platforms so
    // auto-wrap terminals (Windows console, libvte, tmux, SSH) never tear the
    // persistent border on the last column.
    assert.strictEqual(getSafeTerminalWidth(120, 'win32'), 119, 'win32 width should be columns-1');
    assert.strictEqual(getSafeTerminalWidth(120, 'linux'), 119, 'posix width should be columns-1');
    assert.strictEqual(getSafeTerminalWidth(207, 'darwin'), 206, 'darwin width should be columns-1');

    // (d) A resize listener is registered on start and removed on stop, with no
    // leak. Drive launchInteractivePanel against mocked, non-TTY stdio so it runs
    // headless: no raw mode, no banner animation, no pulse timer.
    await runResizeListenerLifecycle();

    console.log('windows-panel-overflow.test.js: OK');
}

async function runResizeListenerLifecycle() {
    const originalStdin = process.stdin;
    const originalStdout = process.stdout;

    // Minimal stdin/stdout stand-ins. Non-TTY keeps clearTerminal()/raw-mode and
    // the pulse off; we only need the resize listener wired through start/stop.
    const fakeStdin = new EventEmitter();
    fakeStdin.isTTY = false;
    fakeStdin.setRawMode = () => {};
    fakeStdin.resume = () => {};
    fakeStdin.pause = () => {};

    const fakeStdout = new EventEmitter();
    fakeStdout.isTTY = false;
    fakeStdout.columns = 120;
    fakeStdout.rows = 60;
    fakeStdout.write = () => true;

    const program = {
        commands: [
            { name: () => 'check', description: () => 'Check compatibility' },
            { name: () => 'help', description: () => 'Show all commands' }
        ]
    };

    // Silence the panel's renderPanel() console.log chatter while we exercise the
    // start/stop lifecycle so it does not pollute the test runner's captured output.
    const originalConsoleLog = console.log;
    console.log = () => {};

    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: fakeStdout, configurable: true });

    try {
        const before = fakeStdout.listenerCount('resize');
        const panelPromise = launchInteractivePanel({ program, binaryPath: '/tmp/fake-bin.js' });

        // launchInteractivePanel awaits animateBanner() (a no-op without a TTY)
        // before attaching listeners; yield a couple of microtasks so start
        // completes before we assert on the registered listener.
        await Promise.resolve();
        await Promise.resolve();

        const during = fakeStdout.listenerCount('resize');
        assert.strictEqual(
            during,
            before + 1,
            'start should register exactly one resize listener'
        );

        // Trigger quit ('q') to run the stop path.
        fakeStdin.emit('keypress', 'q', { name: 'q' });
        await panelPromise;

        const after = fakeStdout.listenerCount('resize');
        assert.strictEqual(
            after,
            before,
            'stop should remove the resize listener (no leak)'
        );
    } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
        Object.defineProperty(process, 'stdout', { value: originalStdout, configurable: true });
        console.log = originalConsoleLog;
    }
}

if (require.main === module) {
    Promise.resolve()
        .then(run)
        .catch((error) => {
            console.error('windows-panel-overflow.test.js: FAILED');
            console.error(error);
            process.exit(1);
        });
}

module.exports = { run };
