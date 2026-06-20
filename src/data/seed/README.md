This directory contains the packaged model database snapshot used on first run.

`models.db` is copied to `~/.llm-checker/models.db` only when the user does not
already have a local database. After that, `llm-checker sync` updates the user's
local Ollama copy, and `llm-checker registry-sync` can refresh the multi-source
registry in the user's local copy.

The snapshot includes:

- the Ollama catalog used by classic recommendation/search commands
- a multi-source registry of exact installable/downloadable artifacts from
  Hugging Face, Ollama, and GPT4All
- Hugging Face pages are fetched with cursor pagination; the default packaged
  snapshot uses the top 3000 repositories by downloads

Refresh cadence: weekly via `.github/workflows/update-model-db.yml`.
