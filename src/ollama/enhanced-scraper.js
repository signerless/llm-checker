/**
 * Enhanced Ollama Scraper
 * Scrapes ALL models from ollama.com with ALL variants and quantizations.
 * Optionally reads exact sizes and quantizations from registry.ollama.ai.
 */

const https = require('https');

class EnhancedOllamaScraper {
    constructor(options = {}) {
        this.baseURL = 'https://ollama.com';
        this.concurrency = options.concurrency || 5;
        this.rateLimitMs = options.rateLimitMs || 200;
        this.timeout = options.timeout || 15000;
        this.maxRetries = options.maxRetries || 3;
        this.registryURL = options.registryURL || 'https://registry.ollama.ai';
        // Registry manifests give exact bytes and quantizations at the cost of
        // two requests per distinct tag digest; off unless asked for.
        this.exact = Boolean(options.exact);
        // License blobs are shared by many tags; classify each digest once.
        this.licenseCache = new Map();

        // Progress tracking
        this.onProgress = options.onProgress || (() => {});
        this.onError = options.onError || console.error;
    }

    /**
     * Make HTTP request with retry logic
     */
    async httpGet(url, retries = 0, extraHeaders = {}) {
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
                    'Cache-Control': 'no-cache',
                    ...extraHeaders
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
                            this.httpGet(url, retries + 1, extraHeaders).then(resolve).catch(reject);
                        }, (retries + 1) * 2000);
                    } else if (res.statusCode >= 300 && res.statusCode < 400) {
                        // Redirect
                        const redirectUrl = res.headers.location;
                        if (redirectUrl) {
                            this.httpGet(redirectUrl.startsWith('http') ? redirectUrl : new URL(redirectUrl, url).toString(), retries, extraHeaders)
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
                        this.httpGet(url, retries + 1, extraHeaders).then(resolve).catch(reject);
                    }, (retries + 1) * 1000);
                } else {
                    reject(err);
                }
            });

            req.on('timeout', () => {
                req.destroy();
                if (retries < this.maxRetries) {
                    this.httpGet(url, retries + 1, extraHeaders).then(resolve).catch(reject);
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
     * Scrape the main library page to get all model identifiers, plus the
     * capability badges, pulls and tag counts each listing card shows.
     */
    async scrapeModelList() {
        this.onProgress({ phase: 'list', message: 'Fetching model list from ollama.com/library...' });

        const html = await this.httpGet(`${this.baseURL}/library`);
        const models = this.parseLibraryListing(html);

        this.onProgress({ phase: 'list', message: `Found ${models.length} models` });

        return models;
    }

    parseLibraryListing(html = '') {
        const models = [];
        const seen = new Set();
        const cards = String(html).split(/<li\b[^>]*>/i).slice(1);
        for (const card of cards) {
            const idMatch = card.match(/href="\/library\/([^"/:?#]+)"/i);
            if (!idMatch) continue;
            const id = idMatch[1].toLowerCase();
            if (seen.has(id)) continue;
            seen.add(id);
            const text = this.cleanText(card);
            const pullsMatch = text.match(/(\d+(?:\.\d+)?\s*[KMB]?)\s*Pulls\b/i);
            const tagsMatch = text.match(/(\d+)\s*Tags\b/i);
            const descriptionMatch = card.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
            models.push({
                id,
                pulls: pullsMatch ? this.parsePulls(pullsMatch[1]) : 0,
                tags_count: tagsMatch ? parseInt(tagsMatch[1], 10) : 0,
                description: descriptionMatch ? this.cleanText(descriptionMatch[1]) : '',
                badges: this.extractCapabilityBadges(card),
                sizes: this.extractSizeBadges(card)
            });
        }

        // Fallback for an unrecognised layout: plain library links.
        if (models.length === 0) {
            const linkPattern = /href="\/library\/([^"/:?#]+)"/gi;
            let match;
            while ((match = linkPattern.exec(html)) !== null) {
                const id = match[1].toLowerCase();
                if (!seen.has(id)) {
                    seen.add(id);
                    models.push({ id, pulls: 0, badges: [], sizes: [] });
                }
            }
        }
        return models;
    }

    // Capability badges (vision, tools, thinking, embedding, audio, cloud...) are
    // the indigo/cyan pills; parameter sizes are the blue ones.
    extractCapabilityBadges(html = '') {
        const badges = [];
        const pattern = /<span[^>]*class="[^"]*\bbg-(?:indigo|cyan)-50\b[^"]*"[^>]*>([^<]+)<\/span>/gi;
        let match;
        while ((match = pattern.exec(html)) !== null) {
            const badge = this.cleanText(match[1]).toLowerCase();
            if (badge && !badges.includes(badge)) badges.push(badge);
        }
        return badges;
    }

    extractSizeBadges(html = '') {
        const sizes = [];
        const pattern = /<span[^>]*class="[^"]*bg-\[#ddf4ff\][^"]*"[^>]*>([^<]+)<\/span>/gi;
        let match;
        while ((match = pattern.exec(html)) !== null) sizes.push(this.cleanText(match[1]).toLowerCase());
        return sizes;
    }

    /**
     * Parse pull count (e.g., "1.2M" -> 1200000)
     */
    parsePulls(pullStr) {
        if (!pullStr) return 0;
        const normalized = String(pullStr).replace(/\s+/g, '');
        const num = parseFloat(normalized);
        if (normalized.includes('B')) return Math.round(num * 1e9);
        if (normalized.includes('M')) return Math.round(num * 1e6);
        if (normalized.includes('K')) return Math.round(num * 1e3);
        return Math.round(num);
    }

    cleanText(html = '') {
        return String(html || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;|&#160;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCodePoint(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (match, decimal) => String.fromCodePoint(Number(decimal)))
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Scrape model detail page
     */
    async scrapeModelDetails(modelId, listing = {}) {
        const url = `${this.baseURL}/library/${modelId}`;

        try {
            const html = await this.httpGet(url);
            const description = listing.description || this.extractDescription(html);
            const badges = [...new Set([...(listing.badges || []), ...this.extractCapabilityBadges(html)])];

            const model = {
                id: modelId,
                name: this.extractModelName(html, modelId),
                description,
                pulls: this.extractPulls(html) || listing.pulls || 0,
                tags_count: this.extractTagsCount(html) || listing.tags_count || 0,
                capabilities: this.extractCapabilities(description, modelId, badges),
                badges,
                last_updated: this.extractLastUpdated(html),
                url: url,
                // Everything under /library is published by Ollama itself;
                // community models live under /<user>/<model>.
                type: 'official'
            };

            return model;
        } catch (error) {
            this.onError(`Error scraping ${modelId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Scrape all tags/variants for a model.
     *
     * Each row of /library/<model>/tags publishes the manifest digest, download
     * size, context window and input types. Cloud tags have no download and are
     * not local variants. Nothing is estimated: a value the page does not show
     * stays null.
     */
    async scrapeModelTags(modelId) {
        const url = `${this.baseURL}/library/${modelId}/tags`;

        try {
            const html = await this.httpGet(url);
            let variants = this.parseTagRows(modelId, html);

            if (variants === null) {
                // Unrecognised layout: fall back to tag names only.
                const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const tagPattern = new RegExp(`${escaped}:([\\w.\\-]+)`, 'gi');
                const seenTags = new Set();
                variants = [];
                let match;
                while ((match = tagPattern.exec(html)) !== null) {
                    const tag = `${modelId}:${match[1]}`;
                    if (seenTags.has(tag) || this.isCloudTag(tag)) continue;
                    seenTags.add(tag);
                    variants.push(this.parseVariant(modelId, tag, null));
                }
            }

            variants = this.shareAliasMetadata(variants);
            if (this.exact && variants.length > 0) {
                await this.enrichFromRegistry(modelId, variants);
            }
            return variants;
        } catch (error) {
            this.onError(`Error scraping tags for ${modelId}: ${error.message}`);
            // Return at least a latest variant
            return [this.parseVariant(modelId, `${modelId}:latest`, null)];
        }
    }

    /**
     * Parse the per-tag rows. Returns null when the page has no recognisable
     * rows, and [] when every row is a cloud-only tag.
     */
    parseTagRows(modelId, html = '') {
        const blocks = String(html).split(/<div class="group px-4 py-3">/i).slice(1);
        if (blocks.length === 0) return null;
        const variants = [];
        const seen = new Set();
        for (const block of blocks) {
            const tagMatch = block.match(/href="\/library\/([^"]+:[^"]+)"/i);
            if (!tagMatch) continue;
            const tag = tagMatch[1];
            if (seen.has(tag)) continue;
            seen.add(tag);
            const text = this.cleanText(block);
            const digest = (text.match(/\b([0-9a-f]{12})\b/) || [])[1] || null;
            const sizeMatch = text.match(/•\s*(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)\s*•/i);
            if (this.isCloudTag(tag) || (!sizeMatch && /\bUsage\b/i.test(text))) continue;
            const variant = this.parseVariant(modelId, tag, sizeMatch ? this.toGiB(sizeMatch[1], sizeMatch[2]) : null);
            const contextMatch = text.match(/(\d+(?:\.\d+)?)\s*([KM])\s*context window/i);
            if (contextMatch) {
                variant.context_length = Math.round(Number(contextMatch[1]) * (contextMatch[2].toUpperCase() === 'M' ? 1024 * 1024 : 1024));
            }
            const inputMatch = text.match(/•\s*([A-Za-z][A-Za-z, ]*?)\s+input\b/i);
            if (inputMatch) {
                const types = inputMatch[1].split(',').map((type) => type.trim().toLowerCase()).filter(Boolean);
                if (types.length) variant.input_types = [...new Set(['text', ...types])];
            }
            variant.digest = digest;
            variants.push(variant);
        }
        return variants;
    }

    isCloudTag(tag = '') {
        return /(?:[:-])cloud$/i.test(String(tag));
    }

    // ollama.com prints decimal units (4.9GB for 4,920,738,944 bytes). Hardware
    // memory is detected in GiB, so stored sizes use binary units.
    toGiB(value, unit) {
        const multiplier = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[String(unit).toUpperCase()] || 1e9;
        return Math.round((Number(value) * multiplier / (1024 ** 3)) * 1000) / 1000;
    }

    /**
     * Tags that share a manifest digest are aliases of one artifact
     * (`llama3.1:latest` = `llama3.1:8b` = `llama3.1:8b-instruct-q4_K_M`), so a
     * size or quantization spelled out in one alias holds for all of them.
     */
    shareAliasMetadata(variants) {
        const byDigest = new Map();
        for (const variant of variants) {
            if (!variant.digest) continue;
            if (!byDigest.has(variant.digest)) byDigest.set(variant.digest, []);
            byDigest.get(variant.digest).push(variant);
        }
        for (const group of byDigest.values()) {
            const known = (key) => group.map((variant) => variant[key]).find((value) => value !== null && value !== undefined);
            const params = known('params_b');
            const quant = known('quant');
            for (const variant of group) {
                if (variant.params_b == null && params != null) variant.params_b = params;
                if (variant.quant == null && quant != null) variant.quant = quant;
                if (group.some((other) => other.is_moe)) variant.is_moe = true;
            }
        }
        return variants;
    }

    /**
     * Exact metadata from the official registry: the manifest lists each layer's
     * byte size and the config blob names the quantization (`file_type`),
     * parameter count (`model_type`) and architecture family. One request pair
     * per distinct digest.
     */
    async enrichFromRegistry(modelId, variants) {
        const byDigest = new Map();
        for (const variant of variants) {
            const key = variant.digest || variant.tag;
            if (!byDigest.has(key)) byDigest.set(key, []);
            byDigest.get(key).push(variant);
        }
        const groups = [...byDigest.values()];
        let index = 0;
        const worker = async () => {
            while (index < groups.length) {
                const group = groups[index];
                index += 1;
                const tagName = group[0].tag.split(':').slice(1).join(':');
                try {
                    const manifest = JSON.parse(await this.httpGet(
                        `${this.registryURL}/v2/library/${modelId}/manifests/${encodeURIComponent(tagName)}`,
                        0,
                        { Accept: 'application/vnd.docker.distribution.manifest.v2+json' }
                    ));
                    const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
                    const weights = layers.filter((layer) => /\.(model|projector|adapter)$/.test(String(layer.mediaType)));
                    if (weights.length === 0) continue;
                    const sizeBytes = weights.reduce((sum, layer) => sum + (Number(layer.size) || 0), 0);
                    const modelLayer = weights.find((layer) => /\.model$/.test(String(layer.mediaType)));
                    let config = {};
                    if (manifest.config?.digest) {
                        config = JSON.parse(await this.httpGet(`${this.registryURL}/v2/library/${modelId}/blobs/${manifest.config.digest}`));
                    }
                    const licenseLayers = layers.filter((layer) => /\.license$/.test(String(layer.mediaType)) && layer.digest);
                    const licenses = [];
                    for (const layer of licenseLayers) {
                        licenses.push(await this.fetchLicense(modelId, layer.digest));
                    }
                    const license = licenses.find((id) => id && id !== 'other') || licenses[0] || null;
                    const params = this.extractParams(String(config.model_type || '').toLowerCase());
                    const quant = this.normalizeFileType(config.file_type);
                    const families = [config.model_family, ...(config.model_families || [])].map((family) => String(family || '').toLowerCase());
                    for (const variant of group) {
                        variant.size_bytes = sizeBytes;
                        variant.size_gb = Math.round((sizeBytes / (1024 ** 3)) * 1000) / 1000;
                        if (params) variant.params_b = params;
                        if (quant) variant.quant = quant;
                        if (modelLayer?.digest) variant.blob_digest = modelLayer.digest;
                        if (license) variant.license = license;
                        if (families.some((family) => /moe/.test(family))) variant.is_moe = true;
                        if (weights.some((layer) => /\.projector$/.test(String(layer.mediaType))) &&
                            !variant.input_types.includes('image')) {
                            variant.input_types = [...variant.input_types, 'image'];
                        }
                    }
                } catch (error) {
                    this.onError(`Registry metadata unavailable for ${group[0].tag}: ${error.message}`);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.concurrency, groups.length) }, worker));
    }

    async fetchLicense(modelId, digest) {
        if (!this.licenseCache.has(digest)) {
            this.licenseCache.set(digest, this.httpGet(`${this.registryURL}/v2/library/${modelId}/blobs/${digest}`)
                .then((text) => this.classifyLicense(text))
                .catch(() => null));
        }
        return this.licenseCache.get(digest);
    }

    /**
     * Map a license text to a short identifier (SPDX where one exists). A
     * license the patterns do not recognise is reported as 'other', never
     * guessed.
     */
    classifyLicense(text = '') {
        const head = String(text).slice(0, 4000).replace(/\s+/g, ' ');
        const rules = [
            [/LLAMA 4 COMMUNITY LICENSE/i, 'llama4'],
            [/LLAMA 3\.3 COMMUNITY LICENSE/i, 'llama3.3'],
            [/LLAMA 3\.2 COMMUNITY LICENSE/i, 'llama3.2'],
            [/LLAMA 3\.1 COMMUNITY LICENSE/i, 'llama3.1'],
            [/LLAMA 3 COMMUNITY LICENSE/i, 'llama3'],
            [/LLAMA 2 COMMUNITY LICENSE/i, 'llama2'],
            [/Gemma Terms of Use/i, 'gemma'],
            [/Qwen RESEARCH LICENSE/i, 'qwen-research'],
            [/Tongyi Qianwen|Qwen LICENSE AGREEMENT/i, 'qwen'],
            [/DEEPSEEK LICENSE AGREEMENT|DeepSeek License Agreement/i, 'deepseek'],
            [/NVIDIA Open Model License/i, 'nvidia-open-model-license'],
            [/Mistral AI Research License/i, 'mrl'],
            [/Attribution-NonCommercial-ShareAlike 4\.0/i, 'cc-by-nc-sa-4.0'],
            [/Attribution-NonCommercial 4\.0/i, 'cc-by-nc-4.0'],
            [/Attribution-ShareAlike 4\.0/i, 'cc-by-sa-4.0'],
            [/Creative Commons Attribution 4\.0|Attribution 4\.0 International/i, 'cc-by-4.0'],
            [/OpenRAIL/i, 'openrail'],
            [/Apache License,? Version 2\.0/i, 'apache-2.0'],
            [/\bMIT License\b|Permission is hereby granted, free of charge/i, 'mit'],
            [/GNU AFFERO GENERAL PUBLIC LICENSE/i, 'agpl-3.0'],
            [/GNU GENERAL PUBLIC LICENSE/i, 'gpl-3.0'],
            [/Redistribution and use in source and binary forms/i, 'bsd-3-clause']
        ];
        const match = rules.find(([pattern]) => pattern.test(head));
        return match ? match[1] : (head.trim() ? 'other' : null);
    }

    normalizeFileType(fileType) {
        const value = String(fileType || '').trim().toUpperCase();
        if (!value || value === 'UNKNOWN') return null;
        return ({ F16: 'FP16', F32: 'FP32' })[value] || value;
    }

    /**
     * Parse variant info from tag string
     */
    parseVariant(modelId, tag, sizeGB) {
        return {
            model_id: modelId,
            tag: tag,
            params_b: this.extractParams(tag),
            quant: this.extractQuantization(tag),
            size_gb: sizeGB,
            // Unknown unless the tag, tags page or registry states it.
            context_length: this.extractContextLength(tag),
            input_types: this.extractInputTypes(tag, modelId),
            is_moe: this.isMoE(tag, modelId),
            expert_count: this.extractExpertCount(tag)
        };
    }

    /**
     * Extract parameter count from tag
     */
    extractParams(tag) {
        // Mixture-of-experts tags ("8x7b") hold every expert in memory.
        const moe = String(tag).match(/(\d+)x(\d+(?:\.\d+)?)b(?:[^a-zA-Z]|$)/i);
        if (moe) return Number(moe[1]) * Number(moe[2]);
        // Match patterns like: 8b, 70b, 1.5b, 335m, 22m
        const match = String(tag).match(/(\d+\.?\d*)\s*([bBmM])(?:[^a-zA-Z]|$)/);
        if (match) {
            const value = parseFloat(match[1]);
            const unit = match[2].toLowerCase();
            return unit === 'm' ? value / 1000 : value;
        }

        return null;
    }

    /**
     * Extract quantization from tag
     */
    extractQuantization(tag) {
        const name = String(tag).split(':').slice(1).join(':') || String(tag);
        const quantPatterns = [
            // IQ patterns first: "iq4_xs" also contains "q4_".
            { pattern: /iq4[_-]?nl/i, quant: 'IQ4_NL' },
            { pattern: /iq4[_-]?xs/i, quant: 'IQ4_XS' },
            { pattern: /iq3[_-]?xxs/i, quant: 'IQ3_XXS' },
            { pattern: /iq3[_-]?xs/i, quant: 'IQ3_XS' },
            { pattern: /iq3[_-]?s\b/i, quant: 'IQ3_S' },
            { pattern: /iq2[_-]?xxs/i, quant: 'IQ2_XXS' },
            { pattern: /iq2[_-]?xs/i, quant: 'IQ2_XS' },
            { pattern: /iq1[_-]?s/i, quant: 'IQ1_S' },
            // K-quant and legacy patterns
            { pattern: /q8[_-]?0/i, quant: 'Q8_0' },
            { pattern: /q6[_-]?k/i, quant: 'Q6_K' },
            { pattern: /q5[_-]?k[_-]?m/i, quant: 'Q5_K_M' },
            { pattern: /q5[_-]?k[_-]?s/i, quant: 'Q5_K_S' },
            { pattern: /q5[_-]?1/i, quant: 'Q5_1' },
            { pattern: /q5[_-]?0/i, quant: 'Q5_0' },
            { pattern: /q4[_-]?k[_-]?m/i, quant: 'Q4_K_M' },
            { pattern: /q4[_-]?k[_-]?s/i, quant: 'Q4_K_S' },
            { pattern: /q4[_-]?1/i, quant: 'Q4_1' },
            { pattern: /q4[_-]?0/i, quant: 'Q4_0' },
            { pattern: /q3[_-]?k[_-]?m/i, quant: 'Q3_K_M' },
            { pattern: /q3[_-]?k[_-]?s/i, quant: 'Q3_K_S' },
            { pattern: /q3[_-]?k[_-]?l/i, quant: 'Q3_K_L' },
            { pattern: /q2[_-]?k/i, quant: 'Q2_K' },
            // Float formats
            { pattern: /mxfp4/i, quant: 'MXFP4' },
            { pattern: /bf16/i, quant: 'BF16' },
            { pattern: /fp16|f16/i, quant: 'FP16' },
            { pattern: /fp32|f32/i, quant: 'FP32' },
            { pattern: /fp8/i, quant: 'FP8' },
            // INT patterns
            { pattern: /int8/i, quant: 'INT8' },
            { pattern: /int4/i, quant: 'INT4' },
        ];

        for (const { pattern, quant } of quantPatterns) {
            if (pattern.test(name)) return quant;
        }

        // Default tags (`:latest`, `:8b`) do not name their quantization; it
        // comes from an alias with the same digest or from the registry.
        return null;
    }

    /**
     * Extract context length from tag
     */
    extractContextLength(tag) {
        // Tag suffixes such as "-128k" state the window; nothing else is assumed.
        const match = String(tag).match(/[-_:](\d+)[kK](?:[^a-zA-Z]|$)/);
        return match ? parseInt(match[1], 10) * 1024 : null;
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
        return /mixtral|moe|experts|\d+x\d+b|[-:]a\d+(?:\.\d+)?b\b/i.test(tag) || /mixtral|moe/i.test(modelId);
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

    // ==================== HTML EXTRACTION HELPERS ====================

    extractModelName(html, modelId) {
        // Try to get display name from title or h1
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
            const title = this.cleanText(titleMatch[1])
                .split('·')[0]
                .replace(/\s+-\s+Ollama.*$/i, '')
                .trim();
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
            return this.cleanText(metaMatch[1]).substring(0, 500);
        }

        // Try first paragraph
        const pMatch = html.match(/<p[^>]*>([^<]{20,500})<\/p>/i);
        if (pMatch) {
            return this.cleanText(pMatch[1]);
        }

        return '';
    }

    extractPulls(html) {
        const text = this.cleanText(html);
        const match = text.match(/(\d+(?:\.\d+)?\s*[KMB]?)\s*(?:Pulls|Downloads)\b/i);
        return match ? this.parsePulls(match[1]) : 0;
    }

    extractTagsCount(html) {
        const text = this.cleanText(html);
        const match = text.match(/\bName\s+(\d+)\s+models?\s+Size\b/i) ||
            text.match(/\b(\d+)\s+(?:Tags|Versions|models?)\b/i);
        return match ? parseInt(match[1]) : 1;
    }

    /**
     * Ollama's capability badges are authoritative (vision, tools, thinking,
     * embedding, audio). They are kept verbatim and mapped onto the app's
     * categories. Name and description patterns only add task specialisations.
     * Scanning the whole page HTML matched navigation text and tagged most of
     * the library as coding or multimodal.
     */
    extractCapabilities(description = '', modelId = '', badges = []) {
        const capabilities = [];
        const badgeCategories = {
            vision: 'multimodal',
            thinking: 'reasoning',
            embedding: 'embeddings',
            tools: 'tools',
            audio: 'audio'
        };
        for (const badge of badges) {
            if (badge === 'cloud') continue;
            if (badgeCategories[badge]) capabilities.push(badgeCategories[badge]);
            capabilities.push(badge);
        }

        // Detect by model ID patterns
        if (/code|coder|starcoder|codestral|devstral/i.test(modelId)) capabilities.push('coding');
        if (/llava|vision|minicpm-v|bakllava|moondream/i.test(modelId)) capabilities.push('multimodal');
        if (/embed|bge|gte|e5|minilm/i.test(modelId)) capabilities.push('embeddings');
        if (/deepseek-r1|qwq|reasoning/i.test(modelId)) capabilities.push('reasoning');
        if (/math|mathstral/i.test(modelId)) capabilities.push('math');
        if (/dolphin|wizard|uncensored/i.test(modelId)) capabilities.push('creative');
        if (/guard|shield|safety/i.test(modelId)) capabilities.push('safety');

        // Detect from the model's own description
        if (/code generation|programming|coding/i.test(description)) capabilities.push('coding');
        if (/image understanding|multimodal|vision-language/i.test(description)) capabilities.push('multimodal');
        if (/embedding model|semantic search/i.test(description)) capabilities.push('embeddings');
        if (/reasoning|chain.of.thought/i.test(description)) capabilities.push('reasoning');

        // Default capability for generative models
        if (!capabilities.some((capability) => capability !== 'tools')) capabilities.push('chat');

        return [...new Set(capabilities)];
    }

    extractLastUpdated(html) {
        const text = this.cleanText(html);
        const match = text.match(/Updated\s+(\d+\s*(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago)/i);
        return match ? match[1] : '';
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

            const batchPromises = batch.map(async (listing) => {
                const { id } = listing;
                try {
                    // Get model details
                    const model = await this.scrapeModelDetails(id, listing);
                    if (!model) return null;

                    // Get all variants/tags
                    await this.sleep(this.rateLimitMs);
                    const variants = await this.scrapeModelTags(id);
                    // Cloud-only models have no tag that runs locally.
                    if (variants.length === 0) return null;

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
