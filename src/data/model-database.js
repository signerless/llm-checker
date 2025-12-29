/**
 * Model Database - SQLite storage for Ollama models
 * Provides fast indexed searches across 4000+ models
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

class ModelDatabase {
    constructor(options = {}) {
        this.dbPath = options.dbPath || path.join(os.homedir(), '.llm-checker', 'models.db');
        this.db = null;
        this.initialized = false;
    }

    /**
     * Initialize database with schema
     */
    async initialize() {
        if (this.initialized) return;

        // Ensure directory exists
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        // Use sql.js (pure JavaScript, works with any Node version)
        const initSqlJs = require('sql.js');
        const SQL = await initSqlJs();

        // Load existing database or create new
        if (fs.existsSync(this.dbPath)) {
            const buffer = fs.readFileSync(this.dbPath);
            this.db = new SQL.Database(buffer);
        } else {
            this.db = new SQL.Database();
        }
        this.useBetterSqlite = false;

        this.createSchema();
        this.initialized = true;
    }

    /**
     * Create database schema
     */
    createSchema() {
        const schema = `
            -- Main models table
            CREATE TABLE IF NOT EXISTS models (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                family TEXT,
                type TEXT DEFAULT 'official',
                description TEXT,
                capabilities TEXT,
                pulls INTEGER DEFAULT 0,
                tags_count INTEGER DEFAULT 0,
                namespace TEXT,
                url TEXT,
                last_updated TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- Variants table (each quantization/size combination)
            CREATE TABLE IF NOT EXISTS variants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                model_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                params_b REAL,
                quant TEXT,
                size_gb REAL,
                context_length INTEGER DEFAULT 4096,
                input_types TEXT DEFAULT '["text"]',
                is_moe INTEGER DEFAULT 0,
                expert_count INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
                UNIQUE(model_id, tag)
            );

            -- Benchmarks table (real performance data per hardware)
            CREATE TABLE IF NOT EXISTS benchmarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                variant_id INTEGER NOT NULL,
                hardware_fingerprint TEXT NOT NULL,
                tokens_per_second REAL,
                time_to_first_token REAL,
                memory_used_gb REAL,
                backend TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (variant_id) REFERENCES variants(id) ON DELETE CASCADE
            );

            -- Sync metadata table
            CREATE TABLE IF NOT EXISTS sync_meta (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            -- Create indexes for fast searches
            CREATE INDEX IF NOT EXISTS idx_models_family ON models(family);
            CREATE INDEX IF NOT EXISTS idx_models_pulls ON models(pulls DESC);
            CREATE INDEX IF NOT EXISTS idx_models_type ON models(type);
            CREATE INDEX IF NOT EXISTS idx_variants_params ON variants(params_b);
            CREATE INDEX IF NOT EXISTS idx_variants_size ON variants(size_gb);
            CREATE INDEX IF NOT EXISTS idx_variants_quant ON variants(quant);
            CREATE INDEX IF NOT EXISTS idx_variants_model ON variants(model_id);
            CREATE INDEX IF NOT EXISTS idx_benchmarks_hardware ON benchmarks(hardware_fingerprint);
            CREATE INDEX IF NOT EXISTS idx_benchmarks_variant ON benchmarks(variant_id);
        `;

        if (this.useBetterSqlite) {
            this.db.exec(schema);
        } else {
            this.db.run(schema);
            this.saveToFile();
        }
    }

    /**
     * Save sql.js database to file
     */
    saveToFile() {
        if (!this.useBetterSqlite && this.db) {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(this.dbPath, buffer);
        }
    }

    /**
     * Execute a query (handles both sqlite implementations)
     */
    run(sql, params = []) {
        if (this.useBetterSqlite) {
            return this.db.prepare(sql).run(...params);
        } else {
            this.db.run(sql, params);
            this.saveToFile();
        }
    }

    /**
     * Get all results from a query
     */
    all(sql, params = []) {
        if (this.useBetterSqlite) {
            return this.db.prepare(sql).all(...params);
        } else {
            const stmt = this.db.prepare(sql);
            stmt.bind(params);
            const results = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            return results;
        }
    }

    /**
     * Get single result from a query
     */
    get(sql, params = []) {
        if (this.useBetterSqlite) {
            return this.db.prepare(sql).get(...params);
        } else {
            const results = this.all(sql, params);
            return results.length > 0 ? results[0] : null;
        }
    }

    // ==================== MODEL OPERATIONS ====================

    /**
     * Insert or update a model
     */
    upsertModel(model) {
        const sql = `
            INSERT INTO models (id, name, family, type, description, capabilities, pulls, tags_count, namespace, url, last_updated, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                family = excluded.family,
                type = excluded.type,
                description = excluded.description,
                capabilities = excluded.capabilities,
                pulls = excluded.pulls,
                tags_count = excluded.tags_count,
                namespace = excluded.namespace,
                url = excluded.url,
                last_updated = excluded.last_updated,
                updated_at = CURRENT_TIMESTAMP
        `;

        this.run(sql, [
            model.id,
            model.name,
            model.family || this.inferFamily(model.id),
            model.type || 'official',
            model.description || '',
            JSON.stringify(model.capabilities || []),
            model.pulls || 0,
            model.tags_count || 0,
            model.namespace || '',
            model.url || `https://ollama.com/library/${model.id}`,
            model.last_updated || ''
        ]);
    }

    /**
     * Infer model family from identifier
     */
    inferFamily(modelId) {
        const id = modelId.toLowerCase();

        const families = [
            { pattern: /llama3\.2/, family: 'llama3.2' },
            { pattern: /llama3\.1/, family: 'llama3.1' },
            { pattern: /llama3/, family: 'llama3' },
            { pattern: /llama2/, family: 'llama2' },
            { pattern: /qwen2\.5/, family: 'qwen2.5' },
            { pattern: /qwen2/, family: 'qwen2' },
            { pattern: /qwen/, family: 'qwen' },
            { pattern: /mistral/, family: 'mistral' },
            { pattern: /mixtral/, family: 'mixtral' },
            { pattern: /gemma2/, family: 'gemma2' },
            { pattern: /gemma/, family: 'gemma' },
            { pattern: /phi-?3/, family: 'phi3' },
            { pattern: /phi-?4/, family: 'phi4' },
            { pattern: /phi/, family: 'phi' },
            { pattern: /deepseek-?coder/, family: 'deepseek-coder' },
            { pattern: /deepseek-?r1/, family: 'deepseek-r1' },
            { pattern: /deepseek/, family: 'deepseek' },
            { pattern: /codellama/, family: 'codellama' },
            { pattern: /starcoder/, family: 'starcoder' },
            { pattern: /tinyllama/, family: 'tinyllama' },
            { pattern: /llava/, family: 'llava' },
            { pattern: /dolphin/, family: 'dolphin' },
            { pattern: /wizard/, family: 'wizard' },
            { pattern: /neural-chat/, family: 'neural-chat' },
            { pattern: /orca/, family: 'orca' },
            { pattern: /vicuna/, family: 'vicuna' },
            { pattern: /yi/, family: 'yi' },
            { pattern: /solar/, family: 'solar' },
            { pattern: /command-r/, family: 'command-r' },
            { pattern: /nomic-embed/, family: 'nomic-embed' },
            { pattern: /mxbai-embed/, family: 'mxbai-embed' },
            { pattern: /bge/, family: 'bge' },
        ];

        for (const { pattern, family } of families) {
            if (pattern.test(id)) {
                return family;
            }
        }

        return 'other';
    }

    /**
     * Insert or update a variant
     */
    upsertVariant(variant) {
        const sql = `
            INSERT INTO variants (model_id, tag, params_b, quant, size_gb, context_length, input_types, is_moe, expert_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(model_id, tag) DO UPDATE SET
                params_b = excluded.params_b,
                quant = excluded.quant,
                size_gb = excluded.size_gb,
                context_length = excluded.context_length,
                input_types = excluded.input_types,
                is_moe = excluded.is_moe,
                expert_count = excluded.expert_count
        `;

        this.run(sql, [
            variant.model_id,
            variant.tag,
            variant.params_b || null,
            variant.quant || null,
            variant.size_gb || null,
            variant.context_length || 4096,
            JSON.stringify(variant.input_types || ['text']),
            variant.is_moe ? 1 : 0,
            variant.expert_count || null
        ]);
    }

    /**
     * Add benchmark result
     */
    addBenchmark(benchmark) {
        const sql = `
            INSERT INTO benchmarks (variant_id, hardware_fingerprint, tokens_per_second, time_to_first_token, memory_used_gb, backend)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        this.run(sql, [
            benchmark.variant_id,
            benchmark.hardware_fingerprint,
            benchmark.tokens_per_second,
            benchmark.time_to_first_token,
            benchmark.memory_used_gb,
            benchmark.backend
        ]);
    }

    // ==================== SEARCH OPERATIONS ====================

    /**
     * Search models with filters
     */
    searchModels(query = '', filters = {}) {
        let sql = `
            SELECT m.*,
                   COUNT(DISTINCT v.id) as variant_count,
                   MIN(v.size_gb) as min_size_gb,
                   MAX(v.size_gb) as max_size_gb,
                   MIN(v.params_b) as min_params_b,
                   MAX(v.params_b) as max_params_b
            FROM models m
            LEFT JOIN variants v ON m.id = v.model_id
            WHERE 1=1
        `;
        const params = [];

        // Text search
        if (query) {
            sql += ` AND (m.id LIKE ? OR m.name LIKE ? OR m.description LIKE ?)`;
            const searchPattern = `%${query}%`;
            params.push(searchPattern, searchPattern, searchPattern);
        }

        // Family filter
        if (filters.family) {
            sql += ` AND m.family = ?`;
            params.push(filters.family);
        }

        // Type filter
        if (filters.type) {
            sql += ` AND m.type = ?`;
            params.push(filters.type);
        }

        // Capability filter
        if (filters.capability) {
            sql += ` AND m.capabilities LIKE ?`;
            params.push(`%${filters.capability}%`);
        }

        // Min pulls filter
        if (filters.minPulls) {
            sql += ` AND m.pulls >= ?`;
            params.push(filters.minPulls);
        }

        sql += ` GROUP BY m.id`;

        // Params range filter (post-group)
        if (filters.minParams || filters.maxParams) {
            sql += ` HAVING 1=1`;
            if (filters.minParams) {
                sql += ` AND max_params_b >= ?`;
                params.push(filters.minParams);
            }
            if (filters.maxParams) {
                sql += ` AND min_params_b <= ?`;
                params.push(filters.maxParams);
            }
        }

        // Size range filter (post-group)
        if (filters.maxSizeGB) {
            if (!sql.includes('HAVING')) sql += ` HAVING 1=1`;
            sql += ` AND min_size_gb <= ?`;
            params.push(filters.maxSizeGB);
        }

        // Order by
        const orderBy = filters.orderBy || 'pulls';
        const orderDir = filters.orderDir || 'DESC';
        sql += ` ORDER BY m.${orderBy} ${orderDir}`;

        // Limit
        if (filters.limit) {
            sql += ` LIMIT ?`;
            params.push(filters.limit);
        }

        return this.all(sql, params);
    }

    /**
     * Get variants for a model
     */
    getVariants(modelId, filters = {}) {
        let sql = `
            SELECT v.*, m.name as model_name, m.family, m.pulls
            FROM variants v
            JOIN models m ON v.model_id = m.id
            WHERE v.model_id = ?
        `;
        const params = [modelId];

        if (filters.quant) {
            sql += ` AND v.quant = ?`;
            params.push(filters.quant);
        }

        if (filters.maxSizeGB) {
            sql += ` AND v.size_gb <= ?`;
            params.push(filters.maxSizeGB);
        }

        if (filters.minParams) {
            sql += ` AND v.params_b >= ?`;
            params.push(filters.minParams);
        }

        if (filters.maxParams) {
            sql += ` AND v.params_b <= ?`;
            params.push(filters.maxParams);
        }

        sql += ` ORDER BY v.params_b DESC, v.size_gb DESC`;

        return this.all(sql, params);
    }

    /**
     * Get all variants matching hardware constraints
     */
    getVariantsForHardware(maxSizeGB, filters = {}) {
        let sql = `
            SELECT v.*, m.name as model_name, m.family, m.pulls, m.capabilities, m.type
            FROM variants v
            JOIN models m ON v.model_id = m.id
            WHERE v.size_gb <= ?
        `;
        const params = [maxSizeGB];

        if (filters.category) {
            sql += ` AND m.capabilities LIKE ?`;
            params.push(`%${filters.category}%`);
        }

        if (filters.family) {
            sql += ` AND m.family = ?`;
            params.push(filters.family);
        }

        if (filters.quant) {
            sql += ` AND v.quant = ?`;
            params.push(filters.quant);
        }

        if (filters.minContext) {
            sql += ` AND v.context_length >= ?`;
            params.push(filters.minContext);
        }

        sql += ` ORDER BY m.pulls DESC, v.params_b DESC`;

        if (filters.limit) {
            sql += ` LIMIT ?`;
            params.push(filters.limit);
        }

        return this.all(sql, params);
    }

    /**
     * Search variants by query (searches model names/descriptions)
     */
    searchVariants(query = '', filters = {}) {
        let sql = `
            SELECT v.*, m.name as model_name, m.family, m.pulls, m.capabilities, m.type, m.description
            FROM variants v
            JOIN models m ON v.model_id = m.id
            WHERE 1=1
        `;
        const params = [];

        // Text search on model id, name, description
        if (query) {
            sql += ` AND (m.id LIKE ? OR m.name LIKE ? OR m.description LIKE ?)`;
            const searchPattern = `%${query}%`;
            params.push(searchPattern, searchPattern, searchPattern);
        }

        // Size filters
        if (filters.maxSize) {
            sql += ` AND (v.size_gb IS NULL OR v.size_gb <= ?)`;
            params.push(filters.maxSize);
        }

        if (filters.minSize) {
            sql += ` AND (v.size_gb IS NULL OR v.size_gb >= ?)`;
            params.push(filters.minSize);
        }

        // Quantization filter
        if (filters.quant) {
            sql += ` AND v.quant = ?`;
            params.push(filters.quant.toUpperCase());
        }

        // Family filter
        if (filters.family) {
            sql += ` AND m.family = ?`;
            params.push(filters.family.toLowerCase());
        }

        // Category/capability filter
        if (filters.category) {
            sql += ` AND m.capabilities LIKE ?`;
            params.push(`%${filters.category}%`);
        }

        sql += ` ORDER BY m.pulls DESC, v.params_b DESC, v.size_gb DESC`;

        if (filters.limit) {
            sql += ` LIMIT ?`;
            params.push(filters.limit);
        }

        return this.all(sql, params);
    }

    /**
     * Get benchmarks for a variant on specific hardware
     */
    getBenchmarks(variantId, hardwareFingerprint = null) {
        let sql = `SELECT * FROM benchmarks WHERE variant_id = ?`;
        const params = [variantId];

        if (hardwareFingerprint) {
            sql += ` AND hardware_fingerprint = ?`;
            params.push(hardwareFingerprint);
        }

        sql += ` ORDER BY created_at DESC`;

        return this.all(sql, params);
    }

    // ==================== SYNC OPERATIONS ====================

    /**
     * Get last sync timestamp
     */
    getLastSync() {
        const result = this.get(`SELECT value FROM sync_meta WHERE key = 'last_sync'`);
        return result ? result.value : null;
    }

    /**
     * Set last sync timestamp
     */
    setLastSync(timestamp) {
        this.run(`
            INSERT INTO sync_meta (key, value, updated_at)
            VALUES ('last_sync', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
        `, [timestamp]);
    }

    /**
     * Get total model count
     */
    getModelCount() {
        const result = this.get(`SELECT COUNT(*) as count FROM models`);
        return result ? result.count : 0;
    }

    /**
     * Get total variant count
     */
    getVariantCount() {
        const result = this.get(`SELECT COUNT(*) as count FROM variants`);
        return result ? result.count : 0;
    }

    /**
     * Get database stats
     */
    getStats() {
        return {
            models: this.getModelCount(),
            variants: this.getVariantCount(),
            lastSync: this.getLastSync(),
            families: this.all(`SELECT family, COUNT(*) as count FROM models GROUP BY family ORDER BY count DESC`),
            topModels: this.all(`SELECT id, name, pulls FROM models ORDER BY pulls DESC LIMIT 10`)
        };
    }

    /**
     * Clear all data
     */
    clear() {
        this.run(`DELETE FROM benchmarks`);
        this.run(`DELETE FROM variants`);
        this.run(`DELETE FROM models`);
        this.run(`DELETE FROM sync_meta`);
    }

    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            if (this.useBetterSqlite) {
                this.db.close();
            } else {
                this.saveToFile();
                this.db.close();
            }
        }
    }
}

module.exports = ModelDatabase;
