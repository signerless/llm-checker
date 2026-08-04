/**
 * Ollama blob resolution + modelvet gate helper.
 *
 * Maps an installed Ollama model name (e.g. "llama3.2:3b" or
 * "hf.co/user/repo:tag") to its on-disk GGUF blob path(s) by reading the
 * Ollama manifest store:
 *
 *   <root>/manifests/<ns...>/<name>/<tag>     (JSON, docker-manifest style)
 *   <root>/blobs/sha256-<hex>                 (content-addressed blobs)
 *
 * The root is $OLLAMA_MODELS when set, else ~/.ollama/models.
 *
 * Everything here is fail-soft: missing manifests, malformed JSON, or
 * absent blobs return { status: 'skipped', reason } — they never throw —
 * so verification gates can degrade gracefully on partial installs.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_HOST = 'registry.ollama.ai';
const DEFAULT_NAMESPACE = 'library';

function getModelsRoot() {
    const env = String(process.env.OLLAMA_MODELS || '').trim();
    if (env) return path.resolve(env);
    return path.join(os.homedir(), '.ollama', 'models');
}

/**
 * Split an Ollama model reference into manifest path segments, applying
 * the same defaults as the Ollama registry client:
 * "llama3.2:3b"           -> { segments: ['registry.ollama.ai', 'library', 'llama3.2'], tag: '3b' }
 * "user/llama3.2"         -> { segments: ['registry.ollama.ai', 'user', 'llama3.2'], tag: 'latest' }
 * "hf.co/user/repo:tag"   -> { segments: ['hf.co', 'user', 'repo'], tag: 'tag' }
 * A first segment containing '.', ':' or equal to 'localhost' is treated
 * as an explicit registry host (docker reference rules); a tag only counts
 * after the last slash, so registry ports ("host:5000/ns/name") parse.
 * Returns null for empty/invalid input.
 */
function parseModelName(modelName) {
    const raw = String(modelName || '').trim();
    if (!raw) return null;

    const lastSlash = raw.lastIndexOf('/');
    const colon = raw.lastIndexOf(':');
    let tag = 'latest';
    let namePart = raw;
    if (colon > lastSlash) {
        tag = raw.slice(colon + 1) || 'latest';
        namePart = raw.slice(0, colon);
    }

    const segments = namePart.split('/').filter(Boolean);
    if (segments.length === 0 || !tag) return null;

    const first = segments[0];
    const hasHost = segments.length > 1 &&
        (first.includes('.') || first.includes(':') || first === 'localhost');
    if (!hasHost) segments.unshift(DEFAULT_HOST);
    if (segments.length === 2) segments.splice(1, 0, DEFAULT_NAMESPACE);
    return { segments, tag };
}

/**
 * Resolve a model name to its GGUF blob path(s).
 * @param {string} modelName e.g. "llama3.2:3b"
 * @param {{ modelsRoot?: string }} [options] overrides $OLLAMA_MODELS when given
 * @returns {{ status: 'resolved', manifestPath: string, blobs: Array<{ digest: string, path: string, size: number }> }
 *          | { status: 'skipped', reason: string }}
 */
function resolveModelBlobs(modelName, options = {}) {
    const parsed = parseModelName(modelName);
    if (!parsed) {
        return { status: 'skipped', reason: `unparseable model name: ${modelName}` };
    }

    const root = options.modelsRoot ? path.resolve(options.modelsRoot) : getModelsRoot();
    const manifestPath = path.join(root, 'manifests', ...parsed.segments, parsed.tag);

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        const reason = error.code === 'ENOENT'
            ? `no local manifest for ${modelName}`
            : `unreadable manifest for ${modelName}: ${error.message}`;
        return { status: 'skipped', reason };
    }

    const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
    if (layers.length === 0) {
        return { status: 'skipped', reason: `manifest for ${modelName} has no layers` };
    }

    // Prefer model weights layers; fall back to the largest layer.
    let candidates = layers.filter((layer) => {
        const mediaType = String(layer && layer.mediaType || '').toLowerCase();
        return mediaType.includes('model') || mediaType.includes('gguf');
    });
    if (candidates.length === 0) {
        const largest = layers.reduce((best, layer) =>
            (layer && layer.size || 0) > (best && best.size || 0) ? layer : best, layers[0]);
        candidates = largest ? [largest] : [];
    }

    const blobs = [];
    for (const layer of candidates) {
        const digest = String(layer && layer.digest || '');
        const match = digest.match(/^sha256:([0-9a-fA-F]{64})$/);
        if (!match) {
            return { status: 'skipped', reason: `manifest for ${modelName} has no sha256 model layer digest` };
        }
        const blobPath = path.join(root, 'blobs', `sha256-${match[1].toLowerCase()}`);
        if (!fs.existsSync(blobPath)) {
            return { status: 'skipped', reason: `blob file missing on disk: ${blobPath}` };
        }
        blobs.push({ digest, path: blobPath, size: layer.size || 0 });
    }

    return { status: 'resolved', manifestPath, blobs };
}

/**
 * Resolve and structurally verify an installed Ollama model's blob(s)
 * with the modelvet WASM verifier.
 *
 * Result statuses:
 *   'verified' — every model blob ACCEPTed (structural only; no
 *                provenance / poisoned-weights guarantee).
 *   'rejected' — a blob was REJECTED; `report` carries the violation.
 *   'skipped'  — could not verify (missing manifest/blob, verifier error
 *                such as MODELVET_FILE_TOO_LARGE or MODELVET_WASM_MISSING);
 *                `reason` (and `code` when available) explains why.
 *
 * @param {string} modelName
 * @returns {Promise<object>}
 */
async function verifyOllamaModel(modelName, options = {}) {
    const resolved = resolveModelBlobs(modelName, options);
    if (resolved.status !== 'resolved') return resolved;

    const modelvet = require('./modelvet-verifier');
    const reports = [];
    for (const blob of resolved.blobs) {
        let report;
        try {
            report = await modelvet.verifyFile(blob.path);
        } catch (error) {
            return {
                status: 'skipped',
                reason: `verifier error: ${error.message}`,
                code: error.code,
                blob: blob.path
            };
        }
        report.blob = blob.path;
        reports.push(report);
        if (!report.accepted) {
            return { status: 'rejected', report, blob: blob.path, manifestPath: resolved.manifestPath };
        }
    }

    const result = {
        status: 'verified',
        blobs: resolved.blobs.map((blob) => blob.path),
        manifestPath: resolved.manifestPath
    };
    if (reports.length === 1) {
        result.report = reports[0];
    } else {
        result.reports = reports;
    }
    return result;
}

module.exports = {
    getModelsRoot,
    parseModelName,
    resolveModelBlobs,
    verifyOllamaModel
};
