module.exports = {
    name: 'custom-model-plugin',
    version: '1.0.0',
    description: 'Adds custom models to the LLM Checker database',
    author: 'LLM Checker Team',
    type: 'code',

    // Custom models to add
    customModels: [
        {
            name: "CustomLlama 5B",
            size: "5B",
            type: "local",
            category: "medium",
            requirements: {
                ram: 6,
                vram: 3,
                cpu_cores: 4,
                storage: 5
            },
            frameworks: ["ollama", "llama.cpp"],
            quantization: ["Q4_0", "Q4_K_M", "Q5_0"],
            performance: {
                speed: "medium",
                quality: "very_good",
                context_length: 8192
            },
            installation: {
                ollama: "ollama pull custom-llama:5b",
                description: "Custom trained Llama model"
            },
            specialization: "custom",
            languages: ["en"],
            year: 2024
        }
    ],

    async initialize(pluginManager) {
        pluginManager.logger.info('Custom Model Plugin initialized');
    },

    hooks: {
        afterModelAnalysis: async function(data, pluginManager) {
            // Add custom models to the analysis results
            if (data.models) {
                data.models.push(...this.customModels);
                pluginManager.logger.debug(`Added ${this.customModels.length} custom models`);
            }
            return data;
        },

        beforeGenerateReport: async function(data, pluginManager) {
            // Add note about custom models in reports
            if (data.recommendations) {
                data.recommendations.push('🔧 Custom models available via plugin');
            }
            return data;
        }
    },

    async execute(action, ...args) {
        switch (action) {
            case 'listCustomModels':
                return this.customModels;

            case 'addCustomModel':
                const [model] = args;
                if (this.validateCustomModel(model)) {
                    this.customModels.push(model);
                    return { success: true, message: 'Custom model added' };
                }
                return { success: false, message: 'Invalid model format' };

            default:
                return { success: false, message: 'Unknown action' };
        }
    },

    validateCustomModel(model) {
        const required = ['name', 'size', 'type', 'category', 'requirements'];
        return required.every(field => model.hasOwnProperty(field));
    },

    cleanup() {
        console.log('Custom Model Plugin cleaned up');
    }
};