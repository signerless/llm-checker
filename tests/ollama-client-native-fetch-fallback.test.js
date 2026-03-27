const assert = require('assert');
const http = require('http');
const OllamaClient = require('../src/ollama/client');

function createServer() {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);

        if (req.url === '/api/version') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: '0.18.2' }));
            return;
        }

        if (req.url === '/api/tags') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                models: [
                    {
                        name: 'llama3.2:3b',
                        size: 2147483648,
                        digest: 'abc123',
                        modified_at: '2026-03-27T00:00:00Z',
                        details: {
                            family: 'llama',
                            parameter_size: '3B',
                            quantization_level: 'Q4_K_M',
                            format: 'gguf'
                        }
                    }
                ]
            }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                server,
                requests,
                baseURL: `http://127.0.0.1:${address.port}`
            });
        });
    });
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

async function testNativeFetchFailureFallsBackToNodeFetch() {
    const { server, requests, baseURL } = await createServer();
    const originalFetch = global.fetch;
    const nativeFetchCalls = [];

    global.fetch = function fetch(url) {
        // Match the Node/undici source markers that the wrapper uses to detect native fetch.
        const undiciMarker = 'internal/deps/undici/undici';
        void undiciMarker;

        nativeFetchCalls.push(url);
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNREFUSED' };
        return Promise.reject(error);
    };

    try {
        const client = new OllamaClient(baseURL);
        const availability = await client.checkOllamaAvailability();

        assert.strictEqual(availability.available, true, 'availability should succeed via node-fetch retry');
        assert.strictEqual(client.baseURL, baseURL, 'client should preserve the working base URL');

        const models = await client.getLocalModels();
        assert.strictEqual(models.length, 1, 'model listing should succeed via node-fetch retry');
        assert.strictEqual(models[0].name, 'llama3.2:3b');

        assert.deepStrictEqual(
            nativeFetchCalls,
            [
                `${baseURL}/api/version`,
                `${baseURL}/api/tags`
            ],
            'wrapper should try the native fetch path before retrying with node-fetch'
        );
        assert.deepStrictEqual(
            requests,
            [
                'GET /api/version',
                'GET /api/tags'
            ],
            'node-fetch fallback should reach the Ollama endpoints after native fetch fails'
        );
    } finally {
        global.fetch = originalFetch;
        await closeServer(server);
    }
}

async function run() {
    await testNativeFetchFailureFallsBackToNodeFetch();
    console.log('ollama-client-native-fetch-fallback.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('ollama-client-native-fetch-fallback.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
