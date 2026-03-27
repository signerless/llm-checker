let nodeFetchPromise = null;

function getNodeFetch() {
    if (!nodeFetchPromise) {
        nodeFetchPromise = import('node-fetch').then((mod) => mod.default || mod);
    }
    return nodeFetchPromise;
}

function isNodeNativeFetch(fetchImpl) {
    if (typeof fetchImpl !== 'function' || process.release?.name !== 'node') {
        return false;
    }

    const source = Function.prototype.toString.call(fetchImpl);
    return (
        source.includes('internal/deps/undici/undici') ||
        source.includes('lazy loading of undici module') ||
        source.includes('[native code]')
    );
}

function isRetryableNativeFetchError(error) {
    const details = [
        error?.message,
        error?.code,
        error?.errno,
        error?.cause?.message,
        error?.cause?.code,
        error?.cause?.errno
    ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase())
        .join(' ');

    return (
        details.includes('fetch failed') ||
        details.includes('econnrefused') ||
        details.includes('econnreset') ||
        details.includes('enotfound') ||
        details.includes('eai_again') ||
        details.includes('etimedout') ||
        details.includes('timed out') ||
        details.includes('enetunreach') ||
        details.includes('ehostunreach') ||
        details.includes('network') ||
        details.includes('socket') ||
        details.includes('connect')
    );
}

async function fetchWithFallback(...args) {
    if (typeof globalThis.fetch === 'function') {
        if (!isNodeNativeFetch(globalThis.fetch)) {
            return globalThis.fetch(...args);
        }

        try {
            return await globalThis.fetch(...args);
        } catch (error) {
            if (!isRetryableNativeFetchError(error)) {
                throw error;
            }

            const fetchImpl = await getNodeFetch();
            return fetchImpl(...args);
        }
    }

    const fetchImpl = await getNodeFetch();
    return fetchImpl(...args);
}

module.exports = fetchWithFallback;
