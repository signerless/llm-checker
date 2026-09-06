'use strict';

/**
 * Unified runtime registry for the desktop app.
 *
 * The CLI advertises `auto|ollama|vllm|mlx|llama.cpp|transformers` on several
 * commands, but src/runtime/runtime-support.js only knows about three of them
 * (`ollama`, `vllm`, `mlx`) and silently normalises everything else to
 * `ollama`. That is fine for the registry/recommender path — which does model
 * llama.cpp and transformers — but it means install/pull/run commands come out
 * wrong for GGUF and safetensors workflows.
 *
 * This module is the single source of truth for the desktop app: every runtime
 * the catalog can target, how to detect it, and how to install/pull/run with
 * it. Detection is async and runs in parallel; nothing here blocks the event
 * loop the way the CLI's 40 spawnSync call sites do.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const PROBE_TIMEOUT_MS = 2500;
const HTTP_TIMEOUT_MS = 1200;

/**
 * Run a command without blocking; resolve to null instead of throwing.
 *
 * Two rules learned the hard way from probing these runtimes for real:
 *
 * - Exit code is NOT the success signal. `llama-quantize --help` exits 1 with
 *   perfectly good output; `ollama --version` exits 0 while printing warnings
 *   that mean the server is down. Callers pass `expectNonZero` and always get
 *   whatever was written.
 * - Some tools write everything to stderr (`llama-cli --version` emits zero
 *   bytes on stdout), so both streams are merged.
 */
function probe(cmd, args, { timeout = PROBE_TIMEOUT_MS, expectNonZero = false } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const child = execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
            // ENOENT / timeout / signal → genuinely nothing to read.
            if (err && !expectNonZero && !out) return finish(null);
            if (err && err.code === 'ENOENT') return finish(null);
            finish(out || null);
        });
        child.on('error', () => finish(null));
    });
}

/** Absolute path under the user's home. Never build these with a literal '~':
 *  execFile does not run a shell, so the tilde stays literal and every probe
 *  using it silently fails. */
const home = (...parts) => path.join(os.homedir(), ...parts);

/**
 * Find a binary without trusting PATH.
 *
 * An Electron app launched from a .desktop entry does not source ~/.profile,
 * so ~/.local/bin — where ollama, lms, llama-cli and the python shim all live
 * on this machine — is simply absent. Verified: with a login-shell PATH,
 * `lms` resolves; with a desktop-launcher PATH it is "not found". So every CLI
 * probe resolves an absolute path first and spawns that.
 */
const BIN_DIRS = [
    home('.local', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    '/usr/local/sbin',
    ...String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
];

const binCache = new Map();
function resolveBin(name) {
    if (binCache.has(name)) return binCache.get(name);
    let found = null;
    for (const dir of BIN_DIRS) {
        const p = path.join(dir, name);
        try {
            fs.accessSync(p, fs.constants.X_OK);
            found = p;
            break;
        } catch { /* keep looking */ }
    }
    binCache.set(name, found);
    return found;
}

/** probe() against a resolved absolute path; null when the binary is absent. */
async function probeBin(name, args, opts) {
    const bin = resolveBin(name);
    if (!bin) return null;
    return probe(bin, args, opts);
}

/** Recursive directory size in bytes, with a work cap so a huge tree cannot
 *  stall the probe. Returns { bytes, capped }. */
async function dirSize(dir, { maxEntries = 20000 } = {}) {
    let bytes = 0;
    let seen = 0;
    let capped = false;
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try {
            entries = await fsp.readdir(cur, { withFileTypes: true });
        } catch { continue; }
        for (const e of entries) {
            if (++seen > maxEntries) { capped = true; stack.length = 0; break; }
            const full = path.join(cur, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.isFile()) {
                try { bytes += (await fsp.stat(full)).size; } catch { /* vanished */ }
            }
        }
    }
    return { bytes, capped };
}

/** Whitelisted env reporting. Tokens are reported as a boolean and never by
 *  value — one probe draft would have printed HF_TOKEN verbatim into JSON the
 *  app parses and logs. */
const ENV_SAFE = [
    'OLLAMA_HOST', 'OLLAMA_MODELS', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_CONTEXT_LENGTH',
    'OLLAMA_NUM_PARALLEL', 'OLLAMA_MAX_LOADED_MODELS', 'OLLAMA_KV_CACHE_TYPE',
    'CUDA_VISIBLE_DEVICES', 'HF_HOME', 'HF_HUB_CACHE', 'HF_HUB_OFFLINE',
];
const ENV_SECRET = ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'OPENAI_API_KEY'];

function safeEnvRows() {
    const rows = [];
    for (const k of ENV_SAFE) {
        if (process.env[k]) rows.push({ label: k, value: process.env[k] });
    }
    for (const k of ENV_SECRET) {
        if (process.env[k]) rows.push({ label: k, value: 'set (value hidden)' });
    }
    return rows;
}

/** LM Studio reports vision capability differently in its two APIs; check both
 *  shapes rather than assuming either. */
const extraHasVision = (entry) =>
    Boolean(entry?.vision ?? entry?.visionCapable ?? entry?.capabilities?.includes?.('vision'));

const fmtBytes = (n) => {
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')} GB`;
    if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
    return `${Math.round(n / 1e3)} KB`;
};

/** GET a local endpoint with a short deadline. Resolves to parsed JSON or null. */
async function probeHttp(url, { timeout = HTTP_TIMEOUT_MS } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function pythonCandidates() {
    return process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
}

/** Try `import <mod>` across the available python binaries.
 *  Cold imports of heavy libs (transformers ~3-5 s) far exceed the default
 *  probe timeout, so these get their own budget. */
async function probePythonModule(mod, versionExpr = `${mod}.__version__`) {
    for (const py of pythonCandidates()) {
        const bin = resolveBin(py) ?? py;
        const out = await probe(bin, ['-c', `import ${mod}; print(${versionExpr})`], { timeout: 10000 });
        if (out) return { version: out.split('\n').pop().trim(), python: bin };
    }
    return null;
}

/**
 * Package version WITHOUT importing it.
 *
 * `import vllm` costs ~2.7 s and `import transformers` ~4 s, which is far too
 * much for a probe that runs on every scan. Reading the installed distribution
 * metadata answers the same question in a fraction of that, and it exits
 * non-zero when the package is absent — which is a finding, not an error.
 */
async function probePythonMeta(dist) {
    for (const py of pythonCandidates()) {
        const bin = resolveBin(py) ?? py;
        const out = await probe(
            bin,
            ['-c', `import importlib.metadata as m;print(m.version(${JSON.stringify(dist)}))`],
            { timeout: 6000, expectNonZero: true }
        );
        const ver = out && out.match(/^\s*(\d[\w.+-]*)\s*$/m);
        if (ver) return { version: ver[1], python: bin };
    }
    return null;
}

/** One cheap torch query for the GPU facts both vLLM and Transformers need. */
async function probeTorchCuda() {
    const code = [
        'import json',
        'try:',
        '    import torch',
        '    a = torch.cuda.is_available()',
        '    d = {"torch": torch.__version__, "cudaAvailable": a}',
        '    if a:',
        '        d["deviceName"] = torch.cuda.get_device_name(0)',
        '        cc = torch.cuda.get_device_capability(0)',
        '        d["capability"] = f"sm_{cc[0]}{cc[1]}"',
        '        free, total = torch.cuda.mem_get_info(0)',
        '        d["freeMiB"] = free // (1024*1024)',
        '        d["totalMiB"] = total // (1024*1024)',
        '        d["bf16"] = torch.cuda.is_bf16_supported()',
        '    print(json.dumps(d))',
        'except Exception as e:',
        '    print(json.dumps({"error": type(e).__name__}))',
    ].join('\n');
    for (const py of pythonCandidates()) {
        const bin = resolveBin(py) ?? py;
        const out = await probe(bin, ['-c', code], { timeout: 12000, expectNonZero: true });
        if (!out) continue;
        try {
            const parsed = JSON.parse(out.split('\n').filter(Boolean).pop());
            if (!parsed.error) return parsed;
        } catch { /* try the next interpreter */ }
    }
    return null;
}

const isAppleSilicon = () => process.platform === 'darwin' && process.arch === 'arm64';
const isWin = () => process.platform === 'win32';

/**
 * Every runtime is declared once. `formats` drives which catalog artifacts can
 * actually run under it; `supported(hw)` gates it against this machine.
 */
const RUNTIMES = [
    {
        id: 'ollama',
        name: 'Ollama',
        blurb: 'Easiest local runner. One command per model.',
        formats: ['ollama', 'gguf'],
        endpoint: 'http://127.0.0.1:11434',
        supported: () => true,
        install: () =>
            process.platform === 'darwin' ? 'brew install ollama'
                : isWin() ? 'winget install Ollama.Ollama'
                    : 'curl -fsSL https://ollama.com/install.sh | sh',
        pull: (ref) => `ollama pull ${ref}`,
        run: (ref) => `ollama run ${ref}`,
        async detect() {
            const [version, tags] = await Promise.all([
                probeBin('ollama', ['--version']),
                probeHttp('http://127.0.0.1:11434/api/tags'),
            ]);
            if (!version && !tags) return { installed: false, serving: false };
            // `ollama --version` exits 0 even with the server down, printing
            // two Warning: lines — so the semver, not the exit code, is the tell.
            const sem = version && version.match(/(\d+\.\d+\.\d+)/);
            return {
                installed: Boolean(version) || Boolean(tags),
                serving: Boolean(tags),
                version: sem ? sem[1] : null,
                models: Array.isArray(tags?.models)
                    ? tags.models.map((m) => ({
                        ref: m.name,
                        sizeBytes: m.size ?? null,
                        quant: m.details?.quantization_level ?? null,
                        params: m.details?.parameter_size ?? null,
                        family: m.details?.family ?? null,
                        contextLength: m.details?.context_length ?? null,
                        capabilities: m.capabilities ?? [],
                    }))
                    : [],
            };
        },

        async probeDetails({ state }) {
            const modelsDir = process.env.OLLAMA_MODELS || home('.ollama', 'models');
            const [ps, disk, backends] = await Promise.all([
                // What is resident in VRAM right now, as opposed to merely downloaded.
                probeHttp('http://127.0.0.1:11434/api/ps'),
                dirSize(modelsDir),
                // Which accelerators this build actually shipped with.
                (async () => {
                    const roots = [
                        home('.local', 'ollama-dist', 'lib', 'ollama'),
                        '/usr/local/lib/ollama', '/usr/lib/ollama',
                        home('.local', 'lib', 'ollama'),
                    ];
                    for (const r of roots) {
                        try {
                            const names = await fsp.readdir(r);
                            const gpu = names.filter((n) => /cuda|rocm|hip|vulkan|metal/i.test(n));
                            const cpu = names.filter((n) => /^libggml-cpu-/.test(n)).length;
                            return { root: r, gpu, cpu };
                        } catch { /* next candidate */ }
                    }
                    return null;
                })(),
            ]);

            const loaded = Array.isArray(ps?.models) ? ps.models : [];
            const loadedNames = new Set(loaded.map((m) => m.name));
            const models = (state.models ?? []).map((m) => ({ ...m, loaded: loadedNames.has(m.ref) }));

            const sections = [];

            sections.push({
                id: 'capability', title: 'What it can do',
                emptyState: 'Start the server to read its capabilities.',
                rows: [
                    backends?.gpu?.length
                        ? { label: 'GPU backends in this build', value: backends.gpu.join(', ') }
                        : { label: 'GPU backends in this build', value: 'none found' },
                    backends?.cpu
                        ? { label: 'CPU kernels shipped', value: `${backends.cpu} microarchitectures` }
                        : null,
                    { label: 'OpenAI-compatible API', value: `${'http://127.0.0.1:11434'}/v1` },
                ].filter(Boolean),
            });

            sections.push({
                id: 'storage', title: 'Storage',
                emptyState: 'No model directory found.',
                rows: [
                    { label: 'Models directory', value: modelsDir },
                    disk.bytes
                        ? { label: 'Disk used by models', value: fmtBytes(disk.bytes) + (disk.capped ? ' (partial)' : '') }
                        : null,
                ].filter(Boolean),
            });

            const envRows = safeEnvRows().filter((r) => r.label.startsWith('OLLAMA_'));
            sections.push({
                id: 'config', title: 'Configuration',
                emptyState: 'No OLLAMA_* overrides set — all defaults.',
                rows: envRows,
            });

            return {
                sections,
                models,
                actions: [
                    { label: 'List downloaded models', command: 'ollama list' },
                    { label: 'Show what is loaded now', command: 'ollama ps' },
                ],
                counts: { downloaded: models.length, loaded: loaded.length },
            };
        },
    },

    {
        id: 'llama.cpp',
        name: 'llama.cpp',
        blurb: 'Runs any GGUF directly. Most control over offload and context.',
        formats: ['gguf'],
        endpoint: 'http://127.0.0.1:8080',
        supported: () => true,
        install: () =>
            process.platform === 'darwin' ? 'brew install llama.cpp'
                : isWin() ? 'winget install ggml.llamacpp'
                    : 'brew install llama.cpp   # or build: cmake -B build && cmake --build build',
        // llama.cpp has no registry of its own — GGUF comes from Hugging Face.
        pull: (ref) => `huggingface-cli download ${ref} --local-dir ./models/${String(ref).split('/').pop()}`,
        run: (ref) => `llama-cli -hf ${ref} -c 4096`,
        serve: (ref) => `llama-server -hf ${ref} -c 4096 --port 8080`,
        async detect() {
            const [cli, server, health] = await Promise.all([
                // Writes its banner to stderr and nothing to stdout.
                probeBin('llama-cli', ['--version'], { expectNonZero: true }),
                probeBin('llama-server', ['--version'], { expectNonZero: true }),
                probeHttp('http://127.0.0.1:8080/health'),
            ]);
            const raw = cli || server;
            if (!raw && !health) return { installed: false, serving: false };
            const m = raw && raw.match(/version:\s*(\S+)/i);
            const build = raw && raw.match(/build\s+(\d+)/i);
            return {
                installed: Boolean(raw),
                serving: Boolean(health),
                version: m ? m[1] : (raw ? raw.split('\n')[0].slice(0, 40) : null),
                build: build ? build[1] : null,
                models: [],
            };
        },

        async probeDetails() {
            // llama.cpp has no model registry, so its page is about CAPABILITY,
            // not inventory: what this particular build can actually do.
            const [devices, props, served, banner] = await Promise.all([
                probeBin('llama-cli', ['--list-devices'], { expectNonZero: true, timeout: 4000 }),
                probeHttp('http://127.0.0.1:8080/props'),
                probeHttp('http://127.0.0.1:8080/v1/models'),
                probeBin('llama-cli', ['--version'], { expectNonZero: true }),
            ]);

            // "(none)" is a real and important answer: a CPU-only build.
            const devLines = (devices ?? '')
                .split('\n')
                .filter((l) => /^\s{2,}\S/.test(l) && !/available devices/i.test(l))
                .map((l) => l.trim())
                .filter(Boolean);
            const hasGpu = devLines.length > 0 && !/^\(none\)$/i.test(devLines[0] ?? '');

            const libRoot = (() => {
                const bin = resolveBin('llama-cli');
                if (!bin) return null;
                try {
                    // The shim points at the real build directory.
                    const txt = fs.readFileSync(bin, 'utf8');
                    const m = txt.match(/exec\s+"([^"]+)\/llama-cli"/);
                    return m ? m[1] : path.dirname(fs.realpathSync(bin));
                } catch { return null; }
            })();

            const backendLibs = (() => {
                if (!libRoot) return [];
                try {
                    return fs.readdirSync(libRoot)
                        .filter((n) => /^libggml-(cuda|vulkan|hip|rocm|metal|blas|sycl)/i.test(n));
                } catch { return []; }
            })();

            const sections = [];

            sections.push({
                id: 'capability', title: 'What it can do',
                emptyState: 'Could not read this build.',
                rows: [
                    {
                        label: 'Accelerator backends',
                        value: hasGpu ? devLines.join(', ')
                            : 'None — this is a CPU-only build',
                        hint: hasGpu ? null
                            : 'Models will run on CPU regardless of the GPU in this machine. Install a CUDA or Vulkan build to use it.',
                    },
                    backendLibs.length
                        ? { label: 'Backend libraries', value: backendLibs.join(', ') }
                        : null,
                    banner?.match(/built with (.+?) for (\S+)/i)
                        ? { label: 'Built with', value: banner.match(/built with (.+?) for (\S+)/i).slice(1, 3).join(' — ') }
                        : null,
                    { label: 'Model format', value: 'GGUF only (pass one with -m)' },
                ].filter(Boolean),
            });

            sections.push({
                id: 'config', title: 'Configuration',
                emptyState: 'Server not running.',
                rows: [
                    libRoot ? { label: 'Build directory', value: libRoot } : null,
                    { label: 'Server endpoint', value: 'http://127.0.0.1:8080 (when started)' },
                    props?.model_path
                        ? { label: 'Loaded model', value: String(props.model_path).split('/').pop() }
                        : null,
                    props?.n_ctx ? { label: 'Active context', value: `${props.n_ctx} tokens` } : null,
                ].filter(Boolean),
            });

            const models = Array.isArray(served?.data)
                ? served.data.map((m) => ({ ref: m.id, loaded: true }))
                : [];

            return {
                sections,
                models,
                actions: [
                    { label: 'Start a server on :8080', command: 'llama-server -m model.gguf -c 4096 --port 8080' },
                    { label: 'Run a model once', command: 'llama-cli -m model.gguf -p "hello"' },
                ],
                gaps: models.length ? [] : [
                    'llama.cpp keeps no model registry, so there is nothing to list until a server is running with -m.',
                ],
            };
        },
    },

    {
        id: 'lmstudio',
        name: 'LM Studio',
        blurb: 'GUI plus an OpenAI-compatible server. GGUF and MLX.',
        formats: ['gguf', 'mlx'],
        endpoint: 'http://127.0.0.1:1234',
        supported: () => true,
        install: () =>
            process.platform === 'darwin' ? 'brew install --cask lm-studio'
                : 'Download from https://lmstudio.ai',
        pull: (ref) => `lms get ${ref}`,
        run: (ref) => `lms load ${ref}`,
        async detect() {
            const [version, models] = await Promise.all([
                probeBin('lms', ['version']),
                // /api/v0 is LM Studio's own API and carries far more than the
                // OpenAI-compatible /v1: quantisation, context, load state.
                probeHttp('http://127.0.0.1:1234/api/v0/models'),
            ]);
            if (!version && !models) return { installed: false, serving: false };
            // `lms version` prints an ANSI banner; the semver is inside it.
            const sem = version && version.match(/(\d+\.\d+\.\d+)/);
            const list = Array.isArray(models?.data) ? models.data : [];
            return {
                installed: Boolean(version) || Boolean(models),
                serving: Boolean(models),
                version: sem ? sem[1] : null,
                models: list.map((m) => ({
                    ref: m.id,
                    quant: m.quantization ?? null,
                    family: m.arch ?? null,
                    contextLength: m.max_context_length ?? null,
                    loaded: m.state === 'loaded',
                    kind: m.type ?? null,
                })),
            };
        },

        async probeDetails({ state }) {
            // `lms ls --json` adds on-disk size and parameter strings that the
            // HTTP API omits. It is optional: if the CLI is not resolvable the
            // page still renders from the HTTP data.
            const [lsRaw, api] = await Promise.all([
                probeBin('lms', ['ls', '--json'], { timeout: 6000 }),
                probeHttp('http://127.0.0.1:1234/api/v0/models'),
            ]);

            let byKey = new Map();
            try {
                const arr = JSON.parse(lsRaw ?? '[]');
                byKey = new Map(arr.map((m) => [m.modelKey, m]));
            } catch { /* CLI absent or shape changed — HTTP data still stands */ }

            const list = Array.isArray(api?.data) ? api.data : [];
            const models = list.map((m) => {
                const extra = byKey.get(m.id) ?? {};
                return {
                    ref: m.id,
                    quant: m.quantization ?? extra.quantization?.name ?? null,
                    params: extra.paramsString ?? null,
                    family: m.arch ?? extra.architecture ?? null,
                    contextLength: m.max_context_length ?? null,
                    sizeBytes: extra.sizeBytes ?? null,
                    loaded: m.state === 'loaded',
                    kind: m.type ?? null,
                    capabilities: m.capabilities ?? [],
                };
            });

            const totalBytes = models.reduce((a, m) => a + (m.sizeBytes ?? 0), 0);
            const loaded = models.filter((m) => m.loaded).length;
            const vision = models.filter((m) => extraHasVision(byKey.get(m.ref))).length;

            const sections = [];
            sections.push({
                id: 'capability', title: 'What it can do',
                emptyState: 'Start the server to read capabilities.',
                rows: [
                    { label: 'Loaded vs downloaded', value: `${loaded} loaded of ${models.length} downloaded` },
                    models.length
                        ? { label: 'Largest context available', value: `${Math.max(...models.map((m) => m.contextLength ?? 0)).toLocaleString()} tokens` }
                        : null,
                    vision ? { label: 'Vision-capable models', value: String(vision) } : null,
                    { label: 'OpenAI-compatible API', value: 'http://127.0.0.1:1234/v1' },
                ].filter(Boolean),
            });
            sections.push({
                id: 'storage', title: 'Storage',
                emptyState: 'No models downloaded.',
                rows: [
                    totalBytes ? { label: 'Disk used by models', value: fmtBytes(totalBytes) } : null,
                    { label: 'Models directory', value: home('.lmstudio', 'models') },
                ].filter(Boolean),
            });

            return {
                sections,
                models,
                actions: [
                    { label: 'List downloaded models', command: 'lms ls' },
                    { label: 'Show what is loaded', command: 'lms ps' },
                ],
            };
        },
    },

    {
        id: 'vllm',
        name: 'vLLM',
        blurb: 'Throughput-oriented server for safetensors on CUDA or ROCm.',
        formats: ['safetensors'],
        endpoint: 'http://127.0.0.1:8000',
        // vLLM has no usable macOS path; it wants a discrete accelerator.
        supported: (hw) => process.platform !== 'darwin' && hasAccelerator(hw),
        install: () => 'pip install vllm',
        pull: (ref) => `huggingface-cli download ${ref}`,
        run: (ref) => `vllm serve ${ref}`,
        async detect() {
            const [mod, served] = await Promise.all([
                // Reading package metadata is ~10x cheaper than importing vllm
                // (measured: 2688 ms for a real import), and this runs on every scan.
                probePythonMeta('vllm'),
                probeHttp('http://127.0.0.1:8000/v1/models'),
            ]);
            if (!mod && !served) return { installed: false, serving: false };
            return {
                installed: Boolean(mod),
                serving: Boolean(served),
                version: mod?.version ?? null,
                python: mod?.python ?? null,
                models: Array.isArray(served?.data) ? served.data.map((m) => ({ ref: m.id, loaded: true })) : [],
            };
        },

        async probeDetails({ state }) {
            // vLLM only matters if this machine can actually run it, so the
            // page leads with the GPU verdict rather than the version.
            const gpu = await probeTorchCuda();
            const sections = [];

            sections.push({
                id: 'capability', title: 'Can this machine run it',
                emptyState: 'Could not query torch.',
                rows: gpu ? [
                    { label: 'CUDA available', value: gpu.cudaAvailable ? 'Yes' : 'No' },
                    gpu.deviceName ? { label: 'GPU', value: gpu.deviceName } : null,
                    gpu.capability ? { label: 'Compute capability', value: gpu.capability } : null,
                    gpu.totalMiB ? { label: 'VRAM', value: `${gpu.freeMiB ?? '?'} MiB free of ${gpu.totalMiB} MiB` } : null,
                    gpu.torch ? { label: 'torch', value: gpu.torch } : null,
                    gpu.bf16 != null ? { label: 'bfloat16', value: gpu.bf16 ? 'Supported' : 'Not supported' } : null,
                ].filter(Boolean) : [],
            });

            sections.push({
                id: 'config', title: 'Configuration',
                emptyState: 'Not installed.',
                rows: [
                    state.python ? { label: 'Python interpreter', value: state.python } : null,
                    { label: 'Server endpoint', value: 'http://127.0.0.1:8000/v1 (when started)' },
                    ...safeEnvRows().filter((r) => r.label === 'CUDA_VISIBLE_DEVICES'),
                ].filter(Boolean),
            });

            return {
                sections,
                models: state.models ?? [],
                actions: [{ label: 'Serve a model', command: 'vllm serve <model> --port 8000' }],
                gaps: (state.models ?? []).length ? [] : [
                    'vLLM has no local model registry. Nothing is listed until a server is running, and it downloads weights from Hugging Face on first serve.',
                ],
            };
        },
    },

    {
        id: 'mlx',
        name: 'MLX-LM',
        blurb: 'Apple Silicon native. Uses unified memory, not VRAM.',
        formats: ['mlx', 'safetensors'],
        endpoint: null,
        supported: () => isAppleSilicon(),
        install: () => 'pip install mlx-lm',
        pull: (ref) => `huggingface-cli download ${ref}`,
        run: (ref) => `mlx_lm.generate --model ${ref} --prompt "hello"`,
        async detect() {
            if (!isAppleSilicon()) return { installed: false, serving: false, reason: 'apple-silicon-only' };
            const mod = await probePythonModule('mlx_lm', 'mlx_lm.version.__version__');
            if (!mod) return { installed: false, serving: false };
            return { installed: true, serving: false, version: mod.version, models: [] };
        },
    },

    {
        id: 'transformers',
        name: 'Transformers',
        blurb: 'Reference PyTorch path. Widest model coverage, slowest to start.',
        formats: ['safetensors'],
        endpoint: null,
        supported: () => true,
        install: () => 'pip install transformers torch',
        pull: (ref) => `huggingface-cli download ${ref}`,
        run: (ref) => `python -c "from transformers import pipeline; print(pipeline('text-generation', '${ref}')('hello'))"`,
        async detect() {
            const mod = await probePythonMeta('transformers');
            if (!mod) return { installed: false, serving: false };
            return {
                installed: true, serving: false,
                version: mod.version, python: mod.python, models: [],
            };
        },

        async probeDetails({ state }) {
            const [gpu, accelerate, cache] = await Promise.all([
                probeTorchCuda(),
                probePythonMeta('accelerate'),
                // The HF cache is the closest thing this library has to an
                // inventory. Scanning it is the expensive part of this page.
                (async () => {
                    const root = process.env.HF_HUB_CACHE
                        || (process.env.HF_HOME ? path.join(process.env.HF_HOME, 'hub') : null)
                        || home('.cache', 'huggingface', 'hub');
                    let entries;
                    try { entries = await fsp.readdir(root, { withFileTypes: true }); }
                    catch { return { root, repos: [], missing: true }; }
                    const repos = [];
                    for (const e of entries) {
                        if (!e.isDirectory() || !e.name.startsWith('models--')) continue;
                        const full = path.join(root, e.name);
                        const { bytes } = await dirSize(full, { maxEntries: 4000 });
                        repos.push({
                            ref: e.name.replace(/^models--/, '').replace(/--/g, '/'),
                            sizeBytes: bytes,
                        });
                    }
                    return { root, repos: repos.sort((a, b) => b.sizeBytes - a.sizeBytes) };
                })(),
            ]);

            const sections = [];

            // Without torch this is a tokenizer library, which is the single
            // most useful thing to tell someone who expects to run a model.
            sections.push({
                id: 'capability', title: 'What it can do',
                emptyState: 'Could not query the environment.',
                rows: [
                    gpu?.torch
                        ? { label: 'torch', value: gpu.torch }
                        : {
                            label: 'torch', value: 'Not installed',
                            hint: 'Without torch, transformers can only do tokenizers and config — it cannot run a model.',
                        },
                    gpu ? { label: 'CUDA available', value: gpu.cudaAvailable ? 'Yes' : 'No' } : null,
                    gpu?.deviceName ? { label: 'GPU', value: gpu.deviceName } : null,
                    gpu?.totalMiB ? { label: 'VRAM', value: `${gpu.freeMiB ?? '?'} MiB free of ${gpu.totalMiB} MiB` } : null,
                    {
                        label: 'accelerate',
                        value: accelerate ? accelerate.version : 'Not installed',
                        hint: accelerate ? null : 'device_map="auto" and multi-GPU sharding need accelerate.',
                    },
                ].filter(Boolean),
            });

            sections.push({
                id: 'storage', title: 'Storage',
                emptyState: 'No Hugging Face cache found.',
                rows: cache.missing ? [] : [
                    { label: 'Cache directory', value: cache.root },
                    { label: 'Cached repositories', value: String(cache.repos.length) },
                    {
                        label: 'Cache size',
                        value: fmtBytes(cache.repos.reduce((a, r) => a + r.sizeBytes, 0)) ?? '0',
                    },
                ],
            });

            sections.push({
                id: 'config', title: 'Configuration',
                emptyState: 'No overrides set.',
                rows: [
                    state.python ? { label: 'Python interpreter', value: state.python } : null,
                    ...safeEnvRows().filter((r) => r.label.startsWith('HF_')),
                ].filter(Boolean),
            });

            return {
                sections,
                models: cache.repos.map((r) => ({ ref: r.ref, sizeBytes: r.sizeBytes })),
                actions: [{ label: 'Install torch for GPU inference', command: 'pip install torch' }],
                gaps: [
                    'Cached repositories are not necessarily runnable — the cache also holds tokenizers, datasets and non-transformers formats.',
                ],
            };
        },
    },
];

function hasAccelerator(hw = {}) {
    const vram = Number(hw?.gpu?.vramGB ?? hw?.summary?.vramGB ?? 0);
    const backend = String(hw?.summary?.backend ?? hw?.gpu?.backend ?? '').toLowerCase();
    return vram > 0 || backend.includes('cuda') || backend.includes('rocm');
}

const BY_ID = new Map(RUNTIMES.map((r) => [r.id, r]));

/** Aliases the CLI and the registry use for the same runtime. */
const ALIASES = new Map([
    ['llamacpp', 'llama.cpp'],
    ['llama-cpp', 'llama.cpp'],
    ['llama_cpp', 'llama.cpp'],
    ['lm-studio', 'lmstudio'],
    ['lmstudio.ai', 'lmstudio'],
    ['mlx-lm', 'mlx'],
    ['mlx_lm', 'mlx'],
    ['hf', 'transformers'],
    ['huggingface', 'transformers'],
    ['pytorch', 'transformers'],
]);

/**
 * Unlike the CLI's normalizeRuntime, this never silently rewrites an unknown
 * runtime to 'ollama' — it returns null so the caller can decide.
 */
function normalize(runtime) {
    if (!runtime) return null;
    const key = String(runtime).trim().toLowerCase();
    if (key === 'auto' || key === 'all' || key === '*') return 'auto';
    if (BY_ID.has(key)) return key;
    return ALIASES.get(key) ?? null;
}

function get(runtime) {
    const id = normalize(runtime);
    return id && id !== 'auto' ? BY_ID.get(id) : null;
}

/** Runtimes that could run on this hardware at all, installed or not. */
function eligible(hardware = {}) {
    return RUNTIMES.filter((r) => r.supported(hardware));
}

/**
 * Detect every eligible runtime concurrently. The whole sweep costs about as
 * much as the slowest single probe (~2.5 s worst case), not the sum.
 */
async function detectAll(hardware = {}) {
    const list = eligible(hardware);
    const results = await Promise.all(
        list.map(async (r) => {
            let state;
            try {
                state = await r.detect();
            } catch (err) {
                state = { installed: false, serving: false, error: err?.message ?? String(err) };
            }
            return {
                id: r.id,
                name: r.name,
                blurb: r.blurb,
                formats: r.formats,
                endpoint: r.endpoint,
                installCommand: r.install(),
                ...state,
            };
        })
    );
    // Installed first, then serving, then alphabetical — the order the UI wants.
    return results.sort(
        (a, b) =>
            Number(b.installed) - Number(a.installed) ||
            Number(b.serving) - Number(a.serving) ||
            a.name.localeCompare(b.name)
    );
}

/**
 * Pick the runtime for a catalog artifact. Prefers something already
 * installed that can handle the artifact's format, and falls back to the
 * best format match so the UI can still show a real install command.
 */
function chooseFor(artifact = {}, detected = [], hardware = {}) {
    const format = String(artifact.format ?? '').toLowerCase();
    const eligibleIds = new Set(eligible(hardware).map((r) => r.id));
    const canRun = (r) => eligibleIds.has(r.id) && (!format || r.formats.includes(format));

    const installedIds = new Set(detected.filter((d) => d.installed).map((d) => d.id));
    const servingIds = new Set(detected.filter((d) => d.serving).map((d) => d.id));

    const candidates = RUNTIMES.filter(canRun);
    if (!candidates.length) return null;

    const rank = (r) =>
        (servingIds.has(r.id) ? 4 : 0) + (installedIds.has(r.id) ? 2 : 0) + (r.id === 'ollama' ? 1 : 0);

    return candidates.reduce((best, r) => (rank(r) > rank(best) ? r : best), candidates[0]);
}

/**
 * Deep, per-runtime data for its detail view.
 *
 * Kept separate from detect() on purpose: detect() runs on every scan and must
 * stay cheap, while these probes are only worth paying for when the user
 * actually opens that runtime's page. Each runtime supplies its own
 * `probeDetails`; anything missing degrades to the detect() summary rather
 * than inventing rows.
 */
async function details(runtime, hardware = {}) {
    const r = get(runtime);
    if (!r) return null;

    const base = {
        id: r.id,
        name: r.name,
        blurb: r.blurb,
        formats: r.formats,
        endpoint: r.endpoint,
        installCommand: r.install(),
        supported: r.supported(hardware),
        sections: [],
        models: [],
        actions: [],
        errors: [],
    };

    let state;
    try {
        state = await r.detect();
    } catch (err) {
        base.errors.push(`detect failed: ${err?.message ?? err}`);
        state = { installed: false, serving: false };
    }
    Object.assign(base, state);

    if (typeof r.probeDetails === 'function') {
        try {
            const extra = await r.probeDetails({ hardware, state });
            if (extra?.sections) base.sections.push(...extra.sections);
            if (extra?.models) base.models = extra.models;
            if (extra?.actions) base.actions.push(...extra.actions);
            if (extra?.errors) base.errors.push(...extra.errors);
        } catch (err) {
            base.errors.push(`details failed: ${err?.message ?? err}`);
        }
    }
    return base;
}

/** Commands for a given (runtime, modelRef) pair, ready to show or copy. */
function commandsFor(runtime, ref) {
    const r = get(runtime);
    if (!r) return null;
    return {
        runtime: r.id,
        name: r.name,
        install: r.install(),
        pull: typeof r.pull === 'function' ? r.pull(ref) : null,
        run: typeof r.run === 'function' ? r.run(ref) : null,
        serve: typeof r.serve === 'function' ? r.serve(ref) : null,
    };
}

module.exports = {
    RUNTIMES,
    normalize,
    get,
    eligible,
    detectAll,
    details,
    chooseFor,
    commandsFor,
    hasAccelerator,
    _internal: { probe, probeHttp, probePythonModule },
};
