'use strict';

const chalk = require('chalk');

const ASCII_BANNER_LINES = [
    ' _      _      __  __    ____ _               _             ',
    '| |    | |    |  \\/  |  / ___| |__   ___  ___| | _____ _ __ ',
    "| |    | |    | |\\/| | | |   | '_ \\ / _ \\/ __| |/ / _ \\ '__|",
    '| |___ | |___ | |  | | | |___| | | |  __/ (__|   <  __/ |   ',
    '|_____||_____||_|  |_|  \\____|_| |_|\\___|\\___|_|\\_\\___|_|   '
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearTerminal() {
    process.stdout.write('\x1b[2J\x1b[0f');
}

function revealLine(line, progress) {
    const normalized = Math.max(0, Math.min(1, progress));
    const visibleChars = Math.floor(line.length * normalized);
    const visible = line.slice(0, visibleChars);
    const hidden = line.slice(visibleChars);
    return chalk.cyanBright(visible) + chalk.gray(hidden);
}

function drawBannerFrame(frameIndex, totalFrames, width = 74) {
    const progress = totalFrames <= 1 ? 1 : frameIndex / (totalFrames - 1);
    const top = `+${'-'.repeat(width - 2)}+`;
    const bottom = `+${'-'.repeat(width - 2)}+`;
    const contentWidth = width - 4;

    console.log(chalk.gray(top));
    for (const line of ASCII_BANNER_LINES) {
        const rendered = revealLine(line, progress).padEnd(contentWidth, ' ');
        console.log(chalk.gray('| ') + rendered + chalk.gray(' |'));
    }
    const byline = chalk.yellow('by Pavelevich');
    const subtitle = chalk.gray('Interactive command panel');
    console.log(chalk.gray('| ') + byline.padEnd(contentWidth, ' ') + chalk.gray(' |'));
    console.log(chalk.gray('| ') + subtitle.padEnd(contentWidth, ' ') + chalk.gray(' |'));
    console.log(chalk.gray(bottom));
}

async function animateBanner(options = {}) {
    const {
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
