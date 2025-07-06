const fs = require('fs');
const path = require('path');
const os = require('os');

class Logger {
    constructor(options = {}) {
        this.level = options.level || process.env.LLM_CHECKER_LOG_LEVEL || 'info';
        this.enableColors = options.colors !== false && !process.env.NO_COLOR;
        this.logFile = options.logFile || null;
        this.enableConsole = options.console !== false;
        this.enableDebug = options.debug || process.env.DEBUG === '1';

        this.levels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3,
            trace: 4
        };

        this.colors = {
            error: '\x1b[31m', // Red
            warn: '\x1b[33m',  // Yellow
            info: '\x1b[36m',  // Cyan
            debug: '\x1b[35m', // Magenta
            trace: '\x1b[37m', // White
            reset: '\x1b[0m'
        };

        this.setupLogFile();
    }

    setupLogFile() {
        if (this.logFile) {
            const logDir = path.dirname(this.logFile);
            if (!fs.existsSync(logDir)) {
                try {
                    fs.mkdirSync(logDir, { recursive: true });
                } catch (error) {
                    console.warn(`Warning: Could not create log directory: ${error.message}`);
                    this.logFile = null;
                }
            }
        }
    }

    shouldLog(level) {
        return this.levels[level] <= this.levels[this.level];
    }

    formatMessage(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const levelUpper = level.toUpperCase();

        let formatted = `${timestamp} [${levelUpper}]`;

        if (meta.component) {
            formatted += ` [${meta.component}]`;
        }

        formatted += ` ${message}`;

        if (meta.data && typeof meta.data === 'object') {
            formatted += '\n' + JSON.stringify(meta.data, null, 2);
        }

        if (meta.error && meta.error instanceof Error) {
            formatted += '\n' + meta.error.stack;
        }

        return formatted;
    }

    colorize(level, message) {
        if (!this.enableColors) return message;
        return this.colors[level] + message + this.colors.reset;
    }

    writeToFile(message) {
        if (!this.logFile) return;

        try {
            fs.appendFileSync(this.logFile, message + '\n', 'utf8');
        } catch (error) {
            // Fallback to console if file write fails
            if (this.enableConsole) {
                console.error('Failed to write to log file:', error.message);
            }
        }
    }

    log(level, message, meta = {}) {
        if (!this.shouldLog(level)) return;

        const formatted = this.formatMessage(level, message, meta);

        // Write to console
        if (this.enableConsole) {
            const colored = this.colorize(level, formatted);

            if (level === 'error') {
                console.error(colored);
            } else if (level === 'warn') {
                console.warn(colored);
            } else {
                console.log(colored);
            }
        }

        // Write to file
        this.writeToFile(formatted);
    }

    error(message, meta = {}) {
        this.log('error', message, meta);
    }

    warn(message, meta = {}) {
        this.log('warn', message, meta);
    }

    info(message, meta = {}) {
        this.log('info', message, meta);
    }

    debug(message, meta = {}) {
        this.log('debug', message, meta);
    }

    trace(message, meta = {}) {
        this.log('trace', message, meta);
    }

    // Specialized logging methods
    logHardwareDetection(hardware) {
        this.debug('Hardware detection completed', {
            component: 'HardwareDetector',
            data: {
                cpu: hardware.cpu.brand,
                ram: `${hardware.memory.total}GB`,
                gpu: hardware.gpu.model,
                architecture: hardware.cpu.architecture
            }
        });
    }

    logModelAnalysis(model, score) {
        this.debug('Model compatibility analyzed', {
            component: 'CompatibilityAnalyzer',
            data: {
                model: model.name,
                score: score,
                category: model.category
            }
        });
    }

    logOllamaOperation(operation, model, result) {
        this.info(`Ollama ${operation} ${result ? 'succeeded' : 'failed'}`, {
            component: 'OllamaClient',
            data: {
                operation,
                model,
                success: result
            }
        });
    }

    logPerformanceTest(model, results) {
        this.info('Performance test completed', {
            component: 'PerformanceAnalyzer',
            data: {
                model,
                tokensPerSecond: results.tokensPerSecond,
                responseTime: results.responseTime
            }
        });
    }

    logError(error, context = {}) {
        this.error(error.message, {
            component: context.component || 'Unknown',
            error: error,
            data: context.data
        });
    }

    // Utility methods
    time(label) {
        const start = process.hrtime.bigint();
        return {
            end: () => {
                const end = process.hrtime.bigint();
                const duration = Number(end - start) / 1000000; // Convert to milliseconds
                this.debug(`Timer: ${label} took ${duration.toFixed(2)}ms`);
                return duration;
            }
        };
    }

    createChild(component) {
        return {
            error: (message, meta = {}) => this.error(message, { ...meta, component }),
            warn: (message, meta = {}) => this.warn(message, { ...meta, component }),
            info: (message, meta = {}) => this.info(message, { ...meta, component }),
            debug: (message, meta = {}) => this.debug(message, { ...meta, component }),
            trace: (message, meta = {}) => this.trace(message, { ...meta, component })
        };
    }

    getLogFile() {
        return this.logFile;
    }

    setLogFile(filePath) {
        this.logFile = filePath;
        this.setupLogFile();
    }

    setLevel(level) {
        if (this.levels.hasOwnProperty(level)) {
            this.level = level;
        } else {
            this.warn(`Invalid log level: ${level}. Valid levels: ${Object.keys(this.levels).join(', ')}`);
        }
    }

    clearLogFile() {
        if (this.logFile && fs.existsSync(this.logFile)) {
            try {
                fs.writeFileSync(this.logFile, '', 'utf8');
                this.info('Log file cleared');
            } catch (error) {
                this.error('Failed to clear log file', { error });
            }
        }
    }

    rotateLogFile() {
        if (!this.logFile || !fs.existsSync(this.logFile)) return;

        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const rotatedFile = this.logFile + '.' + timestamp;

            fs.renameSync(this.logFile, rotatedFile);
            this.info(`Log file rotated to: ${rotatedFile}`);
        } catch (error) {
            this.error('Failed to rotate log file', { error });
        }
    }
}

// Global logger instance
let globalLogger = null;

function getLogger(options = {}) {
    if (!globalLogger) {
        globalLogger = new Logger(options);
    }
    return globalLogger;
}

function setLogger(logger) {
    globalLogger = logger;
}

module.exports = {
    Logger,
    getLogger,
    setLogger
};