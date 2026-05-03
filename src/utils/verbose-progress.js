const chalk = require('chalk');
const ora = require('ora');

/**
 * Minimal activity indicator used while analysis is running.
 * It intentionally keeps output to one animated line, then clears before results.
 */
class VerboseProgress {
    constructor(enabled = true) {
        this.enabled = enabled;
        this.currentStep = 0;
        this.totalSteps = 0;
        this.operationTitle = '';
        this.startTime = null;
        this.currentSpinner = null;
        this.animationTimer = null;
        this.currentVerb = 'thinking';
        this.currentDetail = '';
        this.colorPhase = 0;
    }

    startOperation(title, totalSteps) {
        if (!this.enabled) return this;

        this.operationTitle = title;
        this.totalSteps = totalSteps;
        this.currentStep = 0;
        this.startTime = Date.now();
        this.currentVerb = 'thinking';
        this.currentDetail = '';

        if (!this.shouldAnimate()) return this;

        this.currentSpinner = ora({
            text: this.renderActivityText(),
            spinner: 'dots'
        }).start();

        this.animationTimer = setInterval(() => {
            this.colorPhase += 1;
            this.updateSpinner();
        }, 120);

        return this;
    }

    step(description, details = null) {
        if (!this.enabled) return this;

        this.currentStep += 1;
        this.currentVerb = this.verbForStep(description);
        this.currentDetail = details || description || '';
        this.updateSpinner();

        return this;
    }

    substep(description) {
        if (!this.enabled) return this;

        this.currentDetail = description || this.currentDetail;
        this.updateSpinner();

        return this;
    }

    stepComplete(result = null) {
        if (!this.enabled) return this;

        if (result) this.currentDetail = result;
        this.updateSpinner();

        return this;
    }

    stepFail(error = null) {
        if (!this.enabled) return this;

        if (error) this.currentDetail = error;
        this.updateSpinner();

        return this;
    }

    info(message) {
        if (!this.enabled) return this;

        this.currentDetail = message || this.currentDetail;
        this.updateSpinner();

        return this;
    }

    warn(message) {
        if (!this.enabled) return this;

        this.currentDetail = message || this.currentDetail;
        this.updateSpinner();

        return this;
    }

    found(message, count = null) {
        if (!this.enabled) return this;

        const countStr = count !== null ? ` (${count})` : '';
        this.currentDetail = `${message || ''}${countStr}`;
        this.updateSpinner();

        return this;
    }

    complete() {
        if (!this.enabled) return this;

        this.stopSpinner();

        return this;
    }

    fail(error = null) {
        if (!this.enabled) return this;

        if (this.currentSpinner) {
            this.currentSpinner.fail(error ? `failed: ${error}` : 'failed');
            this.currentSpinner = null;
        }
        this.clearTimer();

        return this;
    }

    shouldAnimate() {
        return Boolean(
            process.stdout.isTTY &&
            process.env.CI !== 'true' &&
            process.env.LLM_CHECKER_DISABLE_ANIMATION !== '1'
        );
    }

    verbForStep(description = '') {
        const text = String(description).toLowerCase();

        if (text.includes('system') || text.includes('hardware')) return 'scanning';
        if (text.includes('database')) return 'syncing';
        if (text.includes('model analysis')) return 'matching';
        if (text.includes('ollama')) return 'checking';
        if (text.includes('filter')) return 'filtering';
        if (text.includes('compatibility')) return 'matching';
        if (text.includes('performance')) return 'estimating';
        if (text.includes('recommend')) return 'ranking';

        return 'thinking';
    }

    renderActivityText() {
        const dots = '.'.repeat((this.colorPhase % 3) + 1);
        const verb = this.colorize(`${this.currentVerb}${dots}`);
        const detail = this.currentDetail ? ` ${chalk.dim(this.currentDetail)}` : '';

        return `${verb}${detail}`;
    }

    colorize(text) {
        const palette = ['#38BDF8', '#60A5FA', '#818CF8', '#A78BFA', '#22D3EE'];
        return String(text)
            .split('')
            .map((char, index) => chalk.hex(palette[(index + this.colorPhase) % palette.length])(char))
            .join('');
    }

    updateSpinner() {
        if (!this.currentSpinner) return;

        this.currentSpinner.text = this.renderActivityText();
    }

    stopSpinner() {
        if (this.currentSpinner) {
            this.currentSpinner.stop();
            this.currentSpinner = null;
        }
        this.clearTimer();
    }

    clearTimer() {
        if (this.animationTimer) {
            clearInterval(this.animationTimer);
            this.animationTimer = null;
        }
    }

    getTotalElapsedTime() {
        if (!this.startTime) return '0ms';

        const elapsed = Date.now() - this.startTime;

        if (elapsed < 1000) return `${elapsed}ms`;
        if (elapsed < 60000) return `${(elapsed / 1000).toFixed(1)}s`;

        const minutes = Math.floor(elapsed / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        return `${minutes}m ${seconds}s`;
    }

    getElapsedTime() {
        return this.getTotalElapsedTime();
    }

    getStepElapsedTime() {
        return this.getTotalElapsedTime();
    }

    createProgressBar() {
        return '';
    }

    static create(enabled = true) {
        return new VerboseProgress(enabled);
    }
}

module.exports = VerboseProgress;
