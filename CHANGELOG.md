Changelog
=========

3.0.6 — Fix TPS Estimation (2025-12-31)
---------------------------------------

- Fix: TPS was overestimated by 2-10x across all hardware
- Updated speed coefficients to match real Ollama benchmarks:
  - H100: 120 TPS (was 400), RTX 4090: 70 TPS (was 260)
  - M4 Pro: 45 TPS (was 270), CPU: 5 TPS (was 50)
- Changed quantization baseline from FP16 to Q4_K_M (the most common format)
- Added diminishing returns for small models (1-3B don't scale linearly)
- Added comprehensive hardware simulation test suite (17 test cases)

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
