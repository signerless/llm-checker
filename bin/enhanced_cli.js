#!/usr/bin/env node
const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const { table } = require('table');
const os = require('os');
const { spawn } = require('child_process');
const LLMChecker = require('../src/index');
const { getLogger } = require('../src/utils/logger');
const fs = require('fs');
const path = require('path');

// Function to search Ollama models by use case
function searchOllamaModelsForUseCase(useCase, hardware) {
    try {
        const cacheFile = path.join(__dirname, '../src/ollama/.cache/ollama-detailed-models.json');
        if (!fs.existsSync(cacheFile)) return [];
        
        const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const models = cacheData.models || [];
        
        // Filter models by use case with typo tolerance
        const useCaseModels = models.filter(model => {
            const lowerUseCase = useCase.toLowerCase();
            switch (lowerUseCase) {
                case 'creative':
                case 'writing':
                    return model.primary_category === 'creative';
                    
                case 'coding':
                case 'code':
                    return model.primary_category === 'coding';
                    
                case 'chat':
                case 'conversation':
                case 'talking':
                    return model.primary_category === 'chat';
                    
                case 'multimodal':
                case 'vision':
                    return model.primary_category === 'multimodal';
                    
                case 'embeddings':
                case 'embedings': // typo tolerance
                case 'embedding':
                case 'embeding': // typo tolerance
                    return model.primary_category === 'embeddings';
                    
                case 'reasoning':
                case 'reason':
                    return model.primary_category === 'reasoning';
                    
                default:
                    // Check for partial matches
                    if (lowerUseCase.includes('embed')) return model.primary_category === 'embeddings';
                    if (lowerUseCase.includes('code')) return model.primary_category === 'coding';
                    if (lowerUseCase.includes('creat')) return model.primary_category === 'creative';
                    if (lowerUseCase.includes('chat') || lowerUseCase.includes('talk')) return model.primary_category === 'chat';
                    if (lowerUseCase.includes('vision') || lowerUseCase.includes('multimodal')) return model.primary_category === 'multimodal';
                    if (lowerUseCase.includes('reason')) return model.primary_category === 'reasoning';
                    return false;
            }
        });
        
        // Convert Ollama models to compatible format and add basic compatibility scoring
        return useCaseModels.map(model => {
            // Find a suitable variant (prefer 7b-13b for high-end hardware)
            let bestVariant = null;
            if (model.variants && model.variants.length > 0) {
                // For high-tier hardware, prefer 7B-13B models
                bestVariant = model.variants.find(v => 
                    v.real_size_gb >= 3 && v.real_size_gb <= 15 &&
                    !v.tag.includes('-instruct') && !v.tag.includes('-code')
                ) || model.variants[0];
            }
            
            const size = bestVariant ? bestVariant.real_size_gb : 7;
            const ollamaTag = bestVariant ? bestVariant.tag : model.model_identifier + ':latest';
            
            return {
                name: model.model_name || model.model_identifier,
                size: size + 'GB',
                type: 'ollama',
                category: model.primary_category,
                specialization: model.primary_category,
                primary_category: model.primary_category,
                categories: model.categories,
                requirements: {
                    ram: Math.max(4, Math.ceil(size * 1.2)),
                    vram: 0,
                    cpu_cores: 2,
                    storage: size,
                    recommended_ram: Math.max(8, Math.ceil(size * 1.5))
                },
                frameworks: ['ollama'],
                performance: {
                    speed: size <= 7 ? 'fast' : size <= 13 ? 'medium' : 'slow',
                    quality: model.primary_category === 'coding' ? 'excellent_for_code' : 
                            model.primary_category === 'creative' ? 'excellent_for_creative' : 'good',
                    context_length: 4096,
                    tokens_per_second_estimate: size <= 7 ? '30-50' : '15-30'
                },
                installation: {
                    ollama: `ollama pull ${ollamaTag}`,
                    description: model.detailed_description || model.description || `${model.primary_category} model`
                },
                ollamaId: model.model_identifier,
                ollamaTag: ollamaTag,
                source: 'ollama_database',
                // Basic compatibility score (can be improved)
                score: calculateBasicCompatibilityScore(size, hardware),
                isOllamaInstalled: false,
                ollamaAvailable: true
            };
        }).slice(0, 10); // Limit to top 10 models
        
    } catch (error) {
        console.warn('Error searching Ollama models:', error.message);
        return [];
    }
}

// Basic compatibility scoring for Ollama models
function calculateBasicCompatibilityScore(modelSizeGB, hardware) {
    const totalRAM = hardware.memory?.total || 8;
    const availableRAM = totalRAM * 0.8; // Assume 80% available
    
    // RAM compatibility
    let ramScore = 0;
    if (modelSizeGB * 1.5 <= availableRAM) {
        ramScore = 100;
    } else if (modelSizeGB <= availableRAM) {
        ramScore = 80;
    } else {
        ramScore = Math.max(0, 50 - (modelSizeGB - availableRAM) * 10);
    }
    
    // Size efficiency (prefer 7B-13B for high-end hardware)
    let sizeScore = 100;
    if (totalRAM >= 16) { // High-end hardware
        if (modelSizeGB >= 7 && modelSizeGB <= 13) {
            sizeScore = 100;
        } else if (modelSizeGB < 7) {
            sizeScore = 85; // Small models are okay but not optimal
        } else {
            sizeScore = Math.max(60, 100 - (modelSizeGB - 13) * 5);
        }
    }
    
    return Math.round((ramScore * 0.7 + sizeScore * 0.3));
}

// Function to get real size directly from Ollama cache
function estimateModelSize(model) {
    // Extract parameter count from model name (e.g., "3B", "7B", "13B")
    const nameMatch = model.name.match(/(\d+\.?\d*)[bB]\b/i);
    if (nameMatch) {
        const paramCount = parseFloat(nameMatch[1]);
        // Estimate size using Q4_K_M quantization (~0.5 bytes per parameter + overhead)
        const estimatedGB = Math.round((paramCount * 0.5 + 0.5) * 10) / 10;
        return `~${estimatedGB}GB (Q4_K_M)`;
    }
    
    // Try to extract from model identifier or fallback patterns
    if (model.model_identifier) {
        const idMatch = model.model_identifier.match(/(\d+\.?\d*)b/i);
        if (idMatch) {
            const paramCount = parseFloat(idMatch[1]);
            const estimatedGB = Math.round((paramCount * 0.5 + 0.5) * 10) / 10;
            return `~${estimatedGB}GB (Q4_K_M)`;
        }
    }
    
    // Known model size patterns
    const sizeMappings = {
        'tinyllama': '~1.1GB (Q4_K_M)',
        'mobilellama': '~1.4GB (Q4_K_M)',
        'phi': '~2.7GB (Q4_K_M)',
        'gemma': '~5.3GB (Q4_K_M)',
        'llama.*3b': '~2.0GB (Q4_K_M)',
        'llama.*7b': '~4.4GB (Q4_K_M)',
        'llama.*13b': '~7.8GB (Q4_K_M)',
        'dolphincoder': '~4.2GB (Q4_K_M)',
        'deepseek-coder': '~4.0GB (Q4_K_M)',
        'starcoder': '~8.4GB (Q4_K_M)'
    };
    
    const modelNameLower = (model.name || '').toLowerCase();
    for (const [pattern, size] of Object.entries(sizeMappings)) {
        if (new RegExp(pattern, 'i').test(modelNameLower)) {
            return size;
        }
    }
    
    // If we have size field but it's not formatted well
    if (model.size && typeof model.size === 'string') {
        const sizeMatch = model.size.match(/(\d+\.?\d*)\s*(GB|MB|B)/i);
        if (sizeMatch) {
            const num = parseFloat(sizeMatch[1]);
            const unit = sizeMatch[2].toUpperCase();
            if (unit === 'GB') return `${num}GB`;
            if (unit === 'MB') return `${Math.round(num / 1024 * 10) / 10}GB`;
        }
    }
    
    // Final fallback
    return '~4.5GB (estimated)';
}

function getRealSizeFromOllamaCache(model) {
    try {
        const cacheFile = path.join(__dirname, '../src/ollama/.cache/ollama-detailed-models.json');
        if (!fs.existsSync(cacheFile)) return null;
        
        const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const models = cacheData.models || [];
        
        // Try to find the model by different strategies
        let targetModel = null;
        
        // Strategy 1: Match by ollamaId directly (e.g., "codellama")
        if (model.ollamaId) {
            // Special case: if looking for phind-codellama but model is actually CodeLlama, use codellama instead
            if (model.ollamaId === 'phind-codellama' && 
                (model.name.toLowerCase().includes('codellama') || model.name.toLowerCase().includes('code llama'))) {
                targetModel = models.find(m => m.model_identifier === 'codellama');
            } 
            // Special case: DeepSeek Coder has wrong ollamaId
            else if (model.ollamaId === 'deepseek-v2.5' && 
                     model.name.toLowerCase().includes('deepseek') && 
                     model.name.toLowerCase().includes('coder')) {
                targetModel = models.find(m => m.model_identifier === 'deepseek-coder');
            } else {
                targetModel = models.find(m => m.model_identifier === model.ollamaId);
            }
        }
        
        // Strategy 2: Match by name similarity  
        if (!targetModel && model.name) {
            const modelNameLower = model.name.toLowerCase();
            
            // Special handling for specific models - be very specific
            if (modelNameLower.includes('deepseek') && modelNameLower.includes('coder')) {
                targetModel = models.find(m => m.model_identifier.toLowerCase() === 'deepseek-coder');
            } else if (modelNameLower.includes('llama3.3')) {
                targetModel = models.find(m => m.model_identifier.toLowerCase() === 'llama3.3');
            } else if (modelNameLower.includes('llama3.2')) {
                targetModel = models.find(m => m.model_identifier.toLowerCase() === 'llama3.2');
            } else if (modelNameLower.includes('llama3.1') || modelNameLower.includes('llama 3.1')) {
                targetModel = models.find(m => m.model_identifier.toLowerCase() === 'llama3.1');
            } else {
                targetModel = models.find(m => {
                    const identifier = m.model_identifier.toLowerCase();
                    return identifier.includes('codellama') && modelNameLower.includes('codellama') ||
                           identifier.includes('qwen') && modelNameLower.includes('qwen') ||
                           identifier.includes('mistral') && modelNameLower.includes('mistral');
                });
            }
        }
        
        if (!targetModel || !targetModel.variants) return null;
        
        // Extract size from model name (e.g., "CodeLlama 7B" -> "7b")
        let targetSize = null;
        if (model.size) {
            targetSize = model.size.toLowerCase().replace('b', '') + 'b';
        } else if (model.name) {
            const sizeMatch = model.name.match(/(\d+\.?\d*)[bB]/);
            if (sizeMatch) {
                targetSize = sizeMatch[1] + 'b';
            }
        }
        
        
        // Find the right variant
        let variant = null;
        if (targetSize) {
            // Look for exact size match (e.g., "codellama:7b")
            variant = targetModel.variants.find(v => 
                v.tag.includes(':' + targetSize) && 
                !v.tag.includes('-instruct') && 
                !v.tag.includes(':code-') // Exclude variants like ":code-" but allow "coder"
            );
            
        }
        
        // Fallback to latest or first variant
        if (!variant) {
            variant = targetModel.variants.find(v => v.tag.includes(':latest')) || 
                     targetModel.variants[0];
            
        }
        
        if (variant && variant.real_size_gb) {
            return variant.real_size_gb + 'GB';
        }
        
        return null;
    } catch (error) {
        console.warn('Error reading Ollama cache:', error.message);
        return null;
    }
}

const program = new Command();

program
    .name('llm-checker')
    .description('Check which LLM models your computer can run')
    .version(require('../package.json').version);

const logger = getLogger({ console: false });

// Ollama installation helper
function getOllamaInstallInstructions() {
    const platform = os.platform();
    const arch = os.arch();
    
    const instructions = {
        'darwin': {
            name: 'macOS',
            downloadUrl: 'https://ollama.com/download/mac',
            instructions: [
                '1. Download Ollama for macOS from the link above',
                '2. Open the downloaded .pkg file and follow the installer',
                '3. Once installed, open Terminal and run: ollama serve',
                '4. In a new terminal window, test with: ollama run llama2:7b'
            ],
            alternativeInstall: 'brew install ollama'
        },
        'win32': {
            name: 'Windows',
            downloadUrl: 'https://ollama.com/download/windows',
            instructions: [
                '1. Download Ollama for Windows from the link above',
                '2. Run the downloaded installer (.exe file)',
                '3. Open Command Prompt or PowerShell',
                '4. Test with: ollama run llama2:7b'
            ],
            alternativeInstall: 'winget install Ollama.Ollama'
        },
        'linux': {
            name: 'Linux',
            downloadUrl: 'https://ollama.com/download/linux',
            instructions: [
                '1. Run the installation script:',
                '   curl -fsSL https://ollama.com/install.sh | sh',
                '2. Start Ollama service:',
                '   sudo systemctl start ollama',
                '3. Test with: ollama run llama2:7b'
            ],
            alternativeInstall: 'Manual install: https://github.com/ollama/ollama/blob/main/docs/linux.md'
        }
    };
    
    return instructions[platform] || instructions['linux'];
}

function displayOllamaInstallHelp() {
    const installInfo = getOllamaInstallInstructions();
    
    console.log(chalk.red.bold('\nOllama is not installed or not running!'));
    console.log(chalk.yellow('\nLLM Checker requires Ollama to function properly.'));
    console.log(chalk.cyan.bold(`\nInstall Ollama for ${installInfo.name}:`));
    console.log(chalk.blue(`\nDownload: ${installInfo.downloadUrl}`));
    
    console.log(chalk.green.bold('\nInstallation Steps:'));
    installInfo.instructions.forEach(step => {
        console.log(chalk.gray(`   ${step}`));
    });
    
    if (installInfo.alternativeInstall) {
        console.log(chalk.magenta.bold('\nQuick Install (if available):'));
        console.log(chalk.white(`   ${installInfo.alternativeInstall}`));
    }
    
    console.log(chalk.yellow.bold('\nAfter installation:'));
    console.log(chalk.gray('   1. Restart your terminal'));
    console.log(chalk.gray('   2. Run: llm-checker check'));
    console.log(chalk.gray('   3. Start using the AI model selector!'));
    
    console.log(chalk.cyan('\nNeed help? Visit: https://github.com/ollama/ollama'));
}

async function checkOllamaAndExit() {
    const spinner = ora('Checking Ollama availability...').start();
    
    try {
        // Quick check if ollama command exists
        const checkCommand = os.platform() === 'win32' ? 'where' : 'which';
        
        return new Promise((resolve) => {
            const proc = spawn(checkCommand, ['ollama'], { stdio: 'pipe' });
            
            proc.on('close', (code) => {
                spinner.stop();
                if (code !== 0) {
                    displayOllamaInstallHelp();
                    process.exit(1);
                }
                resolve(true);
            });
            
            proc.on('error', () => {
                spinner.stop();
                displayOllamaInstallHelp();
                process.exit(1);
            });
        });
    } catch (error) {
        spinner.stop();
        displayOllamaInstallHelp();
        process.exit(1);
    }
}

function getStatusIcon(model, ollamaModels) {
    const ollamaModel = ollamaModels?.find(om => om.matchedModel?.name === model.name);

    if (ollamaModel?.isRunning) return 'R';
    if (ollamaModel?.isInstalled) return 'I';

    if (model.specialization === 'code') return 'C';
    if (model.specialization === 'multimodal' || model.multimodal) return 'M';
    if (model.specialization === 'embeddings') return 'E';
    if (model.category === 'ultra_small') return 'XS';
    if (model.category === 'small') return 'S';
    if (model.category === 'medium') return 'M';
    if (model.category === 'large') return 'L';

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

// Helper function to calculate model compatibility score
function calculateModelCompatibilityScore(model, hardware) {
    let score = 50; // Base score
    
    // Estimar tamaño del modelo
    const sizeMatch = model.model_identifier.match(/(\d+\.?\d*)[bm]/i);
    let modelSizeB = 1; // Default 1B
    
    if (sizeMatch) {
        const num = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[0].slice(-1).toLowerCase();
        modelSizeB = unit === 'm' ? num / 1000 : num;
    }
    
    // Calcular requerimientos estimados
    const estimatedRAM = modelSizeB * 1.2; // 1.2x el tamaño del modelo
    const ramRatio = hardware.memory.total / estimatedRAM;
    
    // Puntuación por compatibilidad de RAM (40% del score)
    if (ramRatio >= 3) score += 40;
    else if (ramRatio >= 2) score += 30;
    else if (ramRatio >= 1.5) score += 20;
    else if (ramRatio >= 1.2) score += 10;
    else if (ramRatio >= 1) score += 5;
    else score -= 20; // Penalización por RAM insuficiente
    
    // Puntuación por tamaño del modelo (30% del score)
    if (modelSizeB <= 1) score += 30; // Modelos pequeños funcionan en cualquier lado
    else if (modelSizeB <= 3) score += 25;
    else if (modelSizeB <= 7) score += 20;
    else if (modelSizeB <= 13) score += 15;
    else if (modelSizeB <= 30) score += 10;
    else score -= 10; // Modelos muy grandes
    
    // Puntuación por CPU cores (20% del score)
    if (hardware.cpu.cores >= 12) score += 20;
    else if (hardware.cpu.cores >= 8) score += 15;
    else if (hardware.cpu.cores >= 6) score += 10;
    else if (hardware.cpu.cores >= 4) score += 5;
    
    // Bonus por popularidad (10% del score)
    const pulls = model.pulls || 0;
    if (pulls > 1000000) score += 10;
    else if (pulls > 100000) score += 7;
    else if (pulls > 10000) score += 5;
    else if (pulls > 1000) score += 3;
    
    // Bonus especial para Apple Silicon
    if (hardware.cpu.architecture === 'Apple Silicon') {
        score += 5;
        // Bonus extra para modelos optimizados
        const modelName = model.model_identifier.toLowerCase();
        if (modelName.includes('llama') || modelName.includes('mistral') || 
            modelName.includes('phi') || modelName.includes('gemma')) {
            score += 3;
        }
    }
    
    return Math.max(0, Math.min(100, Math.round(score)));
}

// Helper function to get hardware tier for display
function getHardwareTierForDisplay(hardware) {
    const ram = hardware.memory.total;
    const cores = hardware.cpu.cores;
    
    if (ram >= 64 && cores >= 16) return 'EXTREME';
    if (ram >= 32 && cores >= 12) return 'VERY HIGH';
    if (ram >= 16 && cores >= 8) return 'HIGH';
    if (ram >= 8 && cores >= 4) return 'MEDIUM';
    if (ram >= 4 && cores >= 2) return 'LOW';
    
    // Casos especiales
    if (ram >= 16 && ram < 32 && cores >= 12) return 'HIGH';
    if (ram >= 32 && ram < 64 && cores >= 8) return 'VERY HIGH';
    
    return 'ULTRA LOW';
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
        `${chalk.cyan('RAM:')} ${ramColor(hardware.memory.total + 'GB')}`,
        `${chalk.cyan('GPU:')} ${gpuColor(hardware.gpu.model || 'Not detected')}`,
        `${chalk.cyan('VRAM:')} ${hardware.gpu.vram === 0 && hardware.gpu.model && hardware.gpu.model.toLowerCase().includes('apple') ? 'Unified Memory' : `${hardware.gpu.vram || 'N/A'}GB`}${hardware.gpu.dedicated ? chalk.green(' (Dedicated)') : chalk.hex('#FFA500')(' (Integrated)')}`,
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

            lines.push(`${chalk.cyan('Installed:')} ${ollamaModels.length} total, ${chalk.green(compatibleCount)} compatible`);
            if (runningCount > 0) {
                lines.push(`${chalk.cyan('Running:')} ${chalk.green(runningCount)} models`);
            }
        } else {
            lines.push(`${chalk.gray('No models installed yet')}`);
        }
    } else {
        lines.push(`${chalk.red('Status:')} Not available`);
    }

    console.log('\n' + chalk.bgMagenta.white.bold(' OLLAMA INTEGRATION '));
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
                statusDisplay = 'Running';
            } else {
                statusDisplay = 'Installed';
            }
        }

        let modelName = model.name;
        if (model.isOllamaInstalled) {
            modelName = `${model.name}`;
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

    console.log('\n' + chalk.yellow.bold('Marginal Performance (Score 60-74)'));

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


function displayStructuredRecommendations(recommendations) {
    if (!recommendations) return;

    if (Array.isArray(recommendations)) {
        displayLegacyRecommendations(recommendations);
        return;
    }

    console.log('\n' + chalk.bgCyan.white.bold(' 🎯 SMART RECOMMENDATIONS '));
    console.log(chalk.cyan('╭' + '─'.repeat(50)));

    if (recommendations.general && recommendations.general.length > 0) {
        console.log(chalk.cyan('│') + ` ${chalk.bold.white('General Recommendations:')}`);
        recommendations.general.slice(0, 4).forEach((rec, index) => {
            console.log(chalk.cyan('│') + `   ${index + 1}. ${chalk.white(rec)}`);
        });
        console.log(chalk.cyan('│'));
    }

    if (recommendations.installedModels && recommendations.installedModels.length > 0) {
        console.log(chalk.cyan('│') + ` ${chalk.bold.green('Your Installed Ollama Models:')}`);
        recommendations.installedModels.forEach(rec => {
            console.log(chalk.cyan('│') + `   ${chalk.green(rec)}`);
        });
        console.log(chalk.cyan('│'));
    }

    if (recommendations.cloudSuggestions && recommendations.cloudSuggestions.length > 0) {
        console.log(chalk.cyan('│') + ` ${chalk.bold.blue('Recommended from Ollama Cloud:')}`);
        recommendations.cloudSuggestions.forEach(rec => {
            if (rec.includes('ollama pull')) {
                console.log(chalk.cyan('│') + `   ${chalk.cyan.bold(rec)}`);
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
        if (rec.includes('Score:')) {
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
        console.log(chalk.cyan('│') + ` ${chalk.bold.green('Your Installed Ollama Models:')}`);
        ollamaFoundRecs.forEach(rec => {
            console.log(chalk.cyan('│') + `   ${chalk.green(rec)}`);
        });
    }

    if (quickInstallRecs.length > 0) {
        console.log(chalk.cyan('│'));
        console.log(chalk.cyan('│') + ` ${chalk.bold.blue('Quick Commands:')}`);
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
        console.log(chalk.red('│') + ` ${chalk.bold.yellow('BEST OVERALL:')} ${chalk.green.bold(best.name)}`);
        console.log(chalk.red('│') + `    Command: ${chalk.cyan.bold(best.command)}`);
        console.log(chalk.red('│') + `    Score: ${chalk.yellow.bold(best.score)}/100 | Category: ${chalk.magenta(best.category)}`);
        console.log(chalk.red('│'));
    }

    // Mostrar por categorías
    const categories = {
        coding: 'Coding',
        talking: 'Chat', 
        reading: 'Reading',
        reasoning: 'Reasoning',
        multimodal: 'Multimodal',
        creative: 'Creative',
        general: 'General'
    };

    Object.entries(summary.by_category).forEach(([category, model]) => {
        const icon = categories[category] || 'Other';
        const categoryName = category.charAt(0).toUpperCase() + category.slice(1);
        const scoreColor = getScoreColor(model.score);
        
        console.log(chalk.red('│') + ` ${chalk.bold.white(categoryName)} (${icon}):`);
        console.log(chalk.red('│') + `    ${chalk.green(model.name)} (${model.size})`);
        console.log(chalk.red('│') + `    Score: ${scoreColor.bold(model.score)}/100 | Pulls: ${chalk.gray(model.pulls?.toLocaleString() || 'N/A')}`);
        console.log(chalk.red('│') + `    Command: ${chalk.cyan.bold(model.command)}`);
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

async function displayTopRecommended(models, categoryFilter) {
    console.log('\n' + chalk.bgGreen.white.bold(' 🏆 TOP 3 RECOMMENDED FOR YOUR HARDWARE '));
    
    try {
        // Usar la heurística matemática inteligente
        const hardwareDetector = new (require('../src/hardware/detector.js'))();
        const hardware = await hardwareDetector.getSystemInfo();
        
        const IntelligentModelRecommender = require('../src/models/intelligent-recommender.js');
        const recommender = new IntelligentModelRecommender();
        
        // Filtrar modelos por la categoría específica usando el mismo criterio
        const categoryModels = recommender.filterModelsByCategory(models, categoryFilter);
        
        // Aplicar scoring matemático inteligente
        const scoredModels = recommender.scoreModelsForCategory(categoryModels, categoryFilter, hardware);
        
        // Ordenar por score de categoría
        const sortedModels = scoredModels.sort((a, b) => b.categoryScore - a.categoryScore);
        
        // Expandir a variantes y calcular score individual para cada variante
        const allVariants = [];
        sortedModels.forEach(model => {
            if (model.tags && model.tags.length > 0) {
                model.tags.forEach(tag => {
                    const tagSize = extractSizeFromIdentifier(tag) || 
                                   model.main_size || 
                                   (model.model_sizes && model.model_sizes[0]) || 
                                   'Unknown';
                    
                    // Crear un modelo temporal para esta variante específica
                    const variantModel = {
                        ...model,
                        model_identifier: tag,
                        tags: [tag]
                    };
                    
                    // Calcular score específico para esta variante
                    const variantScored = recommender.scoreModelsForCategory([variantModel], categoryFilter, hardware)[0];
                    
                    allVariants.push({
                        name: tag,
                        size: tagSize,
                        score: Math.round(variantScored.categoryScore),
                        category: model.category || 'general',
                        context: model.context_length || 'Unknown',
                        input: (model.input_types && model.input_types.length > 0) ? 
                               model.input_types.slice(0, 2).join(',') : 'text',
                        reasoning: `Hardware: ${Math.round(variantScored.hardwareScore || 0)}/100, Specialization: ${Math.round(variantScored.specializationScore || 0)}/100, Popularity: ${Math.round(variantScored.popularityScore || 0)}/100`
                    });
                });
            } else {
                allVariants.push({
                    name: model.model_name || model.model_identifier,
                    size: model.main_size || 'Unknown',
                    score: Math.round(model.categoryScore),
                    category: model.category || 'general',
                    context: model.context_length || 'Unknown',
                    input: (model.input_types && model.input_types.length > 0) ? 
                           model.input_types.slice(0, 2).join(',') : 'text',
                    reasoning: `Hardware: ${Math.round(model.hardwareScore || 0)}/100, Specialization: ${Math.round(model.specializationScore || 0)}/100, Popularity: ${Math.round(model.popularityScore || 0)}/100`
                });
            }
        });
        
        // Ordenar variantes por score individual y tomar los top 3
        const sortedVariants = allVariants.sort((a, b) => b.score - a.score);
        const top3 = sortedVariants.slice(0, 3);
        
        if (top3.length === 0) {
            console.log(chalk.green('│') + chalk.yellow(' No models found for this category with current hardware'));
            console.log(chalk.green('╰' + '─'.repeat(65)));
            return;
        }
    
        top3.forEach((variant, index) => {
            const rankEmoji = ['🥇', '🥈', '🥉'][index];
            const categoryColor = getCategoryColor(variant.category);
            const scoreColor = variant.score >= 80 ? chalk.green.bold : 
                              variant.score >= 60 ? chalk.yellow : chalk.red;
            
            console.log(chalk.green('│'));
            console.log(chalk.green('│') + ` ${rankEmoji} ${chalk.cyan.bold(variant.name)}`);
            console.log(chalk.green('│') + `    Size: ${chalk.green(variant.size)} | Score: ${scoreColor(variant.score + '%')} | Category: ${categoryColor(variant.category)}`);
            console.log(chalk.green('│') + `    Command: ${chalk.yellow.bold('ollama pull ' + variant.name)}`);
            console.log(chalk.green('│') + `    ${chalk.gray(variant.reasoning)}`);
        });
        
        console.log(chalk.green('╰' + '─'.repeat(65)));
        
    } catch (error) {
        console.log(chalk.green('│') + chalk.red(' Error calculating intelligent recommendations: ' + error.message));
        console.log(chalk.green('╰' + '─'.repeat(65)));
    }
}

async function displayCompactModelsList(models, categoryFilter = null) {
    // Si hay modelos con compatibilityScore, mostrar top 3 recomendados primero
    const showCompatibility = models.length > 0 && models[0].compatibilityScore !== undefined;
    
    if (showCompatibility && categoryFilter) {
        await displayTopRecommended(models, categoryFilter);
    }
    
    console.log('\n' + chalk.bgBlue.white.bold(' 📋 MODELS LIST '));
    
    const headers = [
        chalk.bgBlue.white.bold(' # '),
        chalk.bgBlue.white.bold(' Model '),
        chalk.bgBlue.white.bold(' Size ')
    ];
    
    if (showCompatibility) {
        headers.push(chalk.bgBlue.white.bold(' Score '));
    }
    
    headers.push(
        chalk.bgBlue.white.bold(' Context '),
        chalk.bgBlue.white.bold(' Input '),
        chalk.bgBlue.white.bold(' Category ')
    );
    
    const data = [headers];

    let rowIndex = 0;
    models.forEach((model) => {
        const category = model.category || 'general';
        const categoryColor = getCategoryColor(category);
        
        // Context length
        const contextLength = model.context_length || 'Unknown';
        
        // Input types
        const inputTypes = (model.input_types && model.input_types.length > 0) ? 
            model.input_types.slice(0, 2).join(',') : 'text';
        
        // Si el modelo tiene tags/variantes, crear una fila por cada tag
        if (model.tags && model.tags.length > 0) {
            model.tags.forEach((tag) => {
                rowIndex++;
                
                // Extraer el tamaño del tag si está presente
                const tagSize = extractSizeFromIdentifier(tag) || 
                               model.main_size || 
                               (model.model_sizes && model.model_sizes[0]) || 
                               'Unknown';
                
                const row = [
                    chalk.gray(`${rowIndex}`),
                    tag, // Mostrar el tag completo como nombre del modelo
                    chalk.green(tagSize)
                ];
                
                // Agregar score si está disponible
                if (showCompatibility) {
                    const score = model.compatibilityScore || 0;
                    const scoreColor = score >= 80 ? chalk.green.bold : 
                                    score >= 60 ? chalk.yellow : chalk.red;
                    row.push(scoreColor(`${score}%`));
                }
                
                row.push(
                    chalk.blue(contextLength),
                    chalk.magenta(inputTypes),
                    categoryColor(category)
                );
                
                data.push(row);
            });
        } else {
            // Si no tiene tags, mostrar el modelo base
            rowIndex++;
            
            const mainSize = model.main_size || 
                            (model.model_sizes && model.model_sizes[0]) || 
                            extractSizeFromIdentifier(model.model_identifier) || 
                            'Unknown';
            
            const row = [
                chalk.gray(`${rowIndex}`),
                model.model_name || model.model_identifier || 'Unknown',
                chalk.green(mainSize)
            ];
            
            // Agregar score si está disponible
            if (showCompatibility) {
                const score = model.compatibilityScore || 0;
                const scoreColor = score >= 80 ? chalk.green.bold : 
                                score >= 60 ? chalk.yellow : chalk.red;
                row.push(scoreColor(`${score}%`));
            }
            
            row.push(
                chalk.blue(contextLength),
                chalk.magenta(inputTypes),
                categoryColor(category)
            );
            
            data.push(row);
        }
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
    console.log(chalk.yellow('│') + ` ${chalk.bold.white('Browse models by category:')}`);
    console.log(chalk.yellow('│') + `   ${chalk.cyan('llm-checker list-models --category coding')} ${chalk.gray('(Programming & development)')}`);
    console.log(chalk.yellow('│') + `   ${chalk.cyan('llm-checker list-models --category reasoning')} ${chalk.gray('(Logic & math problems)')}`);
    console.log(chalk.yellow('│') + `   ${chalk.cyan('llm-checker list-models --category talking')} ${chalk.gray('(Chat & conversations)')}`);
    console.log(chalk.yellow('│') + `   ${chalk.cyan('llm-checker list-models --category reading')} ${chalk.gray('(Text analysis & comprehension)')}`);
    console.log(chalk.yellow('│') + `   ${chalk.cyan('llm-checker list-models --category multimodal')} ${chalk.gray('(Image & vision tasks)')}`);
    console.log(chalk.yellow('│') + `   ${chalk.cyan('llm-checker list-models --category creative')} ${chalk.gray('(Creative writing & stories)')}`);
    console.log(chalk.yellow('│') + `   ${chalk.cyan('llm-checker list-models --category general')} ${chalk.gray('(General purpose tasks)')}`);
    console.log(chalk.yellow('│'));
    console.log(chalk.yellow('│') + ` ${chalk.bold.white('AI-powered selection:')}`);
    console.log(chalk.yellow('│') + `   ${chalk.cyan('llm-checker ai-check --category coding --top 12')} ${chalk.gray('(AI meta-evaluation)')}`);
    console.log(chalk.yellow('│') + `   ${chalk.cyan('llm-checker ai-run')} ${chalk.gray('(Smart model selection & launch)')}`);
    console.log(chalk.yellow('│'));
    console.log(chalk.yellow('│') + ` ${chalk.bold.white('Additional options:')}`);
    console.log(chalk.yellow('│') + `   ${chalk.gray('llm-checker list-models --popular --limit 10')}`);
    console.log(chalk.yellow('│') + `   ${chalk.gray('llm-checker list-models --json > models.json')}`);
    console.log(chalk.yellow('╰'));
}

async function checkIfModelInstalled(model, ollamaInfo) {
    try {
        // Si Ollama no está disponible, no hay modelos instalados
        if (!ollamaInfo || !ollamaInfo.available) {
            return false;
        }

        // Ejecutar 'ollama list' para obtener modelos instalados
        const installedModels = await new Promise((resolve, reject) => {
            try {
                const ollama = spawn('ollama', ['list'], { stdio: 'pipe' });
                let output = '';
                
                ollama.stdout.on('data', (data) => {
                    output += data.toString();
                });
                
                ollama.on('close', (code) => {
                    if (code === 0) {
                        resolve(output);
                    } else {
                        resolve(''); // Si falla, asumimos que no hay modelos
                    }
                });
                
                ollama.on('error', (err) => {
                    // Handle ENOENT and other spawn errors gracefully
                    if (err.code === 'ENOENT') {
                        resolve(''); // Ollama not found, no models installed
                    } else {
                        resolve(''); // Any other error, assume no models
                    }
                });
            } catch (spawnError) {
                // Handle synchronous spawn errors
                resolve(''); // If spawn itself fails, no models available
            }
        });

        // Parsear la salida de 'ollama list'
        const lines = installedModels.split('\n');
        const modelNames = [];
        
        for (let i = 1; i < lines.length; i++) { // Skip header
            const line = lines[i].trim();
            if (line) {
                const parts = line.split(/\s+/);
                if (parts.length > 0) {
                    modelNames.push(parts[0].toLowerCase());
                }
            }
        }

        // Generar el comando de instalación esperado para el modelo
        const expectedCommand = getOllamaInstallCommand(model);
        if (!expectedCommand) return false;
        
        // Extraer el nombre del modelo del comando (ej: "ollama pull mistral:7b" -> "mistral:7b")
        const modelNameMatch = expectedCommand.match(/ollama pull (.+)/);
        if (!modelNameMatch) return false;
        
        const expectedModelName = modelNameMatch[1].toLowerCase();
        
        // Verificar si el modelo está en la lista de instalados
        return modelNames.some(installedName => 
            installedName === expectedModelName || 
            installedName.startsWith(expectedModelName.split(':')[0])
        );
        
    } catch (error) {
        // Si hay algún error, asumimos que no está instalado
        return false;
    }
}

function displaySimplifiedSystemInfo(hardware) {
    console.log(chalk.cyan.bold('\nSYSTEM SUMMARY'));
    console.log(chalk.gray('─'.repeat(50)));
    
    const cpuInfo = `${hardware.cpu.brand} (${hardware.cpu.cores} cores)`;
    const memInfo = `${hardware.memory.total}GB RAM`;
    const gpuInfo = hardware.gpu.model || 'Integrated GPU';
    
    console.log(`CPU: ${chalk.white(cpuInfo)}`);
    console.log(`Memory: ${chalk.white(memInfo)}`);
    console.log(`GPU: ${chalk.white(gpuInfo)}`);
    console.log(`Architecture: ${chalk.white(hardware.cpu.architecture)}`);
    
    const tier = getHardwareTierForDisplay(hardware);
    const tierColor = tier.includes('HIGH') ? chalk.green : tier.includes('MEDIUM') ? chalk.yellow : chalk.red;
    console.log(`Hardware Tier: ${tierColor.bold(tier)}`);
}

async function displayModelRecommendations(analysis, hardware, useCase = 'general', limit = 1) {
    const title = limit === 1 ? 'RECOMMENDED MODEL' : `TOP ${limit} COMPATIBLE MODELS`;
    console.log(chalk.green.bold(`\n${title}`));
    console.log(chalk.gray('─'.repeat(50)));
    
    // Find the best models from compatible models considering use case
    let selectedModels = [];
    let reason = '';
    
    if (analysis.compatible && analysis.compatible.length > 0) {
        // First, try to find models that match the use case
        let candidateModels = analysis.compatible;
        
        // Apply intelligent filtering based on use case
        if (useCase && useCase !== 'general') {
            // Specific use case filtering
            const useCaseModels = candidateModels.filter(model => {
                const specialization = model.specialization?.toLowerCase();
                const category = model.category?.toLowerCase();
                
                const lowerUseCase = useCase.toLowerCase();
                switch (lowerUseCase) {
                    case 'coding':
                    case 'code':
                        return model.primary_category === 'coding' ||
                               model.categories?.includes('coding') ||
                               specialization === 'code' || category === 'coding' || 
                               model.name.toLowerCase().includes('code') ||
                               model.name.toLowerCase().includes('coder');
                    
                    case 'creative':
                    case 'writing':
                        return model.primary_category === 'creative' ||
                               model.categories?.includes('creative') ||
                               category === 'creative' || specialization === 'creative' ||
                               model.name.toLowerCase().includes('dolphin') ||
                               model.name.toLowerCase().includes('wizard') ||
                               model.name.toLowerCase().includes('uncensored');
                    
                    case 'chat':
                    case 'conversation':
                    case 'talking':
                        // Prefer chat models, exclude coding models
                        if (model.primary_category === 'coding' || 
                            specialization === 'code' || 
                            model.name.toLowerCase().includes('code') ||
                            model.name.toLowerCase().includes('coder')) {
                            return false;
                        }
                        return model.primary_category === 'chat' ||
                               model.categories?.includes('chat') ||
                               category === 'talking' || specialization === 'chat' ||
                               model.name.toLowerCase().includes('llama') ||
                               model.name.toLowerCase().includes('mistral') ||
                               model.name.toLowerCase().includes('qwen') ||
                               (!model.name.toLowerCase().includes('llava') &&
                                (specialization === 'general' || category === 'medium'));
                    
                    case 'multimodal':
                    case 'vision':
                        return model.primary_category === 'multimodal' ||
                               model.categories?.includes('multimodal') ||
                               category === 'multimodal' || 
                               model.name.toLowerCase().includes('llava') ||
                               model.name.toLowerCase().includes('vision');
                    
                    case 'embeddings':
                    case 'embedings': // typo tolerance
                    case 'embedding':
                    case 'embeding': // typo tolerance
                        return model.primary_category === 'embeddings' ||
                               model.categories?.includes('embeddings') ||
                               category === 'embeddings' ||
                               model.name.toLowerCase().includes('embed') ||
                               model.name.toLowerCase().includes('bge');
                    
                    case 'reasoning':
                    case 'reason':
                        return model.primary_category === 'reasoning' ||
                               model.categories?.includes('reasoning') ||
                               category === 'reasoning' ||
                               model.name.toLowerCase().includes('deepseek-r1') ||
                               model.name.toLowerCase().includes('reasoning');
                    
                    default:
                        // Check for partial matches with typo tolerance
                        if (lowerUseCase.includes('embed')) {
                            return model.primary_category === 'embeddings' ||
                                   model.categories?.includes('embeddings') ||
                                   category === 'embeddings' ||
                                   model.name.toLowerCase().includes('embed');
                        }
                        if (lowerUseCase.includes('code')) {
                            return model.primary_category === 'coding' ||
                                   model.categories?.includes('coding');
                        }
                        if (lowerUseCase.includes('creat')) {
                            return model.primary_category === 'creative' ||
                                   model.categories?.includes('creative');
                        }
                        return true;
                }
            });
            
            // If we found use case specific models, use those, otherwise search Ollama database
            if (useCaseModels.length > 0) {
                candidateModels = useCaseModels;
                reason = `Best ${useCase} model for your hardware`;
            } else {
                // Search directly in Ollama database for use case specific models
                const ollamaModels = searchOllamaModelsForUseCase(useCase, hardware);
                if (ollamaModels.length > 0) {
                    candidateModels = ollamaModels;
                    reason = `Best ${useCase} model from Ollama database`;
                }
            }
        } else {
            // No specific use case - apply intelligent general filtering
            // First, infer categories for static models that don't have them
            const modelsWithCategories = candidateModels.map(model => {
                if (!model.primary_category) {
                    const modelName = model.name.toLowerCase();
                    let inferredCategory = 'general';
                    
                    if (modelName.includes('code') || modelName.includes('coder')) {
                        inferredCategory = 'coding';
                    } else if (modelName.includes('llava') || modelName.includes('vision')) {
                        inferredCategory = 'multimodal';
                    } else if (modelName.includes('embed')) {
                        inferredCategory = 'embeddings';
                    } else if (modelName.includes('llama') || modelName.includes('mistral') || 
                               modelName.includes('qwen') || modelName.includes('gemma')) {
                        inferredCategory = 'chat';
                    } else if (modelName.includes('phi') && modelName.includes('mini')) {
                        inferredCategory = 'reasoning';
                    }
                    
                    return { ...model, primary_category: inferredCategory };
                }
                return model;
            });
            
            // Prefer versatile models, exclude highly specialized ones
            const generalModels = modelsWithCategories.filter(model => {
                // Exclude very specialized models
                if (model.primary_category === 'embeddings' || 
                    model.primary_category === 'safety' ||
                    model.primary_category === 'multimodal') {
                    return false;
                }
                
                // Include chat, coding, reasoning, creative, and general models
                return model.primary_category === 'chat' || 
                       model.primary_category === 'coding' || 
                       model.primary_category === 'reasoning' ||
                       model.primary_category === 'creative' ||
                       model.primary_category === 'general' ||
                       model.specialization === 'general' ||
                       model.category === 'medium' ||
                       model.category === 'small';
            });
            
            if (generalModels.length > 0) {
                // Re-score general models with category bonus
                const scoredModels = generalModels.map(model => {
                    let adjustedScore = model.score || 0;
                    
                    // Apply category bonuses for general use
                    if (model.primary_category === 'chat') {
                        adjustedScore += 5; // Chat models are great for general use
                    } else if (model.primary_category === 'coding') {
                        adjustedScore += 3; // Coding models are versatile
                    } else if (model.primary_category === 'reasoning') {
                        adjustedScore += 4; // Reasoning models are smart
                    } else if (model.primary_category === 'creative') {
                        adjustedScore += 2; // Creative models are fun
                    }
                    
                    return { ...model, adjustedScore };
                });
                
                candidateModels = scoredModels.sort((a, b) => b.adjustedScore - a.adjustedScore);
                reason = 'Best general-purpose model for your hardware';
            }
        }
        
        // Filter out unreasonably large models before final selection
        const reasonableSizedModels = candidateModels.filter(model => {
            const realSize = getRealSizeFromOllamaCache(model);
            const sizeGB = parseFloat(realSize?.replace(/GB|gb/gi, '') || '0');
            
            // For hardware with 24GB RAM, models >25GB are not practical
            const maxReasonableSize = hardware.memory.total > 32 ? 50 : 25;
            return sizeGB === 0 || sizeGB <= maxReasonableSize; // 0 means unknown/fallback
        });
        
        // Sort by score and get the top models (use adjustedScore if available)
        const sortedModels = reasonableSizedModels.sort((a, b) => 
            (b.adjustedScore || b.score || 0) - (a.adjustedScore || a.score || 0)
        );
        selectedModels = sortedModels.slice(0, limit);
        
        if (!reason) {
            reason = 'Highest compatibility score for your hardware';
        }
    } else if (analysis.marginal && analysis.marginal.length > 0) {
        const sortedMarginal = analysis.marginal.sort((a, b) => (b.score || 0) - (a.score || 0));
        selectedModels = sortedMarginal.slice(0, limit);
        reason = 'Best available option (marginal performance)';
    }
    
    if (selectedModels && selectedModels.length > 0) {
        for (let index = 0; index < selectedModels.length; index++) {
            const model = selectedModels[index];
            
            if (limit > 1) {
                const rank = index + 1;
                const rankColor = rank === 1 ? chalk.yellow : chalk.gray;
                console.log(`\n${rankColor.bold(`#${rank} - ${model.name}`)}`);
            } else {
                console.log(`Model: ${chalk.cyan.bold(model.name)}`);
            }
            
            // Get real size from Ollama cache or estimate
            const realSize = getRealSizeFromOllamaCache(model) || estimateModelSize(model);
            console.log(`Size: ${chalk.white(realSize)}`);
            console.log(`Compatibility Score: ${chalk.green.bold(model.adjustedScore || model.score || 'N/A')}/100`);
            
            if (index === 0) {
                console.log(`Reason: ${chalk.gray(reason)}`);
            }
            
            // Show performance if available
            if (model.performanceEstimate) {
                console.log(`Estimated Speed: ${chalk.yellow(model.performanceEstimate.estimatedTokensPerSecond || 'N/A')} tokens/sec`);
            }
            
            // Check if it's already installed by comparing with Ollama integration
            try {
                const isInstalled = await checkIfModelInstalled(model, analysis.ollamaInfo);
                if (isInstalled) {
                    console.log(`Status: ${chalk.green('Already installed in Ollama')}`);
                } else if (analysis.ollamaInfo && analysis.ollamaInfo.available) {
                    console.log(`Status: ${chalk.gray('Available via Ollama')}`);
                } else {
                    console.log(`Status: ${chalk.yellow('Requires Ollama (not detected)')}`);
                }
            } catch (installCheckError) {
                // If checking installation status fails, show based on Ollama availability
                if (analysis.ollamaInfo && analysis.ollamaInfo.available) {
                    console.log(`Status: ${chalk.gray('Available via Ollama')}`);
                } else {
                    console.log(`Status: ${chalk.yellow('Requires Ollama (not detected)')}`);
                }
            }
        }
    } else {
        console.log(chalk.yellow('No compatible models found for your hardware'));
        console.log(chalk.gray('Try running with --include-cloud to see more options'));
    }
    
    return selectedModels;
}

async function displayQuickStartCommands(analysis, recommendedModel = null, allRecommended = null) {
    console.log(chalk.yellow.bold('\nQUICK START'));
    console.log(chalk.gray('─'.repeat(50)));
    
    // Use the first model from allRecommended if available, otherwise fallback to recommendedModel
    let bestModel = (allRecommended && allRecommended.length > 0) ? allRecommended[0] : recommendedModel;
    
    if (!bestModel) {
        if (analysis.compatible && analysis.compatible.length > 0) {
            const sortedModels = analysis.compatible.sort((a, b) => (b.score || 0) - (a.score || 0));
            bestModel = sortedModels[0];
        } else if (analysis.marginal && analysis.marginal.length > 0) {
            const sortedMarginal = analysis.marginal.sort((a, b) => (b.score || 0) - (a.score || 0));
            bestModel = sortedMarginal[0];
        }
    }
    
    if (analysis.ollamaInfo && !analysis.ollamaInfo.available) {
        console.log(`1. Install Ollama: ${chalk.underline('https://ollama.ai')}`);
        console.log(`2. Come back and run this command again`);
    } else if (bestModel) {
        let isInstalled = false;
        try {
            isInstalled = await checkIfModelInstalled(bestModel, analysis.ollamaInfo);
        } catch (installCheckError) {
            // If checking installation status fails, assume not installed
            isInstalled = false;
        }
        
        if (isInstalled) {
            const ollamaCommand = getOllamaInstallCommand(bestModel);
            const modelName = ollamaCommand ? extractModelName(ollamaCommand) : bestModel.name.toLowerCase();
            console.log(`1. Start using your installed model:`);
            console.log(`   ${chalk.cyan.bold(`ollama run ${modelName}`)}`);
        } else {
            // Try to find Ollama command
            const ollamaCommand = getOllamaInstallCommand(bestModel);
            if (ollamaCommand) {
                console.log(`1. Install the recommended model:`);
                console.log(`   ${chalk.cyan.bold(ollamaCommand)}`);
                console.log(`2. Start using it:`);
                console.log(`   ${chalk.cyan.bold(`ollama run ${extractModelName(ollamaCommand)}`)}`);
            } else {
                console.log(`1. Search for ${bestModel.name} on Ollama Hub`);
                console.log(`2. Install and run the model`);
            }
        }
        
        // If multiple models were shown, suggest trying alternatives (only reasonable ones)
        if (allRecommended && allRecommended.length > 1) {
            console.log(`\n${chalk.gray('Alternative options:')}`);
            
            // Filter out unreasonable alternatives (>50GB, no ollama command)
            const reasonableAlternatives = allRecommended.slice(1).filter(model => {
                const realSize = getRealSizeFromOllamaCache(model);
                const sizeGB = parseFloat(realSize?.replace(/GB|gb/gi, '') || '0');
                const ollamaCommand = getOllamaInstallCommand(model);
                
                // Only show if size is reasonable (<50GB) and has ollama command
                return sizeGB < 50 && ollamaCommand;
            });
            
            // Show max 2 alternatives, avoid duplicating commands
            const seenCommands = new Set();
            const bestModelCommand = getOllamaInstallCommand(bestModel);
            if (bestModelCommand) seenCommands.add(bestModelCommand);
            
            let alternativeCount = 0;
            reasonableAlternatives.forEach((model) => {
                if (alternativeCount >= 2) return; // Max 2 alternatives
                
                const ollamaCommand = getOllamaInstallCommand(model);
                if (ollamaCommand && !seenCommands.has(ollamaCommand)) {
                    console.log(`   ${chalk.gray(`${alternativeCount + 2}. ${ollamaCommand}`)}`);
                    seenCommands.add(ollamaCommand);
                    alternativeCount++;
                }
            });
            
            // If no reasonable alternatives, don't show the section
            if (reasonableAlternatives.length === 0) {
                console.log(`   ${chalk.gray('No other reasonable alternatives found for your hardware')}`);
            }
        }
    } else {
        console.log(`1. Try expanding search: ${chalk.cyan('llm-checker check --include-cloud')}`);
        console.log(`2. Or see all available models: ${chalk.cyan('llm-checker list-models')}`);
    }
}

function getOllamaInstallCommand(model) {
    // Special handling for specific models that need corrected commands
    const modelName = model.name.toLowerCase();
    
    if (modelName.includes('codellama') && modelName.includes('7b')) {
        return 'ollama pull codellama:7b';
    }
    if (modelName.includes('mistral') && modelName.includes('7b')) {
        return 'ollama pull mistral:7b';
    }
    if (modelName.includes('llama 3.1') && modelName.includes('8b')) {
        return 'ollama pull llama3.1:8b';
    }
    if (modelName.includes('llama3.1') && !modelName.includes('8b')) {
        return 'ollama pull llama3.1:8b'; // Default to 8b variant
    }
    if (modelName.includes('llama3.2-vision')) {
        return 'ollama pull llama3.2-vision:latest';
    }
    if (modelName.includes('llama3.2')) {
        return 'ollama pull llama3.2:3b'; // Most common variant
    }
    if (modelName.includes('llama3.3')) {
        return 'ollama pull llama3.3:70b'; // This is the actual size
    }
    if (modelName.includes('qwen') && modelName.includes('7b')) {
        return 'ollama pull qwen2.5:7b';
    }
    if (modelName.includes('phi4-reasoning')) {
        return 'ollama pull phi4-reasoning:latest';
    }
    if (modelName.includes('deepseek-r1')) {
        return 'ollama pull deepseek-r1:8b';
    }
    if (modelName.includes('dolphin3')) {
        return 'ollama pull dolphin3:latest';
    }
    if (modelName === 'phi' || modelName.includes('phi ')) {
        return 'ollama pull phi:latest';
    }
    
    // First priority: use ollamaTag if available (from Ollama database)
    if (model.ollamaTag) {
        return `ollama pull ${model.ollamaTag}`;
    }
    
    // Second priority: use installation.ollama if available
    if (model.installation && model.installation.ollama) {
        return model.installation.ollama;
    }
    
    // Third priority: try to generate from model name
    
    const mapping = {
        'tinyllama 1.1b': 'ollama pull tinyllama:1.1b',
        'phi-3 mini 3.8b': 'ollama pull phi3:mini',
        'llama 3.2 3b': 'ollama pull llama3.2:3b',
        'llama 3.1 8b': 'ollama pull llama3.1:8b',
        'mistral 7b': 'ollama pull mistral:7b',
        'mistral 7b v0.3': 'ollama pull mistral:7b',
        'qwen 2.5 7b': 'ollama pull qwen2.5:7b',
        'codellama 7b': 'ollama pull codellama:7b',
        'codellama': 'ollama pull codellama:7b'
    };
    
    for (const [key, command] of Object.entries(mapping)) {
        if (modelName.includes(key) || key.includes(modelName)) {
            return command;
        }
    }
    
    // Last resort: use ollamaId if available
    if (model.ollamaId) {
        return `ollama pull ${model.ollamaId}`;
    }
    
    return null;
}

function extractModelName(command) {
    const match = command.match(/ollama pull (.+)/);
    return match ? match[1] : 'model';
}

program
    .command('check')
    .description('Analyze your system and show compatible LLM models')
    .option('-d, --detailed', 'Show detailed hardware information')
    .option('-f, --filter <type>', 'Filter by model type')
    .option('-u, --use-case <case>', 'Specify use case', 'general')
    .option('-l, --limit <number>', 'Number of compatible models to show (default: 1)', '1')
    .option('--include-cloud', 'Include cloud models in analysis')
    .option('--ollama-only', 'Only show models available in Ollama')
    .option('--performance-test', 'Run performance benchmarks')
    .option('--show-ollama-analysis', 'Show detailed Ollama model analysis')
    .option('--no-verbose', 'Disable step-by-step progress display')
    .action(async (options) => {
        try {
            // Use verbose progress unless explicitly disabled
            const verboseEnabled = options.verbose !== false;
            const checker = new LLMChecker({ verbose: verboseEnabled });
            
            // If verbose is disabled, show simple loading message
            if (!verboseEnabled) {
                process.stdout.write(chalk.gray('Analyzing your system...'));
            }

            const hardware = await checker.getSystemInfo();
            const analysis = await checker.analyze({
                filter: options.filter,
                useCase: options.useCase,
                includeCloud: options.includeCloud,
                performanceTest: options.performanceTest,
                limit: parseInt(options.limit) || 10
            });

            if (!verboseEnabled) {
                console.log(chalk.green(' done'));
            }

            // Simplified output - show only essential information
            displaySimplifiedSystemInfo(hardware);
            const recommendedModels = await displayModelRecommendations(analysis, hardware, options.useCase, parseInt(options.limit) || 1);
            await displayQuickStartCommands(analysis, recommendedModels[0], recommendedModels);

        } catch (error) {
            console.error(chalk.red('\nError:'), error.message);
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
                console.log('\nTo install Ollama:');
                console.log('Visit: https://ollama.ai');
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
    .command('recommend')
    .description('Get intelligent model recommendations for your hardware')
    .option('-c, --category <category>', 'Get recommendations for specific category (coding, talking, reading, etc.)')
    .option('--no-verbose', 'Disable step-by-step progress display')
    .action(async (options) => {
        try {
            const verboseEnabled = options.verbose !== false;
            const checker = new LLMChecker({ verbose: verboseEnabled });
            
            if (!verboseEnabled) {
                process.stdout.write(chalk.gray('Generating recommendations...'));
            }

            const hardware = await checker.getSystemInfo();
            const intelligentRecommendations = await checker.generateIntelligentRecommendations(hardware);

            if (!intelligentRecommendations) {
                console.error(chalk.red('\nFailed to generate recommendations'));
                return;
            }

            if (!verboseEnabled) {
                console.log(chalk.green(' done'));
            }

            // Mostrar información del sistema
            displaySystemInfo(hardware, { summary: { hardwareTier: intelligentRecommendations.summary.hardware_tier } });
            
            // Mostrar recomendaciones
            displayIntelligentRecommendations(intelligentRecommendations);

        } catch (error) {
            console.error(chalk.red('\nError:'), error.message);
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
                const categoryFilter = options.category.toLowerCase();
                models = models.filter(model => {
                    // Buscar en categoría principal
                    if (model.category === categoryFilter) return true;
                    
                    // Buscar en use_cases
                    if (model.use_cases && model.use_cases.includes(categoryFilter)) return true;
                    
                    // Buscar por palabras clave en el nombre/identificador
                    const modelText = `${model.model_name} ${model.model_identifier}`.toLowerCase();
                    
                    switch(categoryFilter) {
                        case 'coding':
                        case 'code':
                            return modelText.includes('code') || modelText.includes('coder') || 
                                   modelText.includes('programming') || modelText.includes('deepseek') ||
                                   modelText.includes('starcoder');
                        case 'talking':
                        case 'chat':
                            return modelText.includes('chat') || modelText.includes('llama') ||
                                   modelText.includes('mistral') || modelText.includes('gemma') ||
                                   modelText.includes('phi');
                        case 'reasoning':
                            return modelText.includes('reasoning') || modelText.includes('deepseek-r1') ||
                                   modelText.includes('qwq') || modelText.includes('r1');
                        case 'multimodal':
                        case 'vision':
                            return modelText.includes('vision') || modelText.includes('llava') ||
                                   modelText.includes('minicpm-v');
                        case 'creative':
                        case 'writing':
                            return modelText.includes('wizard') || modelText.includes('creative') ||
                                   modelText.includes('uncensored');
                        case 'embeddings':
                        case 'embed':
                            return modelText.includes('embed') || modelText.includes('bge') ||
                                   modelText.includes('nomic');
                        default:
                            return false;
                    }
                });
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

            // Si hay filtro de categoría, ordenar por compatibilidad con hardware
            if (options.category) {
                try {
                    const LLMChecker = require('../src/index.js');
                    const hardwareDetector = new (require('../src/hardware/detector.js'))();
                    const hardware = await hardwareDetector.getSystemInfo();
                    
                    // Calcular puntuación de compatibilidad para cada modelo
                    models = models.map(model => {
                        const compatibilityScore = calculateModelCompatibilityScore(model, hardware);
                        return { ...model, compatibilityScore };
                    });
                    
                    // Ordenar por compatibilidad primero, luego por popularidad
                    models.sort((a, b) => {
                        if (b.compatibilityScore !== a.compatibilityScore) {
                            return b.compatibilityScore - a.compatibilityScore;
                        }
                        return (b.pulls || 0) - (a.pulls || 0);
                    });
                    
                    spinner.text = `🧠 Sorted by hardware compatibility (${getHardwareTierForDisplay(hardware)})`;
                } catch (error) {
                    console.warn('Could not sort by hardware compatibility:', error.message);
                    // Fallback a ordenar por popularidad
                    models.sort((a, b) => (b.pulls || 0) - (a.pulls || 0));
                }
            } else {
                // Sin filtro de categoría, ordenar solo por popularidad
                models.sort((a, b) => (b.pulls || 0) - (a.pulls || 0));
            }

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
                await displayCompactModelsList(displayModels, options.category);
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
    .command('ai-check')
    .description('AI-powered model evaluation with meta-analysis')
    .option('-c, --category <category>', 'Category: coding, reasoning, multimodal, general', 'general')
    .option('-t, --top <number>', 'Number of top models to show', '12')
    .option('--ctx <number>', 'Target context length', '8192')
    .option('-e, --evaluator <model>', 'Evaluator model (auto for best available)', 'auto')
    .option('-w, --weight <number>', 'AI weight (0.0-1.0, default 0.3)', '0.3')
    .action(async (options) => {
        // Check if Ollama is installed first
        await checkOllamaAndExit();
        
        const AICheckSelector = require('../src/models/ai-check-selector');
        
        try {
            const spinner = ora('🧠 AI-Check Mode: Meta-evaluation in progress...').start();
            
            const aiCheckSelector = new AICheckSelector();
            
            const checkOptions = {
                category: options.category,
                top: parseInt(options.top),
                ctx: options.ctx ? parseInt(options.ctx) : undefined,
                evaluator: options.evaluator,
                weight: parseFloat(options.weight)
            };
            
            spinner.stop();
            
            const result = await aiCheckSelector.aiCheck(checkOptions);
            
            // Format and display results
            aiCheckSelector.formatResults(result);
            
        } catch (error) {
            console.error(chalk.red('❌ AI-Check failed:'), error.message);
            if (process.argv.includes('--verbose')) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });

program
    .command('ai-run')
    .description('AI-powered model selection and execution')
    .option('-m, --models <models...>', 'Specific models to choose from')
    .option('--prompt <prompt>', 'Prompt to run with selected model')
    .action(async (options) => {
        // Check if Ollama is installed first
        await checkOllamaAndExit();
        
        const AIModelSelector = require('../src/ai/model-selector');
        
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
                gpu_vram_gb: systemInfo.gpu?.vram || 0,
                gpu_model_normalized: systemInfo.gpu?.model || 
                    (systemInfo.cpu?.manufacturer === 'Apple' ? 'apple_silicon' : 'cpu_only')
            };
            
            const result = await aiSelector.selectBestModel(candidateModels, systemSpecs);
            
            spinner.succeed(`Selected ${chalk.green.bold(result.bestModel)} (${result.method}, ${Math.round(result.confidence * 100)}% confidence)`);
            
            // Execute the selected model
            console.log(chalk.magenta.bold(`\nLaunching ${result.bestModel}...`));
            console.log(chalk.gray(`Tip: Type ${chalk.cyan('/bye')} to exit the chat when finished\n`));
            
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

// Comando especial para demostrar el nuevo estilo de verbosity
program
    .command('demo')
    .description('Demo of the enhanced verbose progress with progress bars')
    .action(async () => {
        console.log(chalk.cyan.bold('\nLLM Checker - Enhanced Progress Demo'));
        console.log(chalk.gray('This demonstrates the new step-by-step progress display with visual indicators'));
        console.log(chalk.gray('─'.repeat(60)));
        
        // Simular el proceso de análisis con verbosity
        const VerboseProgress = require('../src/utils/verbose-progress');
        const progress = VerboseProgress.create(true);
        
        progress.startOperation('LLM Model Analysis & Compatibility Demo', 5);
        
        // Simular paso 1
        progress.step('System Detection', 'Scanning hardware specifications...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        progress.substep('CPU detected: Apple M4 Pro (12 cores)');
        await new Promise(resolve => setTimeout(resolve, 500));
        progress.substep('Memory detected: 24GB unified memory', true);
        progress.stepComplete('Apple M4 Pro, 24GB RAM, Apple Silicon GPU');
        
        // Simular paso 2
        progress.step('Database Sync', 'Updating model database...');
        await new Promise(resolve => setTimeout(resolve, 800));
        progress.found('3,247 models in database');
        progress.stepComplete('Database synchronized');
        
        // Simular paso 3
        progress.step('Compatibility Analysis', 'Running mathematical heuristics...');
        await new Promise(resolve => setTimeout(resolve, 1200));
        progress.substep('Analyzing hardware requirements...');
        await new Promise(resolve => setTimeout(resolve, 600));
        progress.substep('Calculating performance scores...', true);
        progress.found('127 compatible models found');
        progress.stepComplete('Compatibility analysis complete');
        
        // Simular paso 4
        progress.step('AI Evaluation', 'Running intelligent model selection...');
        await new Promise(resolve => setTimeout(resolve, 900));
        progress.substep('Mathematical heuristics applied');
        progress.found('Top 15 models selected by AI');
        progress.stepComplete('AI evaluation complete');
        
        // Simular paso 5
        progress.step('Smart Recommendations', 'Generating personalized suggestions...');
        await new Promise(resolve => setTimeout(resolve, 600));
        progress.substep('Analyzing use case: general');
        await new Promise(resolve => setTimeout(resolve, 400));
        progress.substep('Generating Ollama commands...', true);
        progress.stepComplete('23 recommendations generated');
        
        // Completar
        progress.complete('Analysis complete! Found optimal models for your hardware');
        
        console.log(chalk.green.bold('Demo completed successfully!'));
        console.log(chalk.gray('\\nNow try running: ') + chalk.cyan.bold('llm-checker check'));
        console.log(chalk.gray('For silent mode: ') + chalk.cyan.bold('llm-checker check --no-verbose'));
    });

program.parse();