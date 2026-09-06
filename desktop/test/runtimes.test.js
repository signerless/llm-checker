'use strict';

/**
 * Runtime registry + card shaping tests. No Electron needed — these exercise
 * the pure logic that the main process depends on.
 *
 *   node test/runtimes.test.js
 */

const assert = require('assert');
const runtimes = require('../src/main/runtimes');
const {
    classifyFit, toCard, harvest, harvestCategories, CATEGORIES, tidyReason, FIT,
} = require('../src/main/core');

let pass = 0;
let fail = 0;
const results = [];

function test(name, fn) {
    try {
        fn();
        pass += 1;
        results.push(`  ok   ${name}`);
    } catch (err) {
        fail += 1;
        results.push(`  FAIL ${name}\n       ${err.message}`);
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        pass += 1;
        results.push(`  ok   ${name}`);
    } catch (err) {
        fail += 1;
        results.push(`  FAIL ${name}\n       ${err.message}`);
    }
}

/* ---------------- normalisation ---------------- */

test('every advertised runtime resolves', () => {
    for (const id of ['ollama', 'llama.cpp', 'lmstudio', 'vllm', 'mlx', 'transformers']) {
        assert.strictEqual(runtimes.normalize(id), id, `${id} did not resolve to itself`);
    }
});

test('aliases resolve to their canonical id', () => {
    assert.strictEqual(runtimes.normalize('llamacpp'), 'llama.cpp');
    assert.strictEqual(runtimes.normalize('llama-cpp'), 'llama.cpp');
    assert.strictEqual(runtimes.normalize('lm-studio'), 'lmstudio');
    assert.strictEqual(runtimes.normalize('mlx_lm'), 'mlx');
    assert.strictEqual(runtimes.normalize('huggingface'), 'transformers');
});

test('unknown runtimes return null, never a silent ollama', () => {
    // This is the CLI bug this module exists to avoid: normalizeRuntime()
    // in src/runtime/runtime-support.js rewrites llama.cpp -> ollama.
    assert.strictEqual(runtimes.normalize('bogus'), null);
    assert.strictEqual(runtimes.normalize(''), null);
    assert.strictEqual(runtimes.normalize(undefined), null);
});

test('auto is preserved rather than collapsed to a concrete runtime', () => {
    assert.strictEqual(runtimes.normalize('auto'), 'auto');
    assert.strictEqual(runtimes.get('auto'), null);
});

/* ---------------- eligibility ---------------- */

test('mlx is offered only on Apple Silicon', () => {
    const ids = runtimes.eligible({}).map((r) => r.id);
    const expected = process.platform === 'darwin' && process.arch === 'arm64';
    assert.strictEqual(ids.includes('mlx'), expected);
});

test('vllm needs an accelerator and is never offered on macOS', () => {
    const withGpu = runtimes.eligible({ gpu: { vramGB: 12 } }).map((r) => r.id);
    const without = runtimes.eligible({ gpu: { vramGB: 0 } }).map((r) => r.id);
    if (process.platform === 'darwin') {
        assert.ok(!withGpu.includes('vllm'), 'vllm must not appear on macOS');
    } else {
        assert.ok(withGpu.includes('vllm'), 'vllm should appear with a GPU');
        assert.ok(!without.includes('vllm'), 'vllm should not appear without one');
    }
});

test('ollama and llama.cpp are available everywhere', () => {
    const ids = runtimes.eligible({}).map((r) => r.id);
    assert.ok(ids.includes('ollama'));
    assert.ok(ids.includes('llama.cpp'));
});

/* ---------------- commands ---------------- */

test('each runtime produces a real, distinct pull command', () => {
    const ollama = runtimes.commandsFor('ollama', 'mistral:7b');
    const llama = runtimes.commandsFor('llama.cpp', 'TheBloke/Mistral-7B-GGUF');
    const mlx = runtimes.commandsFor('mlx', 'mlx-community/Mistral-7B');

    assert.match(ollama.pull, /^ollama pull /);
    assert.match(llama.pull, /huggingface-cli download/);
    assert.match(mlx.run, /mlx_lm/);
    // The bug being guarded: llama.cpp must NOT emit an ollama command.
    assert.ok(!llama.pull.includes('ollama'), 'llama.cpp leaked an ollama command');
    assert.ok(!mlx.run.includes('ollama'), 'mlx leaked an ollama command');
});

test('llama.cpp exposes a serve command, ollama does not', () => {
    assert.ok(runtimes.commandsFor('llama.cpp', 'x').serve);
    assert.strictEqual(runtimes.commandsFor('ollama', 'x').serve, null);
});

test('commandsFor on an unknown runtime returns null', () => {
    assert.strictEqual(runtimes.commandsFor('nope', 'x'), null);
});

/* ---------------- format routing ---------------- */

test('gguf routes to a gguf-capable runtime', () => {
    const chosen = runtimes.chooseFor({ format: 'gguf' }, [], { gpu: { vramGB: 12 } });
    assert.ok(chosen, 'no runtime chosen for gguf');
    assert.ok(chosen.formats.includes('gguf'), `${chosen.id} cannot run gguf`);
});

test('safetensors never routes to ollama', () => {
    const chosen = runtimes.chooseFor({ format: 'safetensors' }, [], { gpu: { vramGB: 12 } });
    assert.ok(chosen, 'no runtime chosen for safetensors');
    assert.ok(chosen.formats.includes('safetensors'));
    assert.notStrictEqual(chosen.id, 'ollama');
});

test('an installed runtime outranks an uninstalled one', () => {
    const detected = [
        { id: 'ollama', installed: false, serving: false },
        { id: 'llama.cpp', installed: true, serving: true },
    ];
    const chosen = runtimes.chooseFor({ format: 'gguf' }, detected, { gpu: { vramGB: 12 } });
    assert.strictEqual(chosen.id, 'llama.cpp');
});

/* ---------------- fit classification ---------------- */

test('fit buckets follow the VRAM budget', () => {
    assert.strictEqual(classifyFit(5.1, 12), FIT.GOOD);   // 42%
    assert.strictEqual(classifyFit(11.5, 12), FIT.TIGHT); // 96% including KV cache
    assert.strictEqual(classifyFit(42.5, 12), FIT.OVER);  // 354%
    assert.strictEqual(classifyFit(12, 12), FIT.TIGHT);   // exactly at budget
});

test('unknown sizes do not get flagged as over budget', () => {
    assert.strictEqual(classifyFit(null, 12), FIT.UNKNOWN);
    assert.strictEqual(classifyFit(5, null), FIT.UNKNOWN);
});

/* ---------------- harvesting ---------------- */

test('harvest flattens the flat buckets, including incompatible', () => {
    const got = harvest({
        recommended: [{ name: 'a' }],
        compatible: [{ name: 'b' }],
        incompatible: [{ name: 'c' }],
        marginal: [{ name: 'd' }],
    });
    assert.deepStrictEqual(got.map((m) => m.name).sort(), ['a', 'b', 'c', 'd']);
});

test('harvest reads model_name, the field the ranked entries actually use', () => {
    const got = harvest({ compatible: [{ model_name: 'qwen2.5-coder' }] });
    assert.strictEqual(got.length, 1);
});

/* ---------------- category grouping ---------------- */

test('harvestCategories reads bestModels two levels down', () => {
    const groups = harvestCategories({
        recommendations: {
            recommendations: {
                coding: { bestModels: [{ model_name: 'qwen2.5-coder' }], totalCandidates: 10799 },
                general: { bestModels: [{ model_name: 'mistral' }], totalCandidates: 10799 },
            },
        },
    });
    const keys = groups.map((g) => g.key);
    assert.ok(keys.includes('coding') && keys.includes('general'));
    // General leads the board; coding follows.
    assert.strictEqual(keys[0], 'general');
    assert.strictEqual(groups[0].evaluated, 10799);
});

test('harvestCategories drops categories with no models', () => {
    const groups = harvestCategories({
        recommendations: { recommendations: { coding: { bestModels: [] }, general: { bestModels: [{ model_name: 'x' }] } } },
    });
    assert.deepStrictEqual(groups.map((g) => g.key), ['general']);
});

test('harvestCategories tolerates a missing tree', () => {
    assert.deepStrictEqual(harvestCategories({}), []);
    assert.deepStrictEqual(harvestCategories(), []);
});

test('every category carries a label, emoji and colour for the column head', () => {
    for (const c of CATEGORIES) {
        assert.ok(c.label && c.emoji && c.colour, `${c.key} is missing display data`);
    }
});

test('tidyReason shortens the float noise the core emits', () => {
    const out = tidyReason('fits in 6.108751999999999/12GB, Q6_K, 7B is sweet spot');
    assert.ok(out.includes('6.1/12GB'), out);
    assert.ok(!out.includes('6.10875'), out);
});

test('harvest de-duplicates case-insensitively', () => {
    const got = harvest({ recommended: [{ name: 'Mistral' }], compatible: [{ name: 'mistral' }] });
    assert.strictEqual(got.length, 1);
});

test('harvest tolerates an empty analysis', () => {
    assert.deepStrictEqual(harvest({}), []);
    assert.deepStrictEqual(harvest(), []);
});

/* ---------------- card shaping ---------------- */

test('toCard carries size, quant and a runtime-correct command', () => {
    const c = toCard(
        { name: 'mistral', parameters: '7B', sizeGB: 5.1, quantization: 'Q5_K_M', format: 'gguf', score: 92 },
        12, [{ id: 'ollama', installed: true, serving: true }], { gpu: { vramGB: 12 } }
    );
    assert.strictEqual(c.name, 'mistral');
    assert.strictEqual(c.fit, FIT.GOOD);
    assert.strictEqual(c.quant, 'Q5_K_M');
    assert.strictEqual(c.runtime, 'ollama');
    assert.match(c.commands.pull, /ollama pull/);
});

test('toCard reads the real ranked-entry shape, not the field names it resembles', () => {
    // Verbatim shape from recommendations.recommendations.coding.bestModels[0].
    const c = toCard({
        model_name: 'qwen2.5-coder',
        model_identifier: 'qwen2.5-coder:7b-base-q6_K',
        categoryScore: 82.7,
        pulls: 15000000,
        size: 7,                       // parameter count in billions, NOT gigabytes
        estimatedRAM: 6.108751999999999, // the real VRAM figure
        quantization: 'Q6_K',
        artifactFormat: 'gguf',
        reasoning: 'fits in 6.108751999999999/12GB, Q6_K, 7B is sweet spot',
        runtime: 'ollama',
    }, 12, [{ id: 'ollama', installed: true, serving: true }], { gpu: { vramGB: 12 } });

    assert.strictEqual(c.name, 'qwen2.5-coder');
    assert.strictEqual(c.params, '7B', 'size must be read as a parameter count');
    assert.ok(Math.abs(c.sizeGB - 6.1087) < 0.001, 'sizeGB must come from estimatedRAM');
    assert.strictEqual(c.fit, FIT.GOOD, '6.1 of 12 GB is a comfortable fit');
    assert.strictEqual(c.ref, 'qwen2.5-coder:7b-base-q6_K');
    assert.match(c.commands.pull, /qwen2\.5-coder:7b-base-q6_K/);
    assert.ok(c.purpose.includes('6.1/12GB'), 'reasoning should be tidied');
});

test('a 70B model on a 12 GB card lands over budget', () => {
    const c = toCard(
        { model_name: 'Llama 3.3 70B', size: 70, estimatedRAM: 24, artifactFormat: 'gguf' },
        12, [], { gpu: { vramGB: 12 } }
    );
    assert.strictEqual(c.fit, FIT.OVER);
    assert.strictEqual(c.params, '70B');
});

test('a safetensors model gets a non-ollama command set', () => {
    const c = toCard(
        { name: 'llama-3', format: 'safetensors', sizeGB: 8 },
        12, [], { gpu: { vramGB: 12 } }
    );
    assert.notStrictEqual(c.runtime, 'ollama');
    assert.ok(!c.commands.pull.startsWith('ollama'));
});

/* ---------------- detection ---------------- */

(async () => {
    await testAsync('detectAll never throws and reports every eligible runtime', async () => {
        const hw = { gpu: { vramGB: 12 }, summary: { backend: 'NVIDIA CUDA' } };
        const t0 = Date.now();
        const found = await runtimes.detectAll(hw);
        const elapsed = Date.now() - t0;

        assert.strictEqual(found.length, runtimes.eligible(hw).length);
        for (const r of found) {
            assert.ok(typeof r.installed === 'boolean', `${r.id} missing installed`);
            assert.ok(typeof r.serving === 'boolean', `${r.id} missing serving`);
            assert.ok(r.installCommand, `${r.id} missing install command`);
        }
        // Probes run concurrently; a serial sweep would be ~N x the timeout.
        assert.ok(elapsed < 6000, `detection took ${elapsed} ms — is it running serially?`);
    });

    console.log('\nruntime registry\n');
    results.forEach((r) => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
})();
