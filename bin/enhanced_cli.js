const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const { table } = require('table');
const inquirer = require('inquirer');
const LLMChecker = require('../src/index');
const OllamaClient = require('../src/ollama/client');
const ExpandedModelsDatabase = require('../src/models/expanded_database');

const program = new Command();

program
    .name('llm-checker')
    .description('Check which LLM models your computer can run')
    .version('2.0.0');

program
    .command('check')
    .description('Analyze your system and show compatible LLM models')
    .option('-d, --detailed', 'Show detailed hardware information')
    .option('-f, --filter <type>', 'Filter by model type (ultra_small, small, medium, large, code, chat, multimodal)')
    .option('-u, --use-case <case>', 'Specify use case (general, code, chat, embeddings, multimodal)', 'general')
    .option('--include-cloud', 'Include cloud models in analysis')
    .option('--ollama-only', 'Only show models available in Ollama')
    .option('--performance-test', 'Run performance benchmarks')
    .action(async (options) => {
        const spinner = ora('🔍 Analyzing your system...').start();

        try {
            // Initialize checkers
            const checker = new LLMChecker();
            const ollama = new OllamaClient();
            const expandedDB = new ExpandedModelsDatabase();

            // Get system information
            const hardware = await checker.getSystemInfo();
            spinner.text = '🖥️  Hardware analysis complete, checking Ollama...';

            // Check Ollama availability
            const ollamaStatus = await ollama.checkOllamaAvailability();
            let localModels = [];
            let runningModels = [];

            if (ollamaStatus.available) {
                try {
                    localModels = await ollama.getLocalModels();
                    runningModels = await ollama.getRunningModels();
                    spinner.text = '📦 Found Ollama installation with local models...';
                } catch (error) {
                    console.warn(chalk.yellow('⚠️  Ollama detected but could not fetch models'));
                }
            }

            spinner.text = '🧠 Analyzing model compatibility...';


            let models = expandedDB.getAllModels();


            if (options.filter) {
                if (['ultra_small', 'small', 'medium', 'large'].includes(options.filter)) {
                    models = expandedDB.getModelsByCategory(options.filter);
                } else if (['code', 'chat', 'multimodal', 'embeddings'].includes(options.filter)) {
                    models = expandedDB.getModelsBySpecialization(options.filter);
                }
            }

            if (options.ollamaOnly) {
                models = models.filter(model =>
                    model.frameworks && model.frameworks.includes('ollama')
                );
            }

            if (!options.includeCloud) {
                models = models.filter(model => model.type === 'local');
            }

            spinner.text = '📊 Calculating compatibility scores...';


            const compatibilityResults = models.map(model => {
                const analysis = expandedDB.getDetailedCompatibilityAnalysis(model, hardware);
                return {
                    ...model,
                    ...analysis,
                    isInstalled: localModels.some(local =>
                        local.name.toLowerCase().includes(model.name.toLowerCase().split(' ')[0])
                    ),
                    isRunning: runningModels.some(running =>
                        running.name.toLowerCase().includes(model.name.toLowerCase().split(' ')[0])
                    )
                };
            });


            const compatible = compatibilityResults.filter(m => m.score >= 75);
            const marginal = compatibilityResults.filter(m => m.score >= 60 && m.score < 75);
            const incompatible = compatibilityResults.filter(m => m.score < 60);


            compatible.sort((a, b) => b.score - a.score);
            marginal.sort((a, b) => b.score - a.score);
            incompatible.sort((a, b) => b.score - a.score);


            let benchmarkResults = null;
            if (options.performanceTest) {
                spinner.text = '⚡ Running performance benchmarks...';
                benchmarkResults = await checker.runBenchmark();
            }

            spinner.succeed('✅ Analysis complete!');


            console.log('\n' + chalk.blue.bold('🖥️  System Information:'));
            console.log(`CPU: ${hardware.cpu.brand} (${hardware.cpu.cores} cores, ${hardware.cpu.speed}GHz)`);
            console.log(`Architecture: ${hardware.cpu.architecture}`);
            console.log(`RAM: ${hardware.memory.total}GB total (${hardware.memory.free}GB free, ${hardware.memory.usagePercent}% used)`);
            console.log(`GPU: ${hardware.gpu.model || 'Not detected'}`);
            console.log(`VRAM: ${hardware.gpu.vram || 'N/A'}GB${hardware.gpu.dedicated ? ' (Dedicated)' : ' (Integrated)'}`);
            console.log(`OS: ${hardware.os.distro} ${hardware.os.release} (${hardware.os.arch})`);


            const tier = expandedDB.getHardwareTier(hardware);
            const overallScore = Math.round((hardware.cpu.score + hardware.memory.score + hardware.gpu.score) / 3);
            console.log(`\n🏆 Hardware Tier: ${chalk.cyan(tier.replace('_', ' ').toUpperCase())} (Overall Score: ${overallScore}/100)`);


            console.log(`\n🦙 Ollama Status: ${ollamaStatus.available ?
                chalk.green(`✅ Running (v${ollamaStatus.version || 'unknown'})`) :
                chalk.red(`❌ ${ollamaStatus.error}`)}`);

            if (ollamaStatus.available) {
                console.log(`📦 Local Models: ${localModels.length} installed`);
                if (runningModels.length > 0) {
                    console.log(`🚀 Running Models: ${runningModels.map(m => m.name).join(', ')}`);
                }
            }


            if (benchmarkResults) {
                console.log(`\n⚡ Performance Benchmark:`);
                console.log(`CPU Score: ${benchmarkResults.cpu}/100`);
                console.log(`Memory Score: ${benchmarkResults.memory}/100`);
                console.log(`Overall Score: ${benchmarkResults.overall}/100`);
            }

            if (options.detailed) {
                console.log('\n' + chalk.blue.bold('📊 Detailed Hardware Analysis:'));
                console.log(JSON.stringify({
                    cpu: hardware.cpu,
                    memory: hardware.memory,
                    gpu: hardware.gpu
                }, null, 2));
            }

            // Compatible models
            if (compatible.length > 0) {
                console.log('\n' + chalk.green.bold('✅ Compatible Models (Score ≥ 75):'));
                displayEnhancedModelsTable(compatible, 'compatible');

                // Show Ollama install commands for top models
                if (ollamaStatus.available) {
                    const ollamaCommands = generateOllamaCommands(compatible.slice(0, 3));
                    if (ollamaCommands.length > 0) {
                        console.log('\n' + chalk.blue.bold('🚀 Quick Install Commands:'));
                        ollamaCommands.forEach(cmd => {
                            const status = cmd.isInstalled ? chalk.green('✓ Installed') : chalk.gray('Not installed');
                            console.log(`${status} ${chalk.cyan(cmd.command)}`);
                        });
                    }
                }
            }

            // Marginal models
            if (marginal.length > 0) {
                console.log('\n' + chalk.yellow.bold('⚠️  Marginal Performance (Score 60-74):'));
                displayEnhancedModelsTable(marginal, 'marginal');
            }


            if (incompatible.length > 0) {
                console.log('\n' + chalk.red.bold('❌ Incompatible Models (showing top 5):'));
                displayEnhancedModelsTable(incompatible.slice(0, 5), 'incompatible');
            }


            const recommendations = expandedDB.getModelRecommendations(hardware, options.useCase);
            console.log('\n' + chalk.cyan.bold('💡 Personalized Recommendations:'));

            console.log(`\n🎯 Your hardware tier: ${chalk.cyan(tier.replace('_', ' ').toUpperCase())}`);
            console.log(`🎮 Use case: ${chalk.cyan(options.useCase)}`);

            console.log('\n📈 Top recommendations for your setup:');
            recommendations.topRecommendations.slice(0, 3).forEach((model, index) => {
                const emoji = model.compatibilityScore >= 90 ? '🟢' :
                    model.compatibilityScore >= 75 ? '🟡' : '🔴';
                console.log(`${index + 1}. ${emoji} ${model.name} (${model.compatibilityScore}/100)`);

                if (model.estimatedPerformance) {
                    console.log(`   ⚡ ~${model.estimatedPerformance.tokensPerSecond} tokens/sec`);
                }

                if (model.bestQuantization) {
                    console.log(`   📉 Recommended quantization: ${model.bestQuantization}`);
                }

                const ollamaName = getOllamaModelName(model.name);
                if (ollamaName) {
                    console.log(`   🦙 ollama pull ${ollamaName}`);
                }
            });


            if (options.useCase === 'general') {
                console.log('\n📋 By category:');
                Object.entries(recommendations.byCategory).forEach(([category, models]) => {
                    if (models.length > 0) {
                        console.log(`\n${getCategoryEmoji(category)} ${category.replace('_', ' ').toUpperCase()}:`);
                        models.forEach(model => {
                            console.log(`  • ${model.name} (${model.compatibilityScore}/100)`);
                        });
                    }
                });
            }


            if (compatible.length < 3) {
                console.log('\n' + chalk.magenta.bold('🔧 Hardware Upgrade Suggestions:'));
                generateUpgradeSuggestions(hardware, tier);
            }


            console.log('\n' + chalk.blue.bold('🎯 Next Steps:'));
            if (!ollamaStatus.available) {
                console.log('1. 🦙 Install Ollama: https://ollama.ai');
            }
            if (compatible.length > 0) {
                console.log(`${ollamaStatus.available ? '1' : '2'}. 🚀 Try a compatible model with: ollama pull ${getOllamaModelName(compatible[0].name) || 'llama3.2:3b'}`);
                console.log(`${ollamaStatus.available ? '2' : '3'}. 💬 Start chatting: ollama run ${getOllamaModelName(compatible[0].name) || 'llama3.2:3b'}`);
            }
            console.log(`${compatible.length > 0 ? '3' : '1'}. 📚 Explore more models: llm-checker browse`);

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
    .description('Manage Ollama integration')
    .option('-l, --list', 'List installed models')
    .option('-r, --running', 'Show running models')
    .option('-t, --test <model>', 'Test model performance')
    .option('--pull <model>', 'Pull a model')
    .option('--remove <model>', 'Remove a model')
    .action(async (options) => {
        const ollama = new OllamaClient();
        const spinner = ora('Checking Ollama...').start();

        try {
            const status = await ollama.checkOllamaAvailability();

            if (!status.available) {
                spinner.fail(`Ollama not available: ${status.error}`);
                console.log('\n💡 To install Ollama:');
                console.log('🔗 Visit: https://ollama.ai');
                console.log('📥 Or use: curl -fsSL https://ollama.ai/install.sh | sh');
                return;
            }

            spinner.succeed(`Ollama is running (version ${status.version || 'unknown'})`);

            if (options.list) {
                const models = await ollama.getLocalModels();
                console.log('\n📦 Installed Models:');
                if (models.length === 0) {
                    console.log('No models installed. Try: ollama pull llama3.2:3b');
                } else {
                    const data = [['Model', 'Size', 'Quantization', 'Modified']];
                    models.forEach(model => {
                        data.push([
                            model.displayName,
                            `${model.fileSizeGB}GB`,
                            model.quantization,
                            new Date(model.modified).toLocaleDateString()
                        ]);
                    });
                    console.log(table(data));
                }
            }

            if (options.running) {
                const running = await ollama.getRunningModels();
                console.log('\n🚀 Running Models:');
                if (running.length === 0) {
                    console.log('No models currently loaded.');
                } else {
                    running.forEach(model => {
                        console.log(`• ${model.name} (${Math.round(model.size_vram / (1024**3))}GB VRAM)`);
                    });
                }
            }

            if (options.test) {
                const testSpinner = ora(`Testing ${options.test}...`).start();
                try {
                    const result = await ollama.testModelPerformance(options.test);

                    if (result.success) {
                        testSpinner.succeed(`Performance test completed`);
                        console.log(`\n⚡ Results for ${options.test}:`);
                        console.log(`Response time: ${result.responseTime}ms`);
                        console.log(`Tokens/second: ${result.tokensPerSecond}`);
                        console.log(`Load time: ${result.loadTime || 'N/A'}ms`);
                        console.log(`Sample response: "${result.response.substring(0, 100)}..."`);
                    } else {
                        testSpinner.fail(`Test failed: ${result.error}`);
                    }
                } catch (error) {
                    testSpinner.fail(`Test error: ${error.message}`);
                }
            }

            if (options.pull) {
                const pullSpinner = ora(`Pulling ${options.pull}...`).start();
                try {
                    await ollama.pullModel(options.pull, (progress) => {
                        pullSpinner.text = `Pulling ${options.pull}: ${progress.percent || 0}%`;
                    });
                    pullSpinner.succeed(`Successfully pulled ${options.pull}`);
                } catch (error) {
                    pullSpinner.fail(`Failed to pull ${options.pull}: ${error.message}`);
                }
            }

            if (options.remove) {
                const confirmed = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'delete',
                    message: `Are you sure you want to delete ${options.remove}?`,
                    default: false
                }]);

                if (confirmed.delete) {
                    const removeSpinner = ora(`Removing ${options.remove}...`).start();
                    try {
                        await ollama.deleteModel(options.remove);
                        removeSpinner.succeed(`Successfully removed ${options.remove}`);
                    } catch (error) {
                        removeSpinner.fail(`Failed to remove ${options.remove}: ${error.message}`);
                    }
                }
            }

        } catch (error) {
            spinner.fail('Error with Ollama operation');
            console.error(chalk.red('Error:'), error.message);
        }
    });

program
    .command('browse')
    .description('Browse available models by category')
    .option('-c, --category <type>', 'Browse specific category')
    .option('-y, --year <year>', 'Filter by year')
    .option('--multimodal', 'Show only multimodal models')
    .action(async (options) => {
        const expandedDB = new ExpandedModelsDatabase();

        let models = expandedDB.getAllModels();

        if (options.category) {
            models = expandedDB.getModelsByCategory(options.category);
        }

        if (options.year) {
            models = expandedDB.getModelsByYear(parseInt(options.year));
        }

        if (options.multimodal) {
            models = expandedDB.getMultimodalModels();
        }

        console.log('\n' + chalk.blue.bold('🌐 Available Models Database:'));
        console.log(`Found ${models.length} models\n`);

        // Group by category
        const categories = ['ultra_small', 'small', 'medium', 'large', 'embedding'];

        categories.forEach(category => {
            const categoryModels = models.filter(m => m.category === category);
            if (categoryModels.length > 0) {
                console.log(chalk.cyan.bold(`\n${getCategoryEmoji(category)} ${category.replace('_', ' ').toUpperCase()} (${categoryModels.length} models):`));

                categoryModels.forEach(model => {
                    const flags = [];
                    if (model.multimodal) flags.push('🖼️ Multimodal');
                    if (model.specialization === 'code') flags.push('💻 Code');
                    if (model.year === 2024 || model.year === 2025) flags.push('🆕 Recent');

                    console.log(`\n• ${chalk.green(model.name)} (${model.size})`);
                    console.log(`  📊 RAM: ${model.requirements.ram}GB | VRAM: ${model.requirements.vram}GB | Storage: ${model.requirements.storage}GB`);
                    console.log(`  🚀 Speed: ${model.performance.speed} | Quality: ${model.performance.quality}`);

                    if (flags.length > 0) {
                        console.log(`  🏷️  ${flags.join(' | ')}`);
                    }

                    if (model.frameworks && model.frameworks.includes('ollama')) {
                        const ollamaName = getOllamaModelName(model.name);
                        console.log(`  🦙 ollama pull ${ollamaName || model.name.toLowerCase()}`);
                    }
                });
            }
        });
    });

function displayEnhancedModelsTable(models, type) {
    if (models.length === 0) return;

    const data = [
        ['Model', 'Size', 'Score', 'RAM', 'VRAM', 'Speed', 'Status']
    ];

    models.slice(0, 10).forEach(model => {
        const scoreColor = model.score >= 90 ? chalk.green :
            model.score >= 75 ? chalk.yellow :
                chalk.red;

        const statusFlags = [];
        if (model.isInstalled) statusFlags.push('📦');
        if (model.isRunning) statusFlags.push('🚀');
        if (model.multimodal) statusFlags.push('🖼️');
        if (model.specialization === 'code') statusFlags.push('💻');

        const row = [
            model.name,
            model.size,
            scoreColor(`${model.score}/100`),
            `${model.requirements.ram}GB`,
            `${model.requirements.vram || 0}GB`,
            model.performance.speed,
            statusFlags.join(' ') || '-'
        ];
        data.push(row);
    });

    console.log(table(data));

    if (models.length > 10) {
        console.log(chalk.gray(`... and ${models.length - 10} more models`));
    }
}

function generateOllamaCommands(models) {
    return models
        .filter(model => model.frameworks && model.frameworks.includes('ollama'))
        .map(model => {
            const ollamaName = getOllamaModelName(model.name);
            return {
                model: model.name,
                command: `ollama pull ${ollamaName}`,
                isInstalled: model.isInstalled
            };
        })
        .filter(cmd => cmd.command.includes('ollama pull'));
}

function getOllamaModelName(modelName) {
    const mapping = {
        'TinyLlama 1.1B': 'tinyllama:1.1b',
        'Qwen 0.5B': 'qwen:0.5b',
        'Gemma 2B': 'gemma2:2b',
        'Gemma 3 1B': 'gemma3:1b',
        'Gemma 3 4B': 'gemma3:4b',
        'Phi-3 Mini 3.8B': 'phi3:mini',
        'Phi-4 14B': 'phi4:14b',
        'Llama 3.2 1B': 'llama3.2:1b',
        'Llama 3.2 3B': 'llama3.2:3b',
        'Llama 3.1 8B': 'llama3.1:8b',
        'Llama 3.3 70B': 'llama3.3:70b',
        'Mistral 7B v0.3': 'mistral:7b',
        'Mistral Small 3.1': 'mistral-small:22b',
        'CodeLlama 7B': 'codellama:7b',
        'Qwen 2.5 7B': 'qwen2.5:7b',
        'DeepSeek Coder 6.7B': 'deepseek-coder:6.7b',
        'DeepSeek-R1 70B': 'deepseek-r1:70b',
        'LLaVA 7B': 'llava:7b'
    };

    return mapping[modelName] || null;
}

function getCategoryEmoji(category) {
    const emojis = {
        ultra_small: '🐣',
        small: '🐤',
        medium: '🐦',
        large: '🦅',
        embedding: '🧲'
    };
    return emojis[category] || '🤖';
}

function generateUpgradeSuggestions(hardware, tier) {
    const suggestions = [];

    if (hardware.memory.total < 16) {
        suggestions.push('💾 Upgrade to 16GB+ RAM for medium models');
    }

    if (hardware.memory.total < 32 && tier !== 'ultra_low') {
        suggestions.push('💾 Consider 32GB RAM for large models');
    }

    if (hardware.gpu.vram < 8 && hardware.gpu.dedicated) {
        suggestions.push('🎮 GPU with 8GB+ VRAM for better performance');
    }

    if (!hardware.gpu.dedicated) {
        suggestions.push('🎮 Dedicated GPU would significantly improve performance');
    }

    if (hardware.cpu.cores < 6) {
        suggestions.push('⚡ More CPU cores help with parallel processing');
    }

    suggestions.forEach((suggestion, index) => {
        console.log(`${index + 1}. ${suggestion}`);
    });

    if (suggestions.length === 0) {
        console.log('🎉 Your hardware is well-suited for most models!');
    }
}


process.on('unhandledRejection', (reason, promise) => {
    console.error(chalk.red('Unhandled Rejection:'), reason);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log(chalk.yellow('\n👋 Goodbye!'));
    process.exit(0);
});

program.parse();