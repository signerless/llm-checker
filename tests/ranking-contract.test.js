const assert = require('assert');
const Selector = require('../src/models/deterministic-selector');
const { artifactToSelectorModel, groupWeightShards } = require('../src/data/registry-recommender');
const { precisionProfile, memoryBudgetGB, classifyFit } = require('../src/models/ranking-contract');
const { checkpointIdentity, sameCheckpoint } = require('../src/data/checkpoint-identity');
const { getRuntimeCommandSet } = require('../src/runtime/runtime-support');

const selector = new Selector();
selector.qualityEvals = null;
const hardware = selector.normalizeHardwareProfile({
    cpu: { architecture: 'x64', cores: 8 }, memory: { totalGB: 32 },
    gpu: { type: 'nvidia', vramGB: 8 }, acceleration: { supports_cuda: true }
});
const base = { name: 'Qwen/Qwen2.5-7B-Instruct', paramsB: 7, tags: ['instruct'],
    ctxMax: 32768, quant: 'FP16', family: 'qwen2.5' };
for (const quant of ['FP16', 'BF16', 'FP32']) {
    assert.strictEqual(selector.normalizeQuantization(quant), quant);
    assert.ok(selector.estimateRequiredGB({ ...base, quant }, quant, 4096) > 14);
    assert.strictEqual(selector.evaluateModel({ ...base, quant }, hardware, 'general', 4096, 8), null);
}
assert.strictEqual(precisionProfile('IQ4_XS').bytes, 0.58);
assert.strictEqual(selector.estimateRequiredGB({ ...base, quant: 'unknown' }, 'unknown', 4096), Infinity);
const fixed = { ...base, quant: 'Q8_0', model_identifier: 'qwen:7b-q8_0',
    availableQuantizations: ['Q8_0', 'Q4_K_M'], sizeByQuant: { Q8_0: 7.6, Q4_K_M: 4.5 } };
assert.deepStrictEqual(selector.getQuantizationCandidates(fixed), ['Q8_0']);
assert.strictEqual(selector.evaluateModel(fixed, hardware, 'general', 4096, 6), null);
const candidate = selector.evaluateModel(fixed, hardware, 'general', 4096, 9);
assert.strictEqual(candidate.quant, 'Q8_0');
assert.strictEqual(selector.mapCandidateToLegacyFormat(candidate).model_identifier, 'qwen:7b-q8_0');

const shard = { source_id: 'huggingface', repo_id: 'test/model-7B-GGUF',
    canonical_model_id: 'test/model-7B-GGUF', repo_tasks: ['text-generation'], format: 'gguf',
    quantization: 'Q8_0', size_gb: 4, parameter_count_b: 7, context_length: 4096,
    runtime_support: ['ollama', 'llama.cpp'] };
const shards = [1, 2].map(i => ({ ...shard, filename: `model-Q8_0-0000${i}-of-00002.gguf` }));
assert.strictEqual(groupWeightShards(shards.slice(1)).length, 0, 'incomplete shard sets are not installable');
const grouped = groupWeightShards(shards);
assert.strictEqual(grouped.length, 1);
const model = artifactToSelectorModel(grouped[0]);
assert.strictEqual(model.sizeGB, 8, 'all shard sizes must count');
assert.strictEqual(model.preferredRuntime, 'llama.cpp');
const commands = getRuntimeCommandSet({ ...model, context: { effective: 4096 } }, 'auto');
for (const part of shards) assert.ok(commands.pull.includes(part.filename), 'download must include every shard');
assert.ok(commands.run.includes(shards[0].filename));
assert.ok(commands.run.includes('--ctx-size 4096'));
assert.strictEqual(getRuntimeCommandSet(model, 'ollama').pull, null, 'a HF filename is not an Ollama pull tag');

for (const category of ['general', 'talking', 'creative', 'reading', 'coding', 'reasoning']) {
    const models = [base, { ...base, name: 'bge-m3', tags: ['embedding', 'instruct'] },
        { ...base, name: 'test-reranker', tags: ['text-ranking', 'instruct'] }, { name: 'unknown' }];
    assert.deepStrictEqual(selector.filterByCategory(models, category), [base]);
}
const scores = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M'].map(q => selector.calculateQualityPrior({ ...base }, q, 'general'));
assert.ok(scores.every((score, i) => i === 0 || scores[i - 1] >= score), 'precision must not lose quality through a falsy zero');
selector.lookupMeasuredQuality = () => ({ score: 80, provenance: { kind: 'measured' } });
assert.strictEqual(selector.calculateQualityPrior({ ...base }, 'Q8_0', 'general'), 80);
assert.strictEqual(selector.calculateQualityPrior({ ...base }, 'Q6_K', 'general'), 79);
for (const backend of ['rocm', 'vulkan', 'sycl']) {
    const hw = { ...hardware, acceleration: { [`supports_${backend}`]: true } };
    const speed = selector.estimateSpeedProfile(hw, base, 'Q4_K_M', 'general');
    assert.strictEqual(speed.backend, backend);
    assert.strictEqual(selector.estimateSpeedProfile({ ...hw, cpuOnly: true }, base, 'Q4_K_M', 'general').backend, 'cpu_x86');
}
const smallContext = { ...base, quant: 'Q4_K_M', ctxMax: 2048 };
assert.strictEqual(selector.evaluateModel(smallContext, hardware, 'reading', 32768, 8), null);
assert.strictEqual(selector.evaluateModel({ ...smallContext, ctxMax: null }, hardware, 'reading', 32768, 8), null);
const preferred = selector.evaluateModel(smallContext, hardware, 'reading', 32768, 8, 'balanced', 'ollama', { contextPolicy: 'preferred' });
assert.strictEqual(preferred.context.effective, 2048);
assert.strictEqual(preferred.context.limited, true);
assert.strictEqual(preferred.memory.requiredGB, selector.estimateRequiredGB(smallContext, 'Q4_K_M', 2048));
assert.strictEqual(memoryBudgetGB({ memory: { totalGB: 26 }, gpu: { unified: true, vramGB: 0.25 }, summary: { effectiveMemory: 13 } }), 13);
assert.strictEqual(classifyFit(null, 8), 'unknown');
assert.strictEqual(classifyFit(100, null), 'unknown');
assert.strictEqual(memoryBudgetGB({}), null);

const identity = (name, params = 7, metadata) => checkpointIdentity(name, params, metadata);
assert.ok(!sameCheckpoint(identity('Qwen/Qwen2.5-7B'), identity('Qwen/Qwen2.5-7B-Instruct')));
assert.ok(!sameCheckpoint(identity('Qwen/Qwen2.5-7B-Instruct'), identity('Qwen/Qwen2.5-8B-Instruct', 8)));
assert.ok(!sameCheckpoint(identity('deepseek-r1', 14), identity('deepseek-r1-0528', null)));
assert.ok(!sameCheckpoint(identity('test-7b-thinking'), identity('test-7b')));
assert.ok(!sameCheckpoint(identity('Qwen/Qwen2.5-7B-Instruct'), identity('Qwen/Qwen2.5-7B-Instruct-1M')));
assert.ok(!sameCheckpoint(identity('other/Qwen2.5-7B'), identity('Qwen/Qwen2.5-7B')));
assert.ok(!sameCheckpoint(identity('other/Qwen2.5-7B-Instruct'), identity('Qwen2.5-7B-Instruct')));
assert.ok(!sameCheckpoint(identity('qwen2.5:7b'), identity('Qwen/Qwen2.5-7B')));
assert.ok(sameCheckpoint(identity('qwen2.5:7b-base'), identity('Qwen/Qwen2.5-7B')));
assert.ok(sameCheckpoint(identity('qwen2.5:7b-instruct', 7, { artifact: { source_id: 'ollama', repo_id: 'qwen2.5' } }), identity('Qwen/Qwen2.5-7B-Instruct')));
const alias = identity('quantizer/Qwen2.5-7B-Instruct-GGUF', 7, { repoTags: ['base_model:quantized:Qwen/Qwen2.5-7B-Instruct'] });
assert.ok(sameCheckpoint(alias, identity('Qwen/Qwen2.5-7B-Instruct')));
const finetune = identity('quantizer/Qwen2.5-7B-Instruct-GGUF', 7, { repoTags: ['base_model:finetune:Qwen/Qwen2.5-7B-Instruct'] });
assert.ok(!sameCheckpoint(finetune, identity('Qwen/Qwen2.5-7B-Instruct')));
console.log('ranking-contract.test.js: OK');
