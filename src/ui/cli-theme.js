'use strict';

const chalk = require('chalk');

const LOGO_LINES = [
    ' _      _      __  __    ____ _               _             ',
    '| |    | |    |  \\/  |  / ___| |__   ___  ___| | _____ _ __ ',
    "| |    | |    | |\\/| | | |   | '_ \\ / _ \\/ __| |/ / _ \\ '__|",
    '| |___ | |___ | |  | | | |___| | | |  __/ (__|   <  __/ |   ',
    '|_____||_____||_|  |_|  \\____|_| |_|\\___|\\___|_|\\_\\___|_|   '
];

const MASCOT_MASK = [
    '             /\\_/\\             ',
    '            / o o \\            ',
    '           (   ^   )           ',
    '            \\  _  /            ',
    '             /___\\             ',
    '            /     \\            ',
    '           (_/   \\_)           '
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearTerminal() {
    process.stdout.write('\x1b[2J\x1b[0f');
}

function revealLine(line, progress, visibleColor = chalk.cyanBright, hiddenColor = chalk.hex('#222a34')) {
    const normalized = Math.max(0, Math.min(1, progress));
    const visibleChars = Math.floor(line.length * normalized);
    const visible = line.slice(0, visibleChars);
    const hidden = line.slice(visibleChars);
    return visibleColor(visible) + hiddenColor(hidden);
}

function fitLine(line, width) {
    const value = String(line || '');
    if (value.length <= width) return value;
    if (width <= 3) return value.slice(0, width);
    return `${value.slice(0, width - 3)}...`;
}

function buildScanline(width, row, phase) {
    const stripe = (row + phase) % 2 === 0 ? '=' : '-';
    return stripe.repeat(width);
}

function applyMask(baseLine, maskLine) {
    if (!maskLine) return baseLine;

    const result = baseLine.split('');
    const limit = Math.min(baseLine.length, maskLine.length);
    for (let index = 0; index < limit; index += 1) {
        const symbol = maskLine[index];
        if (symbol !== ' ') result[index] = symbol;
    }
    return result.join('');
}

function buildMascotLines(frameIndex) {
    const width = 34;
    const rows = 11;
    const phase = frameIndex % 2;
    const maskOffset = 2;
    const lines = [];

    for (let row = 0; row < rows; row += 1) {
        const maskLine = MASCOT_MASK[row - maskOffset];
        lines.push(applyMask(buildScanline(width, row, phase), maskLine));
    }

    return lines;
}

function buildBannerRows(frameIndex) {
    return [
        ...buildMascotLines(frameIndex).map((text) => ({ kind: 'mascot', text })),
        { kind: 'blank', text: '' },
        ...LOGO_LINES.map((text) => ({ kind: 'logo', text })),
        { kind: 'blank', text: '' },
        { kind: 'byline', text: 'by Pavelevich' },
        { kind: 'subtitle', text: 'Interactive command panel' }
    ];
}

function colorizeMascotLine(line, progress) {
    const normalized = Math.max(0, Math.min(1, progress));
    const visibleChars = Math.floor(line.length * normalized);
    let rendered = '';

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (index >= visibleChars) {
            rendered += chalk.hex('#222a34')(char);
            continue;
        }

        if (char === '=' || char === '-') {
            rendered += chalk.hex('#5a6472')(char);
        } else if (char === 'o' || char === '^') {
            rendered += chalk.cyanBright(char);
        } else {
            rendered += chalk.whiteBright(char);
        }
    }

    return rendered;
}

function styleRow(row, progress) {
    if (row.kind === 'blank') return chalk.hex('#222a34')(row.text);
    if (row.kind === 'mascot') return colorizeMascotLine(row.text, progress);
    if (row.kind === 'logo') return revealLine(row.text, progress, chalk.cyanBright, chalk.hex('#222a34'));
    if (row.kind === 'byline') return revealLine(row.text, progress, chalk.yellow, chalk.hex('#222a34'));
    return revealLine(row.text, progress, chalk.gray, chalk.hex('#222a34'));
}

function drawBannerFrame(frameIndex, totalFrames, preferredWidth = 74) {
    const progress = totalFrames <= 1 ? 1 : frameIndex / (totalFrames - 1);
    const rows = buildBannerRows(frameIndex);
    const longestLine = rows.reduce((max, row) => Math.max(max, row.text.length), 0);
    const minWidth = longestLine + 4;
    const terminalWidth = process.stdout.columns || preferredWidth;
    const maxWidth = Math.max(24, terminalWidth - 2);
    const width = Math.min(Math.max(preferredWidth, minWidth), maxWidth);
    const contentWidth = width - 4;
    const top = `+${'-'.repeat(width - 2)}+`;
    const bottom = `+${'-'.repeat(width - 2)}+`;

    console.log(chalk.gray(top));
    for (const row of rows) {
        const fitted = fitLine(row.text, contentWidth).padEnd(contentWidth, ' ');
        const rendered = styleRow({ ...row, text: fitted }, progress);
        console.log(chalk.gray('| ') + rendered + chalk.gray(' |'));
    }
    console.log(chalk.gray(bottom));
}

async function animateBanner(options = {}) {
    const {
        text: _text = 'llm-checker',
        frames = 16,
        frameDelayMs = 34,
        enabled = true
    } = options;

    const shouldAnimate =
        enabled &&
        process.stdout.isTTY &&
        process.env.LLM_CHECKER_DISABLE_ANIMATION !== '1';

    if (!shouldAnimate) {
        clearTerminal();
        drawBannerFrame(1, 1);
        return;
    }

    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
        clearTerminal();
        drawBannerFrame(frameIndex, frames);
        await sleep(frameDelayMs);
    }
}

function renderPersistentBanner(width = 74) {
    drawBannerFrame(1, 1, width);
}

function renderCommandHeader(commandLabel) {
    const label = String(commandLabel || 'command');
    const line = '-'.repeat(Math.min(64, Math.max(28, label.length + 24)));
    console.log(chalk.cyan.bold(`\nllm-checker | ${label}`));
    console.log(chalk.gray(line));
}

module.exports = {
    animateBanner,
    renderPersistentBanner,
    renderCommandHeader,
    __private: {
        revealLine
    }
};
