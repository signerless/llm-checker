const fs = require('fs');
const path = require('path');
const os = require('os');

class ConfigManager {
    constructor() {
        this.configDir = path.join(os.homedir(), '.llm-checker');
        this.configFile = path.join(this.configDir, 'config.json');
        this.defaultConfig = this.getDefaultConfig();
        this.config = null;

        this.ensureConfigDirectory();
    }

    getDefaultConfig() {
        return {
            version: "2.0",
            ollama: {
                baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
                timeout: 30000,
                enabled: true,
                autoDetect: true,
                retryAttempts: 3
            },
            analysis: {
                includeCloudModels: false,
                defaultUseCase: "general",
                performanceTesting: false,
                detailedHardwareInfo: false,
                cacheResults: true,
                cacheExpiry: 300000
            },
            display: {
                maxModelsPerTable: 10,
                showEmojis: !process.env.NO_COLOR,
                colorOutput: !process.env.NO_COLOR,
                compactMode: false,
                showScores: true,
                showInstallCommands: true
            },
            quantization: {
                preferredLevel: "auto",
                availableLevels: ["Q2_K", "Q3_K_M", "Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q6_K", "Q8_0"],
                hardwareBased: {
                    ultra_low: ["Q2_K", "Q3_K_M"],
                    low: ["Q4_0", "Q4_K_M"],
                    medium: ["Q4_K_M", "Q5_0"],
                    high: ["Q5_K_M", "Q6_K"],
                    ultra_high: ["Q8_0", "Q6_K"]
                }
            },
            filters: {
                excludeModels: [],
                includeOnlyFrameworks: [],
                excludeCategories: [],
                minCompatibilityScore: 60,
                maxModelSize: null,
                yearFilter: null
            },
            hardware: {
                overrides: {
                    ram: process.env.LLM_CHECKER_RAM_GB ? (isNaN(parseInt(process.env.LLM_CHECKER_RAM_GB)) ? null : parseInt(process.env.LLM_CHECKER_RAM_GB)) : null,
                    vram: process.env.LLM_CHECKER_VRAM_GB ? (isNaN(parseInt(process.env.LLM_CHECKER_VRAM_GB)) ? null : parseInt(process.env.LLM_CHECKER_VRAM_GB)) : null,
                    cpuCores: process.env.LLM_CHECKER_CPU_CORES ? (isNaN(parseInt(process.env.LLM_CHECKER_CPU_CORES)) ? null : parseInt(process.env.LLM_CHECKER_CPU_CORES)) : null,
                    architecture: process.env.LLM_CHECKER_ARCHITECTURE || null
                },
                ignoreIntegratedGPU: process.env.LLM_CHECKER_NO_GPU === 'true',
                preferDedicatedGPU: true,
                cacheHardwareInfo: true
            },
            recommendations: {
                maxRecommendations: 5,
                includeUpgradeSuggestions: true,
                showPerformanceEstimates: true,
                groupByCategory: true,
                prioritizeOllamaSupport: true
            },
            logging: {
                level: process.env.LLM_CHECKER_LOG_LEVEL || "info",
                file: null,
                enableDebug: process.env.DEBUG === '1',
                enableVerbose: false,
                saveReports: false,
                reportsDirectory: path.join(os.homedir(), '.llm-checker', 'reports')
            },
            updates: {
                checkForUpdates: true,
                autoUpdateDatabase: true,
                updateChannel: "stable",
                notifyNewModels: true
            },
            customModels: []
        };
    }

    ensureConfigDirectory() {
        if (!fs.existsSync(this.configDir)) {
            try {
                fs.mkdirSync(this.configDir, { recursive: true });
            } catch (error) {
                console.warn(`Warning: Could not create config directory: ${error.message}`);
            }
        }
    }

    loadConfig() {
        if (this.config) {
            return this.config;
        }

        let userConfig = {};

        // Try to load user config file
        if (fs.existsSync(this.configFile)) {
            try {
                const configContent = fs.readFileSync(this.configFile, 'utf8');
                userConfig = JSON.parse(configContent);
            } catch (error) {
                console.warn(`Warning: Could not parse config file: ${error.message}`);
                console.warn('Using default configuration');
            }
        }

        // Merge with defaults
        this.config = this.mergeConfigs(this.defaultConfig, userConfig);

        // Apply environment variable overrides
        this.applyEnvironmentOverrides();

        return this.config;
    }

    saveConfig(config = null) {
        const configToSave = config || this.config || this.defaultConfig;

        try {
            const configContent = JSON.stringify(configToSave, null, 2);
            fs.writeFileSync(this.configFile, configContent, 'utf8');
            this.config = configToSave;
            return true;
        } catch (error) {
            console.error(`Error saving config: ${error.message}`);
            return false;
        }
    }

    mergeConfigs(defaultConfig, userConfig) {
        const merged = { ...defaultConfig };

        for (const [key, value] of Object.entries(userConfig)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                merged[key] = this.mergeConfigs(defaultConfig[key] || {}, value);
            } else {
                merged[key] = value;
            }
        }

        return merged;
    }

    applyEnvironmentOverrides() {
        if (!this.config) return;

        // Hardware overrides (validate parsed values are valid numbers)
        if (process.env.LLM_CHECKER_RAM_GB) {
            const parsed = parseInt(process.env.LLM_CHECKER_RAM_GB);
            if (!isNaN(parsed) && parsed > 0) this.config.hardware.overrides.ram = parsed;
        }
        if (process.env.LLM_CHECKER_VRAM_GB) {
            const parsed = parseInt(process.env.LLM_CHECKER_VRAM_GB);
            if (!isNaN(parsed) && parsed > 0) this.config.hardware.overrides.vram = parsed;
        }
        if (process.env.LLM_CHECKER_CPU_CORES) {
            const parsed = parseInt(process.env.LLM_CHECKER_CPU_CORES);
            if (!isNaN(parsed) && parsed > 0) this.config.hardware.overrides.cpuCores = parsed;
        }

        // Ollama overrides
        if (process.env.OLLAMA_BASE_URL) {
            this.config.ollama.baseURL = process.env.OLLAMA_BASE_URL;
        }

        // Display overrides
        if (process.env.NO_COLOR) {
            this.config.display.colorOutput = false;
            this.config.display.showEmojis = false;
        }

        // Debug overrides
        if (process.env.DEBUG === '1') {
            this.config.logging.enableDebug = true;
            this.config.logging.level = 'debug';
        }

        // GPU overrides
        if (process.env.LLM_CHECKER_NO_GPU === 'true') {
            this.config.hardware.ignoreIntegratedGPU = true;
        }
    }

    get(keyPath, defaultValue = null) {
        const config = this.loadConfig();
        const keys = keyPath.split('.');
        let value = config;

        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key];
            } else {
                return defaultValue;
            }
        }

        return value;
    }

    set(keyPath, value) {
        const config = this.loadConfig();
        const keys = keyPath.split('.');
        const lastKey = keys.pop();

        let current = config;
        for (const key of keys) {
            if (!current[key] || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }

        current[lastKey] = value;
        this.saveConfig(config);

        return true;
    }

    reset() {
        this.config = null;
        if (fs.existsSync(this.configFile)) {
            try {
                fs.unlinkSync(this.configFile);
            } catch (error) {
                console.error(`Error removing config file: ${error.message}`);
                return false;
            }
        }
        return true;
    }

    exportConfig() {
        const config = this.loadConfig();
        return JSON.stringify(config, null, 2);
    }

    importConfig(configString) {
        try {
            const config = JSON.parse(configString);
            return this.saveConfig(config);
        } catch (error) {
            console.error(`Error importing config: ${error.message}`);
            return false;
        }
    }

    validateConfig(config = null) {
        const configToValidate = config || this.loadConfig();
        const errors = [];

        // Validate required sections
        const requiredSections = ['ollama', 'analysis', 'display', 'hardware'];
        for (const section of requiredSections) {
            if (!configToValidate[section]) {
                errors.push(`Missing required section: ${section}`);
            }
        }

        // Validate Ollama URL
        if (configToValidate.ollama?.baseURL) {
            try {
                new URL(configToValidate.ollama.baseURL);
            } catch (error) {
                errors.push(`Invalid Ollama URL: ${configToValidate.ollama.baseURL}`);
            }
        }

        // Validate numeric values
        if (configToValidate.ollama?.timeout && configToValidate.ollama.timeout < 1000) {
            errors.push('Ollama timeout should be at least 1000ms');
        }

        if (configToValidate.display?.maxModelsPerTable && configToValidate.display.maxModelsPerTable < 1) {
            errors.push('maxModelsPerTable should be at least 1');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    getConfigPath() {
        return this.configFile;
    }

    getConfigDirectory() {
        return this.configDir;
    }

    createBackup() {
        if (!fs.existsSync(this.configFile)) {
            return null;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(this.configDir, `config.backup.${timestamp}.json`);

        try {
            fs.copyFileSync(this.configFile, backupFile);
            return backupFile;
        } catch (error) {
            console.error(`Error creating backup: ${error.message}`);
            return null;
        }
    }

    listBackups() {
        try {
            const files = fs.readdirSync(this.configDir);
            return files
                .filter(file => file.startsWith('config.backup.') && file.endsWith('.json'))
                .map(file => ({
                    name: file,
                    path: path.join(this.configDir, file),
                    created: fs.statSync(path.join(this.configDir, file)).mtime
                }))
                .sort((a, b) => b.created - a.created);
        } catch (error) {
            console.error(`Error listing backups: ${error.message}`);
            return [];
        }
    }

    restoreBackup(backupName) {
        const backupPath = path.join(this.configDir, backupName);

        if (!fs.existsSync(backupPath)) {
            throw new Error(`Backup file not found: ${backupName}`);
        }

        try {
            fs.copyFileSync(backupPath, this.configFile);
            this.config = null; // Force reload
            return true;
        } catch (error) {
            throw new Error(`Error restoring backup: ${error.message}`);
        }
    }
}

module.exports = ConfigManager;