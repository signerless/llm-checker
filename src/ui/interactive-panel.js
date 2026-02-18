'use strict';

const chalk = require('chalk');
const inquirer = require('inquirer');
const readline = require('readline');
const { spawn } = require('child_process');
const { animateBanner, renderPersistentBanner } = require('./cli-theme');

const PRIMARY_COMMAND_PRIORITY = [
    'check',
    'recommend',
    'ai-run',
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

function clearTerminal() {
    process.stdout.write('\x1b[2J\x1b[0f');
}

function truncateText(text, maxLength) {
    const value = String(text || '');
    if (value.length <= maxLength) return value;
    if (maxLength <= 3) return value.slice(0, maxLength);
    return `${value.slice(0, maxLength - 3)}...`;
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
    const width = Math.max(76, Math.min(process.stdout.columns || 100, 128));
    const separator = '-'.repeat(width - 2);
    const visibleCommands = getVisibleCommands(state, catalog, primaryCommands);
    const maxCommandRows = Math.max(6, Math.min(16, (process.stdout.rows || 40) - 28));
    const selectedIndex =
        visibleCommands.length > 0
            ? Math.max(0, Math.min(state.selected, visibleCommands.length - 1))
            : 0;
    if (selectedIndex !== state.selected) {
        state.selected = selectedIndex;
    }
    const commandWindow = getCommandWindow(visibleCommands, selectedIndex, maxCommandRows);

    clearTerminal();
    renderPersistentBanner(undefined, { colorPhase });
    console.log('');
    console.log(chalk.gray(separator));
    const inputLabel = state.paletteOpen ? `/${state.query}` : '';
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
        const commandCol = 26;
        const descCol = Math.max(18, width - commandCol - 8);
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
        chalk.gray('up/down navigate | Enter run | / open all | Esc close all | q exit')
    );
}

async function collectCommandArgs(commandMeta) {
    const prompts = [];
    const requiredPrompts = REQUIRED_ARG_PROMPTS[commandMeta.name] || [];

    for (const requiredPrompt of requiredPrompts) {
        prompts.push({
            type: 'input',
            name: requiredPrompt.name,
            message: requiredPrompt.message,
            validate: requiredPrompt.validate
        });
    }

    prompts.push({
        type: 'input',
        name: 'extraArgs',
        message: 'Optional extra params (example: --json --limit 5):',
        default: ''
    });

    const answers = await inquirer.prompt(prompts);
    const args = [];

    for (const requiredPrompt of requiredPrompts) {
        const value = String(answers[requiredPrompt.name] || '').trim();
        if (value) args.push(value);
    }

    const extraArgs = String(answers.extraArgs || '').trim();
    if (extraArgs) {
        args.push(...tokenizeArgString(extraArgs));
    }

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

    const renderNow = () => {
        renderPanel(state, catalog, primaryCommands, { colorPhase: state.colorPhase });
    };

    await animateBanner({ text: appName });
    renderNow();

    readline.emitKeypressEvents(process.stdin);

    return new Promise((resolve) => {
        const shouldPulseBanner =
            process.stdout.isTTY &&
            process.env.LLM_CHECKER_DISABLE_ANIMATION !== '1';
        let pulseTimer = null;

        const stopBannerPulse = () => {
            if (pulseTimer) {
                clearInterval(pulseTimer);
                pulseTimer = null;
            }
        };

        const startBannerPulse = () => {
            if (!shouldPulseBanner || pulseTimer) return;
            pulseTimer = setInterval(() => {
                if (state.busy) return;
                state.colorPhase = (state.colorPhase + 1) % 1024;
                renderNow();
            }, 120);
        };

        const stopInteractiveMode = () => {
            stopBannerPulse();
            process.stdin.off('keypress', onKeypress);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
        };

        const startInteractiveMode = () => {
            process.stdin.on('keypress', onKeypress);
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.resume();
            startBannerPulse();
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
                        message: 'Press Enter to return to the panel'
                    }
                ]);
            } catch (error) {
                await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'continue',
                        message: `Command failed (${error.message}). Press Enter to continue`
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
        buildCommandCatalog,
        buildPrimaryCommands,
        getVisibleCommands,
        truncateText
    }
};
