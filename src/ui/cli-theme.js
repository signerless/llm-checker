'use strict';

const chalk = require('chalk');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Adapted from /Users/pchmirenko/Downloads/ascii-motion-cli.tsx frame model.
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

const DEFAULT_LOOP = true;
const FRAMES_PER_SECOND = 14;
// Security: do not auto-load executable-style banner sources from user-writable folders.
// External banner loading is opt-in via LLM_CHECKER_BANNER_SOURCE and supports JSON only.
const DEFAULT_BANNER_SOURCE = null;
// Canonical startup banner asset. Do not edit casually: treat as product identity.
// Any intentional change should update tests/banner-canonical.test.js in the same commit.
const BUNDLED_TEXT_BANNER_SOURCE = path.join(__dirname, 'banner-profesional-v2.txt');
const DEFAULT_TEXT_BANNER_SOURCES = [
    BUNDLED_TEXT_BANNER_SOURCE
];
let cachedExternalBanner = null;
let cachedTextBanner = null;
let cachedMacOsDarkBackground = null;

const TEXT_BANNER_PALETTES = {
    dark: {
        border: '#0066FF',
        primary: '#60A5FA',
        feature: '#A7F3D0',
        subtitle: '#C7D2FE',
        link: '#3B82F6',
        install: '#F8FAFC',
        art: '#F8FAFC',
        solidLogo: ['#F8FAFC', '#E2ECFF', '#DBEAFE', '#E2ECFF'],
        shadedLogo: ['#93C5FD', '#60A5FA', '#38BDF8', '#22D3EE', '#38BDF8', '#60A5FA']
    },
    light: {
        border: '#0047B3',
        primary: '#003A8C',
        feature: '#047857',
        subtitle: '#3730A3',
        link: '#1D4ED8',
        install: '#111827',
        art: '#111827',
        solidLogo: ['#0F172A', '#1E3A8A', '#111827', '#1E40AF'],
        shadedLogo: ['#1D4ED8', '#0369A1', '#0F766E', '#047857', '#1D4ED8']
    }
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSafeTerminalWidth(columns = process.stdout.columns, platform = process.platform) {
    void platform;
    const value = Number(columns);
    if (!Number.isFinite(value) || value <= 0) return null;

    const width = Math.floor(value);
    // Many terminals (Windows consoles, libvte, tmux, SSH) auto-wrap when output
    // writes exactly `columns` cells, which tears the persistent panel border on
    // resize/pulse. The canonical banner is centered/clipped, so reserving one
    // trailing cell on every platform is invisible while avoiding the wrap.
    return Math.max(20, width - 1);
}

function getTerminalClearSequence(platform = process.platform) {
    if (platform === 'win32') {
        return '\x1b[1;1H\x1b[0J';
    }

    return '\x1b[2J\x1b[H';
}

function clearTerminal(options = {}) {
    if (!process.stdout.isTTY) return;

    const platform = options.platform || process.platform;
    if (platform === 'win32') {
        process.stdout.write(getTerminalClearSequence(platform));
        return;
    }

    try {
        readline.cursorTo(process.stdout, 0, 0);
        readline.clearScreenDown(process.stdout);
    } catch {
        process.stdout.write(getTerminalClearSequence(platform));
    }
}

function parseDarkBackgroundValue(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const normalized = value.trim().toLowerCase();

    if (['dark', 'true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['light', 'false', '0', 'no', 'off'].includes(normalized)) return false;

    return null;
}

function detectDarkBackgroundFromColorFgbg(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;

    const parts = value.split(';');
    const backgroundCode = Number.parseInt(parts[parts.length - 1], 10);
    if (!Number.isFinite(backgroundCode)) return null;

    const lightBackgrounds = new Set([7, 10, 11, 14, 15]);
    const darkBackgrounds = new Set([0, 1, 2, 4, 5, 6, 8]);

    if (lightBackgrounds.has(backgroundCode)) return false;
    if (darkBackgrounds.has(backgroundCode)) return true;

    return null;
}

function detectDarkBackgroundFromMacOsAppearance() {
    if (process.platform !== 'darwin') return null;
    if (cachedMacOsDarkBackground !== null) return cachedMacOsDarkBackground;

    try {
        const output = execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 100
        });
        cachedMacOsDarkBackground = output.trim().toLowerCase().includes('dark');
    } catch {
        // macOS omits AppleInterfaceStyle when the system appearance is Light.
        cachedMacOsDarkBackground = false;
    }

    return cachedMacOsDarkBackground;
}

function resolveHasDarkBackground(options = {}) {
    if (typeof options.hasDarkBackground === 'boolean') {
        return options.hasDarkBackground;
    }

    const explicit =
        parseDarkBackgroundValue(process.env.LLM_CHECKER_BANNER_THEME) ??
        parseDarkBackgroundValue(process.env.LLM_CHECKER_HAS_DARK_BACKGROUND) ??
        parseDarkBackgroundValue(process.env.TERM_BACKGROUND);

    if (explicit !== null) return explicit;

    const colorFgbg = detectDarkBackgroundFromColorFgbg(process.env.COLORFGBG);
    if (colorFgbg !== null) return colorFgbg;

    const macOsAppearance = detectDarkBackgroundFromMacOsAppearance();
    if (macOsAppearance !== null) return macOsAppearance;

    return true;
}

function getTextBannerPalette(options = {}) {
    return resolveHasDarkBackground(options)
        ? TEXT_BANNER_PALETTES.dark
        : TEXT_BANNER_PALETTES.light;
}

function fitLine(line, width) {
    const value = String(line || '');
    if (value.length <= width) return value;
    if (value.trim().length === 0) return ' '.repeat(width);
    if (width <= 3) return value.slice(0, width);
    return `${value.slice(0, width - 3)}...`;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseExternalBannerPayload(source) {
    let parsed = null;
    try {
        parsed = JSON.parse(source);
    } catch {
        return null;
    }

    if (!isPlainObject(parsed)) return null;
    const frames = Array.isArray(parsed.frames) ? parsed.frames : null;
    if (!frames || frames.length === 0) return null;

    return {
        frames,
        themeDark: isPlainObject(parsed.themeDark) ? parsed.themeDark : {},
        themeLight: isPlainObject(parsed.themeLight) ? parsed.themeLight : {},
        canvasWidth: Number.isFinite(parsed.canvasWidth) ? parsed.canvasWidth : null
    };
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
    if (!filePath) return null;

    const extension = path.extname(filePath).toLowerCase();
    if (extension !== '.json') {
        cachedExternalBanner = {
            filePath,
            mtimeMs: -1,
            payload: null
        };
        return null;
    }

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
        const payload = parseExternalBannerPayload(source);
        if (!payload) {
            cachedExternalBanner = {
                filePath,
                mtimeMs,
                payload: null
            };
            return null;
        }

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

function loadTextBanner(sourceFile) {
    const requestedFile =
        sourceFile ||
        process.env.LLM_CHECKER_TEXT_BANNER_SOURCE ||
        DEFAULT_TEXT_BANNER_SOURCES.find((candidate) => fs.existsSync(candidate)) ||
        DEFAULT_TEXT_BANNER_SOURCES[0];
    const filePath = requestedFile;
    let mtimeMs = -1;

    try {
        const stat = fs.statSync(filePath);
        mtimeMs = stat.mtimeMs;
    } catch {
        cachedTextBanner = {
            filePath,
            mtimeMs: -1,
            lines: null
        };
        return null;
    }

    if (
        cachedTextBanner &&
        cachedTextBanner.filePath === filePath &&
        cachedTextBanner.mtimeMs === mtimeMs
    ) {
        return cachedTextBanner.lines;
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = String(raw).split(/\r?\n/);
        cachedTextBanner = {
            filePath,
            mtimeMs,
            lines
        };
        return lines;
    } catch {
        cachedTextBanner = {
            filePath,
            mtimeMs,
            lines: null
        };
        return null;
    }
}

function getTextBannerLineCount(sourceFile) {
    const lines = loadTextBanner(sourceFile);
    return Array.isArray(lines) ? lines.length : 0;
}

function drawTextBanner(lines, options = {}) {
    const palette = getTextBannerPalette(options);
    const colorPhase = Number.isFinite(options.colorPhase)
        ? Math.max(0, Math.floor(options.colorPhase))
        : 0;
    const terminalWidth = getSafeTerminalWidth(
        options.columns ?? process.stdout.columns,
        options.platform || process.platform
    );

    const centerToWidth = (text, width) => {
        const value = String(text || '').replace(/\s+$/g, '');
        if (!Number.isFinite(width) || width <= 0) return value;
        if (value.length >= width) return value.slice(0, width);
        const left = Math.floor((width - value.length) / 2);
        const right = width - value.length - left;
        return `${' '.repeat(left)}${value}${' '.repeat(right)}`;
    };

    const fitLogoToWidth = (text, width) => {
        if (!Number.isFinite(width) || width <= 0) return String(text || '');

        const base = String(text || '').replace(/\s+$/g, '');
        if (base.length <= width) {
            return centerToWidth(base, width);
        }

        // Do not distort glyphs. If still too wide, degrade to readable fallback.
        return centerToWidth(width >= 24 ? 'LLM-CHECKER' : 'LLM', width);
    };

    const colorizeDosRebelLine = (text) => {
        const solidPalette = palette.solidLogo;
        const shadePalette = palette.shadedLogo;
        let out = '';
        for (let index = 0; index < text.length; index += 1) {
            const ch = text[index];
            if (ch === '█') {
                const tone = solidPalette[(index + colorPhase) % solidPalette.length];
                out += chalk.hex(tone)(ch);
            } else if (ch === '░' || ch === '▒' || ch === '▓') {
                const tone = shadePalette[(index + colorPhase) % shadePalette.length];
                out += chalk.hex(tone)(ch);
            } else {
                out += ch;
            }
        }
        return out;
    };

    for (const line of lines) {
        if (!line) {
            console.log('');
            continue;
        }

        if (/^\s*\+[-+]+\+\s*$/.test(line)) {
            if (terminalWidth && terminalWidth >= 10) {
                const inner = Math.max(6, terminalWidth - 4);
                console.log(chalk.hex(palette.border)(` +${'-'.repeat(inner)}+ `));
            } else {
                console.log(chalk.hex(palette.border)(line));
            }
            continue;
        }

        const frameMatch = line.match(/^(\s*\|)(.*)(\|\s*)$/);
        if (!frameMatch) {
            console.log(terminalWidth ? fitLine(line, terminalWidth) : line);
            continue;
        }

        const left = chalk.hex(palette.border)(frameMatch[1]);
        const right = chalk.hex(palette.border)(frameMatch[3]);
        const content = frameMatch[2];
        const maxInnerWidth = terminalWidth
            ? Math.max(0, terminalWidth - (frameMatch[1].length + frameMatch[3].length))
            : null;
        const isDosRebelLike =
            content.includes('█') ||
            content.includes('░') ||
            content.includes('▒') ||
            content.includes('▓');

        let fittedContent = content;
        if (Number.isFinite(maxInnerWidth)) {
            if (isDosRebelLike) {
                fittedContent = fitLogoToWidth(content, maxInnerWidth);
            } else {
                const trimmed = content.trim();
                fittedContent = trimmed.length === 0
                    ? ' '.repeat(maxInnerWidth)
                    : centerToWidth(trimmed, maxInnerWidth);
            }
        }

        let inner = fittedContent;

        if (
            fittedContent.includes('INTELLIGENT OLLAMA MODEL SELECTOR') ||
            fittedContent.includes('Deterministic scoring across') ||
            fittedContent.includes('Run: llm-checker recommend')
        ) {
            inner = chalk.hex(palette.primary)(fittedContent);
        } else if (
            fittedContent.includes('[200+ DYNAMIC MODELS]') ||
            fittedContent.includes('[35+ FALLBACK]') ||
            fittedContent.includes('[4D SCORING]') ||
            fittedContent.includes('[MULTI-GPU]') ||
            fittedContent.includes('[MCP SERVER]')
        ) {
            inner = chalk.hex(palette.feature)(fittedContent);
        } else if (
            fittedContent.includes('AI-powered CLI for hardware-aware local LLM recommendations')
        ) {
            inner = chalk.hex(palette.subtitle)(fittedContent);
        } else if (
            fittedContent.includes('github.com/signerless/llm-checker') ||
            fittedContent.includes('npmjs.com/package/llm-checker')
        ) {
            inner = chalk.hex(palette.link)(fittedContent);
        } else if (fittedContent.includes('Install: npm install -g llm-checker')) {
            inner = chalk.hex(palette.install)(fittedContent);
        } else if (
            fittedContent.includes('█') ||
            fittedContent.includes('░') ||
            fittedContent.includes('▒') ||
            fittedContent.includes('▓')
        ) {
            inner = colorizeDosRebelLine(fittedContent);
        } else if (
            /[_\\\/|]/.test(fittedContent) ||
            fittedContent.includes('____') ||
            fittedContent.includes('▀') ||
            fittedContent.includes('▄')
        ) {
            inner = chalk.hex(palette.art)(fittedContent);
        }

        console.log(left + inner + right);
    }
}

function buildRows(phase) {
    void phase;
    return [
        { kind: 'blank', text: '' },
        ...LOGO_LINES.map((text) => ({ kind: 'logo', text })),
        { kind: 'blank', text: '' },
        { kind: 'byline', text: 'by Pavelevich' },
        { kind: 'subtitle', text: 'Interactive command panel' }
    ];
}

function colorKeyForChar(kind, char, visible) {
    void char;
    if (!visible) return 'muted';

    if (kind === 'blank') return 'muted';
    if (kind === 'logo') return 'logo';
    if (kind === 'byline') return 'byline';
    if (kind === 'subtitle') return 'subtitle';
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

    const frameDurationMs = frameDelayMs || Math.round(1000 / FRAMES_PER_SECOND);
    const prepared = makeFrames({
        frameCount: Math.max(1, frames),
        hasDarkBackground,
        frameDurationMs
    });
    const textBanner = loadTextBanner();

    if (textBanner && textBanner.length > 0) {
        if (!shouldAnimate) {
            clearTerminal();
            drawTextBanner(textBanner, { hasDarkBackground });
            return;
        }

        const textFrames = Math.max(10, Math.min(24, frames));
        for (let frameIndex = 0; frameIndex < textFrames; frameIndex += 1) {
            clearTerminal();
            drawTextBanner(textBanner, { colorPhase: frameIndex, hasDarkBackground });
            await sleep(frameDurationMs);
        }
        return;
    }

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

function renderPersistentBanner(width = 74, options = {}) {
    const textBanner = loadTextBanner();
    if (textBanner && textBanner.length > 0) {
        drawTextBanner(textBanner, options);
        return;
    }

    const prepared = makeFrames({
        frameCount: 1,
        width,
        hasDarkBackground: resolveHasDarkBackground(options)
    });
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
        detectDarkBackgroundFromColorFgbg,
        detectDarkBackgroundFromMacOsAppearance,
        fitLine,
        drawTextBanner,
        clearTerminal,
        getSafeTerminalWidth,
        getTerminalClearSequence,
        makeFrames,
        drawFrame,
        resolveHasDarkBackground,
        loadTextBanner,
        getTextBannerLineCount
    }
};
