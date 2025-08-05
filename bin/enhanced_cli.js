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

    console.log('\n' + chalk.bgBlue.white.bold(' 🖥️  SYSTEM INFORMATION '));
    console.log(chalk.blue('╭' + '─'.repeat(50)));

    lines.forEach(line => {
        console.log(chalk.blue('│') + ' ' + line);
    });

    console.log(chalk.blue('╰'));
}

function displayOllamaIntegration(ollamaInfo, ollamaModels) {
    const lines = [];

    if (ollamaInfo.available) {
        lines.push(`${chalk.green('✅ Status:')} Running ${chalk.gray(`(v${ollamaInfo.version || 'unknown'})`)}`);

        if (ollamaModels && ollamaModels.length > 0) {
            const compatibleCount = ollamaModels.filter(m => {
                return m.canRun === true ||
                    m.compatibilityScore >= 60 ||
                    (m.matchedModel && true);
            }).length;

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

    console.log('\n' + chalk.bgMagenta.white.bold(' 🦙 OLLAMA INTEGRATION '));
    console.log(chalk.hex('#a259ff')('╭' + '─'.repeat(50)));

    lines.forEach(line => {
        console.log(chalk.hex('#a259ff')('│') + ' ' + line);
    });

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
        const tokensPerSec = model.performanceEstimate?.estimatedTokensPerSecond || 'N/A';
        const ramReq = model.requirements?.ram || 1;
        const vramReq = model.requirements?.vram || 0;
        const speedFormatted = formatSpeed(model.performance?.speed || 'medium');
        const scoreColor = getScoreColor(model.score || 0);
        const scoreDisplay = scoreColor(`${model.score || 0}/100`);

        let statusDisplay = `${tokensPerSec}t/s`;
        if (model.isOllamaInstalled) {
            const ollamaInfo = model.ollamaInfo || {};
            if (ollamaInfo.isRunning) {
                statusDisplay = '🚀 Running';
            } else {
                statusDisplay = '📦 Installed';
            }
        }

        let modelName = model.name;
        if (model.isOllamaInstalled) {
            modelName = `${model.name} 🦙`;
        }

        const row = [
            modelName,
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

function displayStructuredRecommendations(recommendations) {
    if (!recommendations) return;

    if (Array.isArray(recommendations)) {
        displayLegacyRecommendations(recommendations);
        return;
    }

    console.log('\n' + chalk.bgCyan.white.bold(' 🎯 SMART RECOMMENDATIONS '));
    console.log(chalk.cyan('╭' + '─'.repeat(50)));

    if (recommendations.general && recommendations.general.length > 0) {
        console.log(chalk.cyan('│') + ` ${chalk.bold.white('💡 General Recommendations:')}`);
        recommendations.general.slice(0, 4).forEach((rec, index) => {
            console.log(chalk.cyan('│') + `   ${index + 1}. ${chalk.white(rec)}`);
        });
        console.log(chalk.cyan('│'));
    }

    if (recommendations.installedModels && recommendations.installedModels.length > 0) {
        console.log(chalk.cyan('│') + ` ${chalk.bold.green('📦 Your Installed Ollama Models:')}`);
        recommendations.installedModels.forEach(rec => {
            console.log(chalk.cyan('│') + `   ${chalk.green(rec)}`);
        });
        console.log(chalk.cyan('│'));
    }

    if (recommendations.cloudSuggestions && recommendations.cloudSuggestions.length > 0) {
        console.log(chalk.cyan('│') + ` ${chalk.bold.blue('☁️ Recommended from Ollama Cloud:')}`);
        recommendations.cloudSuggestions.forEach(rec => {
            if (rec.includes('ollama pull')) {
                console.log(chalk.cyan('│') + `   🚀 ${chalk.cyan.bold(rec)}`);
            } else {
                console.log(chalk.cyan('│') + `   ${chalk.blue(rec)}`);
            }
        });
        console.log(chalk.cyan('│'));
    }

    if (recommendations.quickCommands && recommendations.quickCommands.length > 0) {
        console.log(chalk.cyan('│') + ` ${chalk.bold.yellow('⚡ Quick Commands:')}`);
        const uniqueCommands = [...new Set(recommendations.quickCommands)];
        uniqueCommands.slice(0, 3).forEach(cmd => {
            console.log(chalk.cyan('│') + `   > ${chalk.yellow.bold(cmd)}`);
        });
    }

    console.log(chalk.cyan('╰'));
}

function displayLegacyRecommendations(recommendations) {
    if (!recommendations || recommendations.length === 0) return;

    const generalRecs = [];
    const ollamaFoundRecs = [];
    const quickInstallRecs = [];

    recommendations.forEach(rec => {
        if (rec.includes('📦') && rec.includes('Score:')) {
            ollamaFoundRecs.push(rec);
        } else if (rec.includes('ollama pull')) {
            quickInstallRecs.push(rec);
        } else if (rec.includes('ollama run')) {
            quickInstallRecs.push(rec);
        } else {
            generalRecs.push(rec);
        }
    });

    console.log('\n' + chalk.bgCyan.white.bold(' SMART RECOMMENDATIONS '));
    console.log(chalk.cyan('╭' + '─'.repeat(40)));

    generalRecs.slice(0, 8).forEach((rec, index) => {
        const number = chalk.green.bold(`${index + 1}.`);
        console.log(chalk.cyan('│') + ` ${number} ${chalk.white(rec)}`);
    });

    if (ollamaFoundRecs.length > 0) {
        console.log(chalk.cyan('│'));
        console.log(chalk.cyan('│') + ` ${chalk.bold.green('📦 Your Installed Ollama Models:')}`);
        ollamaFoundRecs.forEach(rec => {
            console.log(chalk.cyan('│') + `   ${chalk.green(rec)}`);
        });
    }

    if (quickInstallRecs.length > 0) {
        console.log(chalk.cyan('│'));
        console.log(chalk.cyan('│') + ` ${chalk.bold.blue('🚀 Quick Commands:')}`);
        quickInstallRecs.slice(0, 3).forEach(cmd => {
            console.log(chalk.cyan('│') + `   > ${chalk.cyan.bold(cmd)}`);
        });
    }

    console.log(chalk.cyan('╰'));
}

function displayIntelligentRecommendations(intelligentData) {
    if (!intelligentData || !intelligentData.summary) return;

    const { summary, recommendations } = intelligentData;
    const tier = summary.hardware_tier.replace('_', ' ').toUpperCase();
    const tierColor = tier.includes('HIGH') ? chalk.green : tier.includes('MEDIUM') ? chalk.yellow : chalk.red;

    console.log('\n' + chalk.bgRed.white.bold(' 🧠 INTELLIGENT RECOMMENDATIONS BY CATEGORY '));
    console.log(chalk.red('╭' + '─'.repeat(65)));
    console.log(chalk.red('│') + ` 🏆 Hardware Tier: ${tierColor.bold(tier)} | Models Analyzed: ${chalk.cyan.bold(intelligentData.totalModelsAnalyzed)}`);
    console.log(chalk.red('│'));

    // Mostrar mejor modelo general
    if (summary.best_overall) {
        const best = summary.best_overall;
        console.log(chalk.red('│') + ` 🌟 ${chalk.bold.yellow('BEST OVERALL:')} ${chalk.green.bold(best.name)}`);
        console.log(chalk.red('│') + `    📦 Command: ${chalk.cyan.bold(best.command)}`);
        console.log(chalk.red('│') + `    📊 Score: ${chalk.yellow.bold(best.score)}/100 | Category: ${chalk.magenta(best.category)}`);
        console.log(chalk.red('│'));
    }

    // Mostrar por categorías
    const categories = {
        coding: '💻',
        talking: '💬', 
        reading: '📚',
        reasoning: '🧮',
        multimodal: '🖼️',
        creative: '🎨',
        general: '🤖'
    };

    Object.entries(summary.by_category).forEach(([category, model]) => {
        const icon = categories[category] || '📋';
        const categoryName = category.charAt(0).toUpperCase() + category.slice(1);
        const scoreColor = getScoreColor(model.score);
        
        console.log(chalk.red('│') + ` ${icon} ${chalk.bold.white(categoryName)}:`);
        console.log(chalk.red('│') + `    🏆 ${chalk.green(model.name)} (${model.size})`);
        console.log(chalk.red('│') + `    📊 Score: ${scoreColor.bold(model.score)}/100 | Pulls: ${chalk.gray(model.pulls?.toLocaleString() || 'N/A')}`);
        console.log(chalk.red('│') + `    📦 ${chalk.cyan.bold(model.command)}`);
        console.log(chalk.red('│'));
    });

    console.log(chalk.red('╰'));
}

function displayModelsStats(originalCount, filteredCount, options) {
    console.log('\n' + chalk.bgGreen.white.bold(' 📊 DATABASE STATS '));
    console.log(chalk.green('╭' + '─'.repeat(60)));
    console.log(chalk.green('│') + ` Total models in database: ${chalk.cyan.bold(originalCount)}`);
    console.log(chalk.green('│') + ` After filters: ${chalk.yellow.bold(filteredCount)}`);
    
    if (options.category) {
        console.log(chalk.green('│') + ` Category filter: ${chalk.magenta.bold(options.category)}`);
    }
    if (options.size) {
        console.log(chalk.green('│') + ` Size filter: ${chalk.magenta.bold(options.size)}`);
    }
    if (options.popular) {
        console.log(chalk.green('│') + ` Filter: ${chalk.magenta.bold('Popular models only (>100k pulls)')}`);
    }
    if (options.recent) {
        console.log(chalk.green('│') + ` Filter: ${chalk.magenta.bold('Recent models only')}`);
    }
    
    console.log(chalk.green('╰'));
}

function displayCompactModelsList(models) {
    console.log('\n' + chalk.bgBlue.white.bold(' 📋 MODELS LIST '));
    
    const data = [
        [
            chalk.bgBlue.white.bold(' # '),
            chalk.bgBlue.white.bold(' Model '),
            chalk.bgBlue.white.bold(' Size '),
            chalk.bgBlue.white.bold(' Context '),
            chalk.bgBlue.white.bold(' Input '),
            chalk.bgBlue.white.bold(' Category '),
            chalk.bgBlue.white.bold(' Variants ')
        ]
    ];

    models.forEach((model, index) => {
        const category = model.category || 'general';
        const categoryColor = getCategoryColor(category);
        
        // Obtener el tamaño más representativo
        const mainSize = model.main_size || 
                        (model.model_sizes && model.model_sizes[0]) || 
                        extractSizeFromIdentifier(model.model_identifier) || 
                        'Unknown';
        
        // Context length
        const contextLength = model.context_length || 'Unknown';
        
        // Input types
        const inputTypes = (model.input_types && model.input_types.length > 0) ? 
            model.input_types.slice(0, 2).join(',') : 'text';
        
        // Number of variants
        const variantCount = (model.tags && model.tags.length > 0) ? 
            model.tags.length : 0;
        
        const row = [
            chalk.gray(`${index + 1}`),
            model.model_name || 'Unknown',
            chalk.green(mainSize),
            chalk.blue(contextLength),
            chalk.magenta(inputTypes),
            categoryColor(category),
            chalk.yellow(`${variantCount} tags`)
        ];
        
        data.push(row);
    });

    console.log(table(data));
}

function extractSizeFromIdentifier(identifier) {
    const sizeMatch = identifier.match(/(\d+\.?\d*[bg])/i);
    return sizeMatch ? sizeMatch[1].toLowerCase() : null;
}

function displayFullModelsList(models) {
    console.log('\n' + chalk.bgBlue.white.bold(' 📋 DETAILED MODELS LIST '));
    
    models.forEach((model, index) => {
        console.log(`\n${chalk.cyan.bold(`${index + 1}. ${model.model_name}`)}`);
        console.log(`   ${chalk.gray('Identifier:')} ${chalk.yellow(model.model_identifier)}`);
        console.log(`   ${chalk.gray('Size:')} ${chalk.green(model.main_size || 'Unknown')}`);
        console.log(`   ${chalk.gray('Context:')} ${chalk.blue(model.context_length || 'Unknown')}`);
        console.log(`   ${chalk.gray('Input types:')} ${chalk.magenta((model.input_types || ['text']).join(', '))}`);
        console.log(`   ${chalk.gray('Category:')} ${getCategoryColor(model.category || 'general')(model.category || 'general')}`);
        console.log(`   ${chalk.gray('Pulls:')} ${chalk.green((model.pulls || 0).toLocaleString())}`);
        console.log(`   ${chalk.gray('Description:')} ${model.description || model.detailed_description || 'No description'}`);
        
        if (model.use_cases && model.use_cases.length > 0) {
            console.log(`   ${chalk.gray('Use cases:')} ${model.use_cases.map(uc => chalk.magenta(uc)).join(', ')}`);
        }
        
        if (model.tags && model.tags.length > 0) {
            console.log(`   ${chalk.gray(`Available variants (${model.tags.length}):`)} `);
            // Mostrar las primeras 10 variantes, agrupadas de 5 por línea
            const tagsToShow = model.tags.slice(0, 15);
            for (let i = 0; i < tagsToShow.length; i += 5) {
                const batch = tagsToShow.slice(i, i + 5);
                console.log(`     ${batch.map(tag => chalk.blue(tag)).join(', ')}`);
            }
            if (model.tags.length > 15) {
                console.log(`     ${chalk.gray(`... and ${model.tags.length - 15} more variants`)}`);
            }
        }
        
        if (model.quantizations && model.quantizations.length > 0) {
            console.log(`   ${chalk.gray('Quantizations found:')} ${model.quantizations.map(q => chalk.green(q)).join(', ')}`);
        }
        
        console.log(`   ${chalk.gray('Base command:')} ${chalk.cyan.bold(`ollama pull ${model.model_identifier}`)}`);
        console.log(`   ${chalk.gray('Example variant:')} ${chalk.cyan.bold(`ollama pull ${model.tags && model.tags.length > 0 ? model.tags[0] : model.model_identifier}`)}`);
        console.log(`   ${chalk.gray('Updated:')} ${model.last_updated || 'Unknown'}`);
    });
}

function getCategoryColor(category) {
    const colors = {
        coding: chalk.blue,
        talking: chalk.green,
        reading: chalk.yellow,
        reasoning: chalk.red,
        multimodal: chalk.magenta,
        creative: chalk.cyan,
        general: chalk.gray,
        chat: chalk.green,
        embeddings: chalk.blue
    };
    
    return colors[category] || chalk.gray;
}

function displaySampleCommands(topModels) {
    console.log('\n' + chalk.bgYellow.black.bold(' ⚡ SAMPLE COMMANDS '));
    console.log(chalk.yellow('╭' + '─'.repeat(60)));
    console.log(chalk.yellow('│') + ` ${chalk.bold.white('Try these popular models:')}`);
    
    topModels.forEach((model, index) => {
        const command = `ollama pull ${model.model_identifier}`;
        console.log(chalk.yellow('│') + `   ${index + 1}. ${chalk.cyan.bold(command)}`);
    });
    
    console.log(chalk.yellow('│'));
    console.log(chalk.yellow('│') + ` ${chalk.bold.white('More commands:')}`);
    console.log(chalk.yellow('│') + `   🔍 ${chalk.gray('llm-checker list-models --category coding')}`);
    console.log(chalk.yellow('│') + `   📊 ${chalk.gray('llm-checker list-models --popular --limit 10')}`);
    console.log(chalk.yellow('│') + `   💾 ${chalk.gray('llm-checker list-models --json > models.json')}`);
    console.log(chalk.yellow('╰'));
}

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

    console.log('\n' + chalk.bgMagenta.white.bold(' 🎯 NEXT STEPS ') + '\n' + chalk.hex('#a259ff')('╭' + '─'.repeat(40)));

    stepsRaw.forEach(([icon, text], index) => {
        const num = chalk.green.bold(`${index + 1}.`);
        console.log(chalk.hex('#a259ff')('│') + ` ${num} ${icon} ${text}`);
    });

    console.log(chalk.hex('#a259ff')('╰'));
}

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

            displayStructuredRecommendations(analysis.recommendations);
            
            // Mostrar recomendaciones inteligentes por categoría
            if (analysis.intelligentRecommendations) {
                displayIntelligentRecommendations(analysis.intelligentRecommendations);
            }
            
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

program
    .command('update-db')
    .description('Update Ollama models database')
    .option('-f, --force', 'Force update, ignore cache')
    .action(async (options) => {
        const spinner = ora('Updating Ollama models database...').start();

        try {
            const checker = new LLMChecker();
            
            if (options.force) {
                spinner.text = '🔄 Force updating database (this may take a while)...';
                const data = await checker.forceUpdateOllamaDatabase();
                spinner.succeed(`✅ Database force updated! Found ${data.total_count} models`);
            } else {
                spinner.text = '📡 Checking for database updates...';
                const data = await checker.updateOllamaDatabase();
                if (data) {
                    spinner.succeed(`✅ Database updated! Found ${data.total_count} models`);
                } else {
                    spinner.succeed('📋 Database is up to date');
                }
            }

            const stats = await checker.getOllamaModelStats();
            if (stats) {
                console.log('\n' + chalk.bgBlue.white.bold(' 📊 DATABASE STATS '));
                console.log(chalk.blue('╭' + '─'.repeat(40)));
                console.log(chalk.blue('│') + ` Total models: ${chalk.green.bold(stats.total_models || 'N/A')}`);
                console.log(chalk.blue('│') + ` Last updated: ${chalk.yellow(stats.last_updated || 'Unknown')}`);
                console.log(chalk.blue('╰'));
            }

        } catch (error) {
            spinner.fail('Failed to update database');
            console.error(chalk.red('Error:'), error.message);
            if (process.env.DEBUG) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });

program
    .command('recommend')
    .description('Get intelligent model recommendations for your hardware')
    .option('-c, --category <category>', 'Get recommendations for specific category (coding, talking, reading, etc.)')
    .action(async (options) => {
        const spinner = ora('🧠 Analyzing your hardware and generating recommendations...').start();

        try {
            const checker = new LLMChecker();
            const hardware = await checker.getSystemInfo();
            
            spinner.text = '📊 Analyzing thousands of models...';
            const intelligentRecommendations = await checker.generateIntelligentRecommendations(hardware);

            if (!intelligentRecommendations) {
                spinner.fail('Failed to generate recommendations');
                return;
            }

            spinner.succeed('✅ Smart recommendations generated!');

            // Mostrar información del sistema
            displaySystemInfo(hardware, { summary: { hardwareTier: intelligentRecommendations.summary.hardware_tier } });
            
            // Mostrar recomendaciones
            displayIntelligentRecommendations(intelligentRecommendations);

        } catch (error) {
            spinner.fail('Failed to generate recommendations');
            console.error(chalk.red('Error:'), error.message);
            if (process.env.DEBUG) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });

program
    .command('list-models')
    .description('List all models from Ollama database')
    .option('-c, --category <category>', 'Filter by category (coding, talking, reading, reasoning, multimodal, creative, general)')
    .option('-s, --size <size>', 'Filter by size (small, medium, large, e.g., "7b", "13b")')
    .option('-p, --popular', 'Show only popular models (>100k pulls)')
    .option('-r, --recent', 'Show only recent models (updated in last 30 days)')
    .option('--limit <number>', 'Limit number of results (default: 50)', '50')
    .option('--full', 'Show full details including variants and tags')
    .option('--json', 'Output in JSON format')
    .action(async (options) => {
        const spinner = ora('📋 Loading models database...').start();

        try {
            const checker = new LLMChecker();
            const data = await checker.ollamaScraper.scrapeAllModels(false);
            
            if (!data || !data.models) {
                spinner.fail('No models found in database');
                return;
            }

            let models = data.models;
            let originalCount = models.length;

            // Aplicar filtros
            if (options.category) {
                models = models.filter(model => 
                    model.category === options.category.toLowerCase() ||
                    (model.use_cases && model.use_cases.includes(options.category.toLowerCase()))
                );
            }

            if (options.size) {
                const sizeFilter = options.size.toLowerCase();
                models = models.filter(model => 
                    model.model_identifier.toLowerCase().includes(sizeFilter) ||
                    (model.model_sizes && model.model_sizes.some(size => size.includes(sizeFilter)))
                );
            }

            if (options.popular) {
                models = models.filter(model => (model.pulls || 0) > 100000);
            }

            if (options.recent) {
                models = models.filter(model => 
                    model.last_updated && model.last_updated.includes('day')
                );
            }

            // Ordenar por popularidad
            models.sort((a, b) => (b.pulls || 0) - (a.pulls || 0));

            // Limitar resultados
            const limit = parseInt(options.limit) || 50;
            const displayModels = models.slice(0, limit);

            spinner.succeed(`✅ Found ${models.length} models (showing ${displayModels.length})`);

            if (options.json) {
                console.log(JSON.stringify(displayModels, null, 2));
                return;
            }

            // Mostrar estadísticas
            displayModelsStats(originalCount, models.length, options);
            
            // Mostrar modelos
            if (options.full) {
                displayFullModelsList(displayModels);
            } else {
                displayCompactModelsList(displayModels);
            }

            // Mostrar comandos de ejemplo
            if (displayModels.length > 0) {
                displaySampleCommands(displayModels.slice(0, 3));
            }

        } catch (error) {
            spinner.fail('Failed to load models');
            console.error(chalk.red('Error:'), error.message);
            if (process.env.DEBUG) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });

program
    .command('ai-check')
    .description('AI-powered model selection for optimal hardware compatibility')
    .option('-m, --models <models...>', 'Specific models to choose from')
    .option('--prompt <prompt>', 'Show command to run selected model with this prompt')
    .option('--benchmark', 'Benchmark available models for training data')
    .option('--train', 'Train the AI selector model')
    .option('--status', 'Show AI model training status')
    .action(async (options) => {
        const AIModelSelector = require('../src/ai/model-selector');
        const { spawn } = require('child_process');
        
        try {
            const aiSelector = new AIModelSelector();
            
            if (options.status) {
                const status = aiSelector.getTrainingStatus();
                console.log('\n' + chalk.bgMagenta.white.bold(' 🧠 AI MODEL STATUS '));
                console.log(chalk.magenta('╭' + '─'.repeat(50)));
                console.log(chalk.magenta('│') + ` Status: ${getStatusColor(status.status)(status.status.replace('_', ' ').toUpperCase())}`);
                
                if (status.status === 'trained') {
                    console.log(chalk.magenta('│') + ` Model size: ${chalk.green.bold(status.modelSize + ' KB')}`);
                    console.log(chalk.magenta('│') + ` Version: ${chalk.cyan(status.version)}`);
                    console.log(chalk.magenta('│') + ` Features: ${chalk.yellow(status.features)}`);
                    console.log(chalk.magenta('│') + ` Last updated: ${chalk.gray(new Date(status.lastUpdated).toLocaleDateString())}`);
                    console.log(chalk.magenta('│') + ` Ready for use: ${chalk.green.bold('YES')}`);
                } else if (status.status === 'not_trained') {
                    console.log(chalk.magenta('│') + ` To get started:`);
                    console.log(chalk.magenta('│') + `   1. ${chalk.cyan.bold('npm run benchmark')} - Collect performance data`);
                    console.log(chalk.magenta('│') + `   2. ${chalk.cyan.bold('npm run train-ai')} - Train the AI model`);
                    console.log(chalk.magenta('│') + `   3. ${chalk.cyan.bold('npm run ai-check')} - Use AI selection`);
                } else {
                    console.log(chalk.magenta('│') + ` Issue: ${chalk.red('Model files corrupted or incomplete')}`);
                    console.log(chalk.magenta('│') + ` Solution: ${chalk.cyan.bold('npm run train-ai')}`);
                }
                
                console.log(chalk.magenta('╰'));
                return;
            }
            
            if (options.benchmark) {
                const spinner = ora('🔬 Collecting benchmark data...').start();
                
                try {
                    const benchmarkProcess = spawn('python', [
                        'ml-model/python/benchmark_collector.py'
                    ], { stdio: 'inherit' });
                    
                    benchmarkProcess.on('close', (code) => {
                        if (code === 0) {
                            spinner.succeed('✅ Benchmark data collected!');
                            console.log('\nNext steps:');
                            console.log(`  1. ${chalk.cyan.bold('npm run train-ai')} - Train the AI model`);
                            console.log(`  2. ${chalk.cyan.bold('npm run ai-check')} - Use AI selection`);
                        } else {
                            spinner.fail('❌ Benchmark collection failed');
                        }
                    });
                    
                    return;
                } catch (error) {
                    spinner.fail('❌ Failed to start benchmark collection');
                    console.error(chalk.red('Error:'), error.message);
                    return;
                }
            }
            
            if (options.train) {
                const spinner = ora('🧠 Training AI model...').start();
                
                try {
                    const trainProcess = spawn('python', [
                        'ml-model/python/train_model.py'
                    ], { stdio: 'inherit' });
                    
                    trainProcess.on('close', (code) => {
                        if (code === 0) {
                            spinner.succeed('✅ AI model trained successfully!');
                            console.log('\nYou can now use AI-powered selection:');
                            console.log(`  ${chalk.cyan.bold('npm run ai-check')}`);
                        } else {
                            spinner.fail('❌ AI model training failed');
                        }
                    });
                    
                    return;
                } catch (error) {
                    spinner.fail('❌ Failed to start training');
                    console.error(chalk.red('Error:'), error.message);
                    return;
                }
            }
            
            // Main AI selection logic
            const spinner = ora('🧠 AI-powered model selection...').start();
            
            // Get system info
            const checker = new LLMChecker();
            const systemInfo = await checker.getSystemInfo();
            
            // Get available models or use provided ones
            let candidateModels = options.models;
            
            if (!candidateModels) {
                spinner.text = '📋 Getting available Ollama models...';
                const OllamaClient = require('../src/ollama/client');
                const client = new OllamaClient();
                
                try {
                    const models = await client.getLocalModels();
                    candidateModels = models.map(m => m.name || m.model);
                    
                    if (candidateModels.length === 0) {
                        spinner.fail('❌ No Ollama models found');
                        console.log('\nInstall some models first:');
                        console.log('  ollama pull llama2:7b');
                        console.log('  ollama pull mistral:7b');
                        console.log('  ollama pull phi3:mini');
                        return;
                    }
                } catch (error) {
                    spinner.fail('❌ Failed to get Ollama models');
                    console.error(chalk.red('Error:'), error.message);
                    return;
                }
            }
            
            spinner.text = '🤖 Analyzing optimal model selection...';
            
            // Use AI selector - fix data extraction
            const systemSpecs = {
                cpu_cores: systemInfo.cpu?.cores || 4,
                cpu_freq_max: systemInfo.cpu?.speed || 3.0,
                total_ram_gb: systemInfo.memory?.total || 8,
                gpu_vram_gb: systemInfo.graphics?.vram ? systemInfo.graphics.vram / 1024 : 0,
                gpu_model_normalized: systemInfo.graphics?.model || 
                    (systemInfo.cpu?.manufacturer === 'Apple' ? 'apple_silicon' : 'cpu_only')
            };
            
            const result = await aiSelector.selectBestModel(candidateModels, systemSpecs);
            
            spinner.succeed('✅ AI selection completed!');
            
            // Display results
            console.log('\n' + chalk.bgMagenta.white.bold(' 🧠 INTELLIGENT MODEL SELECTION '));
            console.log(chalk.magenta('╭' + '─'.repeat(65)));
            console.log(chalk.magenta('│') + ` 🏆 Selected Model: ${chalk.green.bold(result.bestModel)}`);
            console.log(chalk.magenta('│') + ` 🎯 Selection Method: ${chalk.cyan(result.method.replace(/_/g, ' ').toUpperCase())}`);
            console.log(chalk.magenta('│') + ` 📊 Confidence: ${getConfidenceColor(result.confidence)(Math.round(result.confidence * 100) + '%')}`);
            
            if (result.score) {
                console.log(chalk.magenta('│') + ` 🔢 Intelligence Score: ${getScoreColor(result.score)(Math.round(result.score))}/100`);
            }
            
            if (result.reasoning || result.reason) {
                const reasoning = result.reasoning || result.reason;
                console.log(chalk.magenta('│') + ` 💡 AI Analysis: ${chalk.yellow(reasoning)}`);
            }
            
            if (result.allPredictions && result.allPredictions.length > 1) {
                console.log(chalk.magenta('│'));
                console.log(chalk.magenta('│') + ` ${chalk.bold.white('Top Candidates:')}`);
                result.allPredictions.slice(0, 5).forEach((pred, i) => {
                    const score = Math.round(pred.score * 100);
                    const icon = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
                    console.log(chalk.magenta('│') + `   ${icon} ${pred.model}: ${getConfidenceColor(pred.score)(score + '%')}`);
                });
            }
            
            console.log(chalk.magenta('╰'));
            
            // Display system info
            const specs = result.systemSpecs || systemSpecs;
            const hwAnalysis = result.hardware_analysis;
            
            console.log('\n' + chalk.bgBlue.white.bold(' 💻 INTELLIGENT HARDWARE ANALYSIS '));
            console.log(chalk.blue('╭' + '─'.repeat(55)));
            console.log(chalk.blue('│') + ` CPU: ${chalk.green(specs.cpu_cores + ' cores')} @ ${chalk.cyan(specs.cpu_freq_max?.toFixed(1) + ' GHz')}`);
            console.log(chalk.blue('│') + ` RAM: ${chalk.green(specs.total_ram_gb?.toFixed(1) + ' GB')}`);
            console.log(chalk.blue('│') + ` GPU: ${chalk.yellow(specs.gpu_model_normalized || 'CPU Only')}`);
            console.log(chalk.blue('│') + ` VRAM: ${chalk.green((specs.gpu_vram_gb || 0).toFixed(1) + ' GB')}`);
            
            if (hwAnalysis) {
                console.log(chalk.blue('│'));
                console.log(chalk.blue('│') + ` ${chalk.bold.white('Hardware Classification:')}`);
                console.log(chalk.blue('│') + `   Overall Tier: ${getTierColor(hwAnalysis.overall_tier)(hwAnalysis.overall_tier.replace('_', ' ').toUpperCase())}`);
                console.log(chalk.blue('│') + `   Available Memory: ${chalk.green(hwAnalysis.available_memory?.total?.toFixed(1) + ' GB')}`);
                console.log(chalk.blue('│') + `   Performance Index: ${chalk.cyan('×' + hwAnalysis.performance_multiplier?.toFixed(1))}`);
            }
            
            console.log(chalk.blue('╰'));
            
            // Show recommended command
            console.log('\n' + chalk.bgGreen.black.bold(' 🎯 RECOMMENDATION '));
            console.log(chalk.green('╭' + '─'.repeat(50)));
            console.log(chalk.green('│') + ` Best model for your hardware:`);
            console.log(chalk.green('│') + `   ${chalk.cyan.bold(`ollama run ${result.bestModel}`)}`);
            
            if (options.prompt) {
                console.log(chalk.green('│'));
                console.log(chalk.green('│') + ` With your prompt:`);
                console.log(chalk.green('│') + `   ${chalk.cyan.bold(`ollama run ${result.bestModel} "${options.prompt}"`)}`);
            }
            
            console.log(chalk.green('│'));
            console.log(chalk.green('│') + ` Why this model?`);
            console.log(chalk.green('│') + `   • ${result.reason || 'Optimized for your hardware configuration'}`);
            console.log(chalk.green('│') + `   • Confidence: ${getConfidenceColor(result.confidence)(Math.round(result.confidence * 100) + '%')}`);
            console.log(chalk.green('│') + `   • Selection method: ${result.method.toUpperCase()}`);
            console.log(chalk.green('╰'));
            
            // Show additional useful commands
            console.log('\n' + chalk.gray('💡 Tips:'));
            console.log(chalk.gray(`  • To execute the recommended model directly:`));
            console.log(chalk.gray(`    llm-checker ai-run${options.models ? ' -m ' + options.models.join(' ') : ''}`));
            console.log(chalk.gray(`  • To exit from Ollama chat, type: ${chalk.cyan('/bye')}`));
            
        } catch (error) {
            console.error(chalk.red('❌ AI selection failed:'), error.message);
            process.exit(1);
        }
    });

function getStatusColor(status) {
    const colors = {
        'TRAINED': chalk.green,
        'NOT TRAINED': chalk.yellow,
        'CORRUPTED': chalk.red
    };
    return colors[status] || chalk.gray;
}

function getConfidenceColor(confidence) {
    if (confidence >= 0.8) return chalk.green.bold;
    if (confidence >= 0.6) return chalk.yellow.bold;
    if (confidence >= 0.4) return chalk.red.bold; // orange doesn't exist, use red
    return chalk.red.bold;
}

function getScoreColor(score) {
    if (score >= 85) return chalk.green.bold;
    if (score >= 70) return chalk.cyan.bold;
    if (score >= 55) return chalk.yellow.bold;
    if (score >= 40) return chalk.red.bold;
    return chalk.gray;
}

function getTierColor(tier) {
    const colors = {
        'extreme': chalk.magenta.bold,
        'very_high': chalk.green.bold,
        'high': chalk.cyan.bold,
        'medium': chalk.yellow,
        'low': chalk.red,
        'ultra_low': chalk.gray
    };
    return colors[tier] || chalk.white;
}

program
    .command('ai-run')
    .description('AI-powered model selection and execution')
    .option('-m, --models <models...>', 'Specific models to choose from')
    .option('--prompt <prompt>', 'Prompt to run with selected model')
    .action(async (options) => {
        const AIModelSelector = require('../src/ai/model-selector');
        const { spawn } = require('child_process');
        
        try {
            const spinner = ora('🧠 Selecting best model and launching...').start();
            
            const aiSelector = new AIModelSelector();
            const checker = new LLMChecker();
            const systemInfo = await checker.getSystemInfo();
            
            // Get available models or use provided ones
            let candidateModels = options.models;
            
            if (!candidateModels) {
                spinner.text = '📋 Getting available Ollama models...';
                const OllamaClient = require('../src/ollama/client');
                const client = new OllamaClient();
                
                try {
                    const models = await client.getLocalModels();
                    candidateModels = models.map(m => m.name || m.model);
                    
                    if (candidateModels.length === 0) {
                        spinner.fail('❌ No Ollama models found');
                        console.log('\nInstall some models first:');
                        console.log('  ollama pull llama2:7b');
                        console.log('  ollama pull mistral:7b');
                        console.log('  ollama pull phi3:mini');
                        return;
                    }
                } catch (error) {
                    spinner.fail('❌ Failed to get Ollama models');
                    console.error(chalk.red('Error:'), error.message);
                    return;
                }
            }
            
            // AI selection
            const systemSpecs = {
                cpu_cores: systemInfo.cpu?.cores || 4,
                cpu_freq_max: systemInfo.cpu?.speed || 3.0,
                total_ram_gb: systemInfo.memory?.total || 8,
                gpu_vram_gb: systemInfo.graphics?.vram ? systemInfo.graphics.vram / 1024 : 0,
                gpu_model_normalized: systemInfo.graphics?.model || 
                    (systemInfo.cpu?.manufacturer === 'Apple' ? 'apple_silicon' : 'cpu_only')
            };
            
            const result = await aiSelector.selectBestModel(candidateModels, systemSpecs);
            
            spinner.succeed(`✅ Selected ${chalk.green.bold(result.bestModel)} (${result.method}, ${Math.round(result.confidence * 100)}% confidence)`);
            
            // Execute the selected model
            console.log(chalk.magenta.bold(`\n🚀 Launching ${result.bestModel}...`));
            console.log(chalk.gray(`💡 Tip: Type ${chalk.cyan('/bye')} to exit the chat when finished\n`));
            
            const args = ['run', result.bestModel];
            if (options.prompt) {
                args.push(options.prompt);
            }
            
            const ollamaProcess = spawn('ollama', args, { 
                stdio: 'inherit'
            });
            
            ollamaProcess.on('error', (error) => {
                console.error(chalk.red('Failed to launch Ollama:'), error.message);
            });
            
        } catch (error) {
            console.error(chalk.red('❌ AI-powered execution failed:'), error.message);
            process.exit(1);
        }
    });

program.parse();