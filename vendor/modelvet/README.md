# modelvet (vendored)

Structural safety validator for GGUF and safetensors model files,
vendored from https://github.com/tetsuo-ai/modelvet (MIT license,
copyright (c) 2026 AgenC).

- Pinned upstream commit: `748ac72c3c040ba097d6d3ff70fb520c776e17cb` (v0.1.0, pre-release)
- `modelvet.c` / `modelvet.h`: upstream amalgamation (`make amalgamation`), unmodified
- `wasm-shim.c`: llm-checker addition; exports the heap base so the JS host
  can manage WASM linear memory without a libc

## Rebuilding the WASM artifact

Requires clang with the wasm32 target (Emscripten SDK, wasi-sdk, or a
recent LLVM with the WebAssembly backend). From the repository root:

```sh
scripts/build-modelvet-wasm.sh            # uses local clang if available
scripts/build-modelvet-wasm.sh --docker   # uses the emscripten/emsdk docker image
```

The output is `src/security/modelvet.wasm`, which is shipped in the npm
package and loaded lazily by `src/security/modelvet-verifier.js`.

To re-vendor from a newer upstream commit:

```sh
git clone https://github.com/tetsuo-ai/modelvet /tmp/modelvet
cd /tmp/modelvet && make amalgamation
cp build/modelvet.c build/modelvet.h <this-directory>/
# update the pinned commit above, then rebuild the wasm
```
