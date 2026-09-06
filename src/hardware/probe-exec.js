/**
 * Async hardware probe runner.
 * Independent detectors overlap via Promise.all when they use execFile
 * instead of blocking execSync/spawnSync.
 */

const { execFile, exec } = require('child_process');

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

function execFileAsync(file, args = [], options = {}) {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    return new Promise((resolve, reject) => {
        execFile(file, args, {
            encoding: options.encoding || 'utf8',
            timeout,
            maxBuffer: options.maxBuffer || DEFAULT_MAX_BUFFER,
            windowsHide: true,
            env: options.env,
            cwd: options.cwd
        }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

function execShellAsync(command, options = {}) {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    return new Promise((resolve, reject) => {
        exec(command, {
            encoding: options.encoding || 'utf8',
            timeout,
            maxBuffer: options.maxBuffer || DEFAULT_MAX_BUFFER,
            windowsHide: true,
            env: options.env,
            cwd: options.cwd
        }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

function needsShell(command) {
    return /[|<>;&`$(){}]/.test(command);
}

function splitArgs(command) {
    const parts = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current) {
                parts.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (current) parts.push(current);
    return parts;
}

async function execCommandAsync(command, options = {}) {
    const cmd = String(command).trim();
    if (!cmd) {
        throw new Error('Empty command');
    }
    if (options.shell || needsShell(cmd)) {
        return execShellAsync(cmd, options);
    }
    const parts = splitArgs(cmd);
    return execFileAsync(parts[0], parts.slice(1), options);
}

function filterLspciDisplayLines(output) {
    return String(output || '')
        .split('\n')
        .filter((line) => /VGA|3D|Display/i.test(line))
        .join('\n');
}

module.exports = {
    execFileAsync,
    execCommandAsync,
    filterLspciDisplayLines
};
