/**
 * Structural validation support for the policy layer.
 *
 * Resolves policy candidates to local model files (Ollama manifest -> blob
 * resolution, or explicit local path fields) and attaches a deterministic
 * `verification` object to each candidate by running the modelvet WASM
 * structural verifier (src/security/modelvet-verifier.js).
 *
 * Blob resolution delegates to the shared helper in
 * src/security/ollama-blobs.js (Ollama registry defaults included).
 *
 * Verification result shapes (append-only contract, consumed by the audit
 * reporters; fields use explicit values instead of being omitted):
 *
 *   accept/reject: { verdict, violation_code, violation_name, offset }
 *   otherwise:     { verdict: 'not_applicable'|'error', reason }
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const defaultVerifier = require('../security/modelvet-verifier');
const { resolveModelBlobs } = require('../security/ollama-blobs');

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNonEmptyString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function getOllamaModelsDir(env = process.env) {
    const configured = toNonEmptyString(env && env.OLLAMA_MODELS);
    if (configured) return path.resolve(configured);
    return path.join(os.homedir(), '.ollama', 'models');
}

function getModelIdentifiers(model) {
    if (!isPlainObject(model)) return [];

    const candidates = [
        model.model_identifier,
        model.modelIdentifier,
        model.identifier,
        model.tag,
        model.model_id,
        model.modelId,
        model.name,
        model.model_name
    ]
        .map(toNonEmptyString)
        .filter(Boolean);

    return Array.from(new Set(candidates));
}

/**
 * Resolve an Ollama model reference to its local blob file via the shared
 * resolver (src/security/ollama-blobs.js). Returns the blob path when the
 * manifest and blob both exist, else null.
 */
function resolveOllamaBlobPath(identifier, options = {}) {
    const env = options.env || process.env;
    const modelsRoot = options.modelsDir
        || (toNonEmptyString(env.OLLAMA_MODELS) ? getOllamaModelsDir(env) : undefined);
    const resolved = resolveModelBlobs(identifier, modelsRoot ? { modelsRoot } : {});
    if (resolved.status !== 'resolved' || resolved.blobs.length === 0) return null;
    return resolved.blobs[0].path;
}

function resolveExplicitFilePath(model) {
    if (!isPlainObject(model)) return null;

    const explicit = [
        model.file_path,
        model.filePath,
        model.local_path,
        model.localPath,
        model.model_file,
        model.modelFile,
        model.path
    ]
        .map(toNonEmptyString)
        .filter(Boolean);

    for (const candidate of explicit) {
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
            // Not a readable file; keep looking.
        }
    }

    return null;
}

/**
 * Resolve a policy candidate to a local model file, or null when the
 * candidate is catalog-only (no local artifact to verify).
 */
function resolveModelFile(model, options = {}) {
    const explicit = resolveExplicitFilePath(model);
    if (explicit) return explicit;

    const identifiers = getModelIdentifiers(model);
    for (const identifier of identifiers) {
        const blobPath = resolveOllamaBlobPath(identifier, options);
        if (blobPath) return blobPath;
    }

    return null;
}

function toVerificationFromReport(report) {
    return {
        verdict: report && report.accepted ? 'accept' : 'reject',
        violation_code: report && Number.isInteger(report.violation) ? report.violation : 'unknown',
        violation_name: toNonEmptyString(report && report.violationName) || 'unknown',
        offset: report && Number.isFinite(report.offset) ? report.offset : 'unknown'
    };
}

function toVerificationFromError(error) {
    const code = toNonEmptyString(error && error.code);
    const message = toNonEmptyString(error && error.message) || 'verification failed';
    return {
        verdict: 'error',
        reason: code ? `[${code}] ${message}` : message
    };
}

/**
 * Attach a `verification` object to every candidate. Verification is lazy
 * and cached per resolved file path, so each file is verified at most once
 * per call (one CLI run performs a single call).
 *
 * @param {Array<object>} models policy candidates
 * @param {object} [options]
 * @param {object} [options.env] environment overrides (OLLAMA_MODELS, HOME)
 * @param {object} [options.verifier] verifier module (defaults to modelvet)
 * @returns {Promise<Array<object>>} new array; inputs are not mutated
 */
async function attachStructuralVerification(models, options = {}) {
    const list = Array.isArray(models) ? models : [];
    const verifier = options.verifier || defaultVerifier;
    const cache = new Map();

    const verifyCached = (filePath) => {
        if (!cache.has(filePath)) {
            cache.set(
                filePath,
                Promise.resolve()
                    .then(() => verifier.verifyFile(filePath))
                    .then(toVerificationFromReport, toVerificationFromError)
            );
        }
        return cache.get(filePath);
    };

    const attached = await Promise.all(
        list.map(async (model) => {
            if (!isPlainObject(model)) return model;

            const filePath = resolveModelFile(model, options);
            const verification = filePath
                ? await verifyCached(filePath)
                : {
                      verdict: 'not_applicable',
                      reason: 'no local model file resolved (catalog-only candidate)'
                  };

            return { ...model, verification };
        })
    );

    return attached;
}

module.exports = {
    attachStructuralVerification,
    resolveModelFile,
    resolveOllamaBlobPath,
    getOllamaModelsDir
};
