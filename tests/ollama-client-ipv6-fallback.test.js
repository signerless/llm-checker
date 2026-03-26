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

async function testLocalhostFallsBackToIpv6WhenIpv4Fails() {
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url) => {
        calls.push(url);

        if (url === 'http://localhost:11434/api/version') {
            const error = new Error('request to http://localhost:11434/api/version failed, reason: connect ECONNREFUSED 127.0.0.1:11434');
            error.code = 'ECONNREFUSED';
            throw error;
        }

        if (url === 'http://127.0.0.1:11434/api/version') {
            const error = new Error('request to http://127.0.0.1:11434/api/version failed, reason: connect ECONNREFUSED 127.0.0.1:11434');
            error.code = 'ECONNREFUSED';
            throw error;
        }

        if (url === 'http://[::1]:11434/api/version') {
            return createJsonResponse({ version: '0.18.2' });
        }

        if (url === 'http://[::1]:11434/api/tags') {
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

        throw new Error(`Unexpected URL in IPv6 fallback test: ${url}`);
    };

    try {
        const client = new OllamaClient('http://localhost:11434');
        const availability = await client.checkOllamaAvailability();

        assert.strictEqual(availability.available, true, 'availability should succeed via IPv6 fallback URL');
        assert.strictEqual(client.baseURL, 'http://[::1]:11434', 'client should persist working IPv6 fallback base URL');
        assert.deepStrictEqual(
            calls.slice(0, 3),
            [
                'http://localhost:11434/api/version',
                'http://127.0.0.1:11434/api/version',
                'http://[::1]:11434/api/version'
            ],
            'availability check should retry localhost with IPv4 and IPv6 fallback URLs'
        );

        const models = await client.getLocalModels();
        assert.strictEqual(models.length, 1, 'model listing should use the resolved IPv6 fallback URL');
        assert.strictEqual(models[0].name, 'llama3.2:3b');
        assert.strictEqual(
            calls[calls.length - 1],
            'http://[::1]:11434/api/tags',
            'subsequent requests should use the resolved IPv6 fallback URL'
        );
    } finally {
        global.fetch = originalFetch;
    }
}

async function run() {
    await testLocalhostFallsBackToIpv6WhenIpv4Fails();
    console.log('ollama-client-ipv6-fallback.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('ollama-client-ipv6-fallback.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
