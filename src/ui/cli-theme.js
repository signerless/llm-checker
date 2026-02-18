'use strict';

const chalk = require('chalk');

// Adapted from ~/Downloads/ascii-motion-cli.tsx frame model.
const THEME_DARK = {
    border: '#6b7280',
    scan: '#56606e',
    outline: '#e2e8f0',
    accent: '#67e8f9',
    logo: '#67e8f9',
    byline: '#facc15',
    subtitle: '#94a3b8',
    muted: '#222a34'
};

const THEME_LIGHT = {
    border: '#475569',
    scan: '#64748b',
    outline: '#0f172a',
    accent: '#0891b2',
    logo: '#0f172a',
    byline: '#854d0e',
    subtitle: '#334155',
    muted: '#cbd5e1'
};

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

const DEFAULT_LOOP = true;
const FRAMES_PER_SECOND = 14;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearTerminal() {
    process.stdout.write('\x1b[2J\x1b[0f');
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

function buildMascotLines(phase) {
    const width = 34;
    const rows = 11;
    const maskOffset = 2;
    const lines = [];

    for (let row = 0; row < rows; row += 1) {
        const maskLine = MASCOT_MASK[row - maskOffset];
        lines.push(applyMask(buildScanline(width, row, phase), maskLine));
    }

    return lines;
}

function buildRows(phase) {
    return [
        ...buildMascotLines(phase).map((text) => ({ kind: 'mascot', text })),
        { kind: 'blank', text: '' },
        ...LOGO_LINES.map((text) => ({ kind: 'logo', text })),
        { kind: 'blank', text: '' },
        { kind: 'byline', text: 'by Pavelevich' },
        { kind: 'subtitle', text: 'Interactive command panel' }
    ];
}

function classifyMascotColor(char) {
    if (char === '=' || char === '-') return 'scan';
    if (char === 'o' || char === '^') return 'accent';
    if (char === '/' || char === '\\' || char === '(' || char === ')' || char === '_') {
        return 'outline';
    }
    return 'outline';
}

function colorKeyForChar(kind, char, visible) {
    if (!visible) return 'muted';

    if (kind === 'blank') return 'muted';
    if (kind === 'logo') return 'logo';
    if (kind === 'byline') return 'byline';
    if (kind === 'subtitle') return 'subtitle';
    if (kind === 'mascot') return classifyMascotColor(char);
    return 'logo';
}

function createFrameData(progress, phase, contentWidth, frameDuration) {
    const sourceRows = buildRows(phase);
    const content = [];
    const fgColors = {};

    for (let y = 0; y < sourceRows.length; y += 1) {
        const row = sourceRows[y];
        const fitted = fitLine(row.text, contentWidth).padEnd(contentWidth, ' ');
        const visibleChars = Math.floor(fitted.length * progress);
        content.push(fitted);

        for (let x = 0; x < fitted.length; x += 1) {
            const char = fitted[x];
            const visible = x < visibleChars;
            const colorKey = colorKeyForChar(row.kind, char, visible);
            if (colorKey) {
                fgColors[`${x},${y}`] = colorKey;
            }
        }
    }

    return {
        duration: frameDuration,
        content,
        fgColors,
        bgColors: {}
    };
}

function resolveTheme(hasDarkBackground) {
    return hasDarkBackground ? THEME_DARK : THEME_LIGHT;
}

function resolveTerminalWidth(preferredWidth) {
    const terminalWidth = process.stdout.columns || preferredWidth;
    const maxWidth = Math.max(24, terminalWidth - 2);

    const sourceRows = buildRows(0);
    const longestLine = sourceRows.reduce((max, row) => Math.max(max, row.text.length), 0);
    const minWidth = longestLine + 4;

    return Math.min(Math.max(preferredWidth, minWidth), maxWidth);
}

function makeFrames(options = {}) {
    const {
        frameCount = 16,
        width = 74,
        hasDarkBackground = true,
        frameDurationMs = Math.round(1000 / FRAMES_PER_SECOND)
    } = options;

    const resolvedWidth = resolveTerminalWidth(width);
    const contentWidth = resolvedWidth - 4;
    const frames = [];

    for (let frameIndex = 0; frameIndex < Math.max(1, frameCount); frameIndex += 1) {
        const progress = frameCount <= 1 ? 1 : frameIndex / (frameCount - 1);
        const phase = frameIndex % 2;
        frames.push(createFrameData(progress, phase, contentWidth, frameDurationMs));
    }

    return {
        width: resolvedWidth,
        theme: resolveTheme(hasDarkBackground),
        frames
    };
}

function applyFg(text, color) {
    if (!color) return text;
    if (color.startsWith('#')) return chalk.hex(color)(text);
    if (typeof chalk[color] === 'function') return chalk[color](text);
    return text;
}

function applyBg(text, color) {
    if (!color) return text;
    if (color.startsWith('#')) return chalk.bgHex(color)(text);
    const key = `bg${color[0].toUpperCase()}${color.slice(1)}`;
    if (typeof chalk[key] === 'function') return chalk[key](text);
    return text;
}

function drawFrame(frame, width, theme) {
    const top = `+${'-'.repeat(width - 2)}+`;
    const bottom = `+${'-'.repeat(width - 2)}+`;

    console.log(applyFg(top, theme.border));

    for (let y = 0; y < frame.content.length; y += 1) {
        const row = frame.content[y];
        let renderedRow = '';

        for (let x = 0; x < row.length; x += 1) {
            const char = row[x];
            const key = `${x},${y}`;
            const fgColorKey = frame.fgColors[key];
            const bgColorKey = frame.bgColors[key];

            const fgColor = fgColorKey ? theme[fgColorKey] : theme.logo;
            const bgColor = bgColorKey ? theme[bgColorKey] : undefined;

            let styled = applyFg(char, fgColor);
            if (bgColor) styled = applyBg(styled, bgColor);
            renderedRow += styled;
        }

        const left = applyFg('| ', theme.border);
        const right = applyFg(' |', theme.border);
        console.log(left + renderedRow + right);
    }

    console.log(applyFg(bottom, theme.border));
}

async function animateBanner(options = {}) {
    const {
        hasDarkBackground = true,
        autoPlay = true,
        loop: _loop = DEFAULT_LOOP,
        frameDelayMs,
        frames = 16,
        enabled = true
    } = options;

    const shouldAnimate =
        enabled &&
        autoPlay &&
        process.stdout.isTTY &&
        process.env.LLM_CHECKER_DISABLE_ANIMATION !== '1';

    const prepared = makeFrames({
        frameCount: Math.max(1, frames),
        hasDarkBackground,
        frameDurationMs: frameDelayMs || Math.round(1000 / FRAMES_PER_SECOND)
    });

    if (!shouldAnimate || prepared.frames.length <= 1) {
        clearTerminal();
        drawFrame(prepared.frames[prepared.frames.length - 1], prepared.width, prepared.theme);
        return;
    }

    for (const frame of prepared.frames) {
        clearTerminal();
        drawFrame(frame, prepared.width, prepared.theme);
        await sleep(frame.duration);
    }
}

function renderPersistentBanner(width = 74) {
    const prepared = makeFrames({ frameCount: 1, width });
    drawFrame(prepared.frames[0], prepared.width, prepared.theme);
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
        makeFrames,
        drawFrame
    }
};
