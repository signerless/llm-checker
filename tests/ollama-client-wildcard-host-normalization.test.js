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

function snapshotOllamaEnv() {
    return {
        OLLAMA_HOST: process.env.OLLAMA_HOST,
        OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
        OLLAMA_URL: process.env.OLLAMA_URL
    };
}

function restoreOllamaEnv(snapshot) {
    for (const [key, value] of Object.entries(snapshot)) {
        if (typeof value === 'undefined') {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

async function testIpv4WildcardHostNormalizesToLoopbackWithDefaultPort() {
    const originalFetch = global.fetch;
    const originalEnv = snapshotOllamaEnv();
    const calls = [];

    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_URL;
    process.env.OLLAMA_HOST = '0.0.0.0';

    global.fetch = async (url) => {
        calls.push(url);

        if (url === 'http://localhost:11434/api/version') {
            return createJsonResponse({ version: '0.18.2' });
        }

        if (url === 'http://localhost:11434/api/tags') {
            return createJsonResponse({ models: [] });
        }

        throw new Error(`Unexpected URL in IPv4 wildcard normalization test: ${url}`);
    };

    try {
        const client = new OllamaClient();
        assert.strictEqual(
            client.preferredBaseURL,
            'http://localhost:11434',
            'wildcard bind host should normalize to localhost with the default Ollama port'
        );

        const availability = await client.checkOllamaAvailability();
        assert.strictEqual(availability.available, true, 'availability should succeed after wildcard host normalization');
        assert.strictEqual(client.baseURL, 'http://localhost:11434');
        assert.deepStrictEqual(
            calls,
            ['http://localhost:11434/api/version'],
            'availability check should start from the normalized localhost URL'
        );

        await client.getLocalModels();
        assert.strictEqual(
            calls[calls.length - 1],
            'http://localhost:11434/api/tags',
            'subsequent requests should keep using the normalized localhost URL'
        );
    } finally {
        global.fetch = originalFetch;
        restoreOllamaEnv(originalEnv);
    }
}

async function testIpv6WildcardHostNormalizesToLoopbackAndPreservesPort() {
    const originalFetch = global.fetch;
    const originalEnv = snapshotOllamaEnv();
    const calls = [];

    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_URL;
    process.env.OLLAMA_HOST = '[::]:22445';

    global.fetch = async (url) => {
        calls.push(url);

        if (url === 'http://localhost:22445/api/version') {
            return createJsonResponse({ version: '0.18.2' });
        }

        if (url === 'http://localhost:22445/api/tags') {
            return createJsonResponse({ models: [] });
        }

        throw new Error(`Unexpected URL in IPv6 wildcard normalization test: ${url}`);
    };

    try {
        const client = new OllamaClient();
        assert.strictEqual(
            client.preferredBaseURL,
            'http://localhost:22445',
            'IPv6 wildcard bind host should normalize to localhost and preserve the configured port'
        );

        const availability = await client.checkOllamaAvailability();
        assert.strictEqual(availability.available, true, 'availability should succeed after IPv6 wildcard normalization');
        assert.strictEqual(client.baseURL, 'http://localhost:22445');
        assert.deepStrictEqual(
            calls,
            ['http://localhost:22445/api/version'],
            'availability check should start from the normalized localhost URL'
        );

        await client.getLocalModels();
        assert.strictEqual(
            calls[calls.length - 1],
            'http://localhost:22445/api/tags',
            'subsequent requests should keep using the normalized localhost URL'
        );
    } finally {
        global.fetch = originalFetch;
        restoreOllamaEnv(originalEnv);
    }
}

async function run() {
    await testIpv4WildcardHostNormalizesToLoopbackWithDefaultPort();
    await testIpv6WildcardHostNormalizesToLoopbackAndPreservesPort();
    console.log('ollama-client-wildcard-host-normalization.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('ollama-client-wildcard-host-normalization.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
