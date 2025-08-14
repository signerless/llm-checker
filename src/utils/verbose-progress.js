const chalk = require('chalk');
const ora = require('ora');

/**
 * Verbose Progress Reporter - Enhanced Visual Style
 * Muestra operaciones paso a paso con barras de progreso y spinners
 */
class VerboseProgress {
    constructor(enabled = true) {
        this.enabled = enabled;
        this.currentStep = 0;
        this.totalSteps = 0;
        this.operationTitle = '';
        this.startTime = null;
        this.stepTimes = [];
        this.currentSpinner = null;
        this.stepStartTime = null;
    }

    /**
     * Inicia una nueva operación con múltiples pasos
     */
    startOperation(title, totalSteps) {
        if (!this.enabled) return;
        
        this.operationTitle = title;
        this.totalSteps = totalSteps;
        this.currentStep = 0;
        this.startTime = Date.now();
        this.stepTimes = [];
        
        console.log(''); // Espacio inicial
    }

    /**
     * Avanza al siguiente paso de la operación
     */
    step(description, details = null) {
        if (!this.enabled) return;
        
        // Finalizar spinner anterior si existe
        if (this.currentSpinner) {
            this.currentSpinner.stop();
        }
        
        this.currentStep++;
        this.stepStartTime = Date.now();
        
        // Crear indicador de progreso visual
        const progress = this.createProgressBar();
        const stepIndicator = chalk.cyan(`[${this.currentStep}/${this.totalSteps}]`);
        
        // Mostrar el paso actual
        console.log(`\n${progress} ${stepIndicator} ${chalk.white.bold(description)}`);
        
        if (details) {
            console.log(`    ${chalk.gray('└─ ' + details)}`);
        }
        
        // Crear spinner para este paso (disabled to fix UI issues)
        this.currentSpinner = null;
        
        this.stepTimes.push(this.stepStartTime);
        
        return this;
    }

    /**
     * Muestra progreso dentro de un paso (sub-operación)
     */
    substep(description, isLast = false) {
        if (!this.enabled) return;
        
        const connector = isLast ? '└─' : '├─';
        const elapsed = this.getStepElapsedTime();
        console.log(`    ${chalk.gray(connector)} ${description} ${chalk.dim(`(${elapsed})`)}`);
        
        return this;
    }

    /**
     * Marca el paso actual como completado exitosamente
     */
    stepComplete(result = null, timing = null) {
        if (!this.enabled) return;
        
        if (result) {
            console.log(`      ${chalk.green(result)}`);
        }
        
        // Mostrar timing
        const elapsed = this.getStepElapsedTime();
        console.log(`    ${chalk.dim(`└─ ${elapsed}`)}`);
        
        return this;
    }

    /**
     * Marca el paso actual como fallido
     */
    stepFail(error = null) {
        if (!this.enabled) return;
        
        if (error) {
            console.log(`      ${chalk.red(error)}`);
        }
        
        return this;
    }

    /**
     * Muestra información adicional durante un paso
     */
    info(message, indent = true) {
        if (!this.enabled) return;
        
        const prefix = indent ? '    ' : '';
        console.log(`${prefix}${chalk.gray(message)}`);
        
        return this;
    }

    /**
     * Muestra una advertencia
     */
    warn(message, indent = true) {
        if (!this.enabled) return;
        
        const prefix = indent ? '    ' : '';
        console.log(`${prefix}${chalk.yellow(message)}`);
        
        return this;
    }

    /**
     * Muestra resultados o datos encontrados
     */
    found(message, count = null, indent = true) {
        if (!this.enabled) return;
        
        const prefix = indent ? '    ' : '';
        const countStr = count !== null ? chalk.cyan.bold(` (${count})`) : '';
        console.log(`${prefix}${chalk.white(message)}${countStr}`);
        
        return this;
    }

    /**
     * Finaliza la operación completa
     */
    complete(summary = null) {
        if (!this.enabled) return;
        
        // Finalizar spinner si existe
        if (this.currentSpinner) {
            this.currentSpinner.stop();
            this.currentSpinner = null;
        }
        
        const totalTime = this.getTotalElapsedTime();
        
        console.log(chalk.gray('─'.repeat(60)));
        
        if (summary) {
            console.log(chalk.green.bold(`${this.operationTitle} complete!`));
            console.log(chalk.gray(`   ${summary}`));
        } else {
            console.log(chalk.green.bold(`Operation complete!`));
        }
        
        console.log(chalk.dim(`   Total time: ${totalTime}`));
        console.log('');
        
        return this;
    }

    /**
     * Finaliza la operación con error
     */
    fail(error = null) {
        if (!this.enabled) return;
        
        // Finalizar spinner si existe
        if (this.currentSpinner) {
            this.currentSpinner.fail();
            this.currentSpinner = null;
        }
        
        console.log(chalk.gray('─'.repeat(60)));
        console.log(chalk.red.bold(`Operation failed!`));
        
        if (error) {
            console.log(chalk.red(`   ${error}`));
        }
        
        console.log('');
        
        return this;
    }

    /**
     * Crea una barra de progreso visual
     */
    createProgressBar() {
        if (this.totalSteps === 0) return '';
        
        const percentage = (this.currentStep / this.totalSteps);
        const filledBars = Math.floor(percentage * 20);
        const emptyBars = 20 - filledBars;
        
        const filled = chalk.cyan('█'.repeat(filledBars));
        const empty = chalk.gray('░'.repeat(emptyBars));
        
        return `${filled}${empty} ${Math.round(percentage * 100)}%`;
    }

    /**
     * Obtiene el tiempo transcurrido desde el inicio de la operación
     */
    getTotalElapsedTime() {
        if (!this.startTime) return '0ms';
        
        const elapsed = Date.now() - this.startTime;
        
        if (elapsed < 1000) return `${elapsed}ms`;
        if (elapsed < 60000) return `${(elapsed / 1000).toFixed(1)}s`;
        
        const minutes = Math.floor(elapsed / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        return `${minutes}m ${seconds}s`;
    }

    /**
     * Obtiene el tiempo transcurrido desde el último paso
     */
    getElapsedTime() {
        if (this.stepTimes.length === 0) return '0ms';
        
        const lastStepTime = this.stepTimes[this.stepTimes.length - 1];
        const elapsed = Date.now() - lastStepTime;
        
        if (elapsed < 1000) return `${elapsed}ms`;
        return `${(elapsed / 1000).toFixed(1)}s`;
    }

    /**
     * Obtiene el tiempo transcurrido desde el inicio del paso actual
     */
    getStepElapsedTime() {
        if (!this.stepStartTime) return '0ms';
        
        const elapsed = Date.now() - this.stepStartTime;
        
        if (elapsed < 1000) return `${elapsed}ms`;
        return `${(elapsed / 1000).toFixed(1)}s`;
    }

    /**
     * Método estático para crear una instancia rápida
     */
    static create(enabled = true) {
        return new VerboseProgress(enabled);
    }
}

module.exports = VerboseProgress;