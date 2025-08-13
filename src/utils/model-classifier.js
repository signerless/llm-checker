#!/usr/bin/env node
// model-classifier.js
// Classifier that adds `categories` (multi) and `primary_category` (single) to each model
//
// IMPORTANT: STATIC DATABASE WITH PRE-CLASSIFIED CATEGORIES
// This system uses a static model database (177 models) with pre-classified categories.
// If you need to update the model database in the future:
// 1. Run the database update process
// 2. RE-ADD CATEGORIES: Run this classification system again on all new models
// 3. Update the cache file with the new categories
// 4. Test all use-case filters (coding, creative, reasoning, multimodal, embeddings, etc.)
// 
// The classification rules below must be applied to any new models added to the database.

const fs = require('fs');

const CANON = ['coding','reasoning','creative','chat','multimodal','embeddings','safety','general'];

const CATEGORY_SYNONYMS = {
  // normalize incoming "category" values
  talking: 'chat',
  multimodal: 'multimodal',
  embeddings: 'embeddings',
  reasoning: 'reasoning',
  coding: 'coding',
  safety: 'safety',
  general: 'general',
};

const RULES = [
  // embeddings - very specific patterns
  {cat:'embeddings', re: /(embedding|embed|e5|bge|gte|minilm|paraphrase|text-embedding|nomic[-\s]?embed|voyage|snowflake-embed|arctic-embed|mxbai-embed)/i},

  // multimodal / vision - specific vision models
  {cat:'multimodal', re: /(llava|vision|vl\b|moondream|paligemma|pixtral|idefics|granite.*vision|llama3\.2[-_ ]?vision|qwen.*vl)/i},

  // safety/moderation
  {cat:'safety', re: /(guard|shield|moderation|safety)/i},

  // coding - be more specific, exclude general models
  {cat:'coding', re: /^(code|coder|codellama|starcoder|magicoder|phind[-_ ]?codellama|codeqwen|granite[-_ ]?code|yi[-_ ]?coder|opencoder|stable[-_ ]?code|deepseek[-_ ]?coder|codegemma)/i},

  // reasoning / math
  {cat:'reasoning', re: /(deepseek[-_ ]?r1|reason|r1\b|math|mathstral|wizard[-_ ]?math|gsm8k|mmlu|logic|phi4[-_ ]?reasoning|o1\b)/i},

  // creative / RP / storytelling - look for specific creative models
  {cat:'creative', re: /(dolphin(?![-_ ]?coder)|wizard(?![-_ ]?math)|mytho|synthia|airoboros|uncensored|roleplay|storyteller|creative|fiction)/i},

  // chat / assistants - general conversational models
  {cat:'chat', re: /(llama(?!.*code)|mistral(?!.*code)|qwen(?!.*code|.*vl)|gemma(?!.*code)|chat|assistant|hermes|openhermes|command\b|mistrallite|reflection)/i},
];

const PRIMARY_ORDER = [
  'embeddings','safety','coding','reasoning','creative','multimodal','chat','general'
];

function toText(model) {
  return [
    model.model_identifier, model.model_name,
    model.description, model.detailed_description,
    model.category, model.use_cases, model.input_types,
    model.tags, model.labels, model.url
  ]
    .flat().filter(Boolean).map(String).join(' ').toLowerCase();
}

function normalizeFromCategoryField(cat) {
  if (!cat) return [];
  const c = CATEGORY_SYNONYMS[String(cat).toLowerCase()];
  return c ? [c] : [];
}

function fromUseCases(use_cases=[]) {
  const set = new Set();
  for (const u of use_cases.map(x => String(x).toLowerCase())) {
    if (/(coding|programming|development)/.test(u)) set.add('coding');
    if (/(reasoning|mathematics|logic)/.test(u)) set.add('reasoning');
    if (/(chat|conversation|assistant)/.test(u)) set.add('chat');
    if (/(vision|image|multimodal)/.test(u)) set.add('multimodal');
    if (/(embedding|embeddings|search|similarity)/.test(u)) set.add('embeddings');
    if (/(safety|moderation)/.test(u)) set.add('safety');
    if (/(creative|story|roleplay)/.test(u)) set.add('creative');
  }
  return [...set];
}

function fromInputTypes(input_types=[]) {
  const set = new Set();
  const low = input_types.map(x => String(x).toLowerCase());
  // Only use input_types as hints, not definitive classification
  // Most models have ['text', 'image', 'code'] automatically, so ignore generic ones
  if (low.includes('image') && low.length === 1) set.add('multimodal'); // only if pure image model
  if (low.includes('audio') && low.length === 1) set.add('multimodal'); // only if pure audio model
  // Don't auto-classify as coding based on input_types since all models have 'code'
  return [...set];
}

function regexRules(haystack) {
  const set = new Set();
  for (const {cat, re} of RULES) if (re.test(haystack)) set.add(cat);
  return [...set];
}

function choosePrimary(cats) {
  for (const c of PRIMARY_ORDER) if (cats.has(c)) return c;
  return 'general';
}

function classifyModel(m) {
  const hay = toText(m);
  const cats = new Set([
    ...normalizeFromCategoryField(m.category),
    ...fromUseCases(m.use_cases),
    ...fromInputTypes(m.input_types),
    ...regexRules(hay),
  ]);

  if (cats.size === 0) cats.add('general');

  // Keep only canonical labels
  for (const c of [...cats]) if (!CANON.includes(c)) cats.delete(c);

  const primary = choosePrimary(cats);
  const categories = [...cats].sort();

  // Also annotate variants (handy for tag-level filtering)
  const variants = (m.variants || []).map(v => {
    const vHay = [m.model_name, v.tag, v.size, v.quantization].filter(Boolean).join(' ').toLowerCase();
    const vCats = new Set(categories);
    regexRules(vHay).forEach(c => vCats.add(c));
    return { ...v, categories: [...vCats].sort() };
  });

  return { ...m, categories, primary_category: primary, variants };
}

function classifyAllModels(inputData) {
  const models = inputData.models || [];
  const classifiedModels = models.map(classifyModel);
  return { ...inputData, models: classifiedModels };
}

function run(path) {
  const input = JSON.parse(fs.readFileSync(path, 'utf8'));
  const output = classifyAllModels(input);
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node model-classifier.js models.json > models_with_categories.json');
    process.exit(1);
  }
  run(path);
}

module.exports = { classifyAllModels, classifyModel };