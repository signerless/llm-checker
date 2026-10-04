This directory contains the packaged model database snapshot used on first run.

`models.db` is copied to `~/.llm-checker/models.db` when the user does not
already have a local database. An existing local database adopts a newer
packaged snapshot part by part (the Ollama catalog and each registry source),
unless the user refreshed that part more recently with `llm-checker sync` or
`llm-checker registry-sync`. Local speed measurements are kept.

The snapshot includes:

- the Ollama library catalog: every tag that runs locally, with its manifest
  digest, exact download size, quantization and parameter count from
  `registry.ollama.ai`, and the context window and input types from the tags
  page (`sync --exact`). Cloud-only tags are excluded.
- a multi-source registry of exact installable/downloadable artifacts from
  Hugging Face, Ollama, and GPT4All. Hugging Face listings are requested per
  language task (text generation, image-text-to-text, embeddings) with exact
  parameter counts, dtypes, GGUF headers and lineage, plus a sweep of official
  model publishers. Each repo's file sizes and SHA-256 hashes come from the tree
  API and its context window from `config.json`. A complete shard set is one
  artifact.

Refresh cadence: weekly via `.github/workflows/update-model-db.yml`
(`npm run sync:seed`). Set the `HF_TOKEN` repository secret to raise the
Hugging Face rate-limit window; without it the build waits between windows.
