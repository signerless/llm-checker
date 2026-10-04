/**
 * Ollama scraper parsing test
 * ===========================
 *   - Library cards yield capability badges, pulls and tag counts.
 *   - Tag rows yield the digest, size (GiB), context window and input types;
 *     cloud tags are not local variants and nothing is estimated.
 *   - Aliases sharing a digest share parameters and quantization.
 *   - Registry manifests give exact bytes, quantization and parameters.
 */

const assert = require('assert');
const EnhancedOllamaScraper = require('../src/ollama/enhanced-scraper');

const LIBRARY_HTML = `
<ul>
    <li  class="flex items-baseline border-b border-neutral-200 py-6">
      <a href="/library/gemma3" class="group w-full space-y-5">
        <div  title="gemma3" class="flex flex-col">
          <h2 class="truncate text-xl font-medium"><span class="group-hover:underline truncate">gemma3</span></h2>
          <p class="max-w-lg break-words text-neutral-800 text-md">The current, most capable model that runs on a single GPU.</p>
        </div>
        <div class="flex flex-col space-y-2">
          <div class="flex flex-wrap space-x-2">
            <span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">vision</span>
            <span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-xs font-medium text-blue-600 sm:text-[13px]">4b</span>
            <span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-xs font-medium text-blue-600 sm:text-[13px]">12b</span>
          </div>
          <p class="my-4 flex space-x-5 text-[13px] font-medium text-neutral-500">
            <span class="flex items-center"><span >40.9M</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
            <span class="flex items-center"><span >26</span><span class="hidden sm:flex">&nbsp;Tags</span></span>
          </p>
        </div>
      </a>
    </li>
    <li  class="flex items-baseline border-b border-neutral-200 py-6">
      <a href="/library/kimi-k3" class="group w-full space-y-5">
        <p class="max-w-lg">Kimi K3.</p>
        <span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5">tools</span>
        <span  class="inline-flex items-center rounded-md bg-cyan-50 px-2 py-0.5">cloud</span>
      </a>
    </li>
</ul>`;

function tagRow(tag, details) {
    return `
          <div class="group px-4 py-3">
            <a href="/library/${tag}" class="md:hidden flex flex-col space-y-[6px] group">
              <span class="group-hover:underline">${tag}</span>
              <div class="flex flex-col text-neutral-500 text-[13px]">
                <span>
                  <span class="font-mono">
                    ${details}
                  <span class="hidden sm:inline">
                    1 year ago
                  </span>
                </span>
              </div>
            </a>
            <div class="hidden md:flex"><a href="/library/${tag}" class="group-hover:underline">${tag}</a></div>
          </div>`;
}

const TAGS_HTML = `<section>
${tagRow('gemma3:latest', 'a2af6cc3eb7f</span> • 3.3GB • 128K context window  • Text, Image input •')}
${tagRow('gemma3:1b', '8648f39daa8f</span> • 815MB • 32K context window  • Text input •')}
${tagRow('gemma3:4b', 'a2af6cc3eb7f</span> • 3.3GB • 128K context window  • Text, Image input •')}
${tagRow('gemma3:4b-it-q4_K_M', 'a2af6cc3eb7f</span> • 3.3GB • 128K context window  • Text, Image input •')}
${tagRow('gemma3:4b-it-q4_1', 'c0ffee000001</span> • 3.5GB • 128K context window  • Text, Image input •')}
${tagRow('gemma3:4b-it-bf16', 'c0ffee000002</span> • 8.6GB • 128K context window  • Text, Image input •')}
${tagRow('gemma3:27b-cloud', '875e8e3a629a</span> • Low Usage • 128K context window  • Text input •')}
</section>`;

function testLibraryListing() {
    const scraper = new EnhancedOllamaScraper({ onError: () => {} });
    const models = scraper.parseLibraryListing(LIBRARY_HTML);
    assert.deepStrictEqual(models.map((model) => model.id), ['gemma3', 'kimi-k3']);
    assert.deepStrictEqual(models[0].badges, ['vision']);
    assert.strictEqual(models[0].pulls, 40900000);
    assert.strictEqual(models[0].tags_count, 26);
    assert.deepStrictEqual(models[0].sizes, ['4b', '12b']);
    assert.deepStrictEqual(models[1].badges, ['tools', 'cloud']);

    const capabilities = scraper.extractCapabilities('Lightweight open model', 'gemma3', ['vision', 'tools', 'cloud']);
    assert.ok(capabilities.includes('multimodal') && capabilities.includes('vision') && capabilities.includes('tools'));
    assert.ok(!capabilities.includes('cloud'), 'cloud availability is not a capability');
    assert.ok(!capabilities.includes('coding'), 'page chrome must not tag a model as coding');
    assert.deepStrictEqual(scraper.extractCapabilities('Embedding model', 'nomic-embed-text', ['embedding']),
        ['embeddings', 'embedding']);
}

function testTagRows() {
    const scraper = new EnhancedOllamaScraper({ onError: () => {} });
    const variants = scraper.shareAliasMetadata(scraper.parseTagRows('gemma3', TAGS_HTML));
    const byTag = Object.fromEntries(variants.map((variant) => [variant.tag, variant]));

    assert.ok(!byTag['gemma3:27b-cloud'], 'cloud tags are not local variants');
    assert.strictEqual(variants.length, 6);

    const latest = byTag['gemma3:latest'];
    assert.strictEqual(latest.digest, 'a2af6cc3eb7f');
    assert.strictEqual(latest.params_b, 4, 'params come from the 4b alias');
    assert.strictEqual(latest.quant, 'Q4_K_M', 'quantization comes from the q4_K_M alias, never a default');
    assert.strictEqual(latest.size_gb, 3.073, 'decimal GB on the page is stored in GiB');
    assert.strictEqual(latest.context_length, 131072);
    assert.deepStrictEqual(latest.input_types, ['text', 'image']);

    assert.strictEqual(byTag['gemma3:1b'].context_length, 32768);
    assert.deepStrictEqual(byTag['gemma3:1b'].input_types, ['text']);
    assert.strictEqual(byTag['gemma3:1b'].size_gb, 0.759);
    assert.strictEqual(byTag['gemma3:4b-it-q4_1'].quant, 'Q4_1', 'q4_1 is its own quantization');
    assert.strictEqual(byTag['gemma3:4b-it-bf16'].quant, 'BF16');
}

function testNoFabricatedValues() {
    const scraper = new EnhancedOllamaScraper({ onError: () => {} });
    const variant = scraper.parseVariant('llama3.1', 'llama3.1:8b', null);
    assert.strictEqual(variant.size_gb, null, 'no size from a parameter formula');
    assert.strictEqual(variant.quant, null, 'no assumed Q4_0');
    assert.strictEqual(variant.context_length, null, 'no assumed 4096 window');
    assert.strictEqual(scraper.parseVariant('llama3.1', 'llama3.1:8b-128k', null).context_length, 131072);
    assert.strictEqual(scraper.extractParams('mixtral:8x7b'), 56, 'every expert is resident');
    assert.strictEqual(scraper.extractQuantization('qwen3:8b-iq4_xs'), 'IQ4_XS');
    assert.strictEqual(scraper.isMoE('qwen3:30b-a3b', 'qwen3'), true);
    assert.strictEqual(scraper.parseTagRows('gemma3', '<html>no rows</html>'), null, 'unknown layout is reported');
}

async function testRegistryEnrichment() {
    const requests = [];
    const scraper = new EnhancedOllamaScraper({ exact: true, onError: (message) => { throw new Error(message); } });
    scraper.httpGet = async (url, retries, headers) => {
        requests.push({ url, headers });
        if (url.endsWith('/manifests/latest')) {
            return JSON.stringify({
                config: { digest: 'sha256:config' },
                layers: [
                    { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${'d'.repeat(64)}`, size: 3_000_000_000 },
                    { mediaType: 'application/vnd.ollama.image.projector', digest: 'sha256:proj', size: 800_000_000 },
                    { mediaType: 'application/vnd.ollama.image.license', digest: 'sha256:license', size: 8432 },
                    { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:tpl', size: 358 }
                ]
            });
        }
        if (url.endsWith('/blobs/sha256:license')) return '  Gemma Terms of Use\n  Last modified: February 21, 2024';
        if (url.endsWith('/blobs/sha256:config')) {
            return JSON.stringify({ model_family: 'gemma3', model_type: '4.3B', file_type: 'Q4_K_M' });
        }
        throw new Error(`unexpected ${url}`);
    };
    const variants = [
        { tag: 'gemma3:latest', digest: 'a2af6cc3eb7f', params_b: null, quant: null, input_types: ['text'] },
        { tag: 'gemma3:4b', digest: 'a2af6cc3eb7f', params_b: 4, quant: null, input_types: ['text'] }
    ];
    await scraper.enrichFromRegistry('gemma3', variants);
    assert.strictEqual(requests.length, 3, 'one manifest, config and license per digest');
    assert.strictEqual(requests[0].headers.Accept, 'application/vnd.docker.distribution.manifest.v2+json');
    for (const variant of variants) {
        assert.strictEqual(variant.size_bytes, 3_800_000_000, 'model and projector layers');
        assert.strictEqual(variant.quant, 'Q4_K_M');
        assert.strictEqual(variant.params_b, 4.3);
        assert.strictEqual(variant.blob_digest, `sha256:${'d'.repeat(64)}`);
        assert.ok(variant.input_types.includes('image'), 'a projector layer accepts images');
        assert.strictEqual(variant.license, 'gemma', 'the license layer is classified');
    }
}

function testLicenseClassification() {
    const scraper = new EnhancedOllamaScraper({ onError: () => {} });
    const cases = {
        'LLAMA 3.1 COMMUNITY LICENSE AGREEMENT Llama 3.1 Version Release Date': 'llama3.1',
        'Qwen RESEARCH LICENSE AGREEMENT  Release Date: September 19, 2024': 'qwen-research',
        '                  Apache License\n                  Version 2.0, January 2004': 'apache-2.0',
        'MIT License  Copyright (c) 2023 DeepSeek  Permission is hereby granted, free of charge': 'mit',
        'Creative Commons Attribution-NonCommercial 4.0 International Public License': 'cc-by-nc-4.0',
        'Some bespoke terms of use': 'other'
    };
    for (const [text, expected] of Object.entries(cases)) {
        assert.strictEqual(scraper.classifyLicense(text), expected, text);
    }
}

async function run() {
    testLibraryListing();
    testTagRows();
    testNoFabricatedValues();
    await testRegistryEnrichment();
    testLicenseClassification();
    console.log('ollama-scraper-parsing.test.js: OK');
}

if (require.main === module) {
    run().catch((error) => {
        console.error('ollama-scraper-parsing.test.js: FAILED');
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
