This directory contains the packaged Ollama model database snapshot used on
first run.

`models.db` is copied to `~/.llm-checker/models.db` only when the user does not
already have a local database. After that, `llm-checker sync` updates the user's
local copy.

Refresh cadence: weekly via `.github/workflows/update-model-db.yml`.
