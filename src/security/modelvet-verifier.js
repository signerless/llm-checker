/**
 * modelvet WASM verifier.
 *
 * Lazily loads the vendored modelvet build (src/security/modelvet.wasm,
 * compiled from the freestanding C11 amalgamation in vendor/modelvet/)
 * and verifies GGUF / safetensors files structurally, before any model
 * loader touches them.
 *
 * An "accept" verdict is structural only: it says nothing about model
 * behavior, provenance, or poisoned weights.
 *
 * The wasm module is -nostdlib with no imports; this host manages its
 * linear memory directly:
 *
 *   heap + 0    mvet_report_t   (32 bytes, written by the library)
 *   heap + 32   mvet_arena_t    (12 bytes on wasm32)
 *   heap + 64   arena storage   (ARENA_CAPACITY bytes)
 *   heap + ...  input file bytes (16-byte aligned)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const WASM_PATH = path.join(__dirname, 'modelvet.wasm');

const WASM_PAGE = 65536;
const REPORT_OFFSET = 0;
const ARENA_STRUCT_OFFSET = 32;
const ARENA_STORAGE_OFFSET = 64;
/* Above the wasm32 worst-case demand (the 64-bit worst case is 278,551
 * bytes and size_t halves on wasm32), with generous margin. */
const ARENA_CAPACITY = 1024 * 1024;

/* wasm32 linear memory cannot address a larger whole-file buffer. Files
 * above this limit need the native modelvet CLI instead. */
const MAX_FILE_BYTES = 3 * 1024 * 1024 * 1024;

/* Violation codes are append-only ABI upstream; names mirror modelvet.h. */
const VIOLATION_NAMES = {
    0: 'NONE',
    1: 'TRUNCATED',
    100: 'MAGIC',
    101: 'VERSION_UNSUPPORTED',
    102: 'VERSION_LEGACY',
    103: 'VERSION_ENDIAN',
    110: 'TENSOR_COUNT_RANGE',
    111: 'KV_COUNT_RANGE',
    200: 'KEY_EMPTY',
    201: 'KEY_LEN_CAP',
    202: 'KEY_UTF8',
    203: 'KEY_DUPLICATE',
    204: 'KV_TYPE_RANGE',
    205: 'KV_ARRAY_TYPE_RANGE',
    206: 'KV_ARRAY_NESTED',
    207: 'KV_ARRAY_ELEMS_CAP',
    208: 'KV_BOOL_BYTE',
    209: 'KV_TOTAL_BYTES_CAP',
    210: 'STR_LEN_CAP',
    211: 'STR_UTF8',
    220: 'ALIGN_TYPE',
    221: 'ALIGN_VALUE',
    300: 'NAME_LEN',
    301: 'NAME_UTF8',
    302: 'NAME_DUPLICATE',
    303: 'TENSOR_DIMS_CAP',
    304: 'TENSOR_NE_RANGE',
    305: 'TENSOR_NE_OVERFLOW',
    306: 'TENSOR_DTYPE_RANGE',
    307: 'TENSOR_DTYPE_UNSUPPORTED',
    308: 'TENSOR_BLOCK_DIVISIBILITY',
    309: 'TENSOR_OFFSET_MISMATCH',
    310: 'TENSOR_SIZE_OVERFLOW',
    311: 'TENSOR_DATA_EXTENT',
    400: 'TRAILING_BYTES',
    500: 'ST_HEADER_LEN_CAP',
    510: 'ST_JSON_SYNTAX',
    511: 'ST_STR_UTF8',
    512: 'ST_STR_ESCAPE',
    513: 'ST_KEY_ESCAPE',
    514: 'ST_NUMBER',
    515: 'ST_NAME_LEN',
    516: 'ST_KEY_DUPLICATE',
    520: 'ST_TENSOR_COUNT_CAP',
    521: 'ST_METADATA_COUNT_CAP',
    530: 'ST_TENSOR_FIELDS',
    531: 'ST_DTYPE_UNKNOWN',
    532: 'ST_OFFSETS_ARITY',
    540: 'ST_OFFSET_ORDER',
    541: 'ST_SIZE_OVERFLOW',
    542: 'ST_SIZE_MISALIGNED',
    543: 'ST_SIZE_MISMATCH',
    544: 'ST_OFFSET_CONTIGUITY',
    545: 'ST_DATA_EXTENT'
};

let instancePromise = null;

function isAvailable() {
    return fs.existsSync(WASM_PATH);
}

function unavailableError() {
    const err = new Error(
        'modelvet WASM artifact not found (src/security/modelvet.wasm). ' +
        'Rebuild it with: scripts/build-modelvet-wasm.sh --docker'
    );
    err.code = 'MODELVET_WASM_MISSING';
    return err;
}

async function load() {
    if (!isAvailable()) throw unavailableError();
    if (!instancePromise) {
        const bytes = fs.readFileSync(WASM_PATH);
        instancePromise = WebAssembly.instantiate(bytes, {}).then(({ instance }) => instance);
    }
    return instancePromise;
}

function align16(n) {
    return (n + 15) & ~15;
}

function detectFormat(buf) {
    if (buf.length >= 4 && buf.readUInt32LE(0) === 0x46554747) return 'gguf'; // 'GGUF'
    return 'safetensors';
}

/**
 * Verify a whole file already loaded in a Buffer.
 * @param {Buffer} buf
 * @param {'gguf'|'safetensors'|'auto'} [format]
 * @returns {Promise<object>} verification report
 */
async function verifyBuffer(buf, format = 'auto') {
    if (!Buffer.isBuffer(buf)) {
        throw new TypeError('verifyBuffer expects a Buffer');
    }
    if (buf.length > MAX_FILE_BYTES) {
        const err = new Error(
            `File is ${(buf.length / 1024 / 1024 / 1024).toFixed(2)} GiB; the WASM verifier ` +
            'is limited to 3 GiB (wasm32 memory). Use the native modelvet CLI for larger files.'
        );
        err.code = 'MODELVET_FILE_TOO_LARGE';
        throw err;
    }

    const instance = await load();
    const ex = instance.exports;
    const memory = ex.memory;

    const heap = ex.mvet_heap_base() >>> 0;
    const reportPtr = heap + REPORT_OFFSET;
    const arenaStructPtr = heap + ARENA_STRUCT_OFFSET;
    const arenaStoragePtr = heap + ARENA_STORAGE_OFFSET;
    const inputPtr = align16(heap + ARENA_STORAGE_OFFSET + ARENA_CAPACITY);
    const needed = inputPtr + Math.max(buf.length, 1);

    if (memory.buffer.byteLength < needed) {
        const pages = Math.ceil((needed - memory.buffer.byteLength) / WASM_PAGE);
        memory.grow(pages);
    }

    // Views must be created after any memory.grow().
    const view = new DataView(memory.buffer);
    new Uint8Array(memory.buffer, inputPtr, buf.length).set(buf);

    const bindStatus = ex.mvet_arena_bind(arenaStructPtr, arenaStoragePtr, ARENA_CAPACITY);
    if (bindStatus !== 0) {
        const err = new Error(`modelvet arena bind failed (status ${bindStatus})`);
        err.code = 'MODELVET_ARENA';
        throw err;
    }

    const resolved = format === 'auto' ? detectFormat(buf) : format;
    const verify = resolved === 'gguf' ? ex.mvet_gguf_verify : ex.mvet_st_verify;
    const status = verify(reportPtr, arenaStructPtr, inputPtr, buf.length);

    if (status === -1) {
        const err = new Error('modelvet rejected the verifier arguments (MVET_ERR_ARG)');
        err.code = 'MODELVET_ARG';
        throw err;
    }
    if (status === -2) {
        const err = new Error(
            'modelvet arena exhausted: input counts exceed configured caps for the 1 MiB arena'
        );
        err.code = 'MODELVET_ARENA';
        throw err;
    }
    if (status !== 0) {
        const err = new Error(`modelvet verify failed (status ${status})`);
        err.code = 'MODELVET_STATUS';
        throw err;
    }

    const verdict = view.getUint32(reportPtr, true);
    const violation = view.getUint32(reportPtr + 4, true);
    const accepted = verdict === 1;

    return {
        format: resolved,
        verdict: accepted ? 'accept' : 'reject',
        accepted,
        violation,
        violationName: VIOLATION_NAMES[violation] || `UNKNOWN_${violation}`,
        offset: Number(view.getBigUint64(reportPtr + 8, true)),
        detail: [
            Number(view.getBigUint64(reportPtr + 16, true)),
            Number(view.getBigUint64(reportPtr + 24, true))
        ],
        arenaUsed: view.getUint32(arenaStructPtr + 8, true),
        modelvetVersion: ex.mvet_version() >>> 0
    };
}

/**
 * Verify a model file on disk (GGUF or safetensors, detected by content).
 * @param {string} filePath
 * @returns {Promise<object>} verification report, plus `file` and `sizeBytes`
 */
async function verifyFile(filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Not a regular file: ${filePath}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
        const err = new Error(
            `File is ${(stat.size / 1024 / 1024 / 1024).toFixed(2)} GiB; the WASM verifier ` +
            'is limited to 3 GiB (wasm32 memory). Use the native modelvet CLI for larger files.'
        );
        err.code = 'MODELVET_FILE_TOO_LARGE';
        throw err;
    }
    const buf = fs.readFileSync(filePath);
    const report = await verifyBuffer(buf, 'auto');
    report.file = filePath;
    report.sizeBytes = stat.size;
    return report;
}

module.exports = {
    isAvailable,
    verifyBuffer,
    verifyFile,
    VIOLATION_NAMES,
    MAX_FILE_BYTES,
    WASM_PATH
};
