# Ranking contract validation

The September 2026 ranking audit identified eight paths that could produce an
incorrect recommendation. These fixes apply to the deterministic selector,
registry recommendations, and the desktop source now tracked in this repository.

| Case | Corrected behavior | Regression coverage |
| --- | --- | --- |
| Artifact precision and size | FP16/BF16/FP32 retain their precision. A fixed Q8 file cannot become Q5 to fit a budget. Complete shard sets contribute their combined size; incomplete sets are excluded. Unknown precision without a known size is ineligible. | `ranking-contract.test.js`, `selector-memory-sizing.test.js`, `deterministic-model-pool-check.js` |
| Model capabilities | Embeddings and rerankers are excluded from generation categories; missing capability data does not imply generation. | `ranking-contract.test.js` |
| Benchmark identity | Base, Instruct, size, revision, thinking, and context-extension variants remain distinct. Unsized family measurements cannot score a smaller checkpoint. Quantized repos require an explicit quantization alias to inherit upstream measurements. | `quality-evals.test.js`, `ranking-contract.test.js` |
| Accelerator scoring | ROCm, Vulkan and SYCL have explicit estimate profiles. CPU-only mode suppresses accelerator scoring. | `ranking-contract.test.js`, `cpu-only-mode.test.js` |
| Desktop memory fit | Cards use the core's budget, including shared memory. Missing size/budget is unknown. The desktop retains the scored runtime and artifact. | `desktop-core.test.js`, `desktop/test/runtimes.test.js` |
| Context | Explicit requests reject insufficient or unknown native windows. Preferred contexts report the effective window and limitations; memory and generated llama.cpp/vLLM commands use that window. | `ranking-contract.test.js` |
| Q8 quality | A zero quantization penalty stays zero for measured and estimated quality. | `ranking-contract.test.js` |
| Desktop updates | The app requires the current ranking contract, refreshes every registered benchmark source, closes database connections, invalidates cached quality data and recalculates rankings. Packaging includes the core, analyzer and CLI. | `desktop-core.test.js`, packaged application validation |

Additional artifact guards prevent an empty vLLM ranking from falling back to
Ollama files, and prevent HF filenames from becoming Ollama pull tags.

## Real execution

Validated on Linux with a Ryzen 9 9900X, 30 GB reported RAM and RTX 5070 with
12 GB VRAM. A packaged Electron 44.0.0 / Node 24.18.1 application reached ready
state and displayed all seven recommendation categories. The renderer bridge
successfully refreshed all six public sources and recalculated the ranking:
HF Open LLM (2,622 rows), LMArena (798), BigCodeBench (279), EvalPlus (428),
LiveBench (1,548), and MMMU (256).

The live benchmark snapshot now assigns Qwen2.5-7B base its own MMLU-PRO score
43.6503, and Qwen2.5-7B-Instruct its own 42.8690. The Instruct-1M context
extension's 35.0482 score is separate. DeepSeek-R1 at 14B does not inherit the
unsized R1-0528 result.

Generated download/run commands completed real CPU inference with
`ggml-org/models/tinyllamas/stories260K.gguf` under llama.cpp and
`HuggingFaceTB/SmolLM2-135M` under Transformers 5.16.1 / Torch 2.14.0.
The llama.cpp command used the requested 512-token context.

The shared-memory example (26 GB RAM, 0.25 GB GPU aperture, 13 GB effective
memory) and AMD/ROCm/Vulkan/SYCL cases use controlled hardware inputs. They
verify classification logic, not physical performance on those accelerators.
Memory and speed predictions remain estimates; this validation does not claim
that every catalog model or runtime build has been physically benchmarked.

The full root suite includes 65 test files. Quality ingestion and matching run
against native SQLite and WASM; the desktop bridge and ranking contract were
also exercised on Node 18. Core production dependencies and desktop dependencies
passed `npm audit` with no reported vulnerabilities at validation time.
