#!/usr/bin/env node

const AIModelSelector = require('./index');
const { spawn } = require('child_process');

class OllamaAISelector {
    constructor() {
        this.selector = new AIModelSelector();
    }

    async getAvailableModels() {
        return new Promise((resolve, reject) => {
            const ollama = spawn('ollama', ['list']);
            let output = '';
            let error = '';

            ollama.stdout.on('data', (data) => {
                output += data.toString();
            });

            ollama.stderr.on('data', (data) => {
                error += data.toString();
            });

            ollama.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Ollama list failed: ${error}`));
                    return;
                }

                // Parse ollama list output
                const lines = output.trim().split('\n').slice(1); // Skip header
                const models = lines
                    .filter(line => line.trim())
                    .map(line => line.split(/\s+/)[0])
                    .filter(model => model && !model.includes('NAME'));

                resolve(models);
            });
        });
    }

    async runOllamaModel(modelName, prompt) {
        console.log(`🚀 Running Ollama with ${modelName}...`);
        
        return new Promise((resolve, reject) => {
            const args = ['run', modelName];
            if (prompt) {
                args.push(prompt);
            }

            const ollama = spawn('ollama', args, { 
                stdio: 'inherit' // Stream output directly to terminal
            });

            ollama.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Ollama exited with code ${code}`));
                }
            });

            ollama.on('error', (error) => {
                reject(new Error(`Failed to start Ollama: ${error.message}`));
            });
        });
    }

    async selectAndRun(candidateModels = null, prompt = null) {
        try {
            console.log('🧠 AI-Powered Ollama Model Selector');
            console.log('=' * 40);

            // Get available models if not provided
            if (!candidateModels) {
                console.log('📋 Getting available models...');
                candidateModels = await this.getAvailableModels();
                
                if (candidateModels.length === 0) {
                    console.log('❌ No Ollama models found. Install some models first:');
                    console.log('  ollama pull llama2:7b');
                    console.log('  ollama pull mistral:7b');
                    console.log('  ollama pull phi3:mini');
                    return;
                }
                
                console.log(`✅ Found ${candidateModels.length} models: ${candidateModels.join(', ')}`);
            }

            // Use AI to select best model
            let result;
            try {
                console.log('🔍 Analyzing your hardware...');
                result = await this.selector.predictBestModel(candidateModels);
                console.log('✅ AI selection completed');
            } catch (error) {
                console.log(`⚠️  AI selection failed: ${error.message}`);
                console.log('🔄 Falling back to heuristic selection...');
                
                const specs = await this.selector.getSystemSpecs();
                result = this.selector.selectModelHeuristic(candidateModels, specs);
            }

            // Display results
            console.log('\n📊 Selection Results:');
            console.log(`🏆 Best Model: ${result.bestModel}`);
            
            if (result.systemSpecs) {
                const specs = result.systemSpecs;
                console.log(`💻 System: ${specs.cpu_cores} cores, ${specs.total_ram_gb.toFixed(1)}GB RAM`);
                console.log(`🎮 GPU: ${specs.gpu_model_normalized} (${specs.gpu_vram_gb.toFixed(1)}GB VRAM)`);
            }

            if (result.allPredictions) {
                console.log('\n📈 All Model Scores:');
                result.allPredictions.slice(0, 5).forEach((pred, i) => {
                    const score = (pred.score * 100).toFixed(1);
                    const icon = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
                    console.log(`${icon} ${pred.model}: ${score}% (${pred.size}B params)`);
                });
            }

            // Run the selected model
            console.log(`\n🚀 Launching ${result.bestModel}...`);
            await this.runOllamaModel(result.bestModel, prompt);

        } catch (error) {
            console.error('❌ Error:', error.message);
            process.exit(1);
        }
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h')) {
        console.log('AI-Powered Ollama Model Selector');
        console.log('');
        console.log('Automatically selects the best Ollama model for your hardware using AI.');
        console.log('');
        console.log('Usage:');
        console.log('  ollama-select                    # Select from all available models');
        console.log('  ollama-select model1 model2      # Select from specific models');
        console.log('  ollama-select --test             # Test the selector');
        console.log('');
        console.log('Examples:');
        console.log('  ollama-select llama2:7b mistral:7b phi3:mini');
        console.log('  ollama-select');
        console.log('');
        return;
    }

    if (args.includes('--test')) {
        console.log('🧪 Testing AI Model Selector...');
        
        const selector = new AIModelSelector();
        try {
            await selector.initialize();
            
            const testModels = ['llama2:7b', 'mistral:7b', 'phi3:mini'];
            const result = await selector.predictBestModel(testModels);
            
            console.log('✅ Test successful!');
            console.log(`Best model: ${result.bestModel}`);
            console.log('Scores:', result.allPredictions.map(p => `${p.model}: ${(p.score * 100).toFixed(1)}%`));
            
        } catch (error) {
            console.log('❌ Test failed:', error.message);
            
            // Test fallback
            console.log('🔄 Testing fallback heuristic...');
            const result = selector.selectModelHeuristic(testModels);
            console.log(`Fallback result: ${result.bestModel} (${result.reason})`);
        }
        
        return;
    }

    // Extract model candidates and prompt
    const candidateModels = args.filter(arg => !arg.startsWith('--'));
    const prompt = null; // Could be extended to accept prompts

    const cli = new OllamaAISelector();
    await cli.selectAndRun(candidateModels.length > 0 ? candidateModels : null, prompt);
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = OllamaAISelector;