const fetch = require('../utils/fetch');

class OllamaClient {
    constructor(baseURL = null) {
        // Support OLLAMA_HOST environment variable (standard Ollama configuration)
        // Also support OLLAMA_URL for backwards compatibility
        this.baseURL = baseURL || process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';

        // Normalize URL: ensure it has protocol and remove trailing slash
        if (!this.baseURL.startsWith('http://') && !this.baseURL.startsWith('https://')) {
            this.baseURL = 'http://' + this.baseURL;
        }
        this.baseURL = this.baseURL.replace(/\/$/, '');

        this.isAvailable = null;
        this.lastCheck = 0;
        this.cacheTimeout = 30000;
        this._pendingCheck = null;
    }

    async checkOllamaAvailability() {

        if (this.isAvailable !== null && Date.now() - this.lastCheck < this.cacheTimeout) {
            return this.isAvailable;
        }

        // Prevent concurrent requests — reuse in-flight promise
        if (this._pendingCheck) {
            return this._pendingCheck;
        }

        this._pendingCheck = this._doAvailabilityCheck();
        try {
            return await this._pendingCheck;
        } finally {
            this._pendingCheck = null;
        }
    }

    async _doAvailabilityCheck() {

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(`${this.baseURL}/api/version`, {
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' }
            });
            
            clearTimeout(timeoutId);

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
            let errorMessage;
            let hint = '';

            if (error.message.includes('ECONNREFUSED')) {
                errorMessage = `Ollama not running at ${this.baseURL}`;
                hint = 'Make sure Ollama is running. Try: ollama serve';
            } else if (error.message.includes('timeout') || error.name === 'AbortError') {
                errorMessage = `Ollama connection timeout at ${this.baseURL}`;
                hint = 'The server is not responding. Check if Ollama is running and accessible.';
            } else if (error.message.includes('ENOTFOUND')) {
                errorMessage = `Cannot resolve host: ${this.baseURL}`;
                hint = 'Check your OLLAMA_HOST environment variable or network configuration.';
            } else {
                errorMessage = error.message;
            }

            this.isAvailable = {
                available: false,
                error: errorMessage,
                hint: hint,
                attemptedURL: this.baseURL
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
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            
            const response = await fetch(`${this.baseURL}/api/tags`, {
                signal: controller.signal,
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });
            
            clearTimeout(timeoutId);

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
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(`${this.baseURL}/api/ps`, {
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            clearTimeout(timeoutId);

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
            const versionController = new AbortController();
            const versionTimeoutId = setTimeout(() => versionController.abort(), 5000);

            const versionResponse = await fetch(`${this.baseURL}/api/version`, {
                signal: versionController.signal
            });

            clearTimeout(versionTimeoutId);
            
            if (!versionResponse.ok) {
                return {
                    success: false,
                    error: `Version check failed: ${versionResponse.status}`,
                    details: 'Ollama might not be running properly'
                };
            }
            
            const versionData = await versionResponse.json();

            // Test 2: Tags check
            const tagsController = new AbortController();
            const tagsTimeoutId = setTimeout(() => tagsController.abort(), 10000);

            const tagsResponse = await fetch(`${this.baseURL}/api/tags`, {
                signal: tagsController.signal
            });

            clearTimeout(tagsTimeoutId);
            
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
            let receivedSuccess = false;

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
                            receivedSuccess = true;
                            return { success: true, model: modelName };
                        }

                        if (data.error) {
                            throw new Error(data.error);
                        }
                    } catch (e) {
                        if (e.message && !e.message.includes('Unexpected')) {
                            throw e; // Re-throw real errors, skip JSON parse errors
                        }
                    }
                }
            }

            if (!receivedSuccess) {
                throw new Error('Stream ended without success confirmation');
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
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(`${this.baseURL}/api/delete`, {
                method: 'DELETE',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName })
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Failed to delete model: HTTP ${response.status}`);
            }

            return { success: true, model: modelName };
        } catch (error) {
            throw new Error(`Failed to delete model: ${error.message}`);
        }
    }

    calculateTokensPerSecond(data, totalTimeMs) {
        const evalCount = Number(data?.eval_count) || 0;
        const evalDurationNs = Number(data?.eval_duration) || 0;
        const totalSeconds = Math.max(0, Number(totalTimeMs) || 0) / 1000;

        const evalTokensPerSecond = evalDurationNs > 0 && evalCount > 0
            ? (evalCount / (evalDurationNs / 1_000_000_000))
            : 0;

        const endToEndTokensPerSecond = totalSeconds > 0 && evalCount > 0
            ? (evalCount / totalSeconds)
            : 0;

        // Prefer eval-only throughput when available because it excludes load/setup overhead.
        const preferred = evalTokensPerSecond > 0 ? evalTokensPerSecond : endToEndTokensPerSecond;

        return {
            tokensPerSecond: Math.round(preferred * 10) / 10,
            evalTokensPerSecond: Math.round(evalTokensPerSecond * 10) / 10,
            endToEndTokensPerSecond: Math.round(endToEndTokensPerSecond * 10) / 10
        };
    }

    async testModelPerformance(modelName, testPrompt = "Hello, how are you?") {
        const availability = await this.checkOllamaAvailability();
        if (!availability.available) {
            throw new Error(`Ollama not available: ${availability.error}`);
        }

        const startTime = Date.now();

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            const response = await fetch(`${this.baseURL}/api/generate`, {
                method: 'POST',
                signal: controller.signal,
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

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Test failed: HTTP ${response.status}`);
            }

            const data = await response.json();
            const endTime = Date.now();

            const totalTime = endTime - startTime;
            const tokensGenerated = Number(data.eval_count) || 0;
            const speed = this.calculateTokensPerSecond(data, totalTime);

            return {
                success: true,
                responseTime: totalTime,
                tokensPerSecond: speed.tokensPerSecond,
                evalTokensPerSecond: speed.evalTokensPerSecond,
                endToEndTokensPerSecond: speed.endToEndTokensPerSecond,
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
