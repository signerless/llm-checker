const https = require('https');
const fs = require('fs');
const path = require('path');

class OllamaNativeScraper {
    constructor() {
        this.baseURL = 'https://ollama.com';
        this.cacheDir = path.join(__dirname, '.cache');
        this.cacheFile = path.join(this.cacheDir, 'ollama-models.json');
        this.cacheExpiry = 24 * 60 * 60 * 1000;

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
                    'Accept-Encoding': 'gzip, deflate',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    ...options.headers
                },
                ...options
            };

            const req = https.request(requestOptions, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ statusCode: res.statusCode, data, headers: res.headers });
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                    }
                });
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
        if (!fs.existsSync(this.cacheFile)) return false;
        const stats = fs.statSync(this.cacheFile);
        const age = Date.now() - stats.mtime.getTime();
        return age < this.cacheExpiry;
    }

    readCache() {
        try {
            const data = fs.readFileSync(this.cacheFile, 'utf8');
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

    async scrapeAllModels(forceRefresh = false) {
        try {
            if (!forceRefresh && this.isCacheValid()) {
                return this.readCache();
            }

            const response = await this.httpRequest(`${this.baseURL}/library`);
            if (response.statusCode !== 200) throw new Error(`Failed to fetch: ${response.statusCode}`);
            const models = this.parseModelFromHTML(response.data);
            if (models.length === 0) throw new Error('No models found');
            this.writeCache(models);

            return {
                models,
                total_count: models.length,
                cached_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + this.cacheExpiry).toISOString()
            };
        } catch (error) {
            const cachedData = this.readCache();
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
