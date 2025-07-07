#!/usr/bin/env node
const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const { table } = require('table');
const LLMChecker = require('../src/index');
const { getLogger } = require('../src/utils/logger');

const program = new Command();

program
    .name('llm-checker')
    .description('Check which LLM models your computer can run')
    .version('2.1.0');

const logger = getLogger({ console: false });

function getStatusIcon(model, ollamaModels) {
    const ollamaModel = ollamaModels?.find(om => om.matchedModel?.name === model.name);

    if (ollamaModel?.isRunning) return '🚀';
    if (ollamaModel?.isInstalled) return '📦';

    if (model.specialization === 'code') return '💻';
    if (model.specialization === 'multimodal' || model.multimodal) return '🖼️';
    if (model.specialization === 'embeddings') return '🧲';
    if (model.category === 'ultra_small') return '🐣';
    if (model.category === 'small') return '🐤';
    if (model.category === 'medium') return '🐦';
    if (model.category === 'large') return '🦅';

    return '-';
}

function formatSize(size) {
    if (!size) return 'Unknown';

    // Clean and format size
    const cleanSize = size.replace(/[^\d.BMK]/gi, '');
    const numMatch = cleanSize.match(/(\d+\.?\d*)/);
    const unitMatch = cleanSize.match(/[BMK]/i);

    if (numMatch && unitMatch) {
        const num = parseFloat(numMatch[1]);
        const unit = unitMatch[0].toUpperCase();
        return `${num}${unit}`;
    }

    return size;
}

function formatSpeed(speed) {
    const speedMap = {
        'very_fast': 'very_fast',
        'fast': 'fast',
        'medium': 'medium',
        'slow': 'slow',
        'very_slow': 'very_slow'
    };
    return speedMap[speed] || (speed || 'unknown');
}

function getScoreColor(score) {
    if (score >= 90) return chalk.green;
    if (score >= 75) return chalk.yellow;
    if (score >= 60) return chalk.hex('#FFA500');
    return chalk.red;
}

function getOllamaCommand(modelName) {
    const mapping = {
        'TinyLlama 1.1B': 'tinyllama:1.1b',
        'Qwen 0.5B': 'qwen:0.5b',
        'Gemma 2B': 'gemma2:2b',
        'Phi-3 Mini 3.8B': 'phi3:mini',
        'Llama 3.2 3B': 'llama3.2:3b',
        'Llama 3.1 8B': 'llama3.1:8b',
        'Mistral 7B v0.3': 'mistral:7b',
        'CodeLlama 7B': 'codellama:7b',
        'Qwen 2.5 7B': 'qwen2.5:7b'
    };

    return mapping[modelName] || '-';
}

function displaySystemInfo(hardware, analysis) {
    const cpuColor = hardware.cpu.cores >= 8 ? chalk.green : hardware.cpu.cores >= 4 ? chalk.yellow : chalk.red;
    const ramColor = hardware.memory.total >= 32 ? chalk.green : hardware.memory.total >= 16 ? chalk.yellow : chalk.red;
    const gpuColor = hardware.gpu.dedicated ? chalk.green : chalk.hex('#FFA500');

    const lines = [
        `${chalk.cyan('CPU:')} ${cpuColor(hardware.cpu.brand)} ${chalk.gray(`(${hardware.cpu.cores} cores, ${hardware.cpu.speed}GHz)`)}`,
        `${chalk.cyan('Architecture:')} ${hardware.cpu.architecture}`,
        `${chalk.cyan('RAM:')} ${ramColor(hardware.memory.total + 'GB')} total ${chalk.gray(`(${hardware.memory.free}GB free)`)}`,
        `${chalk.cyan('GPU:')} ${gpuColor(hardware.gpu.model || 'Not detected')}`,
        `${chalk.cyan('VRAM:')} ${hardware.gpu.vram || 'N/A'}GB${hardware.gpu.dedicated ? chalk.green(' (Dedicated)') : chalk.hex('#FFA500')(' (Integrated)')}`,
    ];

    const tier = analysis.summary.hardwareTier?.replace('_', ' ').toUpperCase() || 'UNKNOWN';
    const tierColor = tier.includes('HIGH') ? chalk.green : tier.includes('MEDIUM') ? chalk.yellow : chalk.red;

    lines.push(`🏆 ${chalk.bold('Hardware Tier:')} ${tierColor.bold(tier)}`);

    // 🎨 Header
    console.log('\n' + chalk.bgBlue.white.bold(' 🖥️  SYSTEM INFORMATION '));
    console.log(chalk.blue('╭' + '─'.repeat(50)));

    // 📦 Content with left-side border only
    lines.forEach(line => {
        console.log(chalk.blue('│') + ' ' + line);
    });

    // 🔚 Footer
    console.log(chalk.blue('╰'));
}


function displayOllamaIntegration(ollamaInfo, ollamaModels) {
    const lines = [];

    if (ollamaInfo.available) {
        lines.push(`${chalk.green('✅ Status:')} Running ${chalk.gray(`(v${ollamaInfo.version || 'unknown'})`)}`);

        if (ollamaModels && ollamaModels.length > 0) {
            const compatibleCount = ollamaModels.filter(m => m.canRun).length;
            const runningCount = ollamaModels.filter(m => m.isRunning).length;

            lines.push(`📦 ${chalk.cyan('Installed:')} ${ollamaModels.length} total, ${chalk.green(compatibleCount)} compatible`);
            if (runningCount > 0) {
                lines.push(`🚀 ${chalk.cyan('Running:')} ${chalk.green(runningCount)} models`);
            }
        } else {
            lines.push(`📦 ${chalk.gray('No models installed yet')}`);
        }
    } else {
        lines.push(`${chalk.red('❌ Status:')} Not available`);
    }

    // 🧾 Header
    console.log('\n' + chalk.bgMagenta.white.bold(' 🦙 OLLAMA INTEGRATION '));
    console.log(chalk.hex('#a259ff')('╭' + '─'.repeat(50)));

    // 📋 Content
    lines.forEach(line => {
        console.log(chalk.hex('#a259ff')('│') + ' ' + line);
    });

    // 🧵 Footer
    console.log(chalk.hex('#a259ff')('╰'));
}


function displayEnhancedCompatibleModels(compatible, ollamaModels) {
    if (compatible.length === 0) {
        console.log('\n' + chalk.yellow('No compatible models found.'));
        return;
    }

    console.log('\n' + chalk.green.bold(' ✅ Compatible Models (Score ≥ 75)'));

    const data = [
        [
            chalk.bgGreen.white.bold(' Model '),
            chalk.bgGreen.white.bold(' Size '),
            chalk.bgGreen.white.bold(' Score '),
            chalk.bgGreen.white.bold(' RAM '),
            chalk.bgGreen.white.bold(' VRAM '),
            chalk.bgGreen.white.bold(' Speed '),
            chalk.bgGreen.white.bold(' Status ')
        ]
    ];


    compatible.slice(0, 15).forEach(model => {
        //const statusIcon = getStatusIcon(model, ollamaModels);
        const tokensPerSec = model.performanceEstimate?.estimatedTokensPerSecond || 'N/A';

        const ramReq = model.requirements?.ram || 1;
        const vramReq = model.requirements?.vram || 0;
        const speedFormatted = formatSpeed(model.performance?.speed || 'medium');

        const scoreColor = getScoreColor(model.score || 0);
        const scoreDisplay = scoreColor(`${model.score || 0}/100`);

        // Status with tokens per second
        const statusDisplay = `${tokensPerSec}t/s`;

        const row = [
            model.name,
            formatSize(model.size || 'Unknown'),
            scoreDisplay,
            `${ramReq}GB`,
            `${vramReq}GB`,
            speedFormatted,
            statusDisplay
        ];
        data.push(row);
    });

    console.log(table(data));

    if (compatible.length > 15) {
        console.log(chalk.gray(`\n... and ${compatible.length - 15} more compatible models`));
    }

    // Summary
    displayCompatibleModelsSummary(compatible.length);

}

function displayCompatibleModelsSummary(count) {
    console.log('\n' + chalk.bgMagenta.white.bold(' COMPATIBLE MODELS '));
    console.log(chalk.hex('#a259ff')('╭' + '─'.repeat(40)));
    console.log(chalk.hex('#a259ff')('│') + ` Total compatible models: ${chalk.green.bold(count)}`);
    console.log(chalk.hex('#a259ff')('╰'));
}


function displayMarginalModels(marginal) {
    if (marginal.length === 0) return;

    console.log('\n' + chalk.yellow.bold('⚠️  Marginal Performance (Score 60-74)'));

    const data = [
        [
            chalk.bgYellow.white.bold(' Model '),
            chalk.bgYellow.white.bold(' Size '),
            chalk.bgYellow.white.bold(' Score '),
            chalk.bgYellow.white.bold(' RAM '),
            chalk.bgYellow.white.bold(' VRAM '),
            chalk.bgYellow.white.bold(' Issue ')
        ]
    ];


    marginal.slice(0, 6).forEach(model => {
        const mainIssue = model.issues?.[0] || 'Performance limitations';
        const scoreColor = getScoreColor(model.score || 0);
        const scoreDisplay = scoreColor(`${model.score || 0}/100`);

        const ramReq = model.requirements?.ram || 1;
        const vramReq = model.requirements?.vram || 0;

        // Truncate issue if too long
        const truncatedIssue = mainIssue.length > 30 ? mainIssue.substring(0, 27) + '...' : mainIssue;

        const row = [
            model.name,
            formatSize(model.size || 'Unknown'),
            scoreDisplay,
            `${ramReq}GB`,
            `${vramReq}GB`,
            truncatedIssue
        ];
        data.push(row);
    });

    console.log(table(data));

    if (marginal.length > 6) {
        console.log(chalk.gray(`\n... and ${marginal.length - 6} more marginal models`));
    }
}

function displayIncompatibleModels(incompatible) {
    if (incompatible.length === 0) return;

    console.log('\n' + chalk.red.bold('❌ Incompatible Models (showing top 5)'));

    const data = [
        [
            chalk.bgRed.white.bold(' Model '),
            chalk.bgRed.white.bold(' Size '),
            chalk.bgRed.white.bold(' Score '),
            chalk.bgRed.white.bold(' Required RAM '),
            chalk.bgRed.white.bold(' Reason ')
        ]
    ];


    incompatible.slice(0, 5).forEach(model => {
        const reason = model.issues?.[0] || 'Hardware insufficient';
        const required = `${model.requirements?.ram || '?'}GB`;
        const scoreColor = getScoreColor(model.score || 0);
        const scoreDisplay = scoreColor(`${model.score || 0}/100`);

        // Truncate reason if too long
        const truncatedReason = reason.length > 50 ? reason.substring(0, 22) + '...' : reason;

        const row = [
            model.name,
            formatSize(model.size || 'Unknown'),
            scoreDisplay,
            required,
            truncatedReason
        ];
        data.push(row);
    });

    console.log(table(data));
}

function displayEnhancedRecommendations(recommendations) {
    if (!recommendations || recommendations.length === 0) return;

    const normalRecs = recommendations.slice(0, 8);
    const quickInstalls = recommendations.filter(r => r.includes('ollama pull'));

    // Header
    console.log('\n' + chalk.bgCyan.white.bold(' SMART RECOMMENDATIONS '));
    console.log(chalk.cyan('╭' + '─'.repeat(40)));

    // Main recommendations
    normalRecs.forEach((rec, index) => {
        const number = chalk.green.bold(`${index + 1}.`);
        //const icon = '🔹';
        console.log(chalk.cyan('│') + ` ${number} ${chalk.white(rec)}`);
    });

    // Quick install section (if any)
    if (quickInstalls.length > 0) {
        console.log(chalk.cyan('│'));
        console.log(chalk.cyan('│') + ` ${chalk.bold.blue('🚀 Quick Install Commands:')}`);
        quickInstalls.forEach(cmd => {
            console.log(chalk.cyan('│') + `   > ${chalk.cyan.bold(cmd)}`);
        });
    }

    // Footer
    console.log(chalk.cyan('╰'));
}



function visibleLength(text) {
    return text.replace(/\u001b\\[[0-9;]*m/g, '').length;
}

// function visualLength(text) {
//     const clean = text.replace(/\x1b\\[[0-9;]*m/g, '').replace(/\u001b\[[0-9;]*m/g, '');
//     let length = 0;
//     for (const char of clean) {
//         length += (char.codePointAt(0) > 0xFFFF || /[\u1100-\u115F\u2329\u232A\u2E80-\uA4CF\uAC00-\uD7A3\u{1F300}-\u{1FAFF}]/u.test(char)) ? 2 : 1;
//     }
//     return length;
// }



function displayNextSteps(analysis) {
    const stepsRaw = [];

    if (!analysis.ollamaInfo.available) {
        stepsRaw.push(['🦙', chalk.white(`Install Ollama:`) + ' ' + chalk.underline('https://ollama.ai')]);
        stepsRaw.push(['📚', `Return here to see compatible models`]);
    } else if (!analysis.ollamaModels || analysis.ollamaModels.length === 0) {
        stepsRaw.push(['🚀', `Install a recommended model from above`]);
        stepsRaw.push(['💬', chalk.yellow(`Start chatting: ollama run <model-name>`)]);
    } else {
        stepsRaw.push(['📊', chalk.yellow(`Analyze: llm-checker analyze-model <model>`)]);
        stepsRaw.push(['🔍', chalk.yellow(`See status: llm-checker ollama --list`)]);
        stepsRaw.push(['🚀', chalk.yellow(`Try: ollama run <your-best-model>`)]);
    }

    // ✅ Header bar with background color
    console.log('\n' + chalk.bgMagenta.white.bold(' NEXT STEPS ') + '\n' + chalk.hex('#a259ff')('╭' + '─'.repeat(40)));

    // ✅ List each step with left border only
    stepsRaw.forEach(([icon, text], index) => {
        const num = chalk.green.bold(`${index + 1}.`);
        console.log(chalk.hex('#a259ff')('│') + ` ${num} ${icon} ${text}`);
    });

    // ✅ Bottom left corner only
    console.log(chalk.hex('#a259ff')('╰'));
}






// Commands remain the same...
program
    .command('check')
    .description('Analyze your system and show compatible LLM models')
    .option('-d, --detailed', 'Show detailed hardware information')
    .option('-f, --filter <type>', 'Filter by model type')
    .option('-u, --use-case <case>', 'Specify use case', 'general')
    .option('--include-cloud', 'Include cloud models in analysis')
    .option('--ollama-only', 'Only show models available in Ollama')
    .option('--performance-test', 'Run performance benchmarks')
    .option('--show-ollama-analysis', 'Show detailed Ollama model analysis')
    .action(async (options) => {
        const spinner = ora('🔍 Analyzing your system...').start();

        try {
            const checker = new LLMChecker();

            spinner.text = '🖥️  Detecting hardware...';
            const hardware = await checker.getSystemInfo();

            spinner.text = '🦙 Integrating with Ollama...';
            const analysis = await checker.analyze({
                filter: options.filter,
                useCase: options.useCase,
                includeCloud: options.includeCloud,
                performanceTest: options.performanceTest
            });

            spinner.succeed('✅ Analysis complete!');

            displaySystemInfo(hardware, analysis);
            displayOllamaIntegration(analysis.ollamaInfo, analysis.ollamaModels);
            displayEnhancedCompatibleModels(analysis.compatible, analysis.ollamaModels);

            if (analysis.marginal.length > 0) {
                displayMarginalModels(analysis.marginal);
            }

            if (analysis.incompatible.length > 0) {
                displayIncompatibleModels(analysis.incompatible);
            }

            displayEnhancedRecommendations(analysis.recommendations);
            displayNextSteps(analysis);

        } catch (error) {
            spinner.fail('Failed to analyze system');
            console.error(chalk.red('Error:'), error.message);
            if (process.env.DEBUG) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });

program
    .command('ollama')
    .description('Manage Ollama integration with hardware compatibility')
    .option('-l, --list', 'List installed models with compatibility scores')
    .option('-r, --running', 'Show running models with performance data')
    .option('-c, --compatible', 'Show only hardware-compatible installed models')
    .option('--recommendations', 'Show installation recommendations')
    .action(async (options) => {
        const spinner = ora('Checking Ollama integration...').start();

        try {
            const checker = new LLMChecker();
            const analysis = await checker.analyze();

            if (!analysis.ollamaInfo.available) {
                spinner.fail(`Ollama not available`);
                console.log('\n💡 To install Ollama:');
                console.log('🔗 Visit: https://ollama.ai');
                return;
            }

            spinner.succeed(`Ollama integration active`);

            if (options.list) {
                console.log('Ollama models list feature coming soon...');
            }

        } catch (error) {
            spinner.fail('Error with Ollama integration');
            console.error(chalk.red('Error:'), error.message);
        }
    });

program.parse();
