# LLM Checker desktop

Electron interface for the model ranking core in this repository. Keep the core
and desktop on the same checkout; the desktop requires ranking contract version 1.

From the repository root:

```sh
npm ci
npm ci --prefix desktop
npm start --prefix desktop
npm test
npm run pack --prefix desktop
```

The main process runs hardware analysis and runtime probes. The renderer receives
structured results through an isolated preload bridge. It can copy installation
commands, inspect local runtimes, refresh the catalog and update benchmarks.

## Ranking and compatibility

Cards retain the exact artifact, precision and runtime selected by the core.
Memory includes weights, estimated KV cache at the effective context, and runtime
overhead. The budget comes from the core, including shared/unified memory and
CPU-only mode. Missing memory data is marked unknown. A preferred context that
exceeds the known window is displayed as limited; an explicitly required context
is enforced by the selector.

Quality chips distinguish checkpoint measurements from parameter-based estimates.
Benchmark matching preserves base/Instruct, revision, context-extension and size
variants. Quantized copies need a verified quantization alias to borrow an
upstream checkpoint's measurements. Family coverage is reported separately from
exact checkpoint coverage.

The benchmark action uses all sources registered in `src/data/quality-evals.js`:
HF Open LLM, LMArena, BigCodeBench, EvalPlus, LiveBench and MMMU. Individual source
failures are shown and leave cached rows intact. Updates and scans are serialized;
the ranking is recalculated after updates.

Speed and memory values are estimates unless explicitly backed by a measurement.
Runtime installation and hardware compatibility do not establish measured speed.

## Packaging

`electron-builder.yml` includes this checkout's core source, CLI entry points and
dependencies under `resources/core`. The desktop interface lives in `app.asar`.
SQLite seed data remains outside the archive. The packaged CLI runs Electron in
Node mode for catalog refreshes.

Local development and packaged builds use the same ranking contract. Linux,
macOS and Windows packaging targets are configured; validation performed for a
change is recorded in its PR. Tests for the bridge and runtime registry run from
the root suite without installing Electron.

The bundled Inter font uses the SIL Open Font License; see
`src/renderer/assets/Inter-LICENSE.txt`.
