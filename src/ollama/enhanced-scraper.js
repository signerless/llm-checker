/**
 * Enhanced Ollama Scraper
 * Scrapes ALL models from ollama.com with ALL variants and quantizations
 * No external API dependencies - pure HTML scraping
 */

const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');

class EnhancedOllamaScraper {
    constructor(options = {}) {
        this.baseURL = 'https://ollama.com';
        this.concurrency = options.concurrency || 5;
        this.rateLimitMs = options.rateLimitMs || 200;
        this.timeout = options.timeout || 15000;
        this.maxRetries = options.maxRetries || 3;

        // Progress tracking
        this.onProgress = options.onProgress || (() => {});
        this.onError = options.onError || console.error;
    }

    /**
     * Make HTTP request with retry logic
     */
    async httpGet(url, retries = 0) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);

            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'identity',
                    'Connection': 'keep-alive',
                    'Cache-Control': 'no-cache'
                },
                timeout: this.timeout
            };

            const req = https.request(options, (res) => {
                let data = '';
                const maxBytes = 10 * 1024 * 1024; // 10MB limit
                let bytesReceived = 0;

                res.on('data', (chunk) => {
                    bytesReceived += chunk.length;
                    if (bytesReceived > maxBytes) {
                        req.destroy();
                        reject(new Error('Response too large'));
                        return;
                    }
                    data += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(data);
                    } else if (res.statusCode === 429 && retries < this.maxRetries) {
                        // Rate limited, retry with backoff
                        setTimeout(() => {
                            this.httpGet(url, retries + 1).then(resolve).catch(reject);
                        }, (retries + 1) * 2000);
                    } else if (res.statusCode >= 300 && res.statusCode < 400) {
                        // Redirect
                        const redirectUrl = res.headers.location;
                        if (redirectUrl) {
                            this.httpGet(redirectUrl.startsWith('http') ? redirectUrl : this.baseURL + redirectUrl, retries)
                                .then(resolve).catch(reject);
                        } else {
                            reject(new Error(`Redirect without location: ${res.statusCode}`));
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                    }
                });
            });

            req.on('error', (err) => {
                if (retries < this.maxRetries) {
                    setTimeout(() => {
                        this.httpGet(url, retries + 1).then(resolve).catch(reject);
                    }, (retries + 1) * 1000);
                } else {
                    reject(err);
                }
            });

            req.on('timeout', () => {
                req.destroy();
                if (retries < this.maxRetries) {
                    this.httpGet(url, retries + 1).then(resolve).catch(reject);
                } else {
                    reject(new Error('Request timeout'));
                }
            });

            req.end();
        });
    }

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Scrape the main library page to get all model identifiers
     */
    async scrapeModelList() {
        this.onProgress({ phase: 'list', message: 'Fetching model list from ollama.com/library...' });

        const html = await this.httpGet(`${this.baseURL}/library`);

        // Extract model links using multiple patterns for robustness
        const models = [];
        const seen = new Set();

        // Pattern 1: Direct library links
        const linkPattern = /href="\/library\/([^"\/]+)"/gi;
        let match;
        while ((match = linkPattern.exec(html)) !== null) {
            const id = match[1].toLowerCase();
            if (!seen.has(id) && !id.includes('?') && !id.includes('#')) {
                seen.add(id);
                models.push({ id });
            }
        }

        // Pattern 2: Look for model cards with more info
        const cardPattern = /<a[^>]*href="\/library\/([^"]+)"[^>]*>[\s\S]*?<\/a>/gi;
        while ((match = cardPattern.exec(html)) !== null) {
            const id = match[1].toLowerCase().split('/')[0];
            if (!seen.has(id)) {
                seen.add(id);

                // Try to extract pulls
                const pullsMatch = match[0].match(/(\d+(?:\.\d+)?[KMB]?)\s*(?:Pulls|pulls)/i);
                const pulls = pullsMatch ? this.parsePulls(pullsMatch[1]) : 0;

                models.push({ id, pulls });
            }
        }

        this.onProgress({ phase: 'list', message: `Found ${models.length} models` });

        return models;
    }

    /**
     * Parse pull count (e.g., "1.2M" -> 1200000)
     */
    parsePulls(pullStr) {
        if (!pullStr) return 0;
        const num = parseFloat(pullStr);
        if (pullStr.includes('B')) return Math.round(num * 1e9);
        if (pullStr.includes('M')) return Math.round(num * 1e6);
        if (pullStr.includes('K')) return Math.round(num * 1e3);
        return Math.round(num);
    }

    /**
     * Scrape model detail page
     */
    async scrapeModelDetails(modelId) {
        const url = `${this.baseURL}/library/${modelId}`;

        try {
            const html = await this.httpGet(url);

            const model = {
                id: modelId,
                name: this.extractModelName(html, modelId),
                description: this.extractDescription(html),
                pulls: this.extractPulls(html),
                tags_count: this.extractTagsCount(html),
                capabilities: this.extractCapabilities(html, modelId),
                last_updated: this.extractLastUpdated(html),
                url: url,
                type: this.isOfficialModel(html) ? 'official' : 'community'
            };

            return model;
        } catch (error) {
            this.onError(`Error scraping ${modelId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Scrape all tags/variants for a model
     */
    async scrapeModelTags(modelId) {
        const url = `${this.baseURL}/library/${modelId}/tags`;

        try {
            const html = await this.httpGet(url);
            const variants = [];

            // Pattern 1: Tag blocks with size info
            // Looking for patterns like: llama3.1:8b    4.9GB
            const tagBlockPattern = new RegExp(
                `(${modelId}:[\\w\\d\\.\\-]+)\\s*[\\n\\r\\s]+([\\d\\.]+)\\s*(GB|MB|KB)`,
                'gi'
            );

            let match;
            while ((match = tagBlockPattern.exec(html)) !== null) {
                const tag = match[1];
                const sizeNum = parseFloat(match[2]);
                const sizeUnit = match[3].toUpperCase();

                let sizeGB = sizeNum;
                if (sizeUnit === 'MB') sizeGB = sizeNum / 1024;
                if (sizeUnit === 'KB') sizeGB = sizeNum / (1024 * 1024);

                variants.push(this.parseVariant(modelId, tag, sizeGB));
            }

            // Pattern 2: Look for all tag mentions
            const tagPattern = new RegExp(`${modelId}:([\\w\\d\\.\\-]+)`, 'gi');
            const seenTags = new Set(variants.map(v => v.tag));

            while ((match = tagPattern.exec(html)) !== null) {
                const tag = `${modelId}:${match[1]}`;
                if (!seenTags.has(tag)) {
                    seenTags.add(tag);
                    variants.push(this.parseVariant(modelId, tag, null));
                }
            }

            // Pattern 3: Size extraction from other patterns
            const sizePattern = /(\d+(?:\.\d+)?)\s*(GB|MB)\s*·/gi;
            const sizes = [];
            while ((match = sizePattern.exec(html)) !== null) {
                const sizeNum = parseFloat(match[1]);
                const sizeUnit = match[2].toUpperCase();
                let sizeGB = sizeUnit === 'MB' ? sizeNum / 1024 : sizeNum;
                sizes.push(sizeGB);
            }

            // Try to match sizes to variants that don't have them
            let sizeIndex = 0;
            for (const variant of variants) {
                if (variant.size_gb === null && sizeIndex < sizes.length) {
                    variant.size_gb = sizes[sizeIndex++];
                }
            }

            // If no variants found, create default ones
            if (variants.length === 0) {
                variants.push(this.parseVariant(modelId, `${modelId}:latest`, null));
            }

            return variants;
        } catch (error) {
            this.onError(`Error scraping tags for ${modelId}: ${error.message}`);
            // Return at least a latest variant
            return [this.parseVariant(modelId, `${modelId}:latest`, null)];
        }
    }

    /**
     * Parse variant info from tag string
     */
    parseVariant(modelId, tag, sizeGB) {
        const variant = {
            model_id: modelId,
            tag: tag,
            params_b: this.extractParams(tag),
            quant: this.extractQuantization(tag),
            size_gb: sizeGB,
            context_length: this.extractContextLength(tag),
            input_types: this.extractInputTypes(tag, modelId),
            is_moe: this.isMoE(tag, modelId),
            expert_count: this.extractExpertCount(tag)
        };

        // Estimate size if not provided
        if (variant.size_gb === null && variant.params_b) {
            variant.size_gb = this.estimateSize(variant.params_b, variant.quant);
        }

        return variant;
    }

    /**
     * Extract parameter count from tag
     */
    extractParams(tag) {
        // Match patterns like: 8b, 70b, 7b, 1.5b, 0.5b, 405b
        const match = tag.match(/(\d+\.?\d*)[bB](?:[^a-zA-Z]|$)/);
        if (match) {
            return parseFloat(match[1]);
        }

        // Check for known sizes in model names
        const sizePatterns = [
            { pattern: /mini/i, size: 3.8 },
            { pattern: /tiny/i, size: 1.1 },
            { pattern: /small/i, size: 7 },
            { pattern: /medium/i, size: 13 },
            { pattern: /large/i, size: 34 },
            { pattern: /xl/i, size: 70 },
        ];

        for (const { pattern, size } of sizePatterns) {
            if (pattern.test(tag)) return size;
        }

        return null;
    }

    /**
     * Extract quantization from tag
     */
    extractQuantization(tag) {
        const quantPatterns = [
            // K-quant patterns
            { pattern: /q8[_-]?0/i, quant: 'Q8_0' },
            { pattern: /q6[_-]?k/i, quant: 'Q6_K' },
            { pattern: /q5[_-]?k[_-]?m/i, quant: 'Q5_K_M' },
            { pattern: /q5[_-]?k[_-]?s/i, quant: 'Q5_K_S' },
            { pattern: /q5[_-]?0/i, quant: 'Q5_0' },
            { pattern: /q4[_-]?k[_-]?m/i, quant: 'Q4_K_M' },
            { pattern: /q4[_-]?k[_-]?s/i, quant: 'Q4_K_S' },
            { pattern: /q4[_-]?0/i, quant: 'Q4_0' },
            { pattern: /q3[_-]?k[_-]?m/i, quant: 'Q3_K_M' },
            { pattern: /q3[_-]?k[_-]?s/i, quant: 'Q3_K_S' },
            { pattern: /q3[_-]?k[_-]?l/i, quant: 'Q3_K_L' },
            { pattern: /q2[_-]?k/i, quant: 'Q2_K' },
            // FP patterns
            { pattern: /fp16/i, quant: 'FP16' },
            { pattern: /fp32/i, quant: 'FP32' },
            { pattern: /f16/i, quant: 'FP16' },
            { pattern: /f32/i, quant: 'FP32' },
            // INT patterns
            { pattern: /int8/i, quant: 'INT8' },
            { pattern: /int4/i, quant: 'INT4' },
            // IQ patterns (important quantization)
            { pattern: /iq4[_-]?nl/i, quant: 'IQ4_NL' },
            { pattern: /iq4[_-]?xs/i, quant: 'IQ4_XS' },
            { pattern: /iq3[_-]?xxs/i, quant: 'IQ3_XXS' },
            { pattern: /iq3[_-]?xs/i, quant: 'IQ3_XS' },
            { pattern: /iq2[_-]?xxs/i, quant: 'IQ2_XXS' },
            { pattern: /iq2[_-]?xs/i, quant: 'IQ2_XS' },
            { pattern: /iq1[_-]?s/i, quant: 'IQ1_S' },
        ];

        for (const { pattern, quant } of quantPatterns) {
            if (pattern.test(tag)) return quant;
        }

        // Default to Q4_0 for standard tags
        if (tag.includes(':latest') || !tag.includes('-')) {
            return 'Q4_0';
        }

        return null;
    }

    /**
     * Extract context length from tag
     */
    extractContextLength(tag) {
        // Match patterns like: 128k, 32k, 8k, 4k
        const match = tag.match(/(\d+)[kK](?:[^a-zA-Z]|$)/);
        if (match) {
            return parseInt(match[1]) * 1024;
        }

        // Known models with specific context lengths
        const longContextModels = [
            { pattern: /qwen2\.5|qwen2/i, ctx: 131072 },
            { pattern: /llama3\.1/i, ctx: 131072 },
            { pattern: /llama3\.2/i, ctx: 131072 },
            { pattern: /mistral/i, ctx: 32768 },
            { pattern: /gemma2/i, ctx: 8192 },
            { pattern: /phi-?3/i, ctx: 131072 },
        ];

        for (const { pattern, ctx } of longContextModels) {
            if (pattern.test(tag)) return ctx;
        }

        return 4096; // Default
    }

    /**
     * Extract input types
     */
    extractInputTypes(tag, modelId) {
        const types = ['text'];

        // Vision/multimodal models
        if (/llava|vision|minicpm-v|bakllava|moondream/i.test(tag) ||
            /llava|vision|minicpm-v|bakllava|moondream/i.test(modelId)) {
            types.push('image');
        }

        return types;
    }

    /**
     * Check if model is Mixture of Experts
     */
    isMoE(tag, modelId) {
        return /mixtral|moe|experts/i.test(tag) || /mixtral|moe/i.test(modelId);
    }

    /**
     * Extract expert count for MoE models
     */
    extractExpertCount(tag) {
        const match = tag.match(/(\d+)x\d+/i);
        if (match) return parseInt(match[1]);

        if (/mixtral/i.test(tag)) return 8;

        return null;
    }

    /**
     * Estimate size based on params and quantization
     */
    estimateSize(paramsB, quant) {
        const bytesPerParam = {
            'FP32': 4,
            'FP16': 2,
            'Q8_0': 1,
            'Q6_K': 0.75,
            'Q5_K_M': 0.625,
            'Q5_K_S': 0.625,
            'Q5_0': 0.625,
            'Q4_K_M': 0.5,
            'Q4_K_S': 0.5,
            'Q4_0': 0.5,
            'Q3_K_M': 0.4,
            'Q3_K_S': 0.375,
            'Q3_K_L': 0.4,
            'Q2_K': 0.3,
            'IQ4_NL': 0.5,
            'IQ4_XS': 0.45,
            'IQ3_XXS': 0.35,
            'IQ3_XS': 0.375,
            'IQ2_XXS': 0.25,
            'IQ2_XS': 0.28,
            'IQ1_S': 0.2,
            'INT8': 1,
            'INT4': 0.5,
        };

        const bpp = bytesPerParam[quant] || 0.5;
        return Math.round(paramsB * bpp * 10) / 10; // GB, rounded to 1 decimal
    }

    // ==================== HTML EXTRACTION HELPERS ====================

    extractModelName(html, modelId) {
        // Try to get display name from title or h1
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
            const title = titleMatch[1].split('·')[0].split('-')[0].trim();
            if (title && title.toLowerCase() !== 'ollama') {
                return title;
            }
        }

        const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        if (h1Match) {
            return h1Match[1].trim();
        }

        // Capitalize the model ID
        return modelId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    extractDescription(html) {
        // Try meta description
        const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
        if (metaMatch) {
            return metaMatch[1].substring(0, 500);
        }

        // Try first paragraph
        const pMatch = html.match(/<p[^>]*>([^<]{20,500})<\/p>/i);
        if (pMatch) {
            return pMatch[1].trim();
        }

        return '';
    }

    extractPulls(html) {
        const match = html.match(/(\d+(?:\.\d+)?[KMB]?)\s*(?:Pulls|pulls|Downloads|downloads)/i);
        return match ? this.parsePulls(match[1]) : 0;
    }

    extractTagsCount(html) {
        const match = html.match(/(\d+)\s*(?:Tags|tags|Versions|versions)/i);
        return match ? parseInt(match[1]) : 1;
    }

    extractCapabilities(html, modelId) {
        const capabilities = [];

        // Detect by model ID patterns
        if (/code|coder|starcoder/i.test(modelId)) capabilities.push('coding');
        if (/llava|vision|minicpm-v|bakllava|moondream/i.test(modelId)) capabilities.push('multimodal');
        if (/embed|bge|nomic|gte|e5/i.test(modelId)) capabilities.push('embeddings');
        if (/deepseek-r1|qwq|reasoning/i.test(modelId)) capabilities.push('reasoning');
        if (/math|mathstral/i.test(modelId)) capabilities.push('math');
        if (/dolphin|wizard|uncensored/i.test(modelId)) capabilities.push('creative');
        if (/guard|shield|safety/i.test(modelId)) capabilities.push('safety');

        // Detect from HTML content
        if (/code generation|programming|coding/i.test(html)) capabilities.push('coding');
        if (/vision|image understanding|multimodal/i.test(html)) capabilities.push('multimodal');
        if (/embedding|semantic search/i.test(html)) capabilities.push('embeddings');
        if (/reasoning|chain.of.thought/i.test(html)) capabilities.push('reasoning');

        // Default capability
        if (capabilities.length === 0) capabilities.push('chat');

        return [...new Set(capabilities)];
    }

    extractLastUpdated(html) {
        const match = html.match(/Updated?\s*(\d+\s*(?:days?|weeks?|months?|hours?)\s*ago)/i);
        return match ? match[1] : '';
    }

    isOfficialModel(html) {
        // Check for official badge or lack of namespace
        return /official|verified/i.test(html) || !/community/i.test(html);
    }

    // ==================== MAIN SCRAPING METHOD ====================

    /**
     * Scrape all models with all variants
     * @param {Function} onModelComplete - Callback when a model is complete
     * @returns {Object} { models: [], variants: [] }
     */
    async scrapeAll(onModelComplete = null) {
        const startTime = Date.now();

        // Step 1: Get list of all models
        const modelList = await this.scrapeModelList();
        const totalModels = modelList.length;

        this.onProgress({
            phase: 'details',
            message: `Scraping ${totalModels} models...`,
            current: 0,
            total: totalModels
        });

        const allModels = [];
        const allVariants = [];

        // Step 2: Process models in batches
        for (let i = 0; i < modelList.length; i += this.concurrency) {
            const batch = modelList.slice(i, i + this.concurrency);

            const batchPromises = batch.map(async ({ id }) => {
                try {
                    // Get model details
                    const model = await this.scrapeModelDetails(id);
                    if (!model) return null;

                    // Get all variants/tags
                    await this.sleep(this.rateLimitMs);
                    const variants = await this.scrapeModelTags(id);

                    return { model, variants };
                } catch (error) {
                    this.onError(`Error processing ${id}: ${error.message}`);
                    return null;
                }
            });

            const batchResults = await Promise.all(batchPromises);

            for (const result of batchResults) {
                if (result) {
                    allModels.push(result.model);
                    allVariants.push(...result.variants);

                    if (onModelComplete) {
                        onModelComplete(result.model, result.variants);
                    }
                }
            }

            this.onProgress({
                phase: 'details',
                message: `Scraped ${Math.min(i + this.concurrency, totalModels)}/${totalModels} models`,
                current: Math.min(i + this.concurrency, totalModels),
                total: totalModels
            });

            // Rate limiting between batches
            await this.sleep(this.rateLimitMs * 2);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        this.onProgress({
            phase: 'complete',
            message: `Scraped ${allModels.length} models with ${allVariants.length} variants in ${elapsed}s`
        });

        return {
            models: allModels,
            variants: allVariants,
            stats: {
                modelCount: allModels.length,
                variantCount: allVariants.length,
                elapsedSeconds: parseFloat(elapsed)
            }
        };
    }
}

module.exports = EnhancedOllamaScraper;
