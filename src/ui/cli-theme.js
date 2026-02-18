'use strict';

const chalk = require('chalk');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
const DEFAULT_BANNER_SOURCE = path.join(os.homedir(), 'Downloads', 'ascii-motion-cli.tsx');
let cachedExternalBanner = null;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearTerminal() {
    process.stdout.write('\x1b[2J\x1b[0f');
}

function fitLine(line, width) {
    const value = String(line || '');
    if (value.length <= width) return value;
    if (value.trim().length === 0) return ' '.repeat(width);
    if (width <= 3) return value.slice(0, width);
    return `${value.slice(0, width - 3)}...`;
}

function extractBalanced(source, startIndex, openChar, closeChar) {
    if (startIndex < 0 || source[startIndex] !== openChar) return null;

    let depth = 0;
    let inString = null;
    let escape = false;

    for (let index = startIndex; index < source.length; index += 1) {
        const char = source[index];

        if (inString) {
            if (escape) {
                escape = false;
                continue;
            }

            if (char === '\\') {
                escape = true;
                continue;
            }

            if (char === inString) {
                inString = null;
            }

            continue;
        }

        if (char === '"' || char === '\'' || char === '`') {
            inString = char;
            continue;
        }

        if (char === openChar) {
            depth += 1;
        } else if (char === closeChar) {
            depth -= 1;
            if (depth === 0) {
                return source.slice(startIndex, index + 1);
            }
        }
    }

    return null;
}

function extractAssignedLiteral(source, constName, openChar, closeChar) {
    const marker = `const ${constName}`;
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return null;

    const equalsIndex = source.indexOf('=', markerIndex);
    if (equalsIndex < 0) return null;

    const startIndex = source.indexOf(openChar, equalsIndex);
    if (startIndex < 0) return null;

    return extractBalanced(source, startIndex, openChar, closeChar);
}

function evaluateLiteral(literal) {
    if (!literal) return null;
    try {
        return Function(`"use strict"; return (${literal});`)();
    } catch {
        return null;
    }
}

function parseNumericConstant(source, constName) {
    const match = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*(\\d+(?:\\.\\d+)?)`));
    if (!match) return null;
    const parsed = Number.parseFloat(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
}

function getLongestFrameLine(frames) {
    let longest = 0;
    for (const frame of frames) {
        const rows = Array.isArray(frame.content) ? frame.content : [];
        for (const row of rows) {
            longest = Math.max(longest, String(row || '').length);
        }
    }
    return longest;
}

function normalizeExternalFrame(frame, contentWidth, defaultDuration) {
    const sourceRows = Array.isArray(frame.content) ? frame.content : [];
    const content = sourceRows.map((line) => fitLine(line, contentWidth).padEnd(contentWidth, ' '));
    const duration = Number.isFinite(frame.duration) ? frame.duration : defaultDuration;

    return {
        duration,
        content,
        fgColors: frame.fgColors && typeof frame.fgColors === 'object' ? frame.fgColors : {},
        bgColors: frame.bgColors && typeof frame.bgColors === 'object' ? frame.bgColors : {}
    };
}

function loadExternalBanner(sourceFile) {
    const filePath = sourceFile || process.env.LLM_CHECKER_BANNER_SOURCE || DEFAULT_BANNER_SOURCE;
    let mtimeMs = -1;

    try {
        const stat = fs.statSync(filePath);
        mtimeMs = stat.mtimeMs;
    } catch {
        cachedExternalBanner = {
            filePath,
            mtimeMs: -1,
            payload: null
        };
        return null;
    }

    if (
        cachedExternalBanner &&
        cachedExternalBanner.filePath === filePath &&
        cachedExternalBanner.mtimeMs === mtimeMs
    ) {
        return cachedExternalBanner.payload;
    }

    try {
        const source = fs.readFileSync(filePath, 'utf8');
        const framesLiteral = extractAssignedLiteral(source, 'FRAMES', '[', ']');
        const darkThemeLiteral = extractAssignedLiteral(source, 'THEME_DARK', '{', '}');
        const lightThemeLiteral = extractAssignedLiteral(source, 'THEME_LIGHT', '{', '}');

        const frames = evaluateLiteral(framesLiteral);
        const themeDark = evaluateLiteral(darkThemeLiteral);
        const themeLight = evaluateLiteral(lightThemeLiteral);
        const canvasWidth = parseNumericConstant(source, 'CANVAS_WIDTH');

        if (!Array.isArray(frames) || frames.length === 0) {
            cachedExternalBanner = {
                filePath,
                mtimeMs,
                payload: null
            };
            return null;
        }

        const payload = {
            frames,
            themeDark: themeDark && typeof themeDark === 'object' ? themeDark : {},
            themeLight: themeLight && typeof themeLight === 'object' ? themeLight : {},
            canvasWidth: Number.isFinite(canvasWidth) ? canvasWidth : null
        };

        cachedExternalBanner = {
            filePath,
            mtimeMs,
            payload
        };

        return payload;
    } catch {
        cachedExternalBanner = {
            filePath,
            mtimeMs,
            payload: null
        };
        return null;
    }
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

function resolveTheme(hasDarkBackground, externalTheme = null) {
    const base = hasDarkBackground ? THEME_DARK : THEME_LIGHT;
    if (!externalTheme || typeof externalTheme !== 'object') return base;
    return { ...base, ...externalTheme };
}

function resolveTerminalWidth(preferredWidth, maxContentWidth) {
    const terminalWidth = process.stdout.columns || preferredWidth;
    const maxWidth = Math.max(24, terminalWidth - 2);
    const fallbackLongest = buildRows(0).reduce((max, row) => Math.max(max, row.text.length), 0);
    const longestLine = Math.max(0, maxContentWidth || fallbackLongest);
    const minWidth = longestLine + 4;

    return Math.min(Math.max(preferredWidth, minWidth), maxWidth);
}

function makeFrames(options = {}) {
    const {
        frameCount = 16,
        width = 74,
        hasDarkBackground = true,
        frameDurationMs = Math.round(1000 / FRAMES_PER_SECOND),
        sourceFile
    } = options;

    const externalBanner = loadExternalBanner(sourceFile);
    if (externalBanner) {
        const longestExternalLine = Math.max(
            getLongestFrameLine(externalBanner.frames),
            externalBanner.canvasWidth || 0
        );
        const resolvedWidth = resolveTerminalWidth(width, longestExternalLine);
        const contentWidth = resolvedWidth - 4;
        const externalTheme = hasDarkBackground
            ? externalBanner.themeDark
            : externalBanner.themeLight;
        const theme = resolveTheme(hasDarkBackground, externalTheme);

        const sourceFrames = externalBanner.frames.length > 0
            ? externalBanner.frames
            : [{ content: [''], fgColors: {}, bgColors: {}, duration: frameDurationMs }];

        const externalFrames = sourceFrames.map((frame) =>
            normalizeExternalFrame(frame, contentWidth, frameDurationMs)
        );

        if (frameCount <= 1) {
            return {
                width: resolvedWidth,
                theme,
                frames: [externalFrames[externalFrames.length - 1]]
            };
        }

        return {
            width: resolvedWidth,
            theme,
            frames: externalFrames
        };
    }

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
    const contentWidth = width - 4;

    console.log(applyFg(top, theme.border));

    for (let y = 0; y < frame.content.length; y += 1) {
        const row = fitLine(frame.content[y] || '', contentWidth).padEnd(contentWidth, ' ');
        let renderedRow = '';

        for (let x = 0; x < row.length; x += 1) {
            const char = row[x];
            const key = `${x},${y}`;
            const fgColorKey = frame.fgColors[key];
            const bgColorKey = frame.bgColors[key];

            const fgColor = fgColorKey
                ? (theme[fgColorKey] || fgColorKey)
                : (theme.logo || 'white');
            const bgColor = bgColorKey
                ? (theme[bgColorKey] || bgColorKey)
                : undefined;

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
