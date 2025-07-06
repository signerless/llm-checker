const fetch = require('node-fetch');

class OllamaClient {
    constructor(baseURL = 'http://localhost:11434') {
        this.baseURL = baseURL;
        this.isAvailable = null;
        this.lastCheck = 0;
        this.cacheTimeout = 30000;
    }

    async checkOllamaAvailability() {

        if (this.isAvailable !== null && Date.now() - this.lastCheck < this.cacheTimeout) {
            return this.isAvailable;
        }

        try {
            const response = await fetch(`${this.baseURL}/api/version`, {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.ok) {
                const data = await response.json();
                this.isAvailable = { available: true, version: data.version || 'unknown' };
                this.lastCheck = Date.now();
                return this.isAvailable;
            }

            this.isAvailable = { available: false, error: 'Ollama not responding properly' };
            this.lastCheck = Date.now();
            return this.isAvailable;
        } catch (error) {
            this.isAvailable = {
                available: false,
                error: error.message.includes('ECONNREFUSED') ?
                    'Ollama not running (connection refused)' :
                    error.message.includes('timeout') ?
                    'Ollama connection timeout' :
                    error.message
            };
            this.lastCheck = Date.now();
            return this.isAvailable;
        }
    }

    async getLocalModels() {
        const availability = await this.checkOllamaAvailability();
        if (!availability.available) {
            throw new Error(`Ollama not available: ${availability.error}`);
        }

        try {
            const response = await fetch(`${this.baseURL}/api/tags`, {
                timeout: 15000,
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
            }

            const data = await response.json();

            if (!data.models) {
                return [];
            }

            const models = data.models.map(model => this.parseOllamaModel(model));
            return models;
        } catch (error) {
            throw new Error(`Failed to fetch local models: ${error.message}`);
        }
    }

    async getRunningModels() {
        const availability = await this.checkOllamaAvailability();
        if (!availability.available) {
            return [];
        }

        try {
            const response = await fetch(`${this.baseURL}/api/ps`, {
                timeout: 10000,
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                return [];
            }

            const data = await response.json();

            const runningModels = (data.models || []).map(model => ({
                name: model.name,
                model: model.model,
                size: model.size,
                digest: model.digest,
                expires_at: model.expires_at,
                size_vram: model.size_vram,
                processor: model.processor || 'unknown'
            }));

            return runningModels;
        } catch (error) {
            return [];
        }
    }

    async testConnection() {
        try {
            // Test 1: Version check
            const versionResponse = await fetch(`${this.baseURL}/api/version`, {
                timeout: 5000
            });
            
            if (!versionResponse.ok) {
                return {
                    success: false,
                    error: `Version check failed: ${versionResponse.status}`,
                    details: 'Ollama might not be running properly'
                };
            }
            
            const versionData = await versionResponse.json();

            // Test 2: Tags check
            const tagsResponse = await fetch(`${this.baseURL}/api/tags`, {
                timeout: 10000
            });
            
            if (!tagsResponse.ok) {
                return {
                    success: false,
                    error: `Tags check failed: ${tagsResponse.status}`,
                    details: 'Could not access models API'
                };
            }
            
            const tagsText = await tagsResponse.text();
            let tagsData;
            
            try {
                tagsData = JSON.parse(tagsText);
            } catch (e) {
                return {
                    success: false,
                    error: 'Invalid JSON in tags response',
                    details: tagsText.substring(0, 100)
                };
            }

            return {
                success: true,
                version: versionData.version,
                modelsFound: tagsData.models ? tagsData.models.length : 0,
                models: tagsData.models || []
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message,
                details: error.code || 'Unknown error'
            };
        }
    }

    parseOllamaModel(ollamaModel) {
        const sizeBytes = ollamaModel.size || 0;
        const sizeGB = Math.round(sizeBytes / (1024 ** 3) * 10) / 10;


        const [modelFamily, version] = ollamaModel.name.split(':');
        const details = ollamaModel.details || {};


        let estimatedParams = 'Unknown';
        if (details.parameter_size) {
            estimatedParams = details.parameter_size;
        } else if (sizeGB > 0) {

            if (sizeGB < 2) estimatedParams = '1B';
            else if (sizeGB < 4) estimatedParams = '3B';
            else if (sizeGB < 6) estimatedParams = '7B';
            else if (sizeGB < 15) estimatedParams = '8B';
            else if (sizeGB < 25) estimatedParams = '13B';
            else if (sizeGB < 45) estimatedParams = '34B';
            else estimatedParams = '70B+';
        }

        return {
            name: ollamaModel.name,
            displayName: `${modelFamily} ${version || 'latest'}`,
            family: details.family || modelFamily.toLowerCase(),
            size: estimatedParams,
            fileSizeGB: sizeGB,
            quantization: details.quantization_level || 'Unknown',
            format: details.format || 'GGUF',
            digest: ollamaModel.digest,
            modified: ollamaModel.modified_at,
            source: 'ollama_local',
            details: {
                parameter_size: details.parameter_size,
                quantization_level: details.quantization_level,
                families: details.families || [details.family || modelFamily],
                parent_model: details.parent_model || ''
            }
        };
    }

    async pullModel(modelName, onProgress = null) {
        const availability = await this.checkOllamaAvailability();
        if (!availability.available) {
            throw new Error(`Ollama not available: ${availability.error}`);
        }

        try {
            const response = await fetch(`${this.baseURL}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName, stream: true })
            });

            if (!response.ok) {
                throw new Error(`Failed to pull model: HTTP ${response.status}`);
            }


            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const data = JSON.parse(line);

                        if (onProgress && (data.status || data.completed !== undefined)) {
                            onProgress({
                                status: data.status,
                                completed: data.completed,
                                total: data.total,
                                percent: data.total ? Math.round((data.completed / data.total) * 100) : 0
                            });
                        }

                        if (data.status === 'success') {
                            return { success: true, model: modelName };
                        }
                    } catch (e) {
                        // Skip malformed JSON lines
                    }
                }
            }

            return { success: true, model: modelName };
        } catch (error) {
            throw new Error(`Failed to pull model: ${error.message}`);
        }
    }

    async deleteModel(modelName) {
        const availability = await this.checkOllamaAvailability();
        if (!availability.available) {
            throw new Error(`Ollama not available: ${availability.error}`);
        }

        try {
            const response = await fetch(`${this.baseURL}/api/delete`, {
                method: 'DELETE',
                timeout: 10000,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName })
            });

            if (!response.ok) {
                throw new Error(`Failed to delete model: HTTP ${response.status}`);
            }

            return { success: true, model: modelName };
        } catch (error) {
            throw new Error(`Failed to delete model: ${error.message}`);
        }
    }

    async testModelPerformance(modelName, testPrompt = "Hello, how are you?") {
        const availability = await this.checkOllamaAvailability();
        if (!availability.available) {
            throw new Error(`Ollama not available: ${availability.error}`);
        }

        const startTime = Date.now();

        try {
            const response = await fetch(`${this.baseURL}/api/generate`, {
                method: 'POST',
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelName,
                    prompt: testPrompt,
                    stream: false,
                    options: {
                        num_predict: 50 // Limitar respuesta para test rápido
                    }
                })
            });

            if (!response.ok) {
                throw new Error(`Test failed: HTTP ${response.status}`);
            }

            const data = await response.json();
            const endTime = Date.now();

            const totalTime = endTime - startTime;
            const tokensGenerated = data.eval_count || 50;
            const tokensPerSecond = Math.round((tokensGenerated / (totalTime / 1000)) * 10) / 10;

            return {
                success: true,
                responseTime: totalTime,
                tokensPerSecond,
                tokensGenerated,
                loadTime: data.load_duration ? Math.round(data.load_duration / 1000000) : null,
                evalTime: data.eval_duration ? Math.round(data.eval_duration / 1000000) : null,
                response: data.response
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                responseTime: Date.now() - startTime
            };
        }
    }
}

module.exports = OllamaClient;
