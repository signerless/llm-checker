Changelog
=========

3.2.7 — License Update: No Paid Distribution (2026-02-17)
----------------------------------------------------------

- Replaced MIT license with **NPDL-1.0** (No Paid Distribution License).
- New license terms allow free use/modification/redistribution but prohibit paid distribution or paid hosted/API delivery without a separate commercial license.
- Updated package metadata (`license: SEE LICENSE IN LICENSE`) and README license badges/section.

3.2.6 — Recommendation & Detection Regression Hardening (2026-02-17)
--------------------------------------------------------------------

- Recommend: enforce feasible 30B-class coverage for capable discrete multi-GPU profiles (non-speed objectives).
- Recommend: add deterministic regression for dual-GPU 36GB aggregate VRAM scenarios.
- Hardware detection: preserve heterogeneous multi-GPU inventory summaries (e.g. mixed V100/P40/M40).
- Hardware mapping/fallbacks:
  - Added AMD Radeon AI PRO R9700 (PCI ID `7551`) support path.
  - Added NVIDIA GTX 1070 Ti (`1b82`) fallback mapping.
  - Re-verified Linux RX 7900 XTX non-ROCm fallback detection path.
- Docs: updated distribution/install notes and recommend optimization profile examples.

3.2.5 — Deterministic Selector Memory Modeling Fixes (2026-02-17)
------------------------------------------------------------------

- MoE memory estimation: fixed active-parameter memory path for deterministic model selection.
- Added deterministic regression coverage for MoE active/fallback parameter handling.
- Improved deterministic recommendation stability for memory-fit edge cases.

3.0.7 — Fix TPS Estimation (2025-12-31)
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
