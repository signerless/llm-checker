const fs = require('fs');
const path = require('path');
const { getLogger } = require('../utils/logger');

class PluginManager {
    constructor(options = {}) {
        this.pluginsDir = options.pluginsDir || path.join(process.cwd(), 'plugins');
        this.plugins = new Map();
        this.hooks = new Map();
        this.logger = getLogger().createChild('PluginManager');
        this.enabled = options.enabled !== false;
    }

    async loadPlugins() {
        if (!this.enabled) {
            this.logger.debug('Plugin system disabled');
            return;
        }

        if (!fs.existsSync(this.pluginsDir)) {
            this.logger.debug('Plugins directory not found, skipping plugin loading');
            return;
        }

        try {
            const pluginFiles = fs.readdirSync(this.pluginsDir)
                .filter(file => file.endsWith('.js') || file.endsWith('.json'));

            for (const file of pluginFiles) {
                await this.loadPlugin(path.join(this.pluginsDir, file));
            }

            this.logger.info(`Loaded ${this.plugins.size} plugins`);
        } catch (error) {
            this.logger.error('Failed to load plugins', { error });
        }
    }

    async loadPlugin(pluginPath) {
        try {
            const pluginName = path.basename(pluginPath, path.extname(pluginPath));

            // Security: Ensure plugin path is within the plugins directory
            const resolvedPath = path.resolve(pluginPath);
            const resolvedPluginsDir = path.resolve(this.pluginsDir);
            if (!resolvedPath.startsWith(resolvedPluginsDir + path.sep)) {
                this.logger.warn(`Blocked plugin outside plugins directory: ${pluginPath}`);
                return false;
            }

            // Load plugin configuration or code
            // WARNING: Code plugins execute with full Node.js permissions.
            // Only load plugins from trusted sources.
            let plugin;
            if (pluginPath.endsWith('.json')) {
                plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
                plugin.type = 'config';
            } else {
                plugin = require(resolvedPath);
                plugin.type = 'code';
            }

            // Validate plugin
            if (!this.validatePlugin(plugin)) {
                this.logger.warn(`Invalid plugin: ${pluginName}`);
                return false;
            }

            // Initialize plugin
            if (plugin.initialize && typeof plugin.initialize === 'function') {
                await plugin.initialize(this);
            }

            // Register plugin
            this.plugins.set(pluginName, {
                ...plugin,
                name: pluginName,
                path: pluginPath,
                loaded: true
            });

            // Register hooks
            if (plugin.hooks) {
                this.registerHooks(pluginName, plugin.hooks);
            }

            this.logger.debug(`Plugin loaded: ${pluginName}`, {
                data: { type: plugin.type, version: plugin.version }
            });

            return true;
        } catch (error) {
            this.logger.error(`Failed to load plugin: ${pluginPath}`, { error });
            return false;
        }
    }

    validatePlugin(plugin) {
        // Basic plugin validation
        if (!plugin.name || !plugin.version) {
            return false;
        }

        if (plugin.type === 'code' && !plugin.execute && !plugin.hooks) {
            return false;
        }

        return true;
    }

    registerHooks(pluginName, hooks) {
        for (const [hookName, hookFunction] of Object.entries(hooks)) {
            if (!this.hooks.has(hookName)) {
                this.hooks.set(hookName, []);
            }

            this.hooks.get(hookName).push({
                plugin: pluginName,
                function: hookFunction
            });
        }
    }

    async executeHook(hookName, data = {}) {
        if (!this.hooks.has(hookName)) {
            return data;
        }

        let result = data;
        const hookFunctions = this.hooks.get(hookName);

        for (const hook of hookFunctions) {
            try {
                this.logger.trace(`Executing hook: ${hookName} from plugin: ${hook.plugin}`);
                result = await hook.function(result, this) || result;
            } catch (error) {
                this.logger.error(`Hook execution failed`, {
                    data: { hook: hookName, plugin: hook.plugin },
                    error
                });
            }
        }

        return result;
    }

    async executePlugin(pluginName, ...args) {
        const plugin = this.plugins.get(pluginName);

        if (!plugin) {
            throw new Error(`Plugin not found: ${pluginName}`);
        }

        if (!plugin.execute || typeof plugin.execute !== 'function') {
            throw new Error(`Plugin ${pluginName} is not executable`);
        }

        try {
            this.logger.debug(`Executing plugin: ${pluginName}`);
            return await plugin.execute(...args);
        } catch (error) {
            this.logger.error(`Plugin execution failed: ${pluginName}`, { error });
            throw error;
        }
    }

    getPlugin(name) {
        return this.plugins.get(name);
    }

    listPlugins() {
        return Array.from(this.plugins.values()).map(plugin => ({
            name: plugin.name,
            version: plugin.version,
            description: plugin.description,
            type: plugin.type,
            loaded: plugin.loaded
        }));
    }

    unloadPlugin(name) {
        const plugin = this.plugins.get(name);

        if (!plugin) {
            return false;
        }

        // Remove hooks
        for (const [hookName, hooks] of this.hooks.entries()) {
            const filtered = hooks.filter(hook => hook.plugin !== name);
            if (filtered.length === 0) {
                this.hooks.delete(hookName);
            } else {
                this.hooks.set(hookName, filtered);
            }
        }

        // Call cleanup if available
        if (plugin.cleanup && typeof plugin.cleanup === 'function') {
            try {
                plugin.cleanup();
            } catch (error) {
                this.logger.error(`Plugin cleanup failed: ${name}`, { error });
            }
        }

        this.plugins.delete(name);
        this.logger.debug(`Plugin unloaded: ${name}`);

        return true;
    }

    reloadPlugin(name) {
        const plugin = this.plugins.get(name);

        if (!plugin) {
            return false;
        }

        const pluginPath = plugin.path;
        this.unloadPlugin(name);

        // Clear require cache
        delete require.cache[require.resolve(pluginPath)];

        return this.loadPlugin(pluginPath);
    }

    // Built-in hooks for extending LLM Checker functionality
    getAvailableHooks() {
        return [
            'beforeHardwareDetection',
            'afterHardwareDetection',
            'beforeModelAnalysis',
            'afterModelAnalysis',
            'beforeOllamaOperation',
            'afterOllamaOperation',
            'beforeFormatOutput',
            'afterFormatOutput',
            'beforeGenerateReport',
            'afterGenerateReport'
        ];
    }

    // Plugin development utilities
    createPluginTemplate(name, type = 'code') {
        const template = {
            name: name,
            version: '1.0.0',
            description: `Plugin: ${name}`,
            author: 'Your Name',
            type: type
        };

        if (type === 'code') {
            template.initialize = async function(pluginManager) {
                // Plugin initialization code
                console.log(`Plugin ${name} initialized`);
            };

            template.execute = async function(...args) {
                // Plugin execution code
                console.log(`Plugin ${name} executed with args:`, args);
                return { success: true };
            };

            template.hooks = {
                beforeModelAnalysis: async function(data, pluginManager) {
                    // Hook implementation
                    console.log(`${name} hook: beforeModelAnalysis`);
                    return data;
                }
            };

            template.cleanup = function() {
                // Cleanup code
                console.log(`Plugin ${name} cleaned up`);
            };
        }

        return template;
    }

    savePluginTemplate(name, outputPath, type = 'code') {
        const template = this.createPluginTemplate(name, type);
        const content = type === 'code' ?
            `module.exports = ${JSON.stringify(template, null, 2)};` :
            JSON.stringify(template, null, 2);

        fs.writeFileSync(outputPath, content, 'utf8');
        this.logger.info(`Plugin template created: ${outputPath}`);
    }
}

module.exports = PluginManager;