const chalk = require('chalk');

class OutputFormatter {
    constructor(options = {}) {
        this.useColors = options.colors !== false && !process.env.NO_COLOR;
        this.useEmojis = options.emojis !== false && !process.env.NO_EMOJI;
        this.compact = options.compact || false;
    }

    formatSystemInfo(hardware) {
        const lines = [];

        if (!this.compact) {
            lines.push(this.header('System Information'));
        }

        lines.push(this.info('CPU', `${hardware.cpu.brand} (${hardware.cpu.cores} cores, ${hardware.cpu.speed || 'Unknown'}GHz)`));
        lines.push(this.info('Architecture', hardware.cpu.architecture));
        lines.push(this.info('RAM', `${hardware.memory.total}GB total (${hardware.memory.free}GB free, ${hardware.memory.usagePercent}% used)`));
        lines.push(this.info('GPU', hardware.gpu.model || 'Not detected'));
        const vramDisplay = hardware.gpu.vram === 0 && hardware.gpu.model && hardware.gpu.model.toLowerCase().includes('apple') 
            ? 'Unified Memory' 
            : `${hardware.gpu.vram || 'N/A'}GB`;
        lines.push(this.info('VRAM', `${vramDisplay}${hardware.gpu.dedicated ? ' (Dedicated)' : ' (Integrated)'}`));
        lines.push(this.info('OS', `${hardware.os.distro} ${hardware.os.release} (${hardware.os.arch})`));

        return lines.join('\n');
    }

    formatCompatibilityResults(results) {
        const lines = [];

        if (results.compatible.length > 0) {
            lines.push(this.success('Compatible Models (Score ≥ 75)'));
            lines.push(this.formatModelsTable(results.compatible, 'compatible'));
        }

        if (results.marginal.length > 0) {
            lines.push(this.warning('Marginal Performance (Score 60-74)'));
            lines.push(this.formatModelsTable(results.marginal, 'marginal'));
        }

        if (results.incompatible.length > 0 && !this.compact) {
            lines.push(this.error('Incompatible Models (showing top 5)'));
            lines.push(this.formatModelsTable(results.incompatible.slice(0, 5), 'incompatible'));
        }

        return lines.join('\n\n');
    }

    formatModelsTable(models, type) {
        if (models.length === 0) return '';

        const headers = ['Model', 'Size', 'Score', 'RAM', 'VRAM', 'Speed'];
        const rows = [headers];

        models.slice(0, this.compact ? 5 : 10).forEach(model => {
            const scoreText = `${model.score || 0}/100`;
            const scoreColored = this.scoreColor(model.score || 0, scoreText);

            rows.push([
                this.truncate(model.name, 20),
                model.size || 'Unknown',
                scoreColored,
                `${model.requirements?.ram || '?'}GB`,
                `${model.requirements?.vram || 0}GB`,
                this.formatSpeed(model.performance?.speed)
            ]);
        });

        return this.createTable(rows);
    }

    formatRecommendations(recommendations) {
        if (!recommendations || recommendations.length === 0) {
            return '';
        }

        const lines = [this.header('Recommendations')];

        recommendations.forEach((rec, index) => {
            lines.push(`${index + 1}. ${rec}`);
        });

        return lines.join('\n');
    }

    formatOllamaStatus(ollamaInfo) {
        if (!ollamaInfo) return '';

        const status = ollamaInfo.available ?
            this.success(`Running (v${ollamaInfo.version || 'unknown'})`) :
            this.error(`${ollamaInfo.error || 'Not available'}`);

        let result = this.info('Ollama Status', status);

        if (ollamaInfo.available) {
            result += '\n' + this.info('Local Models', `${ollamaInfo.localModels || 0} installed`);
            if (ollamaInfo.runningModels > 0) {
                result += '\n' + this.info('Running Models', ollamaInfo.runningModels);
            }
        }

        return result;
    }

    formatHardwareTier(tier, score) {
        const tierFormatted = tier.replace('_', ' ').toUpperCase();
        const tierColored = this.tierColor(tier, tierFormatted);
        return this.info('Hardware Tier', `${tierColored} (Overall Score: ${score}/100)`);
    }

    formatPerformanceBenchmark(benchmark) {
        if (!benchmark) return '';

        const lines = [this.header('Performance Benchmark')];
        lines.push(this.info('CPU Score', `${benchmark.cpu}/100`));
        lines.push(this.info('Memory Score', `${benchmark.memory}/100`));
        lines.push(this.info('Overall Score', `${benchmark.overall}/100`));

        return lines.join('\n');
    }

    formatInstallCommands(commands) {
        if (!commands || commands.length === 0) return '';

        const lines = [this.header('Quick Install Commands')];

        commands.forEach(cmd => {
            const status = cmd.isInstalled ?
                this.success('Installed') :
                this.dim('Not installed');
            lines.push(`${status} ${this.highlight(cmd.command)}`);
        });

        return lines.join('\n');
    }

    formatUpgradeSuggestions(suggestions) {
        if (!suggestions || suggestions.length === 0) return '';

        const lines = [this.header('Hardware Upgrade Suggestions')];

        suggestions.forEach((suggestion, index) => {
            lines.push(`${index + 1}. ${suggestion}`);
        });

        return lines.join('\n');
    }

    formatNextSteps(steps) {
        if (!steps || steps.length === 0) return '';

        const lines = [this.header('Next Steps')];

        steps.forEach((step, index) => {
            lines.push(`${index + 1}. ${step}`);
        });

        return lines.join('\n');
    }

    // Helper methods for styling
    header(text) {
        return this.useColors ? chalk.blue.bold(text) : text;
    }

    success(text) {
        return this.useColors ? chalk.green(text) : text;
    }

    warning(text) {
        return this.useColors ? chalk.yellow(text) : text;
    }

    error(text) {
        return this.useColors ? chalk.red(text) : text;
    }

    info(label, value) {
        const labelFormatted = this.useColors ? chalk.cyan(label + ':') : label + ':';
        return `${labelFormatted} ${value}`;
    }

    highlight(text) {
        return this.useColors ? chalk.cyan(text) : text;
    }

    dim(text) {
        return this.useColors ? chalk.gray(text) : text;
    }

    scoreColor(score, text) {
        if (!this.useColors) return text;

        if (score >= 90) return chalk.green(text);
        if (score >= 75) return chalk.yellow(text);
        if (score >= 60) return chalk.orange(text);
        return chalk.red(text);
    }

    tierColor(tier, text) {
        if (!this.useColors) return text;

        switch (tier) {
            case 'ultra_high': return chalk.magenta(text);
            case 'high': return chalk.green(text);
            case 'medium': return chalk.yellow(text);
            case 'low': return chalk.orange(text);
            case 'ultra_low': return chalk.red(text);
            default: return text;
        }
    }

    formatSpeed(speed) {
        const speedMap = {
            'very_fast': 'Very Fast',
            'fast': 'Fast',
            'medium': 'Medium',
            'slow': 'Slow',
            'very_slow': 'Very Slow'
        };

        return speedMap[speed] || speed || 'Unknown';
    }

    truncate(text, maxLength) {
        if (!text) return '';
        return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
    }

    createTable(rows) {
        if (rows.length === 0) return '';

        // Calculate column widths
        const widths = rows[0].map((_, colIndex) =>
            Math.max(...rows.map(row => this.stripAnsi(row[colIndex] || '').length))
        );

        const lines = [];

        rows.forEach((row, rowIndex) => {
            const paddedRow = row.map((cell, colIndex) => {
                const cellText = cell || '';
                const padding = widths[colIndex] - this.stripAnsi(cellText).length;
                return cellText + ' '.repeat(Math.max(0, padding));
            });

            lines.push('│ ' + paddedRow.join(' │ ') + ' │');

            // Add separator after header
            if (rowIndex === 0) {
                const separator = '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
                lines.push(separator);
            }
        });

        // Add top and bottom borders
        const topBorder = '┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
        const bottomBorder = '└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';

        return [topBorder, ...lines, bottomBorder].join('\n');
    }

    stripAnsi(text) {
        // Simple ANSI escape code removal
        return text.replace(/\x1b\[[0-9;]*m/g, '');
    }

    formatJSON(data, pretty = true) {
        return JSON.stringify(data, null, pretty ? 2 : 0);
    }

    formatCSV(data, headers) {
        const lines = [];

        if (headers) {
            lines.push(headers.join(','));
        }

        data.forEach(row => {
            const csvRow = row.map(cell => {
                const cellStr = String(cell || '');
                // Escape quotes and wrap in quotes if necessary
                if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
                    return '"' + cellStr.replace(/"/g, '""') + '"';
                }
                return cellStr;
            });
            lines.push(csvRow.join(','));
        });

        return lines.join('\n');
    }

    formatMarkdown(data) {
        // Simple markdown table formatting
        if (!data || data.length === 0) return '';

        const headers = data[0];
        const rows = data.slice(1);

        const lines = [];
        lines.push('| ' + headers.join(' | ') + ' |');
        lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');

        rows.forEach(row => {
            lines.push('| ' + row.join(' | ') + ' |');
        });

        return lines.join('\n');
    }
}

module.exports = OutputFormatter;