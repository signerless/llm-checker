Changelog
=========

2.7.2 — Security & Robustness (2025-09-08)
------------------------------------------

- Security: Removed insecure “curl | sh” install instructions from CLI messages and setup script. Now we reference official docs/package managers.
- Network hardening: Added request timeouts and a 5MB response size limit in the Ollama native scraper to prevent hanging connections and excessive memory use.
- Safer caching: Moved Ollama cache to `~/.llm-checker/cache/ollama` with backward-compatible reads from the legacy `src/ollama/.cache` folder.
- CLI updates: Adjusted CLI to read the new cache location with fallback to legacy path.
- No breaking changes: Functionality remains the same; legacy cache is still read. On write, new cache path is used.

2.7.1
------
- Previous version in repository.
