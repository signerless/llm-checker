const fetch = require('../utils/fetch');

class OllamaClient {
    constructor(baseURL = null) {
        // Support OLLAMA_HOST environment variable (standard Ollama configuration)
        // Also support OLLAMA_BASE_URL and OLLAMA_URL for backwards compatibility
        this.preferredBaseURL = this.normalizeBaseURL(
            baseURL || process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL || 'http://localhost:11434'
        );
        this.baseURL = this.preferredBaseURL;

        this.isAvailable = null;
        this.lastCheck = 0;
        this.cacheTimeout = 30000;
        this._pendingCheck = null;
    }

    normalizeBaseURL(baseURL) {
        let normalized = String(baseURL || '').trim();
        if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
            normalized = 'http://' + normalized;
        }
        return normalized.replace(/\/$/, '');
    }

    buildCandidateBaseURLs(baseURL = this.preferredBaseURL) {
        const normalized = this.normalizeBaseURL(baseURL);
        const candidates = [normalized];

        try {
            const parsed = new URL(normalized);
            if (parsed.hostname === 'localhost') {
                const ipv4 = new URL(parsed.toString());
                ipv4.hostname = '127.0.0.1';
                candidates.push(ipv4.toString().replace(/\/$/, ''));

                const ipv6 = new URL(parsed.toString());
                ipv6.hostname = '::1';
                candidates.push(ipv6.toString().replace(/\/$/, ''));
            }
        } catch (error) {
            // Keep the preferred URL only if parsing fails.
        }

        return [...new Set(candidates)];
    }

    applyResolvedBaseURL(baseURL) {
        this.baseURL = this.normalizeBaseURL(baseURL);
        return this.baseURL;
    }

    isRetryableAvailabilityError(error) {
        const message = String(error?.message || '').toLowerCase();
        return (
            message.includes('econnrefused') ||
            message.includes('fetch failed') ||
            message.includes('network') ||
            message.includes('socket') ||
            message.includes('connect') ||
            error?.name === 'AbortError'
        );
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
        const candidateURLs = this.buildCandidateBaseURLs();
        const attemptedURLs = [];
        let lastError = null;

        for (let index = 0; index < candidateURLs.length; index += 1) {
            const candidateBaseURL = candidateURLs[index];
            attemptedURLs.push(candidateBaseURL);

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                const response = await fetch(`${candidateBaseURL}/api/version`, {
                    signal: controller.signal,
                    headers: { 'Content-Type': 'application/json' }
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    this.isAvailable = {
                        available: false,
                        error: 'Ollama not responding properly',
                        attemptedURL: candidateBaseURL,
                        attemptedURLs
                    };
                    this.lastCheck = Date.now();
                    return this.isAvailable;
                }

                const data = await response.json();
                this.applyResolvedBaseURL(candidateBaseURL);
                this.isAvailable = {
                    available: true,
                    version: data.version || 'unknown',
                    attemptedURL: candidateBaseURL,
                    attemptedURLs
                };
                this.lastCheck = Date.now();
                return this.isAvailable;
            } catch (error) {
                lastError = error;
                if (!this.isRetryableAvailabilityError(error) || index === candidateURLs.length - 1) {
                    break;
                }
            }
        }

        if (lastError) {
            let errorMessage;
            let hint = '';
            const errorText = String(lastError.message || '');
            const activeURL = attemptedURLs[attemptedURLs.length - 1] || this.preferredBaseURL;

            if (errorText.includes('ECONNREFUSED')) {
                errorMessage = `Ollama not running at ${activeURL}`;
                hint = 'Make sure Ollama is running. Try: ollama serve';
            } else if (errorText.includes('timeout') || lastError.name === 'AbortError') {
                errorMessage = `Ollama connection timeout at ${activeURL}`;
                hint = 'The server is not responding. Check if Ollama is running and accessible.';
            } else if (errorText.includes('ENOTFOUND')) {
                errorMessage = `Cannot resolve host: ${activeURL}`;
                hint = 'Check your OLLAMA_HOST environment variable or network configuration.';
            } else {
                errorMessage = errorText || 'Unknown Ollama availability error';
            }

            this.isAvailable = {
                available: false,
                error: errorMessage,
                hint,
                attemptedURL: activeURL,
                attemptedURLs
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

    async generate(modelName, prompt, options = {}) {
        const availability = await this.checkOllamaAvailability();
        if (!availability.available) {
            throw new Error(`Ollama not available: ${availability.error}`);
        }

        const {
            timeoutMs = 30000,
            stream = false,
            keepAlive,
            format,
            generationOptions = {}
        } = options;

        const payload = {
            model: modelName,
            prompt,
            stream: Boolean(stream)
        };

        if (keepAlive) payload.keep_alive = keepAlive;
        if (format) payload.format = format;
        if (generationOptions && Object.keys(generationOptions).length > 0) {
            payload.options = generationOptions;
        }

        const startTime = Date.now();

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(`${this.baseURL}/api/generate`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
            }

            const data = await response.json();
            const responseTime = Date.now() - startTime;
            const speed = this.calculateTokensPerSecond(data, responseTime);

            return {
                ...data,
                responseTime,
                tokensPerSecond: speed.tokensPerSecond,
                evalTokensPerSecond: speed.evalTokensPerSecond,
                endToEndTokensPerSecond: speed.endToEndTokensPerSecond
            };
        } catch (error) {
            throw new Error(`Failed to run generate request: ${error.message}`);
        }
    }

    async testModelPerformance(modelName, testPrompt = "Hello, how are you?") {
        const startTime = Date.now();

        try {
            const data = await this.generate(modelName, testPrompt, {
                timeoutMs: 30000,
                generationOptions: {
                    num_predict: 50
                }
            });
            const tokensGenerated = Number(data.eval_count) || 0;

            return {
                success: true,
                responseTime: data.responseTime,
                tokensPerSecond: data.tokensPerSecond,
                evalTokensPerSecond: data.evalTokensPerSecond,
                endToEndTokensPerSecond: data.endToEndTokensPerSecond,
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

    async showModel(modelName) {
        const availability = await this.checkOllamaAvailability();
        if (!availability.available) {
            throw new Error(`Ollama not available: ${availability.error}`);
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(`${this.baseURL}/api/show`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName })
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
            }

            return response.json();
        } catch (error) {
            throw new Error(`Failed to show model info: ${error.message}`);
        }
    }

    async chat(modelName, messages, options = {}) {
        const availability = await this.checkOllamaAvailability();
        if (!availability.available) {
            throw new Error(`Ollama not available: ${availability.error}`);
        }

        const {
            tools,
            format,
            keepAlive,
            timeoutMs = 45000,
            generationOptions = {}
        } = options;

        const payload = {
            model: modelName,
            messages: Array.isArray(messages) ? messages : [],
            stream: false
        };

        if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;
        if (format) payload.format = format;
        if (keepAlive) payload.keep_alive = keepAlive;
        if (generationOptions && Object.keys(generationOptions).length > 0) {
            payload.options = generationOptions;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(`${this.baseURL}/api/chat`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
            }

            return response.json();
        } catch (error) {
            throw new Error(`Failed to run chat request: ${error.message}`);
        }
    }
}

module.exports = OllamaClient;
