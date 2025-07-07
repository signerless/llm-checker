const { OllamaNativeScraper } = require('./native-scraper');
const OllamaClient = require('./client');

class EnhancedOllamaClient extends OllamaClient {
    constructor() {
        super();
        this.scraper = new OllamaNativeScraper();
    }

    async getEnhancedCompatibleModels() {
        try {
            const localModels = await this.getLocalModels();
            const compatibility = await this.scraper.findCompatibleModels(localModels);

            const compatible = compatibility.compatible_models.map(match => {
                return {
                    name: match.cloud.model_name,
                    identifier: match.cloud.model_identifier,
                    description: match.cloud.description,
                    local_name: match.local.name,
                    pulls: match.cloud.pulls,
                    url: match.cloud.url,
                    match_type: match.match_type,
                    score: this.calculateCompatibilityScore(match),
                    size: this.extractSizeFromName(match.cloud.model_identifier),
                    status: '📦',
                    installation: {
                        ollama: `ollama pull ${match.cloud.model_identifier}`
                    }
                };
            });

            const allModels = await this.scraper.scrapeAllModels();
            const recommendations = allModels.models
                .filter(m => !compatibility.compatible_models.find(c => c.cloud.model_identifier === m.model_identifier))
                .sort((a, b) => (b.pulls || 0) - (a.pulls || 0))
                .slice(0, 10)
                .map(model => ({
                    name: model.model_name,
                    identifier: model.model_identifier,
                    description: model.description,
                    pulls: model.pulls,
                    url: model.url,
                    score: this.calculateRecommendationScore(model),
                    size: this.extractSizeFromName(model.model_identifier),
                    installation: {
                        ollama: `ollama pull ${model.model_identifier}`
                    }
                }));

            return {
                installed: localModels.length,
                compatible: compatible.length,
                compatible_models: compatible,
                recommendations,
                total_available: allModels.total_count,
                cache_info: {
                    cached_at: allModels.cached_at,
                    expires_at: allModels.expires_at
                }
            };
        } catch (error) {
            console.error('Error in enhanced compatibility check:', error);
            return await this.getCompatibleModels();
        }
    }

    calculateCompatibilityScore(match) {
        let score = 75;
        if (match.match_type === 'exact') score += 20;
        const pulls = match.cloud.pulls || 0;
        if (pulls > 1000000) score += 5;
        if (pulls > 100000) score += 3;
        if (pulls > 10000) score += 1;
        return Math.min(100, score);
    }

    calculateRecommendationScore(model) {
        let score = 60;
        const pulls = model.pulls || 0;
        if (pulls > 10000000) score += 25;
        else if (pulls > 1000000) score += 20;
        else if (pulls > 100000) score += 15;
        else if (pulls > 10000) score += 10;
        if (model.model_type === 'official') score += 10;
        return Math.min(100, score);
    }

    extractSizeFromName(identifier) {
        const sizeMatch = identifier.match(/(\d+\.?\d*[bm])/i);
        return sizeMatch ? sizeMatch[1].toUpperCase() : 'Unknown';
    }

    async searchAvailableModels(query) {
        const results = await this.scraper.searchModels(query);
        return results.models.map(model => ({
            name: model.model_name,
            identifier: model.model_identifier,
            description: model.description,
            pulls: model.pulls,
            url: model.url,
            installation: {
                ollama: `ollama pull ${model.model_identifier}`
            }
        }));
    }

    async getOllamaStats() {
        return await this.scraper.getStats();
    }
}

module.exports = EnhancedOllamaClient;
