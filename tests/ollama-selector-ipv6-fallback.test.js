const assert = require('assert');
const DeterministicModelSelector = require('../src/models/deterministic-selector');
const AICheckSelector = require('../src/models/ai-check-selector');

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

async function testProbeAndEvaluatorUseResolvedIpv6FallbackURL() {
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url, options = {}) => {
        calls.push({ url, options });

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

        if (url === 'http://[::1]:11434/api/generate') {
            const body = JSON.parse(options.body);
            assert.strictEqual(body.model, 'llama3.2:3b');
            assert.strictEqual(body.options.num_predict, 128);

            return createJsonResponse({
                response: 'unit tests keep regressions contained',
                eval_count: 96,
                eval_duration: 2_000_000_000
            });
        }

        if (url === 'http://[::1]:11434/api/chat') {
            const body = JSON.parse(options.body);
            assert.strictEqual(body.model, 'llama3.2:3b');
            assert.strictEqual(body.options.temperature, 0.1);
            assert.strictEqual(body.options.num_ctx, 4096);

            return createJsonResponse({
                message: {
                    content: JSON.stringify({
                        winner: 'llama3.2:3b',
                        ranking: [
                            {
                                name: 'llama3.2:3b',
                                aiScore: 88,
                                shortWhy: 'best local fit'
                            }
                        ]
                    })
                }
            });
        }

        throw new Error(`Unexpected URL in selector IPv6 fallback test: ${url}`);
    };

    try {
        const deterministicSelector = new DeterministicModelSelector();
        const probeTPS = await deterministicSelector.runSingleProbe('llama3.2:3b', 'general');

        assert(Number.isFinite(probeTPS) && probeTPS > 0, `Expected positive probe TPS, got ${probeTPS}`);
        assert.strictEqual(
            deterministicSelector.ollamaClient.baseURL,
            'http://[::1]:11434',
            'probe path should persist the resolved IPv6 fallback base URL'
        );

        const aiCheckSelector = new AICheckSelector();
        const aiResult = await aiCheckSelector.callOllamaEvaluator('llama3.2:3b', {
            hardware: { category: 'general' },
            candidates: [
                {
                    name: 'llama3.2:3b',
                    paramsB: 3,
                    quant: 'Q4_K_M',
                    requiredGB: 2,
                    installed: true
                }
            ]
        });

        assert.strictEqual(aiResult.winner, 'llama3.2:3b');
        assert.strictEqual(aiResult.ranking.length, 1);
        assert.strictEqual(aiResult.ranking[0].name, 'llama3.2:3b');
        assert.strictEqual(
            aiCheckSelector.ollamaClient.baseURL,
            'http://[::1]:11434',
            'evaluator path should persist the resolved IPv6 fallback base URL'
        );

        const urls = calls.map((entry) => entry.url);
        assert.ok(urls.includes('http://[::1]:11434/api/generate'), 'probe path should use IPv6 fallback URL');
        assert.ok(urls.includes('http://[::1]:11434/api/chat'), 'evaluator path should use IPv6 fallback URL');
        assert.ok(!urls.includes('http://localhost:11434/api/generate'), 'probe path should not keep using localhost after fallback');
        assert.ok(!urls.includes('http://127.0.0.1:11434/api/generate'), 'probe path should not keep using IPv4 after IPv6 fallback succeeds');
        assert.ok(!urls.includes('http://localhost:11434/api/chat'), 'evaluator path should not keep using localhost after fallback');
        assert.ok(!urls.includes('http://127.0.0.1:11434/api/chat'), 'evaluator path should not keep using IPv4 after IPv6 fallback succeeds');
    } finally {
        global.fetch = originalFetch;
    }
}

async function run() {
    await testProbeAndEvaluatorUseResolvedIpv6FallbackURL();
    console.log('ollama-selector-ipv6-fallback.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('ollama-selector-ipv6-fallback.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
