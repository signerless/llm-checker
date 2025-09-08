const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { classifyAllModels } = require('../utils/model-classifier');

class OllamaNativeScraper {
    constructor() {
        this.baseURL = 'https://ollama.com';
        this.registryAPI = 'https://registry.ollama.ai';

        // New secure cache location (user home)
        this.cacheDir = path.join(os.homedir(), '.llm-checker', 'cache', 'ollama');
        this.cacheFile = path.join(this.cacheDir, 'ollama-models.json');
        this.detailedCacheFile = path.join(this.cacheDir, 'ollama-detailed-models.json');

        // Legacy cache location (inside repo) for backward compatibility
        this.legacyCacheDir = path.join(__dirname, '.cache');
        this.legacyCacheFile = path.join(this.legacyCacheDir, 'ollama-models.json');
        this.legacyDetailedCacheFile = path.join(this.legacyCacheDir, 'ollama-detailed-models.json');

        this.cacheExpiry = 6 * 60 * 60 * 1000; // 6 horas para actualizar más frecuentemente

        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    async httpRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port || 443,
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    // Do not claim compression we don't handle here
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    ...options.headers
                }
            };

            const timeoutMs = typeof options.timeout === 'number' ? options.timeout : 15000;
            const maxBytes = typeof options.maxBytes === 'number' ? options.maxBytes : 5 * 1024 * 1024; // 5MB

            const req = https.request(requestOptions, (res) => {
                let data = '';
                let received = 0;

                res.on('data', chunk => {
                    received += chunk.length;
                    if (received > maxBytes) {
                        req.destroy(new Error('Response too large'));
                        return;
                    }
                    data += chunk.toString('utf8');
                });

                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ statusCode: res.statusCode, data, headers: res.headers });
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                    }
                });
            });

            // Socket/request timeout
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error('Request timeout'));
            });

            req.on('error', reject);
            if (options.body) req.write(options.body);
            req.end();
        });
    }

    parseModelFromHTML(html) {
        const models = [];
        const pattern = /<a[^>]*href="\/library\/([^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([^<]*)<\/h3>[\s\S]*?<p[^>]*>([^<]*)<\/p>[\s\S]*?(?:<span[^>]*>([^<]*)<\/span>)[\s\S]*?(?:(\d+(?:\.\d+)?[KMB]?)\s*(?:Pulls|pulls))[\s\S]*?(?:(\d+)\s*(?:Tags|tags))[\s\S]*?(?:Updated\s*(\d+\s*\w+\s*ago))?[\s\S]*?<\/a>/gi;

        let match;
        while ((match = pattern.exec(html)) !== null) {
            const [, identifier, name, description, labels, pulls, tags, lastUpdated] = match;
            const cleanName = this.cleanText(name);
            const cleanDescription = this.cleanText(description);
            const pullsNum = this.parsePulls(pulls);

            models.push({
                model_identifier: identifier,
                model_name: cleanName,
                description: cleanDescription,
                labels: labels ? labels.split(',').map(l => l.trim()) : [],
                pulls: pullsNum,
                tags: parseInt(tags) || 0,
                last_updated: lastUpdated || 'Unknown',
                url: `${this.baseURL}/library/${identifier}`,
                namespace: identifier.includes('/') ? identifier.split('/')[0] : null,
                model_type: identifier.includes('/') ? 'community' : 'official'
            });
        }

        if (models.length === 0) {
            return this.parseModelsFallback(html);
        }

        return models;
    }

    parseModelsFallback(html) {
        const models = [];
        const libraryLinks = html.match(/href="\/library\/[^"]*"/g);

        if (libraryLinks) {
            const uniqueLinks = [...new Set(libraryLinks)];

            for (const link of uniqueLinks) {
                const identifier = link.match(/\/library\/([^"]*)/)[1];
                const linkIndex = html.indexOf(link);
                const section = html.substring(Math.max(0, linkIndex - 500), linkIndex + 500);
                const nameMatch = section.match(/<h[2-4][^>]*>([^<]*)<\/h[2-4]>/);
                const descMatch = section.match(/<p[^>]*>([^<]*)<\/p>/);
                const pullsMatch = section.match(/(\d+(?:\.\d+)?[KMB]?)\s*(?:Pulls|pulls)/i);

                models.push({
                    model_identifier: identifier,
                    model_name: nameMatch ? this.cleanText(nameMatch[1]) : identifier,
                    description: descMatch ? this.cleanText(descMatch[1]) : '',
                    labels: [],
                    pulls: pullsMatch ? this.parsePulls(pullsMatch[1]) : 0,
                    tags: 0,
                    last_updated: 'Unknown',
                    url: `${this.baseURL}/library/${identifier}`,
                    namespace: identifier.includes('/') ? identifier.split('/')[0] : null,
                    model_type: identifier.includes('/') ? 'community' : 'official'
                });
            }
        }

        return models;
    }

    cleanText(text) {
        return text
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
    }

    parsePulls(pullsStr) {
        if (!pullsStr) return 0;
        const num = parseFloat(pullsStr);
        const str = pullsStr.toLowerCase();
        if (str.includes('k')) return Math.floor(num * 1000);
        if (str.includes('m')) return Math.floor(num * 1000000);
        if (str.includes('b')) return Math.floor(num * 1000000000);
        return Math.floor(num);
    }

    isCacheValid() {
        const file = fs.existsSync(this.cacheFile) ? this.cacheFile : (fs.existsSync(this.legacyCacheFile) ? this.legacyCacheFile : null);
        if (!file) return false;
        const stats = fs.statSync(file);
        const age = Date.now() - stats.mtime.getTime();
        return age < this.cacheExpiry;
    }

    readCache() {
        try {
            const file = fs.existsSync(this.cacheFile) ? this.cacheFile : this.legacyCacheFile;
            if (!file) return null;
            const data = fs.readFileSync(file, 'utf8');
            return JSON.parse(data);
        } catch {
            return null;
        }
    }

    writeCache(models) {
        try {
            const data = {
                models,
                total_count: models.length,
                cached_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + this.cacheExpiry).toISOString()
            };
            fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));
            return true;
        } catch {
            return false;
        }
    }

    isDetailedCacheValid() {
        const file = fs.existsSync(this.detailedCacheFile) ? this.detailedCacheFile : (fs.existsSync(this.legacyDetailedCacheFile) ? this.legacyDetailedCacheFile : null);
        if (!file) return false;
        const stats = fs.statSync(file);
        const age = Date.now() - stats.mtime.getTime();
        return age < this.cacheExpiry;
    }

    readDetailedCache() {
        try {
            const file = fs.existsSync(this.detailedCacheFile) ? this.detailedCacheFile : this.legacyDetailedCacheFile;
            if (!file) return null;
            const data = fs.readFileSync(file, 'utf8');
            return JSON.parse(data);
        } catch {
            return null;
        }
    }

    writeDetailedCache(models) {
        try {
            const data = {
                models,
                total_count: models.length,
                cached_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + this.cacheExpiry).toISOString()
            };
            fs.writeFileSync(this.detailedCacheFile, JSON.stringify(data, null, 2));
            return true;
        } catch {
            return false;
        }
    }

    async getDetailedModelsInfo(basicModels) {
        const detailedModels = [];
        const batchSize = 5; // Procesar en lotes para no sobrecargar el servidor
        
        for (let i = 0; i < basicModels.length; i += batchSize) {
            const batch = basicModels.slice(i, i + batchSize);
            console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(basicModels.length/batchSize)}`);
            
            const batchPromises = batch.map(model => this.getModelDetailedInfo(model));
            const batchResults = await Promise.allSettled(batchPromises);
            
            batchResults.forEach((result, index) => {
                if (result.status === 'fulfilled' && result.value) {
                    detailedModels.push(result.value);
                } else {
                    // Si falla, al menos guardamos la información básica
                    detailedModels.push(batch[index]);
                }
            });
            
            // Pequeña pausa entre lotes
            if (i + batchSize < basicModels.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        return detailedModels;
    }

    async getModelDetailedInfo(basicModel) {
        try {
            const modelUrl = `${this.baseURL}/library/${basicModel.model_identifier}`;
            const response = await this.httpRequest(modelUrl);
            
            if (response.statusCode !== 200) {
                return basicModel; // Fallback a información básica
            }
            
            const detailedInfo = this.parseModelDetailPage(response.data, basicModel);
            
            return {
                ...basicModel,
                ...detailedInfo,
                // Usar datos mejorados si están disponibles
                pulls: detailedInfo.actual_pulls || basicModel.pulls || 0,
                main_size: detailedInfo.main_size || 'Unknown',
                detailed_scraped_at: new Date().toISOString()
            };
            
        } catch (error) {
            console.warn(`Failed to get details for ${basicModel.model_identifier}: ${error.message}`);
            return basicModel; // Fallback a información básica
        }
    }

    parseModelDetailPage(html, basicModel) {
        const details = {
            variants: [],
            tags: [],
            detailed_description: '',
            parameters: {},
            quantizations: [],
            model_sizes: [],
            category: 'general',
            use_cases: [],
            main_size: 'Unknown',
            actual_pulls: 0,
            context_length: 'Unknown',
            input_types: []
        };

        try {
            // MEJORAR: Extraer TODOS los tags incluyendo quantizaciones específicas
            const allTagMatches = [];
            
            // Buscar en bloques de código
            const codeBlocks = html.match(/<code[^>]*>([^<]+)<\/code>/g) || [];
            codeBlocks.forEach(match => {
                const content = match.replace(/<[^>]*>/g, '').trim();
                const modelMatch = content.match(/ollama (?:run|pull) ([^\s]+)/);
                if (modelMatch) {
                    allTagMatches.push(modelMatch[1]);
                }
            });

            // Buscar en texto plano (para tags que no están en código)
            const plainTextTags = html.match(new RegExp(`${basicModel.model_identifier}:[\\w\\d\\.-]+`, 'g')) || [];
            allTagMatches.push(...plainTextTags);

            // Buscar patrones específicos de quantización
            const quantPatterns = [
                new RegExp(`${basicModel.model_identifier}:[\\w\\d\\.-]*q\\d+[_km\\d]*`, 'gi'),
                new RegExp(`${basicModel.model_identifier}:[\\w\\d\\.-]*fp\\d+`, 'gi'),
                new RegExp(`${basicModel.model_identifier}:[\\w\\d\\.-]*int\\d+`, 'gi')
            ];
            
            quantPatterns.forEach(pattern => {
                const matches = html.match(pattern) || [];
                allTagMatches.push(...matches);
            });

            // Limpiar y deduplicar tags
            details.tags = [...new Set(allTagMatches)]
                .filter(tag => tag && tag.includes(':'))
                .slice(0, 50); // Aumentar límite para capturar más variantes

            // NUEVO: Extraer información de contexto
            const contextMatches = html.match(/context\s*:?\s*(\d+[kmb]?)/gi) || 
                                 html.match(/(\d+[kmb]?)\s*context/gi) ||
                                 html.match(/context\s+length\s*:?\s*(\d+[kmb]?)/gi);
            
            if (contextMatches && contextMatches.length > 0) {
                // Extraer el número más grande encontrado
                const contextNumbers = contextMatches.map(match => {
                    const num = match.match(/(\d+[kmb]?)/i);
                    if (num) {
                        const value = num[1].toLowerCase();
                        if (value.includes('k')) return parseInt(value) * 1000;
                        if (value.includes('m')) return parseInt(value) * 1000000;
                        if (value.includes('b')) return parseInt(value) * 1000000000;
                        return parseInt(value);
                    }
                    return 0;
                }).filter(n => n > 0);
                
                if (contextNumbers.length > 0) {
                    const maxContext = Math.max(...contextNumbers);
                    details.context_length = maxContext > 1000000 ? 
                        `${(maxContext/1000000).toFixed(1)}M` : 
                        maxContext > 1000 ? `${(maxContext/1000).toFixed(0)}K` : 
                        maxContext.toString();
                }
            }

            // NUEVO: Detectar tipos de input soportados
            const inputTypes = [];
            if (html.toLowerCase().includes('text') || html.toLowerCase().includes('chat')) {
                inputTypes.push('text');
            }
            if (html.toLowerCase().includes('image') || html.toLowerCase().includes('vision') || 
                html.toLowerCase().includes('visual')) {
                inputTypes.push('image');
            }
            if (html.toLowerCase().includes('code') || html.toLowerCase().includes('programming')) {
                inputTypes.push('code');
            }
            if (html.toLowerCase().includes('audio') || html.toLowerCase().includes('speech')) {
                inputTypes.push('audio');
            }
            
            details.input_types = inputTypes.length > 0 ? inputTypes : ['text'];

            // Mejor extracción de tamaños con regex más específico
            const sizeMatches = html.match(/\b(\d+(?:\.\d+)?)\s*[BG]B?\b/gi);
            if (sizeMatches) {
                details.model_sizes = [...new Set(sizeMatches.map(size => size.toLowerCase()))];
                // Determinar el tamaño principal (más común)
                if (details.model_sizes.length > 0) {
                    details.main_size = details.model_sizes[0];
                }
            }

            // Extraer pulls reales del HTML
            const pullsMatch = html.match(/(\d+(?:\.\d+)?[KMB]?)\s*pulls?/i);
            if (pullsMatch) {
                details.actual_pulls = this.parsePulls(pullsMatch[1]);
            }

            // Mejorar detección de quantizaciones
            const quantMatches = html.match(/\b(Q\d+_[KM](?:_[MS])?|Q\d+|FP16|FP32|INT8|INT4)\b/gi);
            if (quantMatches) {
                details.quantizations = [...new Set(quantMatches.map(q => q.toUpperCase()))];
            }

            // Mejor categorización basada en múltiples indicadores
            const htmlLower = html.toLowerCase();
            const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.toLowerCase() || '';
            const description = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i)?.[1]?.toLowerCase() || '';
            const fullText = `${htmlLower} ${title} ${description}`;

            // Resetear categoría
            details.category = 'general';
            details.use_cases = [];

            // Categorizar basado en el nombre del modelo de forma más robusta
            const modelName = basicModel.model_identifier.toLowerCase();
            const modelDisplayName = basicModel.model_name.toLowerCase();
            const fullModelText = `${modelName} ${modelDisplayName}`;
            
            // Resetear categoría y casos de uso
            details.category = 'general';
            details.use_cases = [];
            
            // Sistema de categorización por prioridad (específico a general)
            
            // 1. CODING - Detectar modelos de programación
            if (fullModelText.includes('coder') || 
                fullModelText.includes('codellama') ||
                fullModelText.includes('starcoder') || 
                fullModelText.includes('codestral') ||
                fullModelText.includes('code-') ||
                modelName.startsWith('codellama') ||
                modelName.startsWith('starcoder') ||
                modelName.includes('deepseek-coder') ||
                modelName.includes('qwen2.5-coder')) {
                details.category = 'coding';
                details.use_cases.push('coding', 'programming', 'development');
            }
            
            // 2. EMBEDDINGS - Modelos de vectores/embeddings
            else if (fullModelText.includes('embed') || 
                     fullModelText.includes('nomic') ||
                     fullModelText.includes('bge') || 
                     fullModelText.includes('e5') ||
                     modelName.includes('all-minilm') ||
                     modelName.startsWith('nomic-embed')) {
                details.category = 'embeddings';
                details.use_cases.push('embeddings', 'search', 'similarity');
            }
            
            // 3. MULTIMODAL - Modelos de visión/imagen
            else if (fullModelText.includes('llava') || 
                     fullModelText.includes('pixtral') ||
                     fullModelText.includes('vision') || 
                     fullModelText.includes('moondream') ||
                     modelName.includes('qwen-vl') ||
                     modelName.includes('qwen2.5vl') ||
                     modelName.startsWith('llava')) {
                details.category = 'multimodal';
                details.use_cases.push('vision', 'multimodal', 'image');
            }
            
            // 4. REASONING - Modelos especializados en razonamiento
            else if (fullModelText.includes('deepseek-r1') || 
                     fullModelText.includes('reasoning') ||
                     fullModelText.includes('math') ||
                     modelName.includes('deepseek-r1') ||
                     modelName.includes('o1-')) {
                details.category = 'reasoning';
                details.use_cases.push('reasoning', 'mathematics', 'logic');
            }
            
            // 5. TALKING - Modelos conversacionales/chat (mayoría de modelos)
            else if (fullModelText.includes('llama') || 
                     fullModelText.includes('mistral') ||
                     fullModelText.includes('phi') || 
                     fullModelText.includes('gemma') ||
                     fullModelText.includes('qwen') ||
                     fullModelText.includes('chat') ||
                     fullModelText.includes('instruct') ||
                     modelName.startsWith('llama') ||
                     modelName.startsWith('mistral') ||
                     modelName.startsWith('phi') ||
                     modelName.startsWith('gemma') ||
                     modelName.startsWith('qwen') && !modelName.includes('coder') && !modelName.includes('vl')) {
                details.category = 'talking';
                details.use_cases.push('chat', 'conversation', 'assistant');
            }
            
            // 6. READING - Modelos para análisis de texto
            else if (fullModelText.includes('solar') ||
                     fullModelText.includes('openchat') ||
                     fullModelText.includes('neural-chat') ||
                     fullModelText.includes('vicuna')) {
                details.category = 'reading';
                details.use_cases.push('reading', 'analysis', 'comprehension');
            }
            
            // 7. CREATIVE - Modelos creativos
            else if (fullModelText.includes('dolphin') ||
                     fullModelText.includes('wizard') ||
                     fullModelText.includes('uncensored') ||
                     fullModelText.includes('airoboros')) {
                details.category = 'creative';
                details.use_cases.push('creative', 'writing', 'storytelling');
            }
            
            // 8. Por defecto: GENERAL
            else {
                details.category = 'general';
                details.use_cases.push('general', 'assistant');
            }

            // Extraer descripción mejorada
            const descPatterns = [
                /<p[^>]*class="[^"]*description[^"]*"[^>]*>([^<]+)<\/p>/i,
                /<meta[^>]*name="description"[^>]*content="([^"]+)"/i,
                /<div[^>]*class="[^"]*desc[^"]*"[^>]*>([^<]+)<\/div>/i
            ];
            
            for (const pattern of descPatterns) {
                const match = html.match(pattern);
                if (match) {
                    details.detailed_description = this.cleanText(match[1]);
                    break;
                }
            }

            // Crear variantes mejoradas con tamaños reales extraídos de la página
            details.variants = details.tags.map(tag => {
                const size = this.extractSizeFromTag(tag);
                const quantization = this.extractQuantizationFromTag(tag);
                const realSizeGB = this.extractRealSizeFromHTML(html, tag);
                return {
                    tag: tag,
                    size: size,
                    quantization: quantization,
                    command: `ollama pull ${tag}`,
                    estimated_size_gb: this.estimateModelSizeGB(tag),
                    real_size_gb: realSizeGB || this.estimateModelSizeGB(tag)
                };
            });

        } catch (error) {
            console.warn(`Error parsing detailed page: ${error.message}`);
        }

        return details;
    }

    extractSizeFromTag(tag) {
        const sizeMatch = tag.match(/(\d+\.?\d*)[bg]/i);
        return sizeMatch ? sizeMatch[0].toLowerCase() : 'unknown';
    }

    extractQuantizationFromTag(tag) {
        const quantMatch = tag.match(/\b(q\d+_[km]?_?[ms]?|fp16|fp32|int8|int4)\b/i);
        return quantMatch ? quantMatch[0].toUpperCase() : 'Q4_0'; // Default assumption
    }

    extractRealSizeFromHTML(html, tag) {
        try {
            // Buscar el patrón específico: [tag]\n size·context·type·date
            // Ejemplo: [llama3.1:8b]\n4.9GB · 128K context window · Text · 8 months ago
            const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`\\[${escapedTag}\\][\\s\\S]*?(\\d+(?:\\.\\d+)?)(GB|MB)`, 'i');
            const match = html.match(pattern);
            
            if (match) {
                const num = parseFloat(match[1]);
                const unit = match[2].toUpperCase();
                
                if (unit === 'MB') {
                    return num / 1024; // Convert MB to GB
                } else {
                    return num; // Already in GB
                }
            }
            
            // Fallback: buscar tamaño cerca del tag
            const tagIndex = html.indexOf(tag);
            if (tagIndex !== -1) {
                const surrounding = html.substring(tagIndex, tagIndex + 500);
                const sizeMatch = surrounding.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
                if (sizeMatch) {
                    const num = parseFloat(sizeMatch[1]);
                    const unit = sizeMatch[2].toUpperCase();
                    return unit === 'MB' ? num / 1024 : num;
                }
            }
            
            return null; // No se encontró tamaño real
        } catch (error) {
            console.warn(`Error extracting real size for ${tag}: ${error.message}`);
            return null;
        }
    }

    estimateModelSizeGB(tag) {
        const sizeMatch = tag.match(/(\d+\.?\d*)[bg]/i);
        if (!sizeMatch) return 1;
        
        const num = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[0].slice(-1).toLowerCase();
        
        if (unit === 'b') return num;
        if (unit === 'g') return num;
        return num; // Default to GB
    }

    async scrapeAllModels(forceRefresh = false) {
        try {
            if (!forceRefresh && this.isDetailedCacheValid()) {
                return this.readDetailedCache();
            }

            console.log('Scraping ALL Ollama models with detailed information...');
            
            // Primero obtenemos la lista básica de modelos
            const response = await this.httpRequest(`${this.baseURL}/library`);
            if (response.statusCode !== 200) throw new Error(`Failed to fetch: ${response.statusCode}`);
            const basicModels = this.parseModelFromHTML(response.data);
            
            console.log(`Found ${basicModels.length} models. Getting detailed information...`);
            
            // Ahora obtenemos información detallada de cada modelo
            const detailedModels = await this.getDetailedModelsInfo(basicModels);
            
            // Apply classification to all models
            const classifiedData = classifyAllModels({
                models: detailedModels,
                total_count: detailedModels.length,
                cached_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + this.cacheExpiry).toISOString()
            });
            
            this.writeDetailedCache(classifiedData.models);

            return {
                models: classifiedData.models,
                total_count: classifiedData.models.length,
                cached_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + this.cacheExpiry).toISOString()
            };
        } catch (error) {
            const cachedData = this.readDetailedCache();
            if (cachedData) return cachedData;
            throw error;
        }
    }

    async searchModels(query, options = {}) {
        const data = await this.scrapeAllModels();
        const models = data.models;

        if (!query) return { models, total_count: models.length };

        const filtered = models.filter(model => {
            const searchText = `${model.model_name} ${model.description} ${model.model_identifier}`.toLowerCase();
            return searchText.includes(query.toLowerCase());
        });

        return {
            models: filtered,
            total_count: filtered.length,
            query
        };
    }

    async findCompatibleModels(localModels) {
        const data = await this.scrapeAllModels();
        const cloudModels = data.models;
        const compatible = [];

        for (const localModel of localModels) {
            const localName = localModel.name || localModel.model;
            const [baseName] = localName.split(':');

            const match = cloudModels.find(cloudModel =>
                cloudModel.model_identifier === baseName ||
                cloudModel.model_identifier === localName ||
                cloudModel.model_name.toLowerCase().includes(baseName.toLowerCase()) ||
                baseName.toLowerCase().includes(cloudModel.model_identifier.toLowerCase())
            );

            if (match) {
                compatible.push({
                    local: localModel,
                    cloud: match,
                    match_type: match.model_identifier === baseName ? 'exact' : 'fuzzy'
                });
            }
        }

        return {
            total_local: localModels.length,
            total_compatible: compatible.length,
            compatible_models: compatible,
            all_available: data.total_count
        };
    }

    async getStats() {
        const data = await this.scrapeAllModels();
        const models = data.models;

        return {
            total_models: models.length,
            official_models: models.filter(m => m.model_type === 'official').length,
            community_models: models.filter(m => m.model_type === 'community').length,
            total_pulls: models.reduce((sum, m) => sum + (m.pulls || 0), 0),
            most_popular: models
                .sort((a, b) => (b.pulls || 0) - (a.pulls || 0))
                .slice(0, 10)
                .map(m => ({ name: m.model_name, pulls: m.pulls })),
            last_updated: data.cached_at
        };
    }
}

async function getOllamaModelsIntegration(localModels = []) {
    const scraper = new OllamaNativeScraper();

    try {
        if (localModels.length > 0) {
            const compatible = await scraper.findCompatibleModels(localModels);
            return compatible;
        } else {
            const allModels = await scraper.scrapeAllModels();
            return {
                total_local: 0,
                total_compatible: 0,
                compatible_models: [],
                all_available: allModels.total_count,
                recommendations: allModels.models.slice(0, 20)
            };
        }
    } catch (error) {
        return {
            total_local: localModels.length,
            total_compatible: 0,
            compatible_models: [],
            all_available: 0,
            error: error.message
        };
    }
}

async function testScraper() {
    const scraper = new OllamaNativeScraper();

    const localModels = [
        { name: 'mistral:latest' },
        { name: 'deepseek-coder:6.7b' },
        { name: 'deepseek-coder:1.3b' }
    ];

    const result = await getOllamaModelsIntegration(localModels);
    console.log(JSON.stringify(result, null, 2));
}

module.exports = {
    OllamaNativeScraper,
    getOllamaModelsIntegration
};

if (require.main === module) {
    testScraper().catch(console.error);
}
