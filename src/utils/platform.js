function normalizePlatform(platform = process.platform) {
    const normalized = String(platform || process.platform).trim().toLowerCase();

    if (normalized === 'android') {
        return 'linux';
    }

    if (normalized === 'macos') {
        return 'darwin';
    }

    return normalized;
}

function isLinuxPlatform(platform = process.platform) {
    return normalizePlatform(platform) === 'linux';
}

function isWindowsPlatform(platform = process.platform) {
    return normalizePlatform(platform) === 'win32';
}

function isDarwinPlatform(platform = process.platform) {
    return normalizePlatform(platform) === 'darwin';
}

function isTermuxEnvironment(platform = process.platform, env = process.env) {
    if (String(platform || process.platform).trim().toLowerCase() === 'android') {
        return true;
    }

    const prefix = String(env?.PREFIX || '');
    const termuxVersion = String(env?.TERMUX_VERSION || '');

    return prefix.includes('com.termux') || termuxVersion.length > 0;
}

module.exports = {
    normalizePlatform,
    isLinuxPlatform,
    isWindowsPlatform,
    isDarwinPlatform,
    isTermuxEnvironment
};
