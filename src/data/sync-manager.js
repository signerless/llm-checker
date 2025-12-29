/**
 * Sync Manager - Coordinates scraping and database updates
 * Handles initial sync and incremental updates
 */

const ModelDatabase = require('./model-database');
const EnhancedOllamaScraper = require('../ollama/enhanced-scraper');

class SyncManager {
    constructor(options = {}) {
        this.db = options.database || new ModelDatabase();
        this.scraper = options.scraper || new EnhancedOllamaScraper({
            concurrency: options.concurrency || 5,
            rateLimitMs: options.rateLimitMs || 200,
            onProgress: options.onProgress || this.defaultOnProgress.bind(this),
            onError: options.onError || console.error
        });

        this.onProgress = options.onProgress || this.defaultOnProgress.bind(this);
        this.onError = options.onError || console.error;
    }

    /**
     * Default progress handler
     */
    defaultOnProgress(info) {
        if (info.phase === 'details' && info.current && info.total) {
            const pct = Math.round((info.current / info.total) * 100);
            process.stdout.write(`\r[${pct}%] ${info.message}    `);
        } else {
            console.log(info.message);
        }
    }

    /**
     * Initialize database
     */
    async init() {
        await this.db.initialize();
    }

    /**
     * Perform full sync from scratch
     */
    async fullSync() {
        await this.init();

        this.onProgress({ phase: 'start', message: 'Starting full sync...' });

        // Clear existing data
        this.db.clear();

        // Scrape all models
        const result = await this.scraper.scrapeAll((model, variants) => {
            // Save model as we go
            this.db.upsertModel(model);

            // Save variants
            for (const variant of variants) {
                this.db.upsertVariant(variant);
            }
        });

        // Update sync timestamp
        this.db.setLastSync(new Date().toISOString());

        const stats = this.db.getStats();

        this.onProgress({
            phase: 'complete',
            message: `Sync complete: ${stats.models} models, ${stats.variants} variants`,
            stats
        });

        return stats;
    }

    /**
     * Perform incremental sync (update only changed models)
     */
    async incrementalSync() {
        await this.init();

        const lastSync = this.db.getLastSync();

        if (!lastSync) {
            // No previous sync, do full sync
            return this.fullSync();
        }

        this.onProgress({ phase: 'start', message: 'Starting incremental sync...' });

        // Get current model list
        const modelList = await this.scraper.scrapeModelList();

        // Get existing models from DB
        const existingModels = new Set(
            this.db.all(`SELECT id FROM models`).map(m => m.id)
        );

        // Find new and potentially updated models
        const newModels = modelList.filter(m => !existingModels.has(m.id));
        const toUpdate = modelList.filter(m => existingModels.has(m.id));

        this.onProgress({
            phase: 'incremental',
            message: `Found ${newModels.length} new models, checking ${toUpdate.length} for updates...`
        });

        let updated = 0;
        let added = 0;

        // Process new models
        for (const { id } of newModels) {
            try {
                const model = await this.scraper.scrapeModelDetails(id);
                if (model) {
                    this.db.upsertModel(model);
                    added++;

                    const variants = await this.scraper.scrapeModelTags(id);
                    for (const variant of variants) {
                        this.db.upsertVariant(variant);
                    }
                }

                await this.sleep(200);
            } catch (error) {
                this.onError(`Error syncing ${id}: ${error.message}`);
            }
        }

        // Check for updates in existing models (sample top 50 by pulls)
        const topModels = toUpdate.sort((a, b) => (b.pulls || 0) - (a.pulls || 0)).slice(0, 50);

        for (const { id } of topModels) {
            try {
                const model = await this.scraper.scrapeModelDetails(id);
                if (model) {
                    const existing = this.db.get(`SELECT pulls, tags_count FROM models WHERE id = ?`, [id]);

                    // Update if pulls or tags changed significantly
                    if (!existing ||
                        Math.abs((existing.pulls || 0) - (model.pulls || 0)) > 1000 ||
                        (existing.tags_count || 0) !== (model.tags_count || 0)) {

                        this.db.upsertModel(model);

                        const variants = await this.scraper.scrapeModelTags(id);
                        for (const variant of variants) {
                            this.db.upsertVariant(variant);
                        }

                        updated++;
                    }
                }

                await this.sleep(100);
            } catch (error) {
                // Ignore errors during incremental update
            }
        }

        // Update sync timestamp
        this.db.setLastSync(new Date().toISOString());

        const stats = this.db.getStats();

        this.onProgress({
            phase: 'complete',
            message: `Incremental sync complete: ${added} added, ${updated} updated`,
            stats
        });

        return { added, updated, stats };
    }

    /**
     * Smart sync - chooses full or incremental based on conditions
     */
    async sync(options = {}) {
        await this.init();

        const force = options.force || false;
        const lastSync = this.db.getLastSync();
        const modelCount = this.db.getModelCount();

        // Full sync if:
        // - Force flag is set
        // - No previous sync
        // - Less than 100 models (probably incomplete)
        // - Last sync was more than 7 days ago
        if (force || !lastSync || modelCount < 100) {
            return this.fullSync();
        }

        const lastSyncDate = new Date(lastSync);
        const daysSinceSync = (Date.now() - lastSyncDate.getTime()) / (1000 * 60 * 60 * 24);

        if (daysSinceSync > 7) {
            return this.fullSync();
        }

        return this.incrementalSync();
    }

    /**
     * Check if sync is needed
     */
    async needsSync() {
        await this.init();

        const lastSync = this.db.getLastSync();
        const modelCount = this.db.getModelCount();

        if (!lastSync || modelCount < 100) {
            return { needed: true, reason: 'No previous sync or incomplete data' };
        }

        const lastSyncDate = new Date(lastSync);
        const hoursSinceSync = (Date.now() - lastSyncDate.getTime()) / (1000 * 60 * 60);

        if (hoursSinceSync > 24) {
            return { needed: true, reason: `Last sync was ${Math.round(hoursSinceSync)} hours ago` };
        }

        return { needed: false, stats: this.db.getStats() };
    }

    /**
     * Get database stats
     */
    async getStats() {
        await this.init();
        return this.db.getStats();
    }

    /**
     * Search models
     */
    async search(query, filters = {}) {
        await this.init();
        return this.db.searchModels(query, filters);
    }

    /**
     * Search for variants (not just models)
     */
    async searchVariants(query, filters = {}) {
        await this.init();
        return this.db.searchVariants(query, filters);
    }

    /**
     * Get variants for hardware constraints
     */
    async getCompatibleVariants(maxSizeGB, filters = {}) {
        await this.init();
        return this.db.getVariantsForHardware(maxSizeGB, filters);
    }

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

module.exports = SyncManager;
