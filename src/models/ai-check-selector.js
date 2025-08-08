/**
 * AI-Check Mode - Meta-evaluation using installed models
 * 
 * Uses the best installed instruction model as an evaluator to rerank
 * and refine deterministic selections.
 */

const DeterministicModelSelector = require('./deterministic-selector');
const { OllamaNativeScraper } = require('../ollama/native-scraper');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

class AICheckSelector {
    constructor() {
        this.deterministicSelector = new DeterministicModelSelector();
        this.ollamaScraper = new OllamaNativeScraper();
        this.cachePath = path.join(require('os').homedir(), '.llm-checker', 'ai-check-cache.json');
        
        // Priority models for evaluation (prefer these if installed)
        this.preferredEvaluators = [
            'qwen2.5:7b-instruct',
            'mistral:7b-instruct', 
            'llama3.1:8b-instruct',
            'gemma2:9b-it',
            'qwen2.5-coder:7b', // Good fallback
            'llama3.2:3b'       // Smallest acceptable
        ];
        
        // System prompt for evaluator
        this.systemPrompt = `You are a precise model evaluator. 
Your task: Rank ALL provided models for the given category.
Important: Your ranking must include EVERY model in the list.
Never skip or omit any model from your ranking.
Respond with JSON only, no additional text.`;

        // JSON schema for evaluator response
        this.responseSchema = {
            type: "object",
            properties: {
                winner: { type: "string" },
                ranking: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            aiScore: { type: "number" },
                            shortWhy: { type: "string" }
                        },
                        required: ["name", "aiScore", "shortWhy"]
                    }
                }
            },
            required: ["winner", "ranking"]
        };
    }

    /**
     * Main AI-Check function
     */
    async aiCheck(options = {}) {
        const {
            category = 'general',
            top = 12,
            ctx,
            evaluator = 'auto',
            weight = 0.3,
            silent = false
        } = options;

        const chalk = require('chalk');

        // Phase 1: Get ALL available models from the 177-model Ollama database
        const hardware = await this.deterministicSelector.getHardware();
        
        // Use the same large database that check command uses (177 models)
        const ollamaData = await this.ollamaScraper.scrapeAllModels(false);
        const allOllamaModels = ollamaData.models || [];
        
        if (!silent) {
            console.log(chalk.cyan('│') + ` 📊 Found ${allOllamaModels.length} models in Ollama database`);
        }
        
        // Convert Ollama models to deterministic selector format and evaluate them
        const candidates = [];
        const budget = hardware.gpu.unified ? hardware.usableMemGB : 
                     (hardware.gpu.vramGB || hardware.usableMemGB);
        
        // Filter models by category first
        const categoryModels = this.filterOllamaModelsByCategory(allOllamaModels, category);
        
        if (!silent) {
            console.log(chalk.cyan('│') + ` 🎯 ${categoryModels.length} models match ${category} category`);
        }
        
        // Evaluate each model using deterministic scoring
        for (const ollamaModel of categoryModels) {
            const convertedModel = this.convertOllamaModelToDeterministicFormat(ollamaModel);
            const result = this.deterministicSelector.evaluateModel(
                convertedModel, 
                hardware, 
                category, 
                ctx || this.deterministicSelector.targetContexts[category], 
                budget
            );
            if (result) {
                candidates.push(result);
            }
        }
        
        // Sort by score and get top candidates
        candidates.sort((a, b) => b.score - a.score);
        const allModelsResult = {
            category,
            hardware,
            candidates: candidates,
            total_evaluated: categoryModels.length,
            timestamp: new Date().toISOString(),
            targetCtx: ctx || this.deterministicSelector.targetContexts[category]
        };
        
        // Then trim to top N for final result, but let AI see more options
        const detResults = {
            ...allModelsResult,
            candidates: allModelsResult.candidates.slice(0, top)
        };

        if (detResults.candidates.length === 0) {
            console.log(`🧠 AI-Check Mode: ${category.toUpperCase()}`);
            console.log(`❌ No suitable candidates found by deterministic selector.`);
            return {
                results: detResults,
                note: 'No suitable candidates found by deterministic selector.'
            };
        }

        // Show professional AI-check header in app style
        console.log('\n' + chalk.bgMagenta.white.bold(' 🧠 AI-CHECK MODE '));
        console.log(chalk.magenta('╭' + '─'.repeat(65)));
        console.log(chalk.magenta('│') + ` 🎯 Category: ${chalk.yellow(category.toUpperCase())}`);
        console.log(chalk.magenta('│') + ` ⚖️  AI Weight: ${chalk.cyan(Math.round(weight * 100) + '%')} + Deterministic: ${chalk.green(Math.round((1-weight) * 100) + '%')}`);
        console.log(chalk.magenta('│') + ` 📊 Candidates Found: ${chalk.green(detResults.candidates.length)}`);
        console.log(chalk.magenta('│') + ` 💻 Hardware: ${chalk.cyan(hardware.cpu.cores + ' cores')}, ${chalk.green(hardware.memory.totalGB + 'GB RAM')}, ${chalk.yellow(hardware.gpu.type)}`);
        console.log(chalk.magenta('╰'));
        
        // Phase 2: Pick evaluator model
        const evaluatorModel = evaluator === 'auto' ? 
            await this.pickEvaluatorModel(hardware) : 
            evaluator;

        if (!evaluatorModel) {
            console.log('\n' + chalk.red.bold(' ❌ NO EVALUATOR AVAILABLE '));
            console.log(chalk.red('╭' + '─'.repeat(50)));
            console.log(chalk.red('│') + ` ${chalk.white('No suitable evaluator model found locally')}`);
            console.log(chalk.red('│') + ` ${chalk.gray('Install a model for AI evaluation:')}`);
            console.log(chalk.red('│') + `   ${chalk.cyan('ollama pull qwen2.5:7b-instruct')}`);
            console.log(chalk.red('│') + `   ${chalk.cyan('ollama pull mistral:7b-instruct')}`);
            console.log(chalk.red('│') + ` ${chalk.yellow('Showing deterministic results only')}`);
            console.log(chalk.red('╰'));
            
            // When no evaluator is available, just return deterministic results with final scores
            const candidatesWithFinalScores = detResults.candidates.map(candidate => ({
                ...candidate,
                aiScore: null,
                finalScore: candidate.score,
                rationale: candidate.rationale + ` | AI: not evaluated`
            }));
            
            return {
                results: {
                    ...detResults,
                    candidates: candidatesWithFinalScores,
                    aiEvaluated: false
                },
                note: 'No local evaluator found; install qwen2.5:7b-instruct or similar for AI-check.',
                suggestedInstall: 'ollama pull qwen2.5:7b-instruct'
            };
        }

        // Show evaluator status in app style
        console.log('\n' + chalk.bgCyan.black.bold(' 🤖 AI EVALUATOR STATUS '));
        console.log(chalk.cyan('╭' + '─'.repeat(50)));
        console.log(chalk.cyan('│') + ` 📦 Model: ${chalk.green.bold(evaluatorModel)}`);
        
        // Phase 3: Build payload for evaluator (use broader set for AI evaluation)
        const aiEvaluationCandidates = {
            ...allModelsResult,
            candidates: allModelsResult.candidates.slice(0, Math.max(20, top * 3)) // AI evaluates more models
        };
        console.log(chalk.cyan('│') + ` 🔬 Evaluating: ${chalk.yellow(aiEvaluationCandidates.candidates.length)} models (showing top ${chalk.green(top)})`);
        
        const payload = this.buildEvaluatorPayload(hardware, category, aiEvaluationCandidates);
        
        // Phase 4: Check cache
        const cached = await this.loadCache(payload, evaluatorModel);
        let aiResult;

        if (cached) {
            console.log(chalk.cyan('│') + ` 📥 Status: ${chalk.yellow('Using cached evaluation')}`);
            console.log(chalk.cyan('╰'));
            aiResult = cached;
        } else {
            console.log(chalk.cyan('│') + ` 🔬 Status: ${chalk.blue('Running AI evaluation...')}`);
            console.log(chalk.cyan('╰'));
            // Phase 5: Call evaluator
            try {
                aiResult = await this.callOllamaEvaluator(evaluatorModel, payload);
                await this.saveCache(payload, evaluatorModel, aiResult);
            } catch (error) {
                console.log('\n' + chalk.red.bold(' ❌ AI EVALUATION FAILED '));
                console.log(chalk.red('╭' + '─'.repeat(50)));
                console.log(chalk.red('│') + ` ${chalk.white('Error: ' + error.message)}`);
                console.log(chalk.red('│') + ` ${chalk.yellow('Falling back to deterministic results')}`);
                console.log(chalk.red('╰'));
                
                const candidatesWithFinalScores = detResults.candidates.map(candidate => ({
                    ...candidate,
                    aiScore: null,
                    finalScore: candidate.score,
                    rationale: candidate.rationale + ` | AI: evaluation failed`
                }));
                
                return {
                    results: {
                        ...detResults,
                        candidates: candidatesWithFinalScores,
                        aiEvaluated: false
                    },
                    note: `AI evaluation failed (${error.message}); showing deterministic results.`,
                    evaluatorModel
                };
            }
        }

        // Phase 6: Merge deterministic + AI scores
        // AI evaluated more models, but we merge with our final candidates
        const merged = this.mergeDetAndAI(detResults, aiResult, weight);

        return {
            results: merged,
            evaluatorModel,
            aiResult,
            note: `AI-evaluated using ${evaluatorModel}`
        };
    }

    /**
     * Pick the best installed evaluator model
     */
    async pickEvaluatorModel(hardware) {
        try {
            const installedModels = await this.deterministicSelector.getInstalledModels();
            
            if (installedModels.length === 0) {
                return null;
            }

            // Filter for text-only models that can be used as evaluators
            const candidates = installedModels.filter(model => {
                const isTextOnly = !model.modalities.includes('vision');
                const isReasonableSize = model.paramsB >= 0.5; // At least 0.5B
                const notEmbedding = !model.tags.includes('embedding');
                
                return isTextOnly && isReasonableSize && notEmbedding;
            });

            if (candidates.length === 0) {
                return null;
            }

            // Score evaluator candidates
            const scored = candidates.map(model => {
                let score = 0;
                
                // Quality prior
                score += this.deterministicSelector.getBaseQuality(model.paramsB);
                
                // Speed estimation (prefer faster for evaluation)
                const estimatedSpeed = this.deterministicSelector.estimateSpeed(hardware, model, model.quant || 'Q4_K_M', 'general');
                score += estimatedSpeed * 0.3;
                
                // Installed bonus
                score += 10;
                
                // High-quality quant bonus
                if (model.quant && ['Q8_0', 'Q6_K', 'Q5_K_M'].includes(model.quant)) {
                    score += 10;
                }
                
                // Preferred model bonus
                const isPreferred = this.preferredEvaluators.some(pref => 
                    model.model_identifier.includes(pref.split(':')[0])
                );
                if (isPreferred) score += 15;
                
                // Memory pressure penalty
                const requiredMemory = this.deterministicSelector.estimateRequiredGB(model, model.quant || 'Q4_K_M', 4096);
                if (requiredMemory > hardware.usableMemGB * 0.8) {
                    score -= 20;
                }
                
                return { model, score };
            });

            // Sort by score and pick the best
            scored.sort((a, b) => b.score - a.score);
            return scored[0].model.model_identifier;
            
        } catch (error) {
            console.warn(`Failed to pick evaluator: ${error.message}`);
            return null;
        }
    }

    /**
     * Build payload for the evaluator LLM
     */
    buildEvaluatorPayload(hardware, category, detResults) {
        const categoryWeights = this.deterministicSelector.categoryWeights[category] || [0.4, 0.3, 0.2, 0.1];
        
        return {
            hardware: {
                backend: hardware.acceleration.supports_metal ? 'metal' : 
                        hardware.acceleration.supports_cuda ? 'cuda' : 'cpu',
                usableMemGB: Math.round(hardware.usableMemGB * 10) / 10,
                vramGB: hardware.gpu.vramGB || null,
                targetCtx: detResults.targetCtx || this.deterministicSelector.targetContexts[category],
                category: category
            },
            weights: {
                Q: categoryWeights[0],
                S: categoryWeights[1], 
                F: categoryWeights[2],
                C: categoryWeights[3]
            },
            candidates: detResults.candidates.map(candidate => ({
                name: candidate.meta.model_identifier,
                paramsB: candidate.meta.paramsB,
                quant: candidate.quant,
                ctxMax: candidate.meta.ctxMax,
                modalities: candidate.meta.modalities,
                tags: candidate.meta.tags,
                requiredGB: candidate.requiredGB,
                budgetGB: hardware.usableMemGB,
                estTPS: candidate.estTPS,
                measuredTPS: candidate.measuredTPS || null,
                qualityPrior: candidate.components ? candidate.components.Q : 80,
                fitScore: candidate.components ? candidate.components.F : 90,
                ctxScore: candidate.components ? candidate.components.C : 100,
                detScore: candidate.score,
                installed: candidate.meta.installed || false
            }))
        };
    }

    /**
     * Call Ollama evaluator with JSON format
     */
    async callOllamaEvaluator(modelId, payload) {
        const userPrompt = `Category: ${payload.hardware.category}

Models to rank (RANK ALL ${payload.candidates.length} MODELS):
${payload.candidates.map((c, i) => `${i + 1}. ${c.name} (${c.paramsB}B, ${c.quant}, ${c.requiredGB}GB required, installed: ${c.installed})`).join('\n')}

IMPORTANT: Your ranking array must contain exactly ${payload.candidates.length} models. Rank ALL models provided.

Return JSON with this structure:
{
  "winner": "model_name",
  "ranking": [
    {"name": "model_name", "aiScore": 85, "shortWhy": "reason"},
    {"name": "another_model_name", "aiScore": 75, "shortWhy": "reason"}
  ]
}`;

        const requestBody = {
            model: modelId,
            stream: false,
            options: {
                temperature: 0.1,
                num_ctx: 4096
            },
            messages: [
                { role: 'system', content: this.systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        };

        const response = await fetch('http://localhost:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        if (!data.message || !data.message.content) {
            throw new Error(`Invalid response from Ollama API: ${JSON.stringify(data)}`);
        }

        // Parse JSON response, strip markdown code blocks if present
        let aiResult;
        try {
            let content = data.message.content.trim();
            
            // Strip markdown code blocks
            if (content.startsWith('```json') || content.startsWith('```')) {
                content = content.replace(/```json\s*/, '').replace(/```\s*$/, '').trim();
            }
            
            aiResult = JSON.parse(content);
        } catch (error) {
            throw new Error(`Invalid JSON from evaluator: ${error.message}`);
        }

        // Validate schema
        if (!aiResult.winner || !Array.isArray(aiResult.ranking)) {
            throw new Error('Response does not match required schema');
        }

        // Validate that AI ranked ALL models
        if (aiResult.ranking.length !== payload.candidates.length) {
            console.warn(`AI only ranked ${aiResult.ranking.length}/${payload.candidates.length} models. Expected all models to be ranked.`);
        }

        return aiResult;
    }

    /**
     * Merge deterministic and AI scores
     */
    mergeDetAndAI(detResults, aiResult, weight) {
        const clampedWeight = Math.max(0, Math.min(1, weight));
        
        // Create lookup map for AI scores
        const aiScores = new Map();
        aiResult.ranking.forEach(item => {
            aiScores.set(item.name, {
                aiScore: item.aiScore,
                shortWhy: item.shortWhy
            });
        });

        // Merge scores
        const mergedCandidates = detResults.candidates.map(candidate => {
            const aiData = aiScores.get(candidate.meta.model_identifier);
            
            if (aiData) {
                const finalScore = Math.round(
                    ((1 - clampedWeight) * candidate.score + clampedWeight * aiData.aiScore) * 10
                ) / 10;
                
                return {
                    ...candidate,
                    aiScore: aiData.aiScore,
                    finalScore: finalScore,
                    rationale: candidate.rationale + ` | AI: ${aiData.shortWhy}`
                };
            } else {
                // AI didn't rank this model - assign average AI score as fallback
                const avgAIScore = aiResult.ranking.length > 0 ? 
                    Math.round(aiResult.ranking.reduce((sum, r) => sum + r.aiScore, 0) / aiResult.ranking.length) : 
                    candidate.score;
                    
                const finalScore = Math.round(
                    ((1 - clampedWeight) * candidate.score + clampedWeight * avgAIScore) * 10
                ) / 10;
                
                return {
                    ...candidate,
                    aiScore: avgAIScore,
                    finalScore: finalScore,
                    rationale: candidate.rationale + ` | AI: estimated (${avgAIScore}) - model not ranked by evaluator`
                };
            }
        });

        // Sort by final score
        mergedCandidates.sort((a, b) => b.finalScore - a.finalScore);

        return {
            ...detResults,
            candidates: mergedCandidates,
            winner: aiResult.winner,
            aiEvaluated: true
        };
    }

    /**
     * Generate cache key for results
     */
    generateCacheKey(payload, evaluatorModel) {
        const hashInput = JSON.stringify({
            hardware: payload.hardware,
            category: payload.hardware.category,
            candidates: payload.candidates.map(c => ({
                name: c.name,
                quant: c.quant,
                detScore: c.detScore,
                measuredTPS: c.measuredTPS
            })),
            evaluator: evaluatorModel
        });
        
        return crypto.createHash('md5').update(hashInput).digest('hex');
    }

    /**
     * Load cached AI result
     */
    async loadCache(payload, evaluatorModel) {
        try {
            if (!fs.existsSync(this.cachePath)) {
                return null;
            }

            const cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
            const key = this.generateCacheKey(payload, evaluatorModel);
            const entry = cache[key];

            if (!entry) return null;

            // Check if cache is still valid (7 days)
            const maxAge = 7 * 24 * 60 * 60 * 1000;
            if (Date.now() - entry.timestamp > maxAge) {
                return null;
            }

            return entry.result;
        } catch (error) {
            console.warn(`Failed to load cache: ${error.message}`);
            return null;
        }
    }

    /**
     * Save AI result to cache
     */
    async saveCache(payload, evaluatorModel, result) {
        try {
            let cache = {};
            
            if (fs.existsSync(this.cachePath)) {
                try {
                    cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
                } catch (error) {
                    // Invalid cache file, start fresh
                    cache = {};
                }
            }

            const key = this.generateCacheKey(payload, evaluatorModel);
            cache[key] = {
                timestamp: Date.now(),
                result: result,
                evaluator: evaluatorModel
            };

            // Ensure directory exists
            const dir = path.dirname(this.cachePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(this.cachePath, JSON.stringify(cache, null, 2));
        } catch (error) {
            console.warn(`Failed to save cache: ${error.message}`);
        }
    }

    /**
     * Format results for display
     */
    formatResults(aiCheckResult) {
        const { results, evaluatorModel, note } = aiCheckResult;
        const chalk = require('chalk');
        const { table } = require('table');
        
        if (results.candidates.length === 0) {
            console.log('\n' + chalk.red.bold(' ❌ AI-CHECK: No suitable models found '));
            return aiCheckResult;
        }

        // AI-Check header
        console.log('\n' + chalk.bgMagenta.white.bold(' 🧠 AI-CHECK RESULTS '));
        console.log(chalk.magenta('╭' + '─'.repeat(65)));
        console.log(chalk.magenta('│') + ` 🤖 Evaluator: ${chalk.cyan(evaluatorModel || 'None')}`);
        console.log(chalk.magenta('│') + ` 🎯 Category: ${chalk.yellow(results.category || 'general').toUpperCase()}`);
        console.log(chalk.magenta('│') + ` 📊 Models Evaluated: ${chalk.green(results.candidates.length)}`);
        if (note) {
            console.log(chalk.magenta('│') + ` 📝 Note: ${chalk.gray(note)}`);
        }
        console.log(chalk.magenta('╰'));

        // Create table data in the same style as check command
        const tableData = [
            [
                chalk.bgMagenta.white.bold(' Model '),
                chalk.bgMagenta.white.bold(' Size '),
                chalk.bgMagenta.white.bold(' Det Score '),
                chalk.bgMagenta.white.bold(' AI Score '),
                chalk.bgMagenta.white.bold(' Final '),
                chalk.bgMagenta.white.bold(' RAM '),
                chalk.bgMagenta.white.bold(' Speed '),
                chalk.bgMagenta.white.bold(' Status ')
            ]
        ];

        results.candidates.forEach(candidate => {
            const isInstalled = candidate.meta.installed;
            const modelName = candidate.meta.name || candidate.meta.model_identifier;
            const size = `${candidate.meta.paramsB}B`;
            const detScore = `${Math.round(candidate.score)}/100`;
            const aiScore = candidate.aiScore ? `${Math.round(candidate.aiScore)}/100` : 'N/A';
            const finalScore = `${Math.round(candidate.finalScore)}/100`;
            const ram = `${candidate.requiredGB}/${Math.round(results.hardware.usableMemGB)}GB`;
            const speed = `${candidate.estTPS.toFixed(0)}t/s`;
            
            let statusDisplay, modelDisplay;
            if (isInstalled) {
                statusDisplay = chalk.green.bold('📦 Installed');
                modelDisplay = `${modelName} 🦙`;
            } else {
                statusDisplay = '🌐 Available';
                modelDisplay = modelName;
            }

            const row = [
                modelDisplay,
                size,
                this.getScoreColor(candidate.score)(detScore),
                candidate.aiScore ? this.getScoreColor(candidate.aiScore)(aiScore) : chalk.gray(aiScore),
                this.getScoreColor(candidate.finalScore)(finalScore),
                ram,
                speed,
                statusDisplay
            ];
            tableData.push(row);
        });

        console.log(table(tableData));

        // Best recommendation section
        const best = results.candidates[0];
        console.log('\n' + chalk.bgGreen.black.bold(' 🎯 AI-POWERED RECOMMENDATION '));
        console.log(chalk.green('╭' + '─'.repeat(50)));
        console.log(chalk.green('│') + ` 🏆 Best Model: ${chalk.cyan.bold(best.meta.name || best.meta.model_identifier)}`);
        console.log(chalk.green('│') + ` 📊 Final Score: ${this.getScoreColor(best.finalScore)(Math.round(best.finalScore) + '/100')}`);
        console.log(chalk.green('│') + ` ⚖️  Det: ${Math.round(best.score)} + AI: ${best.aiScore ? Math.round(best.aiScore) : 'N/A'}`);
        console.log(chalk.green('│'));
        
        if (best.meta.installed) {
            console.log(chalk.green('│') + ` 💻 Ready to use:`);
            console.log(chalk.green('│') + `   ${chalk.cyan.bold(`ollama run ${best.meta.model_identifier}`)}`);
        } else {
            console.log(chalk.green('│') + ` 📥 Install command:`);
            console.log(chalk.green('│') + `   ${chalk.cyan.bold(`ollama pull ${best.meta.model_identifier}`)}`);
        }
        
        console.log(chalk.green('│'));
        console.log(chalk.green('│') + ` 🎯 Why this model?`);
        
        // Parse and display reasoning nicely
        const reasons = best.rationale.split(' | ');
        reasons.forEach(reason => {
            if (reason.trim()) {
                console.log(chalk.green('│') + `   • ${chalk.yellow(reason.trim())}`);
            }
        });
        
        console.log(chalk.green('╰'));

        return aiCheckResult;
    }
    
    getScoreColor(score) {
        const chalk = require('chalk');
        if (score >= 85) return chalk.green.bold;
        if (score >= 70) return chalk.cyan.bold;
        if (score >= 55) return chalk.yellow.bold;
        if (score >= 40) return chalk.red.bold;
        return chalk.gray;
    }

    /**
     * Filter Ollama models by category (same logic as deterministic selector)
     */
    filterOllamaModelsByCategory(models, category) {
        return models.filter(model => {
            const modelName = model.model_name.toLowerCase();
            const modelId = model.model_identifier.toLowerCase();
            const fullText = `${modelName} ${modelId}`;
            
            switch (category) {
                case 'coding':
                    return fullText.includes('code') || fullText.includes('coder') || 
                           fullText.includes('deepseek-coder') || fullText.includes('qwen2.5-coder');
                           
                case 'multimodal':
                    return fullText.includes('llava') || fullText.includes('vision') || 
                           fullText.includes('pixtral') || fullText.includes('moondream') ||
                           fullText.includes('qwen-vl');
                           
                case 'embeddings':
                    return fullText.includes('embed') || fullText.includes('nomic') ||
                           fullText.includes('bge') || fullText.includes('e5');
                           
                case 'reasoning':
                    return fullText.includes('deepseek-r1') || fullText.includes('reasoning') ||
                           fullText.includes('math') || model.model_identifier.includes('o1-');
                           
                case 'creative':
                    return fullText.includes('dolphin') || fullText.includes('wizard') ||
                           fullText.includes('uncensored') || fullText.includes('airoboros');
                           
                case 'reading':
                    return fullText.includes('solar') || fullText.includes('openchat') ||
                           fullText.includes('neural-chat') || fullText.includes('vicuna');
                           
                case 'talking':
                    // Most conversational models - llama, mistral, etc.
                    return (fullText.includes('llama') || fullText.includes('mistral') ||
                           fullText.includes('phi') || fullText.includes('gemma') ||
                           fullText.includes('qwen') || fullText.includes('chat') ||
                           fullText.includes('instruct')) &&
                           // Exclude specialized models
                           !fullText.includes('coder') && !fullText.includes('vl') &&
                           !fullText.includes('embed') && !fullText.includes('vision');
                           
                default: // general
                    return true; // Most models can handle general tasks
            }
        });
    }

    /**
     * Convert Ollama model format to deterministic selector format
     */
    convertOllamaModelToDeterministicFormat(ollamaModel) {
        // Extract size from model identifier
        const sizeMatch = ollamaModel.model_identifier.match(/(\d+\.?\d*)[bm]/i);
        const sizeNum = sizeMatch ? parseFloat(sizeMatch[1]) : 7; // Default 7B
        const sizeUnit = sizeMatch ? sizeMatch[0].slice(-1).toLowerCase() : 'b';
        const paramsB = sizeUnit === 'm' ? sizeNum / 1000 : sizeNum;
        
        // Extract family
        const modelId = ollamaModel.model_identifier.toLowerCase();
        let family = 'unknown';
        if (modelId.includes('qwen2.5')) family = 'qwen2.5';
        else if (modelId.includes('qwen')) family = 'qwen';
        else if (modelId.includes('llama3.2')) family = 'llama3.2';
        else if (modelId.includes('llama3.1')) family = 'llama3.1';
        else if (modelId.includes('llama')) family = 'llama';
        else if (modelId.includes('mistral')) family = 'mistral';
        else if (modelId.includes('gemma')) family = 'gemma2';
        else if (modelId.includes('phi')) family = 'phi-3';
        else if (modelId.includes('llava')) family = 'llava';
        
        // Determine modalities
        const modalities = ['text'];
        if (modelId.includes('llava') || modelId.includes('vision') || modelId.includes('vl')) {
            modalities.push('vision');
        }
        
        // Determine tags
        const tags = [];
        if (modelId.includes('instruct') || ollamaModel.model_name.toLowerCase().includes('instruct')) tags.push('instruct');
        if (modelId.includes('chat') || ollamaModel.model_name.toLowerCase().includes('chat')) tags.push('chat');
        if (modelId.includes('code') || ollamaModel.model_name.toLowerCase().includes('code')) tags.push('coder');
        if (modalities.includes('vision')) tags.push('vision');
        if (modelId.includes('embed')) tags.push('embedding');
        
        // Default context length based on model family
        let ctxMax = 4096;
        if (family.includes('qwen')) ctxMax = 32768;
        else if (family.includes('llama3')) ctxMax = 131072;
        else if (family.includes('mistral')) ctxMax = 32768;
        else if (family.includes('gemma')) ctxMax = 8192;
        
        // Estimate model size in GB (rough approximation)
        const sizeGB = paramsB * 0.6; // ~0.6GB per billion parameters for Q4_K_M
        
        return {
            name: ollamaModel.model_name,
            family: family,
            paramsB: paramsB,
            ctxMax: ctxMax,
            quant: 'Q4_K_M', // Default quantization
            sizeGB: sizeGB,
            modalities: modalities,
            tags: tags,
            model_identifier: ollamaModel.model_identifier,
            installed: false, // Will be updated later by checking local models
            pulls: ollamaModel.pulls || 0,
            description: ollamaModel.description || ''
        };
    }
}

module.exports = AICheckSelector;