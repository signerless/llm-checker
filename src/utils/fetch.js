let nodeFetchPromise = null;

function getNodeFetch() {
    if (!nodeFetchPromise) {
        nodeFetchPromise = import('node-fetch').then((mod) => mod.default || mod);
    }
    return nodeFetchPromise;
}

function fetchWithFallback(...args) {
    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch(...args);
    }
    return getNodeFetch().then((fetchImpl) => fetchImpl(...args));
}

module.exports = fetchWithFallback;
