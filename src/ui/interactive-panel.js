'use strict';

const chalk = require('chalk');
const inquirer = require('inquirer');
const readline = require('readline');
const { spawn } = require('child_process');
const {
    animateBanner,
    renderPersistentBanner,
    __private: {
        clearTerminal,
        getSafeTerminalWidth,
        getTextBannerLineCount
    }
} = require('./cli-theme');

// Fixed (non-banner, non-command) chrome lines emitted by the full-layout panel:
// blank-after-banner, top separator, input line, separator, title, blank,
// blank-before-footer, separator, footer hint = 9 lines. Keep this in sync with
// renderPanel(); the integration test asserts the rendered budget never overflows.
const FIXED_CHROME_LINES = 9;
// Fixed chrome for the compact header layout (single-line header replaces the
// 37-line banner): header, separator, input, separator, title, blank,
// blank-before-footer, separator, footer = 9 lines as well.
const COMPACT_CHROME_LINES = 9;
// Smallest command list we are willing to show in either layout.
const MIN_FULL_COMMAND_ROWS = 3;
const MIN_COMPACT_COMMAND_ROWS = 4;
const MAX_COMMAND_ROWS = 16;

// Derive the full-layout banner height from the real banner asset so layout
// budgeting tracks the banner automatically instead of drifting from a literal.
function getBannerLineCount() {
    const count = typeof getTextBannerLineCount === 'function' ? getTextBannerLineCount() : 0;
    return Number.isFinite(count) && count > 0 ? count : 37;
}

// Total fixed (always-present) lines for a layout, excluding the command list.
function getReservedRows(compact = false) {
    return compact
        ? COMPACT_CHROME_LINES
        : getBannerLineCount() + FIXED_CHROME_LINES;
}

const PRIMARY_COMMAND_PRIORITY = [
    'check',
    'help',
    'mcp-setup',
    'recommend',
    'simulate',
    'ai-run',
    'sync',
    'ollama-plan',
    'list-models',
    'search',
    'installed',
    'ollama'
];

const REQUIRED_ARG_PROMPTS = {
    search: [
        {
            name: 'query',
            message: 'Search text for `search`:',
            validate: (value) => (value && value.trim() ? true : 'Type a search query')
        }
    ]
};

function truncateText(text, maxLength) {
    const value = String(text || '');
    if (value.length <= maxLength) return value;
    if (maxLength <= 3) return value.slice(0, maxLength);
    return `${value.slice(0, maxLength - 3)}...`;
}

function getPanelWidth({
    columns = process.stdout.columns,
    platform = process.platform
} = {}) {
    const safeWidth = getSafeTerminalWidth(columns, platform) || 100;
    return Math.max(40, Math.min(safeWidth, 128));
}

function getTerminalRows(rows = process.stdout.rows) {
    const value = Number(rows);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
}

// Minimum terminal height at which the full-banner layout fits without scrolling.
// The full layout always emits getReservedRows(false) fixed lines plus at least
// MIN_FULL_COMMAND_ROWS command rows, so anything shorter must use the compact
// header instead (otherwise the panel overflows the viewport and flickers, the
// #86 artifact on Windows Terminal / PowerShell / CMD).
function getFullLayoutMinRows() {
    return getReservedRows(false) + MIN_FULL_COMMAND_ROWS;
}

function shouldUseCompactPanelLayout({
    rows = process.stdout.rows,
    platform = process.platform,
    forceFullBanner = process.env.LLM_CHECKER_FORCE_FULL_PANEL_BANNER
} = {}) {
    if (forceFullBanner === '1') return false;

    const terminalRows = getTerminalRows(rows);
    if (!terminalRows) return false;

    // Windows consoles keep a larger compact band: their scrollback/redraw is the
    // worst offender, so favor the single-line header well past the strict fit.
    const fullLayoutMinRows = getFullLayoutMinRows();
    if (platform === 'win32') {
        return terminalRows < Math.max(64, fullLayoutMinRows);
    }
    return terminalRows < fullLayoutMinRows;
}

function getMaxCommandRows({
    rows = process.stdout.rows,
    compact = false
} = {}) {
    const terminalRows = getTerminalRows(rows) || 40;
    const reservedRows = getReservedRows(compact);
    const minimumRows = compact ? MIN_COMPACT_COMMAND_ROWS : MIN_FULL_COMMAND_ROWS;
    return Math.max(minimumRows, Math.min(MAX_COMMAND_ROWS, terminalRows - reservedRows));
}

function tokenizeArgString(rawInput = '') {
    const tokens = [];
    let current = '';
    let quote = null;
    let escape = false;

    for (const char of String(rawInput)) {
        if (escape) {
            current += char;
            escape = false;
            continue;
        }

        if (char === '\\') {
            escape = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === '\'') {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current.length > 0) {
        tokens.push(current);
    }

    return tokens;
}

function getRequiredOptionPrompts(commandMeta) {
    const commandOptions = Array.isArray(commandMeta?.command?.options)
        ? commandMeta.command.options
        : [];

    const isMandatoryOption = (option) => {
        if (!option) return false;
        if (typeof option.mandatory === 'boolean') {
            return option.mandatory;
        }
        return Boolean(option.required);
    };

    return commandOptions
        .filter((option) => isMandatoryOption(option))
        .map((option) => {
            const flag = option.long || option.short || option.flags.split(/[,\s|]+/).find((token) => token.startsWith('-'));
            const attributeName =
                typeof option.attributeName === 'function'
                    ? option.attributeName()
                    : String(flag || 'required').replace(/^-+/, '').replace(/[^a-zA-Z0-9]+/g, '_');
            const optionType = typeof option.isBoolean === 'function' && option.isBoolean() ? 'boolean' : 'value';
            const promptName = `required_${attributeName}`;
            const optionFlags = option.flags || flag || attributeName;
            const message =
                optionType === 'boolean'
                    ? `Required flag ${optionFlags} (enable?):`
                    : `Required option ${optionFlags}:`;

            return {
                promptName,
                flag,
                optionFlags,
                variadic: Boolean(option.variadic),
                optionType,
                message
            };
        })
        .filter((entry) => Boolean(entry.flag));
}

function normalizeVariadicValue(rawValue) {
    const tokens = tokenizeArgString(rawValue);
    const values = [];

    tokens.forEach((token) => {
        String(token)
            .split(',')
            .map((piece) => piece.trim())
            .filter(Boolean)
            .forEach((piece) => values.push(piece));
    });

    return values;
}

function buildRequiredOptionArgs(requiredOptionPrompts, answers) {
    const args = [];

    requiredOptionPrompts.forEach((entry) => {
        const answer = answers ? answers[entry.promptName] : undefined;

        if (entry.optionType === 'boolean') {
            if (answer) args.push(entry.flag);
            return;
        }

        const rawValue = String(answer || '').trim();
        if (!rawValue) return;

        if (entry.variadic) {
            const values = normalizeVariadicValue(rawValue);
            if (values.length > 0) {
                args.push(entry.flag, ...values);
            }
            return;
        }

        args.push(entry.flag, rawValue);
    });

    return args;
}

function buildCommandCatalog(program) {
    return (program.commands || [])
        .map((command) => ({
            name: command.name(),
            description: command.description() || 'No description available',
            command
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function buildPrimaryCommands(catalog) {
    const byName = new Map(catalog.map((item) => [item.name, item]));
    const ordered = [];

    for (const name of PRIMARY_COMMAND_PRIORITY) {
        if (byName.has(name)) ordered.push(byName.get(name));
    }

    if (ordered.length === 0) {
        return catalog.slice(0, 8);
    }

    return ordered;
}

function getVisibleCommands(state, catalog, primaryCommands) {
    if (!state.paletteOpen) {
        return primaryCommands;
    }

    const query = state.query.trim().toLowerCase();
    if (!query) {
        return catalog;
    }

    return catalog.filter((item) => {
        return (
            item.name.toLowerCase().includes(query) ||
            item.description.toLowerCase().includes(query)
        );
    });
}

function getCommandWindow(commands, selectedIndex, maxRows) {
    const total = commands.length;
    if (total <= maxRows) {
        return {
            start: 0,
            end: total,
            items: commands
        };
    }

    const half = Math.floor(maxRows / 2);
    let start = Math.max(0, selectedIndex - half);
    if (start + maxRows > total) {
        start = total - maxRows;
    }

    const end = Math.min(total, start + maxRows);
    return {
        start,
        end,
        items: commands.slice(start, end)
    };
}

function renderPanel(state, catalog, primaryCommands, options = {}) {
    const colorPhase = Number.isFinite(options.colorPhase) ? options.colorPhase : 0;
    const platform = options.platform || process.platform;
    const rows = options.rows ?? process.stdout.rows;
    const columns = options.columns ?? process.stdout.columns;
    const compact = typeof options.compact === 'boolean'
        ? options.compact
        : shouldUseCompactPanelLayout({ rows, platform });
    const width = getPanelWidth({ columns, platform });
    const separator = '-'.repeat(width - 2);
    const visibleCommands = getVisibleCommands(state, catalog, primaryCommands);
    const maxCommandRows = getMaxCommandRows({ rows, compact });
    const selectedIndex =
        visibleCommands.length > 0
            ? Math.max(0, Math.min(state.selected, visibleCommands.length - 1))
            : 0;
    if (selectedIndex !== state.selected) {
        state.selected = selectedIndex;
    }
    const commandWindow = getCommandWindow(visibleCommands, selectedIndex, maxCommandRows);

    clearTerminal({ platform });
    if (compact) {
        console.log(chalk.cyan.bold('llm-checker | Interactive command panel'));
    } else {
        renderPersistentBanner(undefined, { colorPhase, columns, platform });
        console.log('');
    }
    console.log(chalk.gray(separator));
    const inputLabel = state.paletteOpen
        ? truncateText(`/${state.query}`, Math.max(1, width - 4))
        : '';
    console.log(`${chalk.white.bold('>')} ${chalk.white(inputLabel)}${chalk.gray('|')}`);
    console.log(chalk.gray(separator));

    const title = state.paletteOpen
        ? 'All commands (filtered with `/`)'
        : 'Main commands';
    console.log(chalk.cyan(title));
    console.log('');

    if (visibleCommands.length === 0) {
        console.log(chalk.yellow('No commands match your query.'));
    } else {
        const commandCol = Math.min(26, Math.max(12, Math.floor(width * 0.36)));
        const descCol = Math.max(8, width - commandCol - 2);
        const hiddenAbove = commandWindow.start;
        const hiddenBelow = visibleCommands.length - commandWindow.end;

        if (hiddenAbove > 0) {
            console.log(chalk.gray(`... ${hiddenAbove} command(s) above`));
        }

        commandWindow.items.forEach((item, index) => {
            const globalIndex = commandWindow.start + index;
            const active = globalIndex === selectedIndex;
            const commandText = truncateText(`/${item.name}`, commandCol).padEnd(commandCol, ' ');
            const description = truncateText(item.description, descCol);

            if (active) {
                console.log(
                    `${chalk.hex('#7c5cff').bold(commandText)} ${chalk.white(description)}`
                );
            } else {
                console.log(`${chalk.gray(commandText)} ${chalk.gray(description)}`);
            }
        });

        if (hiddenBelow > 0) {
            console.log(chalk.gray(`... ${hiddenBelow} command(s) below`));
        }
    }

    console.log('');
    console.log(chalk.gray(separator));
    console.log(
        chalk.gray(truncateText('up/down navigate | Enter run | / open all | Esc close all | q exit', width))
    );
}

function shouldEnableBannerPulse({
    isTTY = process.stdout.isTTY,
    disableAnimation = process.env.LLM_CHECKER_DISABLE_ANIMATION,
    forcePulse = process.env.LLM_CHECKER_FORCE_PANEL_PULSE,
    platform = process.platform
} = {}) {
    if (!isTTY) return false;
    if (disableAnimation === '1') return false;
    if (forcePulse === '1') return true;
    return platform !== 'win32';
}

async function collectCommandArgs(commandMeta) {
    const prompts = [];
    const requiredPrompts = REQUIRED_ARG_PROMPTS[commandMeta.name] || [];
    const requiredOptionPrompts = getRequiredOptionPrompts(commandMeta);

    for (const requiredPrompt of requiredPrompts) {
        prompts.push({
            type: 'input',
            name: requiredPrompt.name,
            message: requiredPrompt.message,
            prefix: ' ',
            validate: requiredPrompt.validate
        });
    }

    for (const requiredOptionPrompt of requiredOptionPrompts) {
        prompts.push({
            type: requiredOptionPrompt.optionType === 'boolean' ? 'confirm' : 'input',
            name: requiredOptionPrompt.promptName,
            message: requiredOptionPrompt.message,
            prefix: ' ',
            default: requiredOptionPrompt.optionType === 'boolean' ? true : '',
            validate:
                requiredOptionPrompt.optionType === 'boolean'
                    ? undefined
                    : (value) => {
                          const trimmed = String(value || '').trim();
                          if (!trimmed) {
                              return `Provide a value for ${requiredOptionPrompt.optionFlags}`;
                          }

                          if (requiredOptionPrompt.variadic) {
                              const values = normalizeVariadicValue(trimmed);
                              if (values.length === 0) {
                                  return `Provide at least one value for ${requiredOptionPrompt.optionFlags}`;
                              }
                          }

                          return true;
                      }
        });
    }

    if (prompts.length === 0) {
        return [];
    }

    const answers = await inquirer.prompt(prompts);
    const args = [];

    for (const requiredPrompt of requiredPrompts) {
        const value = String(answers[requiredPrompt.name] || '').trim();
        if (value) args.push(value);
    }

    args.push(...buildRequiredOptionArgs(requiredOptionPrompts, answers));

    return args;
}

async function runSelectedCommand(binaryPath, commandMeta) {
    const args = await collectCommandArgs(commandMeta);
    const childArgs = [binaryPath, commandMeta.name, ...args];

    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, childArgs, {
            stdio: 'inherit',
            env: process.env
        });

        child.on('error', reject);
        child.on('close', () => resolve());
    });
}

async function launchInteractivePanel(options) {
    const {
        program,
        binaryPath,
        appName = 'llm-checker'
    } = options;

    if (!program || !binaryPath) {
        throw new Error('launchInteractivePanel requires { program, binaryPath }');
    }

    const catalog = buildCommandCatalog(program);
    if (catalog.length === 0) {
        throw new Error('No commands available for interactive panel');
    }

    const primaryCommands = buildPrimaryCommands(catalog);
    const state = {
        paletteOpen: false,
        query: '',
        selected: 0,
        busy: false,
        colorPhase: 0
    };

    let lastRenderedColorPhase = null;
    const renderNow = () => {
        lastRenderedColorPhase = state.colorPhase;
        renderPanel(state, catalog, primaryCommands, { colorPhase: state.colorPhase });
    };

    // Fix #5: the startup reveal animation (animateBanner) already commits its
    // final banner frame to the screen. Previously renderNow() then immediately
    // cleared and redrew the whole screen a second time, producing a visible
    // double-clear flash. Run the reveal once, then commit the panel chrome a
    // single time on top of the same screen state.
    if (!shouldUseCompactPanelLayout()) {
        await animateBanner({ text: appName });
    }
    renderNow();

    readline.emitKeypressEvents(process.stdin);

    return new Promise((resolve) => {
        const shouldPulseBanner = shouldEnableBannerPulse();
        let pulseTimer = null;
        let resizeTimer = null;

        const stopBannerPulse = () => {
            if (pulseTimer) {
                clearInterval(pulseTimer);
                pulseTimer = null;
            }
        };

        const startBannerPulse = () => {
            if (!shouldPulseBanner || pulseTimer) return;
            // Fix #4: animating color no longer drives a full-screen clear+redraw
            // 8x/second. Slow the cadence and only repaint when the visible color
            // phase actually advanced, so an idle panel stops thrashing the
            // terminal (the flicker amplifier behind issue #86).
            pulseTimer = setInterval(() => {
                if (state.busy) return;
                state.colorPhase = (state.colorPhase + 1) % 1024;
                if (state.colorPhase === lastRenderedColorPhase) return;
                renderNow();
            }, 220);
        };

        // Fix #3: react to terminal resizes. The pulse timer is disabled on
        // Windows, so without this the panel keeps drawing at the old width until
        // the next keypress, tearing the borders (the #86 artifact). Debounce so a
        // drag-resize coalesces into a single repaint at the final size.
        const onResize = () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                resizeTimer = null;
                if (state.busy) return;
                renderNow();
            }, 100);
        };

        const stopResizeWatcher = () => {
            if (resizeTimer) {
                clearTimeout(resizeTimer);
                resizeTimer = null;
            }
            process.stdout.off('resize', onResize);
        };

        const stopInteractiveMode = () => {
            stopBannerPulse();
            stopResizeWatcher();
            process.stdin.off('keypress', onKeypress);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
        };

        const startInteractiveMode = () => {
            process.stdin.on('keypress', onKeypress);
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.resume();
            startBannerPulse();
            process.stdout.on('resize', onResize);
            renderNow();
        };

        const exitPanel = () => {
            stopInteractiveMode();
            process.stdout.write('\n');
            resolve();
        };

        const withCommandExecution = async (commandMeta) => {
            state.busy = true;
            stopInteractiveMode();

            try {
                await runSelectedCommand(binaryPath, commandMeta);
                await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'continue',
                        message: 'Press Enter to return to the panel',
                        prefix: ' '
                    }
                ]);
            } catch (error) {
                await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'continue',
                        message: `Command failed (${error.message}). Press Enter to continue`,
                        prefix: ' '
                    }
                ]);
            } finally {
                state.busy = false;
                startInteractiveMode();
            }
        };

        const onKeypress = (str, key = {}) => {
            if (state.busy) return;

            if (key.ctrl && key.name === 'c') {
                exitPanel();
                return;
            }

            if (str === 'q' && !state.paletteOpen) {
                exitPanel();
                return;
            }

            const visibleCommands = getVisibleCommands(state, catalog, primaryCommands);
            if (visibleCommands.length === 0 && key.name === 'return') {
                return;
            }

            if (key.name === 'up' || key.name === 'down') {
                if (visibleCommands.length > 0) {
                    const direction = key.name === 'up' ? -1 : 1;
                    state.selected =
                        (state.selected + direction + visibleCommands.length) % visibleCommands.length;
                    renderNow();
                }
                return;
            }

            if (key.name === 'return') {
                const selectedCommand = visibleCommands[state.selected];
                if (selectedCommand) {
                    void withCommandExecution(selectedCommand);
                }
                return;
            }

            if (!state.paletteOpen && str === '/') {
                state.paletteOpen = true;
                state.query = '';
                state.selected = 0;
                renderNow();
                return;
            }

            if (state.paletteOpen && key.name === 'escape') {
                state.paletteOpen = false;
                state.query = '';
                state.selected = 0;
                renderNow();
                return;
            }

            if (!state.paletteOpen) {
                return;
            }

            if (key.name === 'backspace') {
                if (state.query.length > 0) {
                    state.query = state.query.slice(0, -1);
                    state.selected = 0;
                    renderNow();
                }
                return;
            }

            if (str && !key.ctrl && !key.meta && /^[a-zA-Z0-9._:-]$/.test(str)) {
                state.query += str;
                state.selected = 0;
                renderNow();
            }
        };

        startInteractiveMode();
    });
}

module.exports = {
    launchInteractivePanel,
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
        shouldUseCompactPanelLayout,
        getBannerLineCount,
        getReservedRows,
        getFullLayoutMinRows,
        FIXED_CHROME_LINES,
        COMPACT_CHROME_LINES,
        MIN_FULL_COMMAND_ROWS,
        MIN_COMPACT_COMMAND_ROWS,
        MAX_COMMAND_ROWS
    }
};
