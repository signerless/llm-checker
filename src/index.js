const path = require('path');
const HardwareDetector = require('./hardware/detector');
const ExpandedModelsDatabase = require('./models/expanded_database');
const EnhancedModelSelector = require('./models/enhanced-selector');
const CompatibilityAnalyzer = require(path.join(__dirname, '..', 'analyzer', 'compatibility'));
const PerformanceAnalyzer = require(path.join(__dirname, '..', 'analyzer', 'performance'));
const OllamaClient = require('./ollama/client');
const { getLogger } = require('./utils/logger');
const { getOllamaModelsIntegration, OllamaNativeScraper } = require('./ollama/native-scraper');
const VerboseProgress = require('./utils/verbose-progress');

class LLMChecker {
    constructor(options = {}) {
        this.hardwareDetector = new HardwareDetector();
        this.expandedModelsDatabase = new ExpandedModelsDatabase();
        this.intelligentRecommender = new EnhancedModelSelector();
        this.ollamaScraper = new OllamaNativeScraper();
        this.compatibilityAnalyzer = new CompatibilityAnalyzer();
        this.performanceAnalyzer = new PerformanceAnalyzer();
        this.ollamaClient = new OllamaClient();
        this.logger = getLogger().createChild('LLMChecker');
        this.verbose = options.verbose !== false; // Default to verbose unless explicitly disabled
        this.progress = null; // Will be initialized when needed
    }

    async analyze(options = {}) {
        // Initialize verbose progress if enabled
        if (this.verbose && !this.progress) {
            this.progress = VerboseProgress.create(true);
        }

        try {
            if (this.progress) {
                this.progress.startOperation('LLM Model Analysis & Compatibility Check', 8);
            }

            // Step 1: Hardware Detection
            if (this.progress) {
                this.progress.step('System Detection', 'Scanning hardware specifications...');
            }
            
            const hardware = await this.hardwareDetector.getSystemInfo();
            this.logger.info('Hardware detected', { hardware });

            // Detect platform and route to appropriate logic (use hardware OS for simulation support)
            const detectedPlatform = hardware.os?.platform || process.platform;

            // Report hardware detection progress before platform-specific analysis
            if (this.progress) {
                this.progress.substep(`CPU detected: ${hardware.cpu.brand} (${hardware.cpu.cores} cores)`);
                await new Promise(resolve => setTimeout(resolve, 200)); // Small delay for demo
                const isApple = detectedPlatform === 'darwin';
                const memLabel = isApple ? 'unified memory' : 'RAM';
                this.progress.substep(`Memory detected: ${hardware.memory.total}GB ${memLabel}`, true);
                const summary = `${hardware.cpu.brand}, ${hardware.memory.total}GB RAM, ${hardware.gpu.model || 'Integrated GPU'}`;
                this.progress.stepComplete(summary);
            }
            const isAppleSilicon = detectedPlatform === 'darwin';
            const isWindows = detectedPlatform === 'win32';
            const isLinux = detectedPlatform === 'linux';

            if (isAppleSilicon) {
                return await this.analyzeForAppleSilicon(hardware, options);
            } else if (isWindows) {
                return await this.analyzeForWindows(hardware, options);
            } else if (isLinux) {
                return await this.analyzeForLinux(hardware, options);
            } else {
                // Fallback to Windows logic for unknown platforms
                return await this.analyzeForWindows(hardware, options);
            }

            // Step 2: Load Base Models (dynamic count from database)
            if (this.progress) {
                this.progress.step('Database Sync', 'Loading model database...');
            }

            let models = this.expandedModelsDatabase.getAllModels();
            const modelCount = models.length; // Dynamic count from actual database

            if (this.progress) {
                this.progress.found(`${modelCount} models in database`);
                this.progress.stepComplete('Database synchronized');
            }

            // Step 3: Model Analysis (use count from already loaded models)
            if (this.progress) {
                this.progress.stepComplete('Base models loaded');
            }

            // Step 4: Ollama Integration
            if (this.progress) {
                this.progress.step('Ollama Integration', 'Connecting to Ollama and checking installed models...');
            }
            
            const ollamaIntegration = await this.integrateOllamaModels(hardware, models);
            
            if (this.progress) {
                if (ollamaIntegration.ollamaInfo.available) {
                    const installed = ollamaIntegration.compatibleOllamaModels.length;
                    this.progress.found(`Ollama connected with ${installed} locally installed models`);
                } else {
                    this.progress.warn('Ollama not available - continuing with database analysis only');
                }
                this.progress.stepComplete('Ollama integration complete');
            }

            // Step 5: Filter Models (skip step if no filtering needed)
            if (options.filter || !options.includeCloud) {
                if (this.progress) {
                    this.progress.step('Model Filtering', 'Applying user-specified filters...');
                }

                const originalCount = models.length;
                if (options.filter) {
                    models = this.filterModels(models, options.filter);
                    if (this.progress) {
                        this.progress.substep(`Filter applied: ${options.filter}`);
                    }
                }

                if (!options.includeCloud) {
                    models = models.filter(model => model.type === 'local');
                    if (this.progress) {
                        this.progress.substep('Cloud models excluded', true);
                    }
                }
                
                if (this.progress) {
                    this.progress.stepComplete(`${models.length}/${originalCount} models selected`);
                }
            }

            // Step 6: Mathematical Analysis
            if (this.progress) {
                this.progress.step('Compatibility Analysis', 'Running mathematical heuristics and hardware matching...');
            }
            
            const compatibility = await this.analyzeWithMathematicalHeuristics(hardware, models, ollamaIntegration);
            
            if (this.progress) {
                const stats = `${compatibility.compatible.length} compatible, ${compatibility.marginal.length} marginal`;
                this.progress.stepComplete(stats);
            }

            // Step 7: Performance Estimation
            if (this.progress) {
                this.progress.step('Performance Analysis', 'Estimating model performance and speeds...');
            }
            
            const enrichedResults = await this.enrichWithPerformanceData(hardware, compatibility);
            
            if (this.progress) {
                const perfCount = Object.keys(enrichedResults.performanceEstimates || {}).length;
                this.progress.stepComplete(`Performance data for ${perfCount} models`);
            }

            // Step 8: Generating Recommendations
            if (this.progress) {
                this.progress.step('Smart Recommendations', 'Generating personalized model suggestions...');
            }
            
            const [recommendations, intelligentRecommendations] = await Promise.all([
                this.generateEnhancedRecommendations(
                    hardware,
                    enrichedResults,
                    ollamaIntegration,
                    options.useCase || 'general'
                ),
                this.generateIntelligentRecommendations(hardware)
            ]);
            
            if (this.progress) {
                // Calculate actual number of recommendations that will be shown (respecting limit)
                const limit = options.limit || 10;
                const totalRecs = Object.values(recommendations).flat().length;
                const actualRecsShown = Math.min(totalRecs, limit);
                
                this.progress.substep(`Analyzing use case: ${options.useCase || 'general'}`);
                await new Promise(resolve => setTimeout(resolve, 100)); // Small delay for demo
                
                // Adjust message based on Ollama availability
                if (ollamaIntegration.ollamaInfo.available) {
                    this.progress.substep('Generating Ollama commands...', true);
                } else {
                    this.progress.substep('Generating installation recommendations...', true);
                }
                this.progress.stepComplete(`${actualRecsShown} recommendations generated`);
                
                // Complete the entire operation with accurate counts
                const compatibleCount = enrichedResults.compatible.length;
                const marginalCount = enrichedResults.marginal.length;
                
                if (compatibleCount > 0) {
                    this.progress.complete(`Found ${compatibleCount} compatible models for your hardware`);
                } else if (marginalCount > 0) {
                    this.progress.complete(`Found ${compatibleCount} compatible (${marginalCount} marginal) models for your hardware`);
                } else {
                    this.progress.complete(`No compatible models found for your hardware`);
                }
            }

            return {
                hardware,
                compatible: enrichedResults.compatible,
                marginal: enrichedResults.marginal,
                incompatible: enrichedResults.incompatible,
                recommendations,
                intelligentRecommendations,
                ollamaInfo: ollamaIntegration.ollamaInfo,
                ollamaModels: ollamaIntegration.compatibleOllamaModels,
                summary: this.generateEnhancedSummary(hardware, enrichedResults, ollamaIntegration),
                performanceEstimates: enrichedResults.performanceEstimates
            };

        } catch (error) {
            if (this.progress) {
                this.progress.fail(`Analysis failed: ${error.message}`);
            }
            this.logger.error('Analysis failed', { error: error.message, component: 'LLMChecker', method: 'analyze' });
            throw new Error(`Analysis failed: ${error.message}`);
        }
    }

    // ============================================================================
    // PLATFORM-SPECIFIC ANALYSIS METHODS
    // ============================================================================

    async analyzeForAppleSilicon(hardware, options = {}) {
        // Apple Silicon optimized analysis with unified memory consideration
        if (this.progress) {
            this.progress.substep(`CPU detected: ${hardware.cpu.brand} (${hardware.cpu.cores} cores)`);
            await new Promise(resolve => setTimeout(resolve, 200));
            this.progress.substep(`Memory detected: ${hardware.memory.total}GB unified memory`, true);
            const summary = `${hardware.cpu.brand}, ${hardware.memory.total}GB RAM, ${hardware.gpu.model || 'Apple Silicon GPU'}`;
            this.progress.stepComplete(summary);
        }

        // Continue with original analysis flow but with Apple Silicon specific optimizations
        return await this.runAnalysisFlow(hardware, options, 'apple_silicon');
    }

    async analyzeForWindows(hardware, options = {}) {
        // Windows-specific analysis with discrete GPU / iGPU handling
        if (this.progress) {
            this.progress.substep(`CPU detected: ${hardware.cpu.brand} (${hardware.cpu.cores} cores)`);
            await new Promise(resolve => setTimeout(resolve, 200));
            this.progress.substep(`Memory detected: ${hardware.memory.total}GB RAM`, true);
            const summary = `${hardware.cpu.brand}, ${hardware.memory.total}GB RAM, ${hardware.gpu.model || 'Integrated GPU'}`;
            this.progress.stepComplete(summary);
        }

        // Continue with original analysis flow but with Windows specific optimizations
        return await this.runAnalysisFlow(hardware, options, 'windows');
    }

    async analyzeForLinux(hardware, options = {}) {
        // Linux-specific analysis (similar to Windows but with Linux considerations)
        if (this.progress) {
            this.progress.substep(`CPU detected: ${hardware.cpu.brand} (${hardware.cpu.cores} cores)`);
            await new Promise(resolve => setTimeout(resolve, 200));
            this.progress.substep(`Memory detected: ${hardware.memory.total}GB RAM`, true);
            const summary = `${hardware.cpu.brand}, ${hardware.memory.total}GB RAM, ${hardware.gpu.model || 'GPU'}`;
            this.progress.stepComplete(summary);
        }

        // Continue with original analysis flow but with Linux specific optimizations
        return await this.runAnalysisFlow(hardware, options, 'linux');
    }

    async runAnalysisFlow(hardware, options, platform) {
        // Step 2: Database Sync (using static database)
        if (this.progress) {
            this.progress.step('Database Sync', 'Loading model database...');
        }
        
        // Using static pre-loaded model database with classifications
        const modelCount = 177; // Static count from pre-loaded database
        
        if (this.progress) {
            this.progress.found(`${modelCount} models in database`);
            this.progress.stepComplete('Database synchronized');
        }

        // Step 3: Load Base Models
        if (this.progress) {
            this.progress.step('Model Analysis', 'Loading base model definitions...');
        }
        
        let models = this.expandedModelsDatabase.getAllModels();
        
        if (this.progress) {
            this.progress.found(`Loaded ${models.length} base models`);
            this.progress.stepComplete('Base models loaded');
        }

        // Step 4: Ollama Integration
        if (this.progress) {
            this.progress.step('Ollama Integration', 'Connecting to Ollama and checking installed models...');
        }
        
        const ollamaIntegration = await this.integrateOllamaModels(hardware, models);
        
        if (this.progress) {
            if (ollamaIntegration.ollamaInfo.available) {
                const installed = ollamaIntegration.compatibleOllamaModels.length;
                this.progress.found(`Ollama connected with ${installed} locally installed models`);
            } else {
                this.progress.warn('Ollama not available - continuing with database analysis only');
            }
            this.progress.stepComplete('Ollama integration complete');
        }

        // Step 5: Filter Models (skip step if no filtering needed)
        if (options.filter || !options.includeCloud || options.maxSize || options.minSize) {
            if (this.progress) {
                this.progress.step('Model Filtering', 'Applying user-specified filters...');
            }

            const originalCount = models.length;
            if (options.filter) {
                models = this.filterModels(models, options.filter);
                if (this.progress) {
                    this.progress.substep(`Filter applied: ${options.filter}`);
                }
            }

            if (!options.includeCloud) {
                models = models.filter(model => model.type === 'local');
                if (this.progress) {
                    this.progress.substep('Cloud models excluded', true);
                }
            }

            // Apply size filters (maxSize and minSize in billions of parameters)
            if (options.maxSize || options.minSize) {
                models = models.filter(model => {
                    // Extract size in B from model.size (e.g., "7B", "13B", "70B")
                    const sizeMatch = (model.size || '').match(/(\d+\.?\d*)/);
                    if (!sizeMatch) return true; // Keep models without size info
                    const modelSizeB = parseFloat(sizeMatch[1]);

                    if (options.maxSize && modelSizeB > options.maxSize) {
                        return false;
                    }
                    if (options.minSize && modelSizeB < options.minSize) {
                        return false;
                    }
                    return true;
                });
                if (this.progress) {
                    const sizeInfo = [];
                    if (options.minSize) sizeInfo.push(`min: ${options.minSize}B`);
                    if (options.maxSize) sizeInfo.push(`max: ${options.maxSize}B`);
                    this.progress.substep(`Size filter: ${sizeInfo.join(', ')}`, true);
                }
            }

            if (this.progress) {
                this.progress.stepComplete(`${models.length}/${originalCount} models selected`);
            }
        }

        // Step 6: Platform-specific Mathematical Analysis
        if (this.progress) {
            this.progress.step('Compatibility Analysis', 'Running mathematical heuristics and hardware matching...');
        }
        
        const compatibility = await this.analyzeWithPlatformSpecificHeuristics(hardware, models, ollamaIntegration, platform, options);
        
        if (this.progress) {
            const stats = `${compatibility.compatible.length} compatible, ${compatibility.marginal.length} marginal`;
            this.progress.stepComplete(stats);
        }

        // Step 7: Performance Estimation
        if (this.progress) {
            this.progress.step('Performance Analysis', 'Estimating model performance and speeds...');
        }
        
        const enrichedResults = await this.enrichWithPerformanceData(hardware, compatibility, platform);
        
        if (this.progress) {
            const perfCount = Object.keys(enrichedResults.performanceEstimates || {}).length;
            this.progress.stepComplete(`Performance data for ${perfCount} models`);
        }

        // Step 8: Generate Platform-specific Recommendations
        if (this.progress) {
            this.progress.step('Smart Recommendations', 'Generating personalized model suggestions...');
        }

        const recommendations = await this.generateIntelligentRecommendations(hardware);
        const intelligentRecommendations = recommendations;

        if (this.progress) {
            const compatibleCount = enrichedResults.compatible.length;
            const marginalCount = enrichedResults.marginal.length;
            const recCount = Object.keys(intelligentRecommendations || {}).length;
            this.progress.substep(`Generating ${platform} recommendations...`, true);
            this.progress.stepComplete(`${recCount} recommendations generated`);
            
            if (compatibleCount > 0 && marginalCount === 0) {
                this.progress.complete(`Found ${compatibleCount} compatible models for your hardware`);
            } else if (marginalCount > 0) {
                this.progress.complete(`Found ${compatibleCount} compatible (${marginalCount} marginal) models for your hardware`);
            } else {
                this.progress.complete(`No compatible models found for your hardware`);
            }
        }

        return {
            hardware,
            compatible: enrichedResults.compatible,
            marginal: enrichedResults.marginal,
            incompatible: enrichedResults.incompatible,
            recommendations,
            intelligentRecommendations,
            ollamaInfo: ollamaIntegration.ollamaInfo,
            ollamaModels: ollamaIntegration.compatibleOllamaModels,
            summary: this.generateEnhancedSummary(hardware, enrichedResults, ollamaIntegration),
            performanceEstimates: enrichedResults.performanceEstimates,
            platform
        };
    }

    async analyzeWithPlatformSpecificHeuristics(hardware, staticModels, ollamaIntegration, platform, options = {}) {
        // Use different analysis approaches based on platform
        if (platform === 'apple_silicon') {
            return await this.analyzeWithAppleSiliconHeuristics(hardware, staticModels, ollamaIntegration, options);
        } else {
            return await this.analyzeWithMathematicalHeuristics(hardware, staticModels, ollamaIntegration);
        }
    }

    async analyzeWithAppleSiliconHeuristics(hardware, staticModels, ollamaIntegration, options = {}) {
        // Apple Silicon specific analysis - more optimistic for unified memory
        this.logger.info('Using Apple Silicon specific heuristics');
        
        // For Apple Silicon, we use more optimistic thresholds
        const MultiObjectiveSelector = require('./ai/multi-objective-selector');
        const selector = new MultiObjectiveSelector();
        
        // Use the specified use case, default to 'general'
        const useCase = options.useCase || 'general';
        const results = await selector.selectBestModels(hardware, staticModels, useCase, 100);
        
        // Apple Silicon specific post-processing - make more models compatible
        // Lower threshold for Apple Silicon due to unified memory efficiency
        const appleSiliconThreshold = hardware.memory_gb >= 16 ? 45 : 55;
        const appleSiliconResults = {
            compatible: [...results.compatible, ...results.marginal.filter(m => m.totalScore >= appleSiliconThreshold)],
            marginal: results.marginal.filter(m => m.totalScore < appleSiliconThreshold && m.totalScore >= 35),
            incompatible: [...results.incompatible, ...results.marginal.filter(m => m.totalScore < 35)]
        };
        
        this.logger.info('Apple Silicon heuristic results', {
            compatible: appleSiliconResults.compatible.length,
            marginal: appleSiliconResults.marginal.length,
            incompatible: appleSiliconResults.incompatible.length
        });
        
        
        // Convert totalScore to score for consistency with other analysis paths
        const mappedResults = {
            compatible: appleSiliconResults.compatible.map(model => ({
                ...model,
                score: model.totalScore,
                confidence: model.totalScore / 100,
                reasoning: model.reasoning,
                mathAnalysis: {
                    qualityScore: model.components?.quality,
                    speedScore: model.components?.speed,
                    ttfbScore: model.components?.ttfb,
                    contextScore: model.components?.context,
                    hardwareMatchScore: model.components?.hardwareMatch
                },
                isOllamaInstalled: this.checkIfModelInstalled(model, ollamaIntegration),
                ollamaInfo: this.getOllamaModelInfo(model, ollamaIntegration)
            })),
            marginal: appleSiliconResults.marginal.map(model => ({
                ...model,
                score: model.totalScore,
                confidence: model.totalScore / 100,
                reasoning: model.reasoning,
                mathAnalysis: {
                    qualityScore: model.components?.quality,
                    speedScore: model.components?.speed,
                    ttfbScore: model.components?.ttfb,
                    contextScore: model.components?.context,
                    hardwareMatchScore: model.components?.hardwareMatch
                },
                isOllamaInstalled: this.checkIfModelInstalled(model, ollamaIntegration),
                ollamaInfo: this.getOllamaModelInfo(model, ollamaIntegration)
            })),
            incompatible: appleSiliconResults.incompatible.map(model => ({
                ...model,
                score: model.totalScore,
                confidence: model.totalScore / 100,
                reasoning: model.reasoning,
                mathAnalysis: {
                    qualityScore: model.components?.quality,
                    speedScore: model.components?.speed,
                    ttfbScore: model.components?.ttfb,
                    contextScore: model.components?.context,
                    hardwareMatchScore: model.components?.hardwareMatch
                },
                isOllamaInstalled: this.checkIfModelInstalled(model, ollamaIntegration),
                ollamaInfo: this.getOllamaModelInfo(model, ollamaIntegration)
            }))
        };
        
        return mappedResults;
    }

    async integrateOllamaModels(hardware, availableModels) {
        const integration = {
            ollamaInfo: { available: false },
            compatibleOllamaModels: [],
            recommendedPulls: [],
            currentlyRunning: []
        };

        try {
            const ollamaStatus = await this.ollamaClient.checkOllamaAvailability();
            integration.ollamaInfo = ollamaStatus;

            if (!ollamaStatus.available) {
                this.logger.warn('Ollama not available', { error: ollamaStatus.error });
                return integration;
            }

            const [localModels, runningModels] = await Promise.all([
                this.ollamaClient.getLocalModels().catch(error => {
                    this.logger.warn('Failed to get local Ollama models', { error: error.message });
                    return [];
                }),
                this.ollamaClient.getRunningModels().catch(error => {
                    this.logger.warn('Failed to get running Ollama models', { error: error.message });
                    return [];
                })
            ]);

            integration.currentlyRunning = runningModels;

            try {
                this.logger.info('Using enhanced model database for compatibility...');

                const enhancedCompatibility = await getOllamaModelsIntegration(localModels);

                if (enhancedCompatibility.compatible_models && enhancedCompatibility.compatible_models.length > 0) {
                    for (const compatibleMatch of enhancedCompatibility.compatible_models) {
                        const ollamaModel = compatibleMatch.local;
                        const cloudModel = compatibleMatch.cloud;

                        let matchedModel = this.findMatchingModelInDatabase(cloudModel, availableModels);

                        if (!matchedModel) {
                            matchedModel = this.createModelFromCloudData(cloudModel);
                        }

                        const compatibility = this.compatibilityAnalyzer.calculateModelCompatibility(hardware, matchedModel);

                        let finalScore = compatibility.score;
                        if (compatibleMatch.match_type === 'exact') {
                            finalScore = Math.max(finalScore, 75);
                        } else {
                            finalScore = Math.max(finalScore, 65);
                        }

                        const enrichedOllamaModel = {
                            ...ollamaModel,
                            matchedModel,
                            compatibilityScore: finalScore,
                            issues: compatibility.issues || [],
                            notes: compatibility.notes || [],
                            isRunning: runningModels.some(r => r.name === ollamaModel.name),
                            canRun: finalScore >= 60,
                            performanceEstimate: await this.performanceAnalyzer.estimateModelPerformance(matchedModel, hardware),
                            cloudInfo: {
                                pulls: cloudModel.pulls,
                                url: cloudModel.url,
                                match_type: compatibleMatch.match_type,
                                model_type: cloudModel.model_type
                            }
                        };

                        integration.compatibleOllamaModels.push(enrichedOllamaModel);
                    }

                    this.logger.info('Enhanced Ollama integration completed', {
                        data: {
                            localModels: localModels.length,
                            compatibleModels: integration.compatibleOllamaModels.length,
                            runningModels: runningModels.length,
                            totalAvailable: enhancedCompatibility.all_available,
                            enhancedMatching: true
                        }
                    });
                } else {
                    this.logger.warn('No enhanced compatible models found, using fallback');
                    await this.processFallbackModels(localModels, runningModels, availableModels, hardware, integration);
                }

            } catch (enhancedError) {
                this.logger.warn('Enhanced matching failed, using fallback method', { error: enhancedError.message });
                await this.processFallbackModels(localModels, runningModels, availableModels, hardware, integration);
            }

            integration.recommendedPulls = await this.generateOllamaRecommendations(hardware, availableModels, localModels);

        } catch (error) {
            this.logger.error('Ollama integration failed', { error: error.message, component: 'LLMChecker', method: 'integrateOllamaModels' });
        }

        return integration;
    }

    async analyzeWithMathematicalHeuristics(hardware, staticModels, ollamaIntegration) {
        this.logger.info('Using mathematical heuristics combining database + local models');
        
        try {
            // 1. Obtener TODOS los modelos de la base de datos de Ollama
            const ollamaData = await this.ollamaScraper.scrapeAllModels(false);
            const allOllamaModels = ollamaData.models || [];
            this.logger.info(`Found ${allOllamaModels.length} models in Ollama database`);

            // 2. Crear una lista combinada de todos los modelos únicos
            const allModelsMap = new Map();
            
            // Agregar modelos estáticos
            staticModels.forEach(model => {
                allModelsMap.set(model.name, {
                    ...model,
                    source: 'static_database',
                    isOllamaInstalled: false
                });
            });
            
            // Agregar modelos de Ollama (con prioridad si ya existen)
            allOllamaModels.forEach(ollamaModel => {
                const modelKey = this.findBestMatchingKey(ollamaModel, allModelsMap);
                
                if (modelKey) {
                    // Mejorar modelo existente con datos de Ollama
                    const existing = allModelsMap.get(modelKey);
                    allModelsMap.set(modelKey, {
                        ...existing,
                        ...this.createEnhancedModelFromOllama(ollamaModel, existing),
                        source: 'enhanced_with_ollama'
                    });
                } else {
                    // Crear nuevo modelo desde datos de Ollama
                    const newModel = this.createModelFromOllamaData(ollamaModel);
                    allModelsMap.set(newModel.name, {
                        ...newModel,
                        source: 'ollama_database'
                    });
                }
            });
            
            const allUniqueModels = Array.from(allModelsMap.values());
            this.logger.info(`Combined total: ${allUniqueModels.length} unique models`);

            // 3. Usar el nuevo selector multi-objetivo
            const MultiObjectiveSelector = require('./ai/multi-objective-selector');
            const multiObjectiveSelector = new MultiObjectiveSelector();
            
            // Ejecutar análisis multi-objetivo
            const multiObjectiveResult = await multiObjectiveSelector.selectBestModels(
                hardware,
                allUniqueModels,
                'general',
                50 // Top 50 modelos
            );
            
            this.logger.info(`Multi-objective analysis completed: ${multiObjectiveResult.compatible.length} compatible, ${multiObjectiveResult.marginal.length} marginal`);

            // 4. Los resultados ya vienen clasificados del nuevo selector
            const compatibility = {
                compatible: multiObjectiveResult.compatible.map(model => ({
                    ...model,
                    score: model.totalScore,
                    confidence: model.totalScore / 100,
                        reasoning: model.reasoning,
                        mathAnalysis: {
                            qualityScore: model.components.quality,
                            speedScore: model.components.speed,
                            ttfbScore: model.components.ttfb,
                            contextScore: model.components.context,
                            hardwareMatchScore: model.components.hardwareMatch
                        },
                    isOllamaInstalled: this.checkIfModelInstalled(model, ollamaIntegration),
                    ollamaInfo: this.getOllamaModelInfo(model, ollamaIntegration)
                })),
                marginal: multiObjectiveResult.marginal.map(model => ({
                    ...model,
                    score: model.totalScore,
                    confidence: model.totalScore / 100,
                    reasoning: model.reasoning,
                    mathAnalysis: {
                        qualityScore: model.components.quality,
                        speedScore: model.components.speed,
                        ttfbScore: model.components.ttfb,
                        contextScore: model.components.context,
                        hardwareMatchScore: model.components.hardwareMatch
                    },
                    isOllamaInstalled: this.checkIfModelInstalled(model, ollamaIntegration),
                    ollamaInfo: this.getOllamaModelInfo(model, ollamaIntegration)
                })),
                incompatible: multiObjectiveResult.incompatible.map(model => ({
                    ...model,
                    score: model.totalScore,
                    confidence: model.totalScore / 100,
                    reasoning: model.reasoning,
                    isOllamaInstalled: this.checkIfModelInstalled(model, ollamaIntegration),
                    ollamaInfo: this.getOllamaModelInfo(model, ollamaIntegration)
                }))
            };
            
            // Agregar modelos sin puntuación alta a incompatibles
            // Build a set of already included model names for O(1) lookup (instead of O(n) .some())
            const includedModelNames = new Set();
            compatibility.compatible.forEach(m => includedModelNames.add(m.name));
            compatibility.marginal.forEach(m => includedModelNames.add(m.name));
            compatibility.incompatible.forEach(m => includedModelNames.add(m.name));

            allUniqueModels.forEach(model => {
                if (!includedModelNames.has(model.name)) {
                    compatibility.incompatible.push({
                        ...model,
                        score: 0,
                        issues: ['Low compatibility score with current hardware'],
                        mathAnalysis: { reason: 'Below threshold in mathematical analysis' }
                    });
                }
            });
            
            this.logger.info(`Mathematical heuristic results: ${compatibility.compatible.length} compatible, ${compatibility.marginal.length} marginal, ${compatibility.incompatible.length} incompatible`);
            
            return compatibility;
            
        } catch (error) {
            this.logger.error('Mathematical heuristic analysis failed, using fallback', { error: error.message });
            
            if (this.progress) {
                this.progress.warn('Advanced analysis failed, falling back to basic compatibility check');
            }
            
            // Fallback al método original
            const compatibility = this.compatibilityAnalyzer.analyzeCompatibility(hardware, staticModels);

            if (ollamaIntegration.compatibleOllamaModels && ollamaIntegration.compatibleOllamaModels.length > 0) {
                for (const ollamaModel of ollamaIntegration.compatibleOllamaModels) {
                    if (ollamaModel.matchedModel && ollamaModel.canRun) {
                        const enhancedModel = {
                            ...ollamaModel.matchedModel,
                            score: ollamaModel.compatibilityScore,
                            issues: ollamaModel.issues || [],
                            notes: [...(ollamaModel.notes || []), 'Installed in Ollama'],
                            performanceEstimate: ollamaModel.performanceEstimate,
                            isOllamaInstalled: true,
                            ollamaInfo: {
                                localName: ollamaModel.name,
                                isRunning: ollamaModel.isRunning,
                                cloudInfo: ollamaModel.cloudInfo
                            }
                        };

                        if (ollamaModel.compatibilityScore >= 75) {
                            compatibility.compatible.push(enhancedModel);
                        } else if (ollamaModel.compatibilityScore >= 60) {
                            compatibility.marginal.push(enhancedModel);
                        }
                    }
                }

                compatibility.compatible.sort((a, b) => b.score - a.score);
                compatibility.marginal.sort((a, b) => b.score - a.score);
            }
            
            return compatibility;
        }
    }

    findBestMatchingKey(ollamaModel, modelsMap) {
        const ollamaName = ollamaModel.model_name.toLowerCase();
        const ollamaId = ollamaModel.model_identifier.toLowerCase();
        
        // Buscar coincidencia exacta por nombre
        for (const [key, model] of modelsMap) {
            if (key.toLowerCase() === ollamaName || 
                model.name.toLowerCase() === ollamaName) {
                return key;
            }
        }
        
        // Buscar por palabras clave del identificador, priorizando matches más exactos
        const keywords = ollamaId.split(/[:\-_]/);
        let bestMatch = null;
        let bestScore = 0;
        
        for (const [key, model] of modelsMap) {
            const modelName = model.name.toLowerCase();
            let score = 0;
            
            // Calcular score de coincidencia
            for (const keyword of keywords) {
                if (keyword.length > 2 && modelName.includes(keyword)) {
                    if (keyword === 'codellama' && ollamaId === 'codellama') {
                        score += 10; // Priorizar codellama exacto sobre phind-codellama
                    } else if (keyword === 'codellama') {
                        score += 5;
                    } else {
                        score += 1;
                    }
                }
            }
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = key;
            }
        }
        
        return bestMatch;
    }
    
    createEnhancedModelFromOllama(ollamaModel, existingModel) {
        // Extract real file size from variants if available
        let realStorageSize = null;
        if (ollamaModel.variants && ollamaModel.variants.length > 0) {
            // Try to match based on the existing model size
            let mainVariant = null;
            
            if (existingModel.size) {
                // Extract size from existing model (e.g., "7B" -> "7b")
                const existingSize = existingModel.size.toLowerCase().replace('b', '');
                // Look for matching variant (e.g., "codellama:7b")
                mainVariant = ollamaModel.variants.find(v => 
                    v.tag.includes(`:${existingSize}b`) && !v.tag.includes('-instruct') && !v.tag.includes('-code')
                );
            }
            
            // Fallback to exact match or latest
            if (!mainVariant) {
                mainVariant = ollamaModel.variants.find(v => 
                    v.tag === ollamaModel.model_identifier || 
                    v.tag === `${ollamaModel.model_identifier}:latest`
                ) || ollamaModel.variants[0];
            }
            
            if (mainVariant && mainVariant.real_size_gb) {
                realStorageSize = mainVariant.real_size_gb;
            }
        }

        return {
            ...existingModel,
            ollamaId: ollamaModel.model_identifier,
            pulls: ollamaModel.pulls,
            lastUpdated: ollamaModel.last_updated,
            description: ollamaModel.description || existingModel.description,
            ollamaAvailable: true,
            requirements: {
                ...existingModel.requirements,
                // Update storage with real size if available
                storage: realStorageSize || existingModel.requirements?.storage
            },
            installation: {
                ...existingModel.installation,
                ollama: `ollama pull ${ollamaModel.model_identifier}`
            }
        };
    }
    
    createModelFromOllamaData(ollamaModel) {
        // Improved size detection with multiple patterns and fallbacks
        let sizeMatch = ollamaModel.model_identifier.match(/(\d+\.?\d*)[bm]/i);
        
        // Try alternative patterns if first doesn't work
        if (!sizeMatch) {
            // Try patterns like "llama3.1" -> estimate as 8B, "qwen2.5" -> 7B
            if (/llama3\.?[12]?/i.test(ollamaModel.model_identifier)) {
                sizeMatch = ['8b', '8'];
            } else if (/qwen2\.?5?/i.test(ollamaModel.model_identifier)) {
                sizeMatch = ['7b', '7'];
            } else if (/mistral/i.test(ollamaModel.model_identifier)) {
                sizeMatch = ['7b', '7'];
            } else if (/gemma/i.test(ollamaModel.model_identifier)) {
                sizeMatch = ['7b', '7'];
            } else if (/phi/i.test(ollamaModel.model_identifier)) {
                sizeMatch = ['3b', '3'];
            }
        }
        
        const size = sizeMatch ? sizeMatch[1] + 'B' : '7B'; // Default to 7B instead of Unknown
        const sizeNum = sizeMatch ? parseFloat(sizeMatch[1]) : 7; // Default to 7B
        
        // Extract real file size from variants if available
        let realStorageSize = null;
        if (ollamaModel.variants && ollamaModel.variants.length > 0) {
            // Find the main variant (usually the first one or one matching the base model name)
            const mainVariant = ollamaModel.variants.find(v => 
                v.tag === ollamaModel.model_identifier || 
                v.tag === `${ollamaModel.model_identifier}:latest`
            ) || ollamaModel.variants[0];
            
            if (mainVariant && mainVariant.real_size_gb) {
                realStorageSize = mainVariant.real_size_gb;
            }
        }
        
        let category = 'medium';
        if (sizeNum < 1) category = 'ultra_small';
        else if (sizeNum <= 4) category = 'small';
        else if (sizeNum <= 15) category = 'medium';
        else category = 'large';
        
        let specialization = 'general';
        const id = ollamaModel.model_identifier.toLowerCase();
        if (id.includes('code')) specialization = 'code';
        else if (id.includes('embed')) specialization = 'embeddings';
        
        return {
            name: ollamaModel.model_name,
            ollamaId: ollamaModel.model_identifier,
            size: size,
            type: 'local',
            category: category,
            specialization: specialization,
            frameworks: ['ollama'],
            requirements: {
                ram: Math.ceil(sizeNum * 0.6) || 2,
                vram: Math.ceil(sizeNum * 0.4) || 0,
                cpu_cores: Math.min(8, Math.max(2, Math.ceil(sizeNum / 2))),
                storage: realStorageSize || Math.ceil(sizeNum * 0.7) || 1
            },
            installation: {
                ollama: `ollama pull ${ollamaModel.model_identifier}`,
                description: ollamaModel.description || 'Available in Ollama library'
            },
            description: ollamaModel.description || `${ollamaModel.model_name} from Ollama`,
            pulls: ollamaModel.pulls,
            lastUpdated: ollamaModel.last_updated,
            year: 2024,
            ollamaAvailable: true
        };
    }
    
    checkIfModelInstalled(model, ollamaIntegration) {
        if (!ollamaIntegration.compatibleOllamaModels) return false;
        
        return ollamaIntegration.compatibleOllamaModels.some(installed => {
            return installed.name.toLowerCase().includes(model.ollamaId?.toLowerCase() || model.name.toLowerCase()) ||
                   (model.ollamaId?.toLowerCase() || model.name.toLowerCase()).includes(installed.name.toLowerCase());
        });
    }
    
    getOllamaModelInfo(model, ollamaIntegration) {
        if (!ollamaIntegration.compatibleOllamaModels) return null;
        
        const installedModel = ollamaIntegration.compatibleOllamaModels.find(installed => {
            return installed.name.toLowerCase().includes(model.ollamaId?.toLowerCase() || model.name.toLowerCase()) ||
                   (model.ollamaId?.toLowerCase() || model.name.toLowerCase()).includes(installed.name.toLowerCase());
        });
        
        return installedModel ? {
            localName: installedModel.name,
            isRunning: installedModel.isRunning,
            cloudInfo: installedModel.cloudInfo
        } : null;
    }

    async processFallbackModels(localModels, runningModels, availableModels, hardware, integration) {
        for (const ollamaModel of localModels) {
            const matchedModel = this.findMatchingModel(ollamaModel, availableModels);

            if (matchedModel) {
                const compatibility = this.compatibilityAnalyzer.calculateModelCompatibility(hardware, matchedModel);

                const enrichedOllamaModel = {
                    ...ollamaModel,
                    matchedModel,
                    compatibilityScore: compatibility.score,
                    issues: compatibility.issues,
                    notes: compatibility.notes,
                    isRunning: runningModels.some(r => r.name === ollamaModel.name),
                    canRun: compatibility.score >= 60,
                    performanceEstimate: await this.performanceAnalyzer.estimateModelPerformance(matchedModel, hardware)
                };

                integration.compatibleOllamaModels.push(enrichedOllamaModel);
            }
        }
    }

    findMatchingModelInDatabase(cloudModel, availableModels) {
        const cloudName = cloudModel.model_name.toLowerCase();
        const cloudId = cloudModel.model_identifier.toLowerCase();

        let match = availableModels.find(m =>
            m.name.toLowerCase() === cloudName ||
            m.name.toLowerCase().includes(cloudId)
        );

        if (match) return match;

        const keywords = cloudId.split('-');
        match = availableModels.find(model => {
            const modelName = model.name.toLowerCase();
            return keywords.some(keyword =>
                keyword.length > 2 && modelName.includes(keyword)
            );
        });

        return match;
    }

    createModelFromCloudData(cloudModel) {
        // Improved size detection for cloud models too
        let sizeMatch = cloudModel.model_identifier.match(/(\d+\.?\d*)[bm]/i);
        
        // Try alternative patterns if first doesn't work
        if (!sizeMatch) {
            if (/llama3\.?[12]?/i.test(cloudModel.model_identifier)) {
                sizeMatch = ['8b', '8'];
            } else if (/qwen2\.?5?/i.test(cloudModel.model_identifier)) {
                sizeMatch = ['7b', '7'];
            } else if (/mistral/i.test(cloudModel.model_identifier)) {
                sizeMatch = ['7b', '7'];
            } else if (/gemma/i.test(cloudModel.model_identifier)) {
                sizeMatch = ['7b', '7'];
            } else if (/phi/i.test(cloudModel.model_identifier)) {
                sizeMatch = ['3b', '3'];
            }
        }
        
        const size = sizeMatch ? sizeMatch[1] + 'B' : '7B'; // Default to 7B instead of Unknown

        let category = 'medium';
        if (size !== '7B') { // Changed from 'Unknown' check
            const sizeNum = parseFloat(size);
            const unit = size.slice(-1);
            const sizeInB = unit === 'M' ? sizeNum / 1000 : sizeNum;

            if (sizeInB < 1) category = 'ultra_small';
            else if (sizeInB <= 4) category = 'small';
            else if (sizeInB <= 15) category = 'medium';
            else category = 'large';
        }

        let specialization = 'general';
        const id = cloudModel.model_identifier.toLowerCase();
        if (id.includes('code')) specialization = 'code';
        else if (id.includes('chat')) specialization = 'chat';
        else if (id.includes('embed')) specialization = 'embeddings';

        return {
            name: cloudModel.model_name,
            size: size,
            type: 'local',
            category: category,
            specialization: specialization,
            frameworks: ['ollama'],
            requirements: {
                ram: Math.ceil((parseFloat(size) || 4) * 0.6),
                vram: Math.ceil((parseFloat(size) || 4) * 0.4),
                cpu_cores: 4,
                storage: Math.ceil((parseFloat(size) || 4) * 0.7)
            },
            installation: {
                ollama: `ollama pull ${cloudModel.model_identifier}`,
                description: cloudModel.description || 'Model from Ollama library'
            },
            year: 2024,
            description: cloudModel.description || `${cloudModel.model_name} model`,
            cloudData: {
                pulls: cloudModel.pulls,
                url: cloudModel.url,
                model_type: cloudModel.model_type,
                identifier: cloudModel.model_identifier
            }
        };
    }

    findMatchingModel(ollamaModel, availableModels) {
        const ollamaName = ollamaModel.name.toLowerCase();

        const nameMapping = {
            'llama3.2:3b': 'Llama 3.2 3B',
            'llama3.1:8b': 'Llama 3.1 8B',
            'mistral:7b': 'Mistral 7B v0.3',
            'mistral:latest': 'Mistral 7B v0.3',
            'codellama:7b': 'CodeLlama 7B',
            'phi3:mini': 'Phi-3 Mini 3.8B',
            'gemma2:2b': 'Gemma 2B',
            'tinyllama:1.1b': 'TinyLlama 1.1B',
            'qwen2.5:7b': 'Qwen 2.5 7B'
        };

        if (nameMapping[ollamaName]) {
            return availableModels.find(m => m.name === nameMapping[ollamaName]);
        }

        const modelKeywords = ollamaName.split(':')[0].split('-');

        return availableModels.find(model => {
            const modelName = model.name.toLowerCase();
            return modelKeywords.some(keyword =>
                keyword.length > 2 && modelName.includes(keyword)
            );
        });
    }

    async generateOllamaRecommendations(hardware, availableModels, installedModels) {
        const recommendations = [];
        const installedNames = new Set(installedModels.map(m => m.name.toLowerCase()));

        const compatibleModels = availableModels.filter(model => {
            const compatibility = this.compatibilityAnalyzer.calculateModelCompatibility(hardware, model);
            return compatibility.score >= 75 && model.frameworks?.includes('ollama');
        });

        for (const model of compatibleModels.slice(0, 5)) {
            const ollamaCommand = this.getOllamaCommand(model);

            if (ollamaCommand && !installedNames.has(ollamaCommand.split(' ')[2])) {
                const performance = await this.performanceAnalyzer.estimateModelPerformance(model, hardware);

                recommendations.push({
                    model,
                    command: ollamaCommand,
                    reason: this.getRecommendationReason(model, hardware),
                    estimatedPerformance: performance,
                    priority: this.calculatePriority(model, hardware)
                });
            }
        }

        return recommendations.sort((a, b) => b.priority - a.priority);
    }

    async enrichWithPerformanceData(hardware, compatibility) {
        const performanceEstimates = new Map();

        for (const model of [...compatibility.compatible, ...compatibility.marginal]) {
            try {
                const estimate = await this.performanceAnalyzer.estimateModelPerformance(model, hardware);
                performanceEstimates.set(model.name, estimate);

                model.performanceEstimate = estimate;
                model.tokensPerSecond = estimate.estimatedTokensPerSecond;
                model.loadTime = estimate.loadTimeEstimate;
            } catch (error) {
                this.logger.warn(`Failed to estimate performance for ${model.name}`, { error });
            }
        }

        return {
            ...compatibility,
            performanceEstimates: Object.fromEntries(performanceEstimates)
        };
    }

    async generateEnhancedRecommendations(hardware, results, ollamaIntegration, useCase) {
        const recommendations = {
            general: [],
            installedModels: [],
            cloudSuggestions: [],
            quickCommands: []
        };

        const generalRecs = this.compatibilityAnalyzer.generateRecommendations(hardware, results);
        recommendations.general.push(...generalRecs);

        if (ollamaIntegration.ollamaInfo.available) {
            if (ollamaIntegration.compatibleOllamaModels.length === 0) {
                recommendations.general.push('No compatible models installed in Ollama');
            } else {
                recommendations.installedModels.push(`${ollamaIntegration.compatibleOllamaModels.length} compatible models found in Ollama:`);

                ollamaIntegration.compatibleOllamaModels.forEach((model, index) => {
                    const runningStatus = model.isRunning ? ' (running)' : '';
                    const score = model.compatibilityScore || 'N/A';
                    recommendations.installedModels.push(`${index + 1}. ${model.name} (Score: ${score}/100)${runningStatus}`);
                });

                const bestModel = ollamaIntegration.compatibleOllamaModels
                    .sort((a, b) => (b.compatibilityScore || 0) - (a.compatibilityScore || 0))[0];

                if (bestModel) {
                    recommendations.quickCommands.push(`ollama run ${bestModel.name}`);
                }
            }

            this.logger.info('Searching for cloud recommendations...');
            try {
                const cloudRecommendations = await this.searchOllamaCloudRecommendations(hardware, ollamaIntegration.compatibleOllamaModels);

                if (cloudRecommendations.length > 0) {
                    this.logger.info(`Found ${cloudRecommendations.length} cloud recommendations`);
                    recommendations.cloudSuggestions.push('Recommended models from Ollama library for your hardware:');
                    cloudRecommendations.forEach((model, index) => {
                        recommendations.cloudSuggestions.push(`${index + 1}. ollama pull ${model.identifier} - ${model.reason} (${model.pulls.toLocaleString()} pulls)`);
                        recommendations.quickCommands.push(`ollama pull ${model.identifier}`);
                    });
                } else {
                    this.logger.warn('No cloud recommendations found, using fallback');
                    this.addFallbackSuggestions(recommendations, ollamaIntegration.compatibleOllamaModels);
                }
            } catch (error) {
                this.logger.error('Failed to get cloud recommendations:', error);
                this.addFallbackSuggestions(recommendations, ollamaIntegration.compatibleOllamaModels);
            }

        } else {
            recommendations.general.push('Install Ollama for local LLM management: https://ollama.ai');
        }

        const useCaseRecs = this.getUseCaseRecommendations(results, useCase);
        recommendations.general.push(...useCaseRecs);

        return recommendations;
    }

    addFallbackSuggestions(recommendations, installedModels) {
        const installedNames = new Set(installedModels.map(m => m.name.toLowerCase()));

        const allSuggestions = [
            { name: 'qwen:0.5b', reason: 'Ultra-fast 0.5B model, runs on any hardware', minRAM: 1, tier: 'any' },
            { name: 'tinyllama:1.1b', reason: 'Tiny but capable, perfect for testing', minRAM: 2, tier: 'any' },
            { name: 'phi3:mini', reason: 'Microsoft\'s efficient 3.8B model with excellent reasoning', minRAM: 4, tier: 'low' },
            { name: 'llama3.2:1b', reason: 'Meta\'s latest compact 1B model', minRAM: 2, tier: 'any' },
            { name: 'llama3.2:3b', reason: 'Meta\'s balanced 3B model', minRAM: 4, tier: 'low' },
            { name: 'gemma2:2b', reason: 'Google\'s optimized 2B model', minRAM: 3, tier: 'any' },
            { name: 'mistral:7b', reason: 'High-quality European 7B model', minRAM: 8, tier: 'medium' },
            { name: 'llama3.1:8b', reason: 'Meta\'s flagship 8B model', minRAM: 10, tier: 'medium' },
            { name: 'qwen2.5:7b', reason: 'Advanced Chinese 7B model', minRAM: 8, tier: 'medium' },
            { name: 'codellama:7b', reason: 'Specialized for coding tasks', minRAM: 8, tier: 'medium', specialty: 'code' },
            { name: 'nomic-embed-text', reason: 'Best for text embeddings', minRAM: 2, tier: 'any', specialty: 'embeddings' }
        ];

        const availableSuggestions = allSuggestions.filter(model =>
            !installedNames.has(model.name) && !installedNames.has(model.name.split(':')[0])
        );

        if (availableSuggestions.length > 0) {
            recommendations.cloudSuggestions.push('Curated model suggestions for your hardware:');
            availableSuggestions.slice(0, 5).forEach((model, index) => {
                recommendations.cloudSuggestions.push(`${index + 1}. ollama pull ${model.name} - ${model.reason}`);
                recommendations.quickCommands.push(`ollama pull ${model.name}`);
            });
        }
    }

    async searchOllamaCloudRecommendations(hardware, installedModels) {
        try {
            this.logger.info('Searching Ollama cloud for compatible models...');
            const { getOllamaModelsIntegration } = require('./ollama/native-scraper');

            const allModelsData = await getOllamaModelsIntegration([]);

            if (!allModelsData.recommendations || allModelsData.recommendations.length === 0) {
                this.logger.warn('No recommendations found from cloud search');
                return [];
            }

            this.logger.info(`Found ${allModelsData.recommendations.length} total models from cloud`);

            const installedIdentifiers = new Set(
                installedModels.map(m => {
                    const name = m.name.toLowerCase();
                    return name.split(':')[0];
                })
            );

            this.logger.info(`Installed models identifiers: ${Array.from(installedIdentifiers).join(', ')}`);

            const hardwareTier = this.getHardwareTier(hardware);
            this.logger.info(`Hardware tier: ${hardwareTier}`);

            const compatibleModels = allModelsData.recommendations
                .filter(model => {
                    const baseIdentifier = model.model_identifier.split(':')[0].toLowerCase();
                    const isNotInstalled = !installedIdentifiers.has(baseIdentifier) &&
                        !installedIdentifiers.has(model.model_identifier.toLowerCase());

                    if (!isNotInstalled) {
                        this.logger.debug(`Skipping already installed model: ${model.model_identifier}`);
                    }
                    return isNotInstalled;
                })
                .map(model => {
                    const score = this.calculateCloudModelCompatibility(model, hardware);
                    return {
                        ...model,
                        compatibilityScore: score,
                        reason: this.getCloudModelReason(model, hardware)
                    };
                })
                .filter(model => {
                    const isCompatible = model.compatibilityScore >= 60;
                    if (!isCompatible) {
                        this.logger.debug(`Model ${model.model_identifier} has low compatibility score: ${model.compatibilityScore}`);
                    }
                    return isCompatible;
                })
                .sort((a, b) => {
                    if (b.compatibilityScore !== a.compatibilityScore) {
                        return b.compatibilityScore - a.compatibilityScore;
                    }
                    return (b.pulls || 0) - (a.pulls || 0);
                })
                .slice(0, 5);

            this.logger.info(`Final compatible models for recommendations: ${compatibleModels.length}`);
            compatibleModels.forEach(model => {
                this.logger.debug(`Recommending: ${model.model_identifier} (score: ${model.compatibilityScore}, pulls: ${model.pulls})`);
            });

            return compatibleModels.map(model => ({
                identifier: model.model_identifier,
                name: model.model_name,
                pulls: model.pulls || 0,
                reason: model.reason,
                score: model.compatibilityScore,
                size: this.extractModelSize(model.model_identifier),
                description: model.description || ''
            }));

        } catch (error) {
            this.logger.error('Error searching Ollama cloud recommendations:', error);
            return [];
        }
    }

    getHardwareTier(hardware) {
        return this.calculateHardwareScore(hardware).tier;
    }

    calculateHardwareScore(hardware) {
        const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
        
        // Extract hardware info
        const ramGB = hardware.memory.total || 0;
        const vramGB = hardware.gpu?.vram || 0;
        const cpuModel = hardware.cpu?.brand || hardware.cpu?.model || '';
        const gpuModel = hardware.gpu?.model || '';
        const architecture = hardware.cpu?.architecture || hardware.cpu?.brand || '';
        const cpuCoresPhys = hardware.cpu?.physicalCores || hardware.cpu?.cores || 1;
        const cpuGHzBase = hardware.cpu?.speed || 2.0;
        
        // Enhanced Apple Silicon detection
        const isAppleSilicon = architecture.toLowerCase().includes('apple') || 
                              architecture.toLowerCase().includes('m1') || 
                              architecture.toLowerCase().includes('m2') ||
                              architecture.toLowerCase().includes('m3') ||
                              architecture.toLowerCase().includes('m4') ||
                              cpuModel.toLowerCase().includes('apple') ||
                              gpuModel.toLowerCase().includes('apple');
        const unified = isAppleSilicon;
        
        // Detect PC platform (Windows/Linux)
        const isPC = !isAppleSilicon && (process.platform === 'win32' || process.platform === 'linux');
        const hasAVX512 = cpuModel.toLowerCase().includes('intel') && 
                         (cpuModel.includes('12th') || cpuModel.includes('13th') || cpuModel.includes('14th'));
        const hasAVX2 = cpuModel.toLowerCase().includes('intel') || 
                       cpuModel.toLowerCase().includes('amd');
        
        // 1) Capacidad efectiva para pesos del modelo (45%)
        let effMem;
        
        if (vramGB > 0 && !unified) {
            // Dedicated GPU path (Windows/Linux with discrete GPU)
            if (isPC) {
                // PC-specific GPU memory calculation with offload support
                const PCOptimizer = require('./hardware/pc-optimizer');
                const pcOpt = new PCOptimizer();
                const pcSpecs = this.getPCGPUSpecs(hardware, vramGB, ramGB);
                
                // For PC discrete GPU: VRAM + strategic offload potential
                effMem = vramGB + pcSpecs.offloadCapacity;
            } else {
                // Generic discrete GPU calculation
                effMem = vramGB + Math.min(0.25 * ramGB, 8);  // GPU + small CPU offload
            }
        } else if (unified && isAppleSilicon) {
            // Apple Silicon unified memory optimization
            const appleSiliconInfo = this.getAppleSiliconSpecs(cpuModel, gpuModel, ramGB);
            
            // For Apple Silicon, use higher efficiency ratio due to:
            // 1. Unified memory architecture (no GPU<->RAM transfers)
            // 2. High memory bandwidth (200-800 GB/s)
            // 3. Optimized quantization-aware memory allocation
            // 4. Metal backend optimizations
            effMem = appleSiliconInfo.effectiveMemoryRatio * ramGB;
            
            // Apply model size bonus for larger unified memory pools
            if (ramGB >= 32) {
                effMem += appleSiliconInfo.largeMemoryBonus;
            }
        } else {
            // Traditional CPU-only path or integrated GPU
            if (isPC) {
                // PC CPU-only with potential iGPU assist
                const pcSpecs = this.getPCCPUSpecs(hardware, ramGB);
                effMem = pcSpecs.effectiveMemoryRatio * ramGB;
            } else {
                // Generic CPU-only calculation
                effMem = 0.6 * ramGB;  // Conservative for CPU inference
            }
        }
        
        const mem_cap = clamp(effMem / 32);  // Normalizado contra 32GB para Q4-Q6 (más realista)
        
        // 2) Ancho de banda de memoria (20%)
        let memBandwidthGBs = this.estimateMemoryBandwidth(hardware);
        const mem_bw = clamp(memBandwidthGBs / 500);  // Normalizado contra 500 GB/s (más realista)
        
        // 3) Cómputo (20%)
        let compute;
        const tflopsFP16 = this.estimateComputeTFLOPs(hardware);
        
        if (tflopsFP16 > 0) {
            compute = clamp(tflopsFP16 / 80);  // GPU: normalizado contra 80 TFLOPs (más realista)
            
            // Cap iGPU compute
            if (/iris xe|uhd|vega.*integrated|radeon.*graphics/i.test(gpuModel)) {
                compute = Math.min(compute, 0.15);
            }
        } else {
            // CPU path
            compute = clamp((cpuCoresPhys * cpuGHzBase) / 60);
            if (hasAVX512) compute = Math.min(1, compute + 0.1);
            else if (hasAVX2) compute = Math.min(1, compute + 0.05);
        }
        
        // 4) RAM del sistema para KV-cache (10%)
        const sys_ram = clamp(ramGB / 64);
        
        // 5) Almacenamiento (5%)
        const storageClass = this.detectStorageClass(hardware);
        const storage = storageClass === 'NVME' ? 1.0 : 
                       storageClass === 'SSD' ? 0.4 : 0.1;
        
        // Score final (0-100)
        let score = 100 * (
            0.45 * mem_cap + 
            0.20 * mem_bw + 
            0.20 * compute + 
            0.10 * sys_ram + 
            0.05 * storage
        );
        
        // Mapear score → tier (final adjusted thresholds)
        let tier = score >= 75 ? 'ultra_high' :    // 75+ for highest-end systems (RTX 4090, etc)
                  score >= 55 ? 'high' :           // 55-74 for high-end systems like M4 Pro
                  score >= 35 ? 'medium' :         // 35-54 for mid-range systems
                  score >= 20 ? 'low' : 'ultra_low'; // 20-34 for budget systems
        
        // Detect if system has dedicated GPU (not integrated) - improved detection
        const hasIntegratedGPU = /iris.*xe|iris.*graphics|uhd.*graphics|vega.*integrated|radeon.*graphics|intel.*integrated|integrated/i.test(gpuModel);
        const hasDedicatedGPU = vramGB > 0 && !hasIntegratedGPU && !unified;
        
        // Debug logging for tier calculation
        if (process.env.DEBUG_TIER) {
            console.log(`GPU Model: "${gpuModel}"`);
            console.log(`Has Integrated GPU: ${hasIntegratedGPU}`);
            console.log(`Has Dedicated GPU: ${hasDedicatedGPU}`);
            console.log(`VRAM: ${vramGB}GB`);
            console.log(`Unified: ${unified}`);
            console.log(`Initial Tier: ${tier}`);
        }
        
        // Cap tier for systems without dedicated GPU to avoid overselling capabilities
        if (!hasDedicatedGPU && !unified) {
            // Cap iGPU and CPU-only systems at 'high' tier maximum
            const maxTier = 'high';
            const tierValues = { 'ultra_low': 0, 'low': 1, 'medium': 2, 'high': 3, 'ultra_high': 4 };
            const currentTierValue = tierValues[tier] || 0;
            const maxTierValue = tierValues[maxTier];
            if (currentTierValue > maxTierValue) {
                tier = maxTier;
            }
        }
        
        // Ajustes realistas basados en capacidades reales de LLM inference
        if (vramGB >= 24 && memBandwidthGBs >= 400) {
            // High-end dedicated GPU boost (RTX 4090, etc.)
            tier = this.bumpTier(tier, +1);
        } else if (!vramGB && !unified) {
            // Windows/Linux CPU-only - significativa limitación pero no extrema
            tier = this.bumpTier(tier, -1);
        } else if (hasIntegratedGPU) {
            // iGPU - limitada pero algo mejor que CPU puro
            tier = this.bumpTier(tier, -1);
        } else if (vramGB > 0 && vramGB < 6) {
            // GPU dedicada con poca VRAM (GTX 1060, etc.)
            tier = this.bumpTier(tier, -1);
        }
        
        return {
            score: Math.round(score),
            tier: tier,
            breakdown: {
                memory_capacity: Math.round(mem_cap * 45),
                memory_bandwidth: Math.round(mem_bw * 20),
                compute: Math.round(compute * 20),
                system_ram: Math.round(sys_ram * 10),
                storage: Math.round(storage * 5),
                effective_memory_gb: Math.round(effMem * 10) / 10,
                bandwidth_gbs: Math.round(memBandwidthGBs),
                tflops_fp16: tflopsFP16 > 0 ? Math.round(tflopsFP16 * 10) / 10 : 0,
                apple_silicon_optimized: isAppleSilicon,
                pc_optimized: isPC
            }
        };
    }
    
    /**
     * Apple Silicon-specific specifications and optimization parameters
     * Based on unified memory architecture and quantization-aware allocation
     */
    getAppleSiliconSpecs(cpuModel, gpuModel, ramGB) {
        const cpu = cpuModel.toLowerCase();
        const gpu = gpuModel.toLowerCase();
        
        // Base specs for different Apple Silicon generations
        let baseSpecs = {
            effectiveMemoryRatio: 0.85,  // Default unified memory efficiency
            largeMemoryBonus: 0,         // Bonus for large memory configs
            memoryBandwidth: 100,        // GB/s
            quantizationEfficiency: 1.0, // Quantization optimization factor
            metalOptimization: 1.2       // Metal backend boost
        };
        
        // M4 Pro/Max optimizations
        if (cpu.includes('m4 pro') || gpu.includes('m4 pro')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.90,  // Higher efficiency due to newer architecture
                largeMemoryBonus: 4,         // 4GB bonus for 32GB+ configs
                memoryBandwidth: 273,        // 273 GB/s memory bandwidth
                quantizationEfficiency: 1.15, // Better quantization support
                metalOptimization: 1.3       // Enhanced Metal backend
            };
        } else if (cpu.includes('m4') || gpu.includes('m4')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.88,
                largeMemoryBonus: 2,
                memoryBandwidth: 120,
                quantizationEfficiency: 1.10,
                metalOptimization: 1.25
            };
        }
        // M3 optimizations
        else if (cpu.includes('m3 max') || gpu.includes('m3 max')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.87,
                largeMemoryBonus: 3,
                memoryBandwidth: 400,
                quantizationEfficiency: 1.08,
                metalOptimization: 1.2
            };
        } else if (cpu.includes('m3 pro') || gpu.includes('m3 pro')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.86,
                largeMemoryBonus: 2,
                memoryBandwidth: 150,
                quantizationEfficiency: 1.05,
                metalOptimization: 1.15
            };
        } else if (cpu.includes('m3') || gpu.includes('m3')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.85,
                largeMemoryBonus: 1,
                memoryBandwidth: 100,
                quantizationEfficiency: 1.03,
                metalOptimization: 1.1
            };
        }
        // M2 optimizations
        else if (cpu.includes('m2 max') || gpu.includes('m2 max')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.84,
                largeMemoryBonus: 2,
                memoryBandwidth: 400,
                quantizationEfficiency: 1.02,
                metalOptimization: 1.1
            };
        } else if (cpu.includes('m2 pro') || gpu.includes('m2 pro')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.83,
                largeMemoryBonus: 1,
                memoryBandwidth: 200,
                quantizationEfficiency: 1.0,
                metalOptimization: 1.05
            };
        } else if (cpu.includes('m2') || gpu.includes('m2')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.82,
                largeMemoryBonus: 0,
                memoryBandwidth: 100,
                quantizationEfficiency: 1.0,
                metalOptimization: 1.0
            };
        }
        // M1 optimizations (legacy but still supported)
        else if (cpu.includes('m1 max') || gpu.includes('m1 max')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.80,
                largeMemoryBonus: 1,
                memoryBandwidth: 400,
                quantizationEfficiency: 0.95,
                metalOptimization: 1.0
            };
        } else if (cpu.includes('m1 pro') || gpu.includes('m1 pro')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.78,
                largeMemoryBonus: 0,
                memoryBandwidth: 200,
                quantizationEfficiency: 0.95,
                metalOptimization: 0.95
            };
        } else if (cpu.includes('m1') || gpu.includes('m1')) {
            baseSpecs = {
                effectiveMemoryRatio: 0.75,
                largeMemoryBonus: 0,
                memoryBandwidth: 68.25,
                quantizationEfficiency: 0.90,
                metalOptimization: 0.90
            };
        }
        
        // Apply memory configuration scaling
        if (ramGB >= 64) {
            baseSpecs.effectiveMemoryRatio += 0.03;  // Bonus for very large memory
            baseSpecs.largeMemoryBonus += 2;
        } else if (ramGB >= 32) {
            baseSpecs.effectiveMemoryRatio += 0.02;  // Bonus for large memory
        } else if (ramGB <= 8) {
            baseSpecs.effectiveMemoryRatio -= 0.05;  // Penalty for small memory
        }
        
        return baseSpecs;
    }
    
    /**
     * PC GPU-specific specifications for Windows/Linux discrete GPU systems
     */
    getPCGPUSpecs(hardware, vramGB, ramGB) {
        const gpuModel = hardware.gpu?.model || '';
        const gpu = gpuModel.toLowerCase();
        
        let specs = {
            offloadCapacity: 0,      // Additional effective memory from RAM offload
            memoryEfficiency: 0.85,  // VRAM utilization efficiency
            backendOptimization: 1.0, // Backend-specific optimization
            quantizationSupport: 1.0  // Quantization efficiency
        };
        
        // NVIDIA GPU optimizations
        if (gpu.includes('nvidia') || gpu.includes('geforce') || gpu.includes('rtx') || gpu.includes('gtx')) {
            if (gpu.includes('rtx 50')) {
                specs = {
                    offloadCapacity: Math.min(ramGB * 0.3, 12),  // Up to 12GB offload for RTX 50 series
                    memoryEfficiency: 0.92,
                    backendOptimization: 1.2,  // Excellent CUDA optimization
                    quantizationSupport: 1.15  // Great quantization support
                };
            } else if (gpu.includes('rtx 40')) {
                specs = {
                    offloadCapacity: Math.min(ramGB * 0.25, 10),  // Up to 10GB offload for RTX 40 series
                    memoryEfficiency: 0.90,
                    backendOptimization: 1.15,
                    quantizationSupport: 1.10
                };
            } else if (gpu.includes('rtx 30')) {
                specs = {
                    offloadCapacity: Math.min(ramGB * 0.2, 8),   // Up to 8GB offload for RTX 30 series
                    memoryEfficiency: 0.88,
                    backendOptimization: 1.10,
                    quantizationSupport: 1.05
                };
            } else if (gpu.includes('rtx 20') || gpu.includes('gtx 16')) {
                specs = {
                    offloadCapacity: Math.min(ramGB * 0.15, 6),  // Up to 6GB offload for older cards
                    memoryEfficiency: 0.85,
                    backendOptimization: 1.05,
                    quantizationSupport: 1.0
                };
            }
        }
        // AMD GPU optimizations
        else if (gpu.includes('amd') || gpu.includes('radeon') || gpu.includes('rx ')) {
            if (gpu.includes('rx 7000') || gpu.includes('rx 7900') || gpu.includes('rx 7800')) {
                specs = {
                    offloadCapacity: Math.min(ramGB * 0.2, 8),   // Good offload for RDNA3
                    memoryEfficiency: 0.85,
                    backendOptimization: 0.95,  // ROCm slightly behind CUDA
                    quantizationSupport: 1.0
                };
            } else if (gpu.includes('rx 6000')) {
                specs = {
                    offloadCapacity: Math.min(ramGB * 0.15, 6),  // Moderate offload for RDNA2
                    memoryEfficiency: 0.82,
                    backendOptimization: 0.90,
                    quantizationSupport: 0.95
                };
            }
        }
        // Intel GPU optimizations
        else if (gpu.includes('intel') || gpu.includes('arc')) {
            if (gpu.includes('arc a7') || gpu.includes('arc a5')) {
                specs = {
                    offloadCapacity: Math.min(ramGB * 0.2, 6),   // Decent offload for Arc discrete
                    memoryEfficiency: 0.80,
                    backendOptimization: 0.85,  // Intel drivers still maturing
                    quantizationSupport: 0.90
                };
            }
        }
        
        // Apply memory scaling bonuses
        if (ramGB >= 32) {
            specs.offloadCapacity += 2;  // Extra offload potential with large RAM
        }
        if (vramGB >= 16) {
            specs.memoryEfficiency += 0.02;  // High VRAM efficiency bonus
        }
        
        return specs;
    }
    
    /**
     * PC CPU-specific specifications for Windows/Linux CPU-only or iGPU systems
     */
    getPCCPUSpecs(hardware, ramGB) {
        const cpuModel = hardware.cpu?.brand || hardware.cpu?.model || '';
        const gpuModel = hardware.gpu?.model || '';
        const cpu = cpuModel.toLowerCase();
        const gpu = gpuModel.toLowerCase();
        const cores = hardware.cpu?.physicalCores || hardware.cpu?.cores || 1;
        
        let specs = {
            effectiveMemoryRatio: 0.6,   // Default CPU memory efficiency
            instructionOptimization: 1.0, // CPU instruction set bonus
            iGPUAssist: 0,               // Integrated GPU assistance
            thermalHeadroom: 1.0         // Thermal performance factor
        };
        
        // Intel CPU optimizations
        if (cpu.includes('intel')) {
            if (cpu.includes('i9') || cpu.includes('13th gen') || cpu.includes('14th gen')) {
                specs.effectiveMemoryRatio = 0.75;  // High-end Intel efficiency
                specs.instructionOptimization = 1.15; // AVX512 + optimization
            } else if (cpu.includes('i7') || cpu.includes('12th gen')) {
                specs.effectiveMemoryRatio = 0.70;
                specs.instructionOptimization = 1.10;  // AVX2 + some AVX512
            } else if (cpu.includes('i5')) {
                specs.effectiveMemoryRatio = 0.65;
                specs.instructionOptimization = 1.05;
            }
            
            // Intel iGPU assistance
            if (gpu.includes('iris xe')) {
                specs.iGPUAssist = 0.05;  // 5% effective memory boost from iGPU
                specs.effectiveMemoryRatio += 0.05;
            } else if (gpu.includes('uhd')) {
                specs.iGPUAssist = 0.02;  // Minimal iGPU assistance
                specs.effectiveMemoryRatio += 0.02;
            }
        }
        // AMD CPU optimizations
        else if (cpu.includes('amd') || cpu.includes('ryzen')) {
            if (cpu.includes('ryzen 9') || cpu.includes('7000') || cpu.includes('9000')) {
                specs.effectiveMemoryRatio = 0.72;  // High-end AMD efficiency
                specs.instructionOptimization = 1.12; // Strong AVX2 performance
            } else if (cpu.includes('ryzen 7') || cpu.includes('5000') || cpu.includes('6000')) {
                specs.effectiveMemoryRatio = 0.68;
                specs.instructionOptimization = 1.08;
            } else if (cpu.includes('ryzen 5')) {
                specs.effectiveMemoryRatio = 0.65;
                specs.instructionOptimization = 1.05;
            }
            
            // AMD iGPU assistance (RDNA2/3 in APUs)
            if (gpu.includes('radeon') && gpu.includes('graphics')) {
                if (gpu.includes('780m') || gpu.includes('880m')) {
                    specs.iGPUAssist = 0.08;  // Strong RDNA3 iGPU
                    specs.effectiveMemoryRatio += 0.08;
                } else if (gpu.includes('680m') || gpu.includes('660m')) {
                    specs.iGPUAssist = 0.06;  // Good RDNA2 iGPU
                    specs.effectiveMemoryRatio += 0.06;
                }
            }
        }
        
        // Multi-core efficiency scaling
        if (cores >= 16) {
            specs.effectiveMemoryRatio += 0.05;  // High core count bonus
        } else if (cores >= 8) {
            specs.effectiveMemoryRatio += 0.03;
        }
        
        // Memory configuration scaling
        if (ramGB >= 64) {
            specs.effectiveMemoryRatio += 0.05;  // Large memory pool bonus
        } else if (ramGB >= 32) {
            specs.effectiveMemoryRatio += 0.03;
        } else if (ramGB <= 8) {
            specs.effectiveMemoryRatio -= 0.05;  // Small memory penalty
        }
        
        return specs;
    }
    
    /**
     * Generate PC-specific recommendations with backend and offload strategies
     */
    async generatePCRecommendations(hardware) {
        if (!hardware || hardware.cpu?.architecture?.toLowerCase().includes('apple')) {
            return null; // Not a PC system
        }
        
        try {
            const PCOptimizer = require('./hardware/pc-optimizer');
            const pcOptimizer = new PCOptimizer();
            
            // Get detailed PC capabilities
            const pcCapabilities = await pcOptimizer.detectPCCapabilities();
            
            // Generate hardware-specific recommendations
            const recommendations = pcOptimizer.generateRecommendations(pcCapabilities);
            
            return {
                platform: 'PC (Windows/Linux)',
                backend: recommendations.backend,
                capability: recommendations.capability,
                recommendations: recommendations.recommendations,
                hardwareProfile: {
                    gpu: pcCapabilities.gpu,
                    cpu: pcCapabilities.cpu,
                    memory: pcCapabilities.memory,
                    availableBackends: pcCapabilities.backends
                }
            };
        } catch (error) {
            this.logger.warn('PC optimization failed', { error: error.message });
            return null;
        }
    }
    
    bumpTier(tier, direction) {
        const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
        const tiers = ['ultra_low', 'low', 'medium', 'high', 'ultra_high'];
        const index = tiers.indexOf(tier);
        const newIndex = clamp(index + direction, 0, tiers.length - 1);
        return tiers[newIndex];
    }
    
    estimateMemoryBandwidth(hardware) {
        const gpuModel = hardware.gpu?.model || '';
        const ramType = hardware.memory?.type || 'DDR4';
        const ramSpeed = hardware.memory?.clockSpeed || 3200;
        
        // GPU bandwidth (known values)
        const gpu = gpuModel.toLowerCase();
        if (gpu.includes('rtx 4090')) return 1008;
        if (gpu.includes('rtx 4080')) return 716;
        if (gpu.includes('rtx 4070 ti')) return 504;
        if (gpu.includes('rtx 4070')) return 448;
        if (gpu.includes('rtx 4060 ti')) return 288;
        if (gpu.includes('rtx 4060')) return 272;
        if (gpu.includes('rtx 3090')) return 936;
        if (gpu.includes('rtx 3080')) return 760;
        if (gpu.includes('rtx 3070')) return 448;
        if (gpu.includes('rx 7900 xtx')) return 960;
        if (gpu.includes('rx 7900 xt')) return 800;
        if (gpu.includes('rx 6800 xt')) return 512;
        if (gpu.includes('m4 pro')) return 273;  // Apple M4 Pro
        if (gpu.includes('m4')) return 120;      // Apple M4
        if (gpu.includes('m3 max')) return 400;
        if (gpu.includes('m3 pro')) return 150;
        if (gpu.includes('m3')) return 100;
        
        // Intel iGPU bandwidth (limited)
        if (gpu.includes('iris xe')) return 68;
        if (gpu.includes('uhd')) return 47;
        
        // Fallback to system RAM bandwidth
        const channels = 2; // Most common
        if (ramType.includes('DDR5')) {
            return (ramSpeed * channels * 8) / 1000; // MT/s to GB/s
        } else if (ramType.includes('DDR4')) {
            return (ramSpeed * channels * 8) / 1000;
        }
        
        return 50; // Conservative fallback
    }
    
    estimateComputeTFLOPs(hardware) {
        const gpuModel = hardware.gpu?.model || '';
        const gpu = gpuModel.toLowerCase();
        
        // Known GPU TFLOPs FP16
        if (gpu.includes('rtx 4090')) return 165;
        if (gpu.includes('rtx 4080')) return 121;
        if (gpu.includes('rtx 4070 ti')) return 83;
        if (gpu.includes('rtx 4070')) return 64;
        if (gpu.includes('rtx 4060 ti')) return 44;
        if (gpu.includes('rtx 4060')) return 32;
        if (gpu.includes('rtx 3090')) return 142;
        if (gpu.includes('rtx 3080')) return 116;
        if (gpu.includes('rtx 3070')) return 82;
        if (gpu.includes('rx 7900 xtx')) return 123;
        if (gpu.includes('rx 7900 xt')) return 103;
        if (gpu.includes('rx 6800 xt')) return 65;
        if (gpu.includes('m4 pro')) return 28;   // Apple M4 Pro GPU
        if (gpu.includes('m4')) return 15;       // Apple M4 GPU
        if (gpu.includes('m3 max')) return 40;
        if (gpu.includes('m3 pro')) return 20;
        if (gpu.includes('m3')) return 10;
        
        // Intel iGPU (very limited)
        if (gpu.includes('iris xe')) return 2;
        if (gpu.includes('uhd')) return 0.5;
        
        return 0; // Use CPU path
    }
    
    detectStorageClass(hardware) {
        // This would need to be enhanced with actual storage detection
        // For now, assume NVMe for modern systems
        const architecture = hardware.cpu?.architecture || hardware.cpu?.brand || '';
        if (architecture.toLowerCase().includes('apple') || 
            architecture.toLowerCase().includes('m1') || 
            architecture.toLowerCase().includes('m2') ||
            architecture.toLowerCase().includes('m3') ||
            architecture.toLowerCase().includes('m4')) {
            return 'NVME'; // Apple Silicon typically has fast storage
        }
        
        return 'NVME'; // Conservative assumption for modern systems
    }

    calculateCloudModelCompatibility(model, hardware) {
        let score = 50;

        const sizeMatch = model.model_identifier.match(/(\d+\.?\d*)[bm]/i);
        let modelSizeB = 1;

        if (sizeMatch) {
            const num = parseFloat(sizeMatch[1]);
            const unit = sizeMatch[0].slice(-1).toLowerCase();
            modelSizeB = unit === 'm' ? num / 1000 : num;
        }

        const estimatedRAM = modelSizeB * 1.2;
        const ramRatio = hardware.memory.total / estimatedRAM;

        if (ramRatio >= 3) {
            score += 40;
        } else if (ramRatio >= 2) {
            score += 30;
        } else if (ramRatio >= 1.5) {
            score += 20;
        } else if (ramRatio >= 1.2) {
            score += 10;
        } else {
            score -= 20;
        }

        if (modelSizeB <= 0.5) {
            score += 25;
        } else if (modelSizeB <= 1) {
            score += 20;
        } else if (modelSizeB <= 3) {
            score += 15;
        } else if (modelSizeB <= 7) {
            score += 10;
        } else if (modelSizeB <= 13) {
            score += 5;
        } else {
            score -= 15;
        }

        const hardwareTier = this.getHardwareTier(hardware);
        switch (hardwareTier) {
            case 'ultra_high':
                score += 15;
                break;
            case 'high':
                score += 10;
                break;
            case 'medium':
                score += 5;
                break;
            case 'low':
                if (modelSizeB <= 3) score += 5;
                break;
            case 'ultra_low':
                if (modelSizeB <= 1) score += 10;
                else score -= 10;
                break;
        }

        if (hardware.cpu.cores >= 8) {
            score += 10;
        } else if (hardware.cpu.cores >= 4) {
            score += 5;
        } else if (hardware.cpu.cores < 4) {
            score -= 5;
        }

        const pulls = model.pulls || 0;
        if (pulls > 10000000) {
            score += 15;
        } else if (pulls > 1000000) {
            score += 10;
        } else if (pulls > 100000) {
            score += 5;
        }

        if (model.model_type === 'official') {
            score += 8;
        }

        const identifier = model.model_identifier.toLowerCase();
        if (identifier.includes('tinyllama') || identifier.includes('phi3') || identifier.includes('qwen')) {
            score += 5;
        }

        if (identifier.includes('code') && hardware.cpu.cores >= 6) {
            score += 5;
        }

        if (identifier.includes('mini') || identifier.includes('tiny')) {
            score += 8;
        }

        if (hardware.cpu.architecture === 'Apple Silicon') {
            score += 5;
        }

        this.logger.debug(`Model ${model.model_identifier}: size=${modelSizeB}B, RAM ratio=${ramRatio.toFixed(2)}, score=${score}`);

        return Math.max(0, Math.min(100, Math.round(score)));
    }

    getCloudModelReason(model, hardware) {
        const identifier = model.model_identifier.toLowerCase();
        const sizeMatch = model.model_identifier.match(/(\d+\.?\d*)[bm]/i);
        const modelSizeB = sizeMatch ?
            (sizeMatch[0].slice(-1).toLowerCase() === 'm' ? parseFloat(sizeMatch[1]) / 1000 : parseFloat(sizeMatch[1])) : 1;

        if (identifier.includes('qwen') && modelSizeB <= 1) {
            return 'Ultra-efficient Chinese model, great for limited hardware';
        }
        if (identifier.includes('tinyllama')) {
            return 'Tiny but capable, perfect for testing and light tasks';
        }
        if (identifier.includes('phi3') && identifier.includes('mini')) {
            return 'Microsoft\'s efficient model with excellent reasoning';
        }
        if (identifier.includes('gemma') && modelSizeB <= 2) {
            return 'Google\'s compact model, well-optimized';
        }
        if (identifier.includes('mistral') && modelSizeB <= 7) {
            return 'High-quality European model, excellent performance';
        }
        if (identifier.includes('llama3.2') && modelSizeB <= 3) {
            return 'Meta\'s latest compact model, state-of-the-art';
        }
        if (identifier.includes('code')) {
            return 'Specialized for coding tasks';
        }

        const ramRatio = hardware.memory.total / (modelSizeB * 0.6);

        if (modelSizeB <= 1) {
            return 'Ultra-small model, runs very fast on your hardware';
        } else if (modelSizeB <= 3 && ramRatio >= 2) {
            return 'Small model with good performance balance';
        } else if (modelSizeB <= 7 && ramRatio >= 1.5) {
            return 'Medium-sized model, good capabilities';
        } else if (ramRatio >= 1.2) {
            return 'Should run well on your system';
        } else {
            return 'Recommended with quantization for your hardware';
        }
    }

    extractModelSize(identifier) {
        const sizeMatch = identifier.match(/(\d+\.?\d*)[bm]/i);
        if (sizeMatch) {
            const num = parseFloat(sizeMatch[1]);
            const unit = sizeMatch[0].slice(-1).toUpperCase();
            return `${num}${unit}`;
        }
        return 'Unknown';
    }

    getOllamaCommand(model) {
        const mapping = {
            'TinyLlama 1.1B': 'ollama pull tinyllama:1.1b',
            'Qwen 0.5B': 'ollama pull qwen:0.5b',
            'Gemma 2B': 'ollama pull gemma2:2b',
            'Phi-3 Mini 3.8B': 'ollama pull phi3:mini',
            'Llama 3.2 3B': 'ollama pull llama3.2:3b',
            'Llama 3.1 8B': 'ollama pull llama3.1:8b',
            'Mistral 7B v0.3': 'ollama pull mistral:7b',
            'CodeLlama 7B': 'ollama pull codellama:7b',
            'Qwen 2.5 7B': 'ollama pull qwen2.5:7b'
        };

        return mapping[model.name] || null;
    }

    getRecommendationReason(model, hardware) {
        if (model.specialization === 'code') {
            return 'Excellent for coding tasks';
        }
        if (hardware.memory.total >= 16 && model.size.includes('8B')) {
            return 'Perfect size for your RAM capacity';
        }
        if (model.category === 'small' && hardware.memory.total < 16) {
            return 'Optimized for systems with limited RAM';
        }
        return 'Great balance of performance and efficiency';
    }

    calculatePriority(model, hardware) {
        let priority = 50;
        const modelSize = this.parseModelSize(model.size);
        const requiredRAM = model.requirements?.ram || 4;
        const ramRatio = hardware.memory.total / requiredRAM;

        if (ramRatio >= 2) priority += 20;
        else if (ramRatio >= 1.5) priority += 10;
        else if (ramRatio < 1) priority -= 20;

        if (modelSize <= 1) priority += 15;
        else if (modelSize <= 3) priority += 10;
        else if (modelSize <= 7) priority += 5;
        else if (modelSize > 30) priority -= 15;

        if (model.specialization === 'code') priority += 15;
        else if (model.specialization === 'chat') priority += 10;
        else if (model.specialization === 'embeddings') priority += 5;

        if (model.year >= 2024) priority += 10;
        else if (model.year >= 2023) priority += 5;

        if (hardware.gpu.dedicated && model.requirements?.vram > 0) {
            if (hardware.gpu.vram >= model.requirements.vram) {
                priority += 10;
            } else {
                priority -= 5;
            }
        }

        if (hardware.cpu.architecture === 'Apple Silicon' &&
            model.frameworks?.includes('llama.cpp')) {
            priority += 8;
        }

        return Math.max(0, priority);
    }

    parseModelSize(sizeString) {
        const match = sizeString.match(/(\d+\.?\d*)[BM]/i);
        if (!match) return 1;

        const num = parseFloat(match[1]);
        const unit = match[0].slice(-1).toUpperCase();

        return unit === 'B' ? num : num / 1000;
    }

    getUseCaseRecommendations(results, useCase) {
        const recommendations = [];

        switch (useCase) {
            case 'code':
                const codeModels = results.compatible.filter(m => m.specialization === 'code');
                if (codeModels.length > 0) {
                    recommendations.push(`Top coding model: ${codeModels[0].name}`);
                }
                break;

            case 'chat':
                const chatModels = results.compatible.filter(m =>
                    m.specialization === 'chat' || m.specialization === 'general'
                );
                if (chatModels.length > 0) {
                    recommendations.push(`Best chat model: ${chatModels[0].name}`);
                }
                break;

            case 'multimodal':
                const multiModels = results.compatible.filter(m => m.multimodal);
                if (multiModels.length > 0) {
                    recommendations.push(`Multimodal option: ${multiModels[0].name}`);
                }
                break;
        }

        return recommendations;
    }

    generateEnhancedSummary(hardware, results, ollamaIntegration) {
        const baseSummary = this.generateSummary(hardware, results);

        return {
            ...baseSummary,
            ollama: {
                available: ollamaIntegration.ollamaInfo.available,
                installedModels: ollamaIntegration.compatibleOllamaModels.length,
                runningModels: ollamaIntegration.currentlyRunning.length,
                recommendedInstalls: ollamaIntegration.recommendedPulls.length
            },
            hardwareTier: this.getHardwareTier(hardware),
            topPerformanceModel: this.getTopPerformanceModel(results)
        };
    }

    getTopPerformanceModel(results) {
        if (results.compatible.length === 0) return null;

        const sorted = results.compatible
            .filter(m => m.performanceEstimate)
            .sort((a, b) => (b.performanceEstimate.estimatedTokensPerSecond || 0) -
                (a.performanceEstimate.estimatedTokensPerSecond || 0));

        return sorted[0] || results.compatible[0];
    }

    async analyzeOllamaModel(modelName) {
        try {
            const [hardware, model] = await Promise.all([
                this.getSystemInfo(),
                Promise.resolve(this.findModel(modelName))
            ]);

            if (!model) {
                throw new Error(`Model "${modelName}" not found in database`);
            }

            const [localModels, runningModels] = await Promise.all([
                this.ollamaClient.getLocalModels().catch(error => {
                    this.logger.warn('Failed to get local Ollama models for analysis', { error: error.message });
                    return [];
                }),
                this.ollamaClient.getRunningModels().catch(error => {
                    this.logger.warn('Failed to get running Ollama models for analysis', { error: error.message });
                    return [];
                })
            ]);

            const isInstalled = localModels.some(m => m.name.toLowerCase().includes(modelName.toLowerCase()));
            const isRunning = runningModels.some(m => m.name.toLowerCase().includes(modelName.toLowerCase()));

            const [compatibility, performance] = await Promise.all([
                Promise.resolve(this.compatibilityAnalyzer.calculateModelCompatibility(hardware, model)),
                this.performanceAnalyzer.estimateModelPerformance(model, hardware)
            ]);

            let benchmarkResults = null;
            if (isInstalled) {
                try {
                    benchmarkResults = await this.performanceAnalyzer.benchmarkInferenceSpeed(
                        modelName, hardware, this.ollamaClient
                    );
                } catch (error) {
                    this.logger.warn(`Benchmark failed for ${modelName}`, { error });
                }
            }

            return {
                model,
                hardware,
                status: {
                    installed: isInstalled,
                    running: isRunning,
                    canRun: compatibility.score >= 60
                },
                compatibility,
                performance,
                benchmarkResults,
                recommendations: this.generateModelSpecificRecommendations(model, hardware, compatibility)
            };

        } catch (error) {
            this.logger.error('Model analysis failed', { error: error.message, component: 'LLMChecker', method: 'analyzeOllamaModel' });
            throw error;
        }
    }

    generateModelSpecificRecommendations(model, hardware, compatibility) {
        const recommendations = [];

        if (compatibility.score < 60) {
            recommendations.push('Model may not run well on this hardware');
            recommendations.push('Consider using heavy quantization (Q2_K, Q3_K_M)');
        } else if (compatibility.score < 75) {
            recommendations.push('✅ Model should run with some optimizations');
            recommendations.push('Use Q4_K_M quantization for best balance');
        } else {
            recommendations.push('Model should run excellently on this hardware');
            if (hardware.memory.total >= 32) {
                recommendations.push('You can use higher quality quantization (Q5_K_M, Q6_K)');
            }
        }

        if (hardware.gpu.dedicated && hardware.gpu.vram >= (model.requirements?.vram || 0)) {
            recommendations.push('Enable GPU acceleration for faster inference');
        }

        return recommendations;
    }

    filterModels(models, filter) {
        switch (filter.toLowerCase()) {
            case 'local':
                return models.filter(m => m.type === 'local');
            case 'cloud':
                return models.filter(m => m.type === 'cloud');
            case 'ultra_small':
                return models.filter(m => m.category === 'ultra_small');
            case 'small':
                return models.filter(m => m.category === 'small');
            case 'medium':
                return models.filter(m => m.category === 'medium');
            case 'large':
                return models.filter(m => m.category === 'large');
            case 'code':
                return models.filter(m => m.specialization === 'code');
            case 'chat':
                return models.filter(m => m.specialization === 'chat' || !m.specialization);
            case 'multimodal':
                return models.filter(m => m.specialization === 'multimodal' || m.multimodal);
            case 'embeddings':
                return models.filter(m => m.specialization === 'embeddings');
            default:
                return models;
        }
    }

    generateSummary(hardware, compatibility) {
        return {
            grade: this.calculateGrade(compatibility),
            systemClass: this.getSystemClass(hardware),
            compatibleCount: compatibility.compatible.length,
            marginalCount: compatibility.marginal.length,
            incompatibleCount: compatibility.incompatible.length,
            totalModels: compatibility.compatible.length + compatibility.marginal.length + compatibility.incompatible.length
        };
    }

    calculateGrade(compatibility) {
        const total = compatibility.compatible.length + compatibility.marginal.length + compatibility.incompatible.length;
        const compatiblePercent = total > 0 ? (compatibility.compatible.length / total) * 100 : 0;

        if (compatiblePercent >= 80) return 'A';
        if (compatiblePercent >= 60) return 'B';
        if (compatiblePercent >= 40) return 'C';
        if (compatiblePercent >= 20) return 'D';
        return 'F';
    }

    getSystemClass(hardware) {
        if (hardware.memory.total >= 32 && hardware.gpu.vram >= 16) return 'High End';
        if (hardware.memory.total >= 16 && hardware.gpu.vram >= 8) return 'Mid Range';
        if (hardware.memory.total >= 8) return 'Budget';
        return 'Entry Level';
    }

    async getOllamaInfo() {
        return await this.integrateOllamaModels(await this.getSystemInfo(), []);
    }

    async getSystemInfo() {
        return await this.hardwareDetector.getSystemInfo();
    }

    getAllModels() {
        return this.expandedModelsDatabase.getAllModels();
    }

    findModel(name) {
        return this.expandedModelsDatabase.findModel ?
            this.expandedModelsDatabase.findModel(name) :
            this.getAllModels().find(m => m.name.toLowerCase().includes(name.toLowerCase()));
    }


    async generateIntelligentRecommendations(hardware) {
        try {
            this.logger.info('Generating intelligent recommendations...');
            
            // Obtener todos los modelos de Ollama
            const ollamaData = await this.ollamaScraper.scrapeAllModels(false);
            const allModels = ollamaData.models || [];

            if (allModels.length === 0) {
                this.logger.warn('No Ollama models available for recommendations');
                return null;
            }

            // Generar recomendaciones inteligentes
            const recommendations = await this.intelligentRecommender.getBestModelsForHardware(hardware, allModels);
            const summary = this.intelligentRecommender.generateRecommendationSummary(recommendations, hardware);

            this.logger.info(`Generated recommendations for ${Object.keys(recommendations).length} categories`);
            
            return {
                recommendations,
                summary,
                totalModelsAnalyzed: allModels.length,
                generatedAt: new Date().toISOString()
            };

        } catch (error) {
            this.logger.error('Failed to generate intelligent recommendations', { error: error.message });
            return null;
        }
    }

}

module.exports = LLMChecker;