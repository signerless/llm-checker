#!/bin/sh
# Build src/security/modelvet.wasm from the vendored modelvet amalgamation.
#
# modelvet is freestanding C11 (no libc, no heap), so it compiles to a
# self-contained wasm32 module with plain clang: no Emscripten runtime,
# no imports, deterministic output.
#
# Usage:
#   scripts/build-modelvet-wasm.sh           # local clang with wasm32 target
#   scripts/build-modelvet-wasm.sh --docker  # emscripten/emsdk docker image
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/modelvet"
OUT="$ROOT/src/security/modelvet.wasm"
IMAGE="emscripten/emsdk:3.1.74"

EXPORTS="--export-memory --export=mvet_heap_base --export=mvet_version \
--export=mvet_arena_bind --export=mvet_gguf_verify --export=mvet_st_verify"

build() {
    # $1 = clang command, $2/$3 = paths to the sources as seen by that clang
    "$1" --target=wasm32 -O2 -std=c11 -nostdlib -ffreestanding -fno-builtin \
        -Wall -Wextra -Werror -Wconversion -Wshadow \
        -I"$(dirname "$2")" \
        -Wl,--no-entry -Wl,-z,stack-size=1048576 \
        $(for e in $EXPORTS; do printf -- "-Wl,%s " "$e"; done) \
        -o "$OUT" "$2" "$3"
}

if [ "${1:-}" = "--docker" ]; then
    # The emsdk image keeps real clang under /emsdk/upstream/bin (not on PATH).
    docker run --rm -v "$ROOT:/src" -w /src "$IMAGE" \
        /emsdk/upstream/bin/clang --target=wasm32 -O2 -std=c11 -nostdlib -ffreestanding -fno-builtin \
        -Wall -Wextra -Werror -Wconversion -Wshadow \
        -Ivendor/modelvet \
        -Wl,--no-entry -Wl,-z,stack-size=1048576 \
        -Wl,--export-memory -Wl,--export=mvet_heap_base -Wl,--export=mvet_version \
        -Wl,--export=mvet_arena_bind -Wl,--export=mvet_gguf_verify -Wl,--export=mvet_st_verify \
        -o src/security/modelvet.wasm \
        vendor/modelvet/modelvet.c vendor/modelvet/wasm-shim.c
else
    build clang "$VENDOR/modelvet.c" "$VENDOR/wasm-shim.c"
fi

ls -l "$OUT"
