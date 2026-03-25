Changelog
=========

3.5.8 — Windows Ollama Localhost Fallback + Vulkan Assist Visibility (2026-03-25)
----------------------------------------------------------------------------------

- Fixed Ollama availability checks on Windows systems where `localhost` resolves unreliably:
  - Ollama probing now retries loopback candidates such as `127.0.0.1` and `::1`.
  - the first working Ollama base URL is persisted for follow-up model listing and local checks.
- Improved Windows integrated GPU reporting for `hw-detect`:
  - fake adapters such as `Microsoft Remote Display Adapter` are filtered out of fallback GPU inventory.
  - integrated AMD/Intel/NVIDIA systems can now surface `Vulkan` runtime assist metadata even when the primary backend remains CPU.
  - CLI output now shows runtime-assist visibility more clearly instead of implying a CPU-only path.
- Added regression coverage for:
  - Ollama localhost-to-loopback fallback behavior.
  - Windows integrated GPU runtime-assist reporting and remote-display-adapter filtering.

3.5.7 — Windows WMIC Silence + Safer Local Recommendations (2026-03-25)
-----------------------------------------------------------------------

- Fixed Windows CPU detection noise on newer Windows builds where `wmic` has been removed:
  - Windows probes now capture shell stderr instead of printing `wmic` command-not-found errors into CLI flows.
  - PowerShell/CIM fallback continues quietly when WMIC is unavailable.
- Fixed oversized local Ollama recommendation edge cases:
  - local/cloud variant metadata is isolated more safely during recommendation scoring.
  - local recommendation sizing and hardware-tier routing are more consistent for CPU-backed systems.
- Added regression coverage for both the Windows WMIC-retired path and the oversized local recommendation path.

3.5.6 — Integrated GPU Inventory & Hybrid Visibility (2026-03-13)
------------------------------------------------------------------

- Added first-class integrated GPU inventory handling:
  - unified hardware summaries now preserve integrated and dedicated GPU topology separately.
  - summary metadata now exposes integrated/dedicated GPU counts and model lists.
- Improved hybrid and integrated-only system reporting:
  - hybrid systems now keep both dedicated and integrated GPU models visible.
  - integrated-only systems continue to surface GPU inventory even when the runtime backend remains CPU.
- Improved downstream model selection heuristics:
  - recommendation, tiering, and token-speed estimation now prefer canonical integrated-GPU signals over scattered regex-only checks.
- Improved CLI/system output:
  - hardware displays now show dedicated vs integrated GPU inventory explicitly.
  - CPU-backend systems with integrated GPU assist paths are labeled more clearly.
- Added regression coverage:
  - hybrid dedicated + integrated inventory preservation tests.
  - integrated-only CPU-backend inventory preservation tests.

3.5.5 — Termux Support (2026-03-07)
-----------------------------------

- Added Termux / Android package support:
  - npm package metadata now accepts the `android` platform so global installs work in Termux.
- Improved Linux-compatible runtime handling for Termux:
  - normalized Android platform detection to Linux-style hardware analysis where appropriate.
  - added Termux-specific Ollama install hints (`pkg install ollama`, `ollama serve`).
- Added regression coverage:
  - Android platform normalization and Termux runtime install command tests.

3.5.4 — GPU Detection + AMD VRAM Fix + Fine-Tuning Support (2026-03-05)
-------------------------------------------------------------------------

- Fixed Linux hybrid GPU detection fallback:
  - added `lspci`-based discovery when primary hardware libraries miss discrete GPUs.
  - improved fallback enrichment so dedicated GPUs are surfaced even when the primary backend resolves to CPU.
- Fixed AMD ROCm VRAM normalization:
  - corrected `rocm-smi` unit parsing (`B`, `KiB`, `MiB`, `GiB`) to prevent overreported memory values.
- Added fine-tuning suitability output in model selection workflows:
  - `check`, `recommend`, and `ai-check` now include a `Fine-tuning` indicator.
  - labels include `Full+LoRA+QLoRA`, `LoRA+QLoRA`, `QLoRA`, and no-support states.
- Added regression coverage:
  - ROCm VRAM parsing tests.
  - Fine-tuning support classification tests.
  - Linux hybrid GPU parsing and detector enrichment regression tests.

3.5.0 — Interactive CLI Panel + Unified Visual Style (2026-02-18)
------------------------------------------------------------------

- Added interactive panel mode when running `llm-checker` with no arguments on TTY terminals:
  - startup animated banner
  - main command list with descriptions
  - `/` opens full command list
  - keyboard navigation with up/down + Enter to execute
  - command filtering while typing in slash mode
- Added argument capture flow from interactive panel:
  - required prompt for `search <query>`
  - optional free-form extra parameters for any selected command (for example `--json --limit 5`)
- Replaced large per-command ASCII banners with a minimal, consistent command header style.
- Kept direct non-interactive command invocation unchanged (`llm-checker <command> ...`).
- Added helper regression coverage for interactive panel internals:
  - `tests/cli-interactive-panel.test.js`
- Included the new UI test in the unified test runner (`tests/run-all-tests.js`).

3.4.1 — Jetson/CUDA Output + Packaging Channel Clarification (2026-02-17)
--------------------------------------------------------------------------

- Fixed Jetson/CUDA driver display fallback:
  - `hw-detect` now reports `Driver: unknown` instead of `Driver: null` when driver metadata is unavailable.
- Hardened Jetson driver version detection:
  - probes additional driver sources and parsing patterns (`/proc/driver/nvidia/version`, `/sys/module/nvidia/version`).
- Fixed CUDA hardware fingerprint normalization:
  - prevents malformed fingerprints containing duplicate hyphens (for example `cuda--jetson-orin-nano-6gb`).
- Added Jetson regression coverage:
  - driver fallback assertion and fingerprint sanitization checks in `tests/cuda-jetson-detection.test.js`.
- Updated install channel docs:
  - npm unscoped package (`llm-checker`) is explicitly marked as the recommended latest channel.
  - scoped GitHub Packages channel is marked legacy/may-lag with recovery steps for stale installs.

3.4.0 — Ollama Runtime Capacity Planner (2026-02-17)
-----------------------------------------------------

- Added new `ollama-plan` command to generate safe Ollama runtime settings from local models + detected hardware.
- Added planner output for:
  - recommended `OLLAMA_NUM_CTX`
  - recommended `OLLAMA_NUM_PARALLEL`
  - recommended `OLLAMA_MAX_LOADED_MODELS`
  - queue/keep-alive/flash-attention environment variables
  - fallback profile and memory risk scoring
- Added model selection handling by exact tag/family/partial match for planning input.
- Added planner unit coverage:
  - `tests/ollama-capacity-planner.test.js`
- Extended CLI smoke coverage to include `ollama-plan --help`.
- Added `ollama-plan` to command documentation table in `README.md`.

3.3.0 — Calibration Docs + E2E Coverage (2026-02-17)
----------------------------------------------------

- Added a calibration quick-start flow in `README.md` designed for first-time setup in under 10 minutes.
- Added docs fixtures for calibration onboarding:
  - `docs/fixtures/calibration/sample-suite.jsonl`
  - `docs/fixtures/calibration/sample-generated-policy.yaml`
  - `docs/fixtures/calibration/README.md`
- Added deterministic end-to-end test coverage for the path:
  - `calibrate --policy-out ...` → `recommend --calibrated ...`
  - New test: `tests/calibration-e2e-integration.test.js`
- Expanded usage docs to include calibration routing workflow and precedence behavior:
  - `--policy` precedence over `--calibrated`
  - default calibrated discovery path at `~/.llm-checker/calibration-policy.{yaml,yml,json}`
- Added command documentation updates for calibration artifacts:
  - `calibration-result.json`
  - `calibration-policy.yaml`
- Updated `ml-model/README.md` to align commands with current CLI/scripts (`ai-check`, `ai-run`, benchmark/train flow) and improve quick-start clarity.
- Fixed training artifact output path to reliably write into `ml-model/trained` regardless of current working directory.
- Hardened Jetson CUDA detection to prevent CPU-only fallback on valid Jetson/L4T systems:
  - Expanded Jetson platform markers (`/etc/nv_tegra_release`, device-tree compatible IDs, kernel/utility hints).
  - Expanded Jetson CUDA runtime hints (`/etc/nv_tegra_release`, tegra runtime paths/tools).
- Added regression coverage for Jetson marker-based detection paths:
  - `tests/cuda-jetson-detection.test.js`

Known limitations:

- `calibrate --mode full` currently supports `--runtime ollama` only.
- Routing selection in `recommend`/`ai-run` still falls back to deterministic selection when calibrated policy is missing/invalid or when route models are unavailable.
- Calibration suite quality checks (`checks`) are optional in `dry-run` and `contract-only` modes and do not execute runtime validation.

3.2.9 — Calibrated Routing for Recommend/AI-Run (2026-02-17)
-------------------------------------------------------------

- Added calibrated routing integration to `recommend` and `ai-run`:
  - new `--calibrated [file]` option (with default discovery at `~/.llm-checker/calibration-policy.{yaml,yml,json}`).
  - `--policy` precedence over `--calibrated` for route resolution.
  - deterministic selector fallback when calibrated routing is unavailable.
- `recommend` now supports dual policy behavior:
  - enterprise governance policy (`policy.yaml`) remains supported.
  - calibration routing policy can be provided via `--policy` or `--calibrated`.
- `ai-run` now accepts calibrated routing options and can select an installed model directly from calibrated primary/fallback routes before AI selector fallback.
- Added calibrated routing provenance output (policy source + resolved task/route/selected model) to `recommend` and `ai-run`.
- Added calibration routing integration tests and fixtures:
  - `tests/calibration-routing-policy.test.js`
  - `tests/calibration-fixtures/calibration-policy-valid.yaml`
- Updated CLI smoke coverage for new `--calibrated`/`--policy` help surfaces in `recommend` and `ai-run`.
- Documentation updates:
  - README calibrated routing guide and precedence examples.
  - USAGE_GUIDE calibrated `ai-run` example.

3.2.8 — Multimodal Classification Hotfix (2026-02-17)
-----------------------------------------------------

- Fixed false multimodal recommendations caused by noisy `input_types` metadata (for example, coding models incorrectly marked as image-capable by upstream scraping noise).
- Hardened modality inference: `input_types=image` alone is no longer enough; recommendation logic now also requires explicit multimodal metadata or strong vision naming/context hints.
- Added deterministic regression coverage to ensure coding-only models are excluded from multimodal picks when metadata is ambiguous.

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
