'use strict';

const chalk = require('chalk');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearTerminal() {
    process.stdout.write('\x1b[2J\x1b[0f');
}

function buildShimmerText(text, frameIndex) {
    const cursor = frameIndex % (text.length + 6);
    return text
        .split('')
        .map((char, index) => {
            const distance = Math.abs(index - (cursor - 3));
            if (distance === 0) return chalk.cyanBright.bold(char);
            if (distance <= 1) return chalk.cyan(char);
            return chalk.gray(char);
        })
        .join('');
}

function drawBannerFrame(text, frameIndex, width = 72) {
    const top = `+${'-'.repeat(width - 2)}+`;
    const bottom = `+${'-'.repeat(width - 2)}+`;
    const shimmerText = buildShimmerText(text, frameIndex);
    const subtitle = chalk.gray('Interactive command panel');
    const contentWidth = width - 4;
    const line1 = shimmerText.padEnd(contentWidth, ' ');
    const line2 = subtitle.padEnd(contentWidth, ' ');

    console.log(chalk.gray(top));
    console.log(chalk.gray('| ') + line1 + chalk.gray(' |'));
    console.log(chalk.gray('| ') + line2 + chalk.gray(' |'));
    console.log(chalk.gray(bottom));
}

async function animateBanner(options = {}) {
    const {
        text = 'llm-checker',
        frames = 14,
        frameDelayMs = 38,
        enabled = true
    } = options;

    const shouldAnimate =
        enabled &&
        process.stdout.isTTY &&
        process.env.LLM_CHECKER_DISABLE_ANIMATION !== '1';

    if (!shouldAnimate) {
        clearTerminal();
        drawBannerFrame(text, 0);
        return;
    }

    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
        clearTerminal();
        drawBannerFrame(text, frameIndex);
        await sleep(frameDelayMs);
    }
}

function renderCommandHeader(commandLabel) {
    const label = String(commandLabel || 'command');
    const line = '-'.repeat(Math.min(64, Math.max(28, label.length + 24)));
    console.log(chalk.cyan.bold(`\nllm-checker | ${label}`));
    console.log(chalk.gray(line));
}

module.exports = {
    animateBanner,
    renderCommandHeader,
    __private: {
        buildShimmerText
    }
};
