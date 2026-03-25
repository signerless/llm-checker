const assert = require('assert');
const OllamaClient = require('../src/ollama/client');

function createJsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'ERROR',
        async json() {
            return payload;
        },
        async text() {
            return JSON.stringify(payload);
        }
    };
}

async function testLocalhostFallsBackToIpv4() {
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url) => {
        calls.push(url);

        if (url === 'http://localhost:11434/api/version') {
            const error = new Error('request to http://localhost:11434/api/version failed, reason: connect ECONNREFUSED ::1:11434');
            error.code = 'ECONNREFUSED';
            throw error;
        }

        if (url === 'http://127.0.0.1:11434/api/version') {
            return createJsonResponse({ version: '0.18.2' });
        }

        if (url === 'http://127.0.0.1:11434/api/tags') {
            return createJsonResponse({
                models: [
                    {
                        name: 'llama3.2:3b',
                        size: 2147483648,
                        digest: 'abc123',
                        modified_at: '2026-03-25T00:00:00Z',
                        details: {
                            family: 'llama',
                            parameter_size: '3B',
                            quantization_level: 'Q4_K_M',
                            format: 'gguf'
                        }
                    }
                ]
            });
        }

        throw new Error(`Unexpected URL in fallback test: ${url}`);
    };

    try {
        const client = new OllamaClient('http://localhost:11434');
        const availability = await client.checkOllamaAvailability();

        assert.strictEqual(availability.available, true, 'availability should succeed via fallback URL');
        assert.strictEqual(client.baseURL, 'http://127.0.0.1:11434', 'client should persist working fallback base URL');
        assert.deepStrictEqual(
            calls.slice(0, 2),
            [
                'http://localhost:11434/api/version',
                'http://127.0.0.1:11434/api/version'
            ],
            'availability check should retry localhost with IPv4 fallback'
        );

        const models = await client.getLocalModels();
        assert.strictEqual(models.length, 1, 'model listing should use the resolved fallback URL');
        assert.strictEqual(models[0].name, 'llama3.2:3b');
        assert.strictEqual(
            calls[calls.length - 1],
            'http://127.0.0.1:11434/api/tags',
            'subsequent requests should use the resolved fallback URL'
        );
    } finally {
        global.fetch = originalFetch;
    }
}

async function run() {
    await testLocalhostFallsBackToIpv4();
    console.log('ollama-client-localhost-fallback.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('ollama-client-localhost-fallback.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
