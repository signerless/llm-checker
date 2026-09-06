const SUPPORTED_RUNTIMES = ['ollama', 'vllm', 'mlx', 'llama.cpp', 'transformers'];
const { normalizePlatform, isTermuxEnvironment } = require('../utils/platform');

function normalizeRuntime(runtime = 'ollama') {
    const normalized = String(runtime ?? '').trim().toLowerCase();
    const aliases = { llamacpp: 'llama.cpp', llama_cpp: 'llama.cpp', hf: 'transformers', all: 'auto', '*': 'auto' };
    const name = aliases[normalized] || normalized;
    return name === 'auto' || SUPPORTED_RUNTIMES.includes(name) ? name : null;
}

function getRuntimeDisplayName(runtime = 'ollama') {
    const normalized = normalizeRuntime(runtime);
    if (normalized === 'vllm') return 'vLLM';
    if (normalized === 'mlx') return 'MLX-LM';
    if (normalized === 'llama.cpp') return 'llama.cpp';
    if (normalized === 'transformers') return 'Transformers';
    if (normalized === 'auto') return 'Automatic';
    return normalized === 'ollama' ? 'Ollama' : 'Unknown runtime';
}

function isAppleSiliconHardware(hardware = {}) {
    const osPlatform = String(hardware?.os?.platform || '').toLowerCase();
    const arch = String(
        hardware?.cpu?.architecture ||
        hardware?.summary?.architecture ||
        ''
    ).toLowerCase();
    const cpuBrand = String(hardware?.cpu?.brand || '').toLowerCase();
    const gpuModel = String(hardware?.gpu?.model || '').toLowerCase();
    const isDarwin = osPlatform === 'darwin' || osPlatform === 'macos';
    const hasAppleChipSignal =
        arch.includes('apple silicon') ||
        cpuBrand.includes('apple') ||
        gpuModel.includes('apple');

    // Prefer explicit Apple signals and avoid treating generic Linux ARM64 as Apple Silicon.
    if (isDarwin) {
        return arch === 'arm64' || hasAppleChipSignal;
    }

    // Fallback for partial hardware payloads that still expose Apple-specific identifiers.
    return hasAppleChipSignal;
}

function runtimeSupportedOnHardware(runtime = 'ollama', hardware = {}) {
    const normalized = normalizeRuntime(runtime);
    if (!normalized) return false;
    if (normalized === 'mlx') {
        if (hardware?.cpuOnly) return false;
        return isAppleSiliconHardware(hardware);
    }
    return true;
}

function runtimeSupportsSpeculativeDecoding(runtime = 'ollama') {
    const normalized = normalizeRuntime(runtime);
    return normalized === 'vllm' || normalized === 'mlx';
}

function shellEscapeArg(value = '') {
    const text = String(value || '');
    if (!text) return "''";
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

function extractFromInstallCommand(command = '') {
    const match = String(command).match(/ollama\s+pull\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function slugifyModelName(text = '') {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'model';
}

function getRuntimeModelRef(model = {}, runtime = 'ollama') {
    const normalized = resolveCommandRuntime(model, runtime);
    if (!normalized) return null;

    const candidates = [
        model.hfModel,
        model.hfId,
        model.huggingfaceId,
        ...(normalized !== 'ollama' ? [model.artifact?.repo_id, model.repo_id] : []),
        model.model_identifier,
        model.identifier,
        model.cloudData?.identifier,
        model.ollamaTag,
        extractFromInstallCommand(model.installation?.ollama),
        model.ollamaId,
        model.name
    ].filter(Boolean);

    const raw = String(candidates[0] || '').trim();
    if (!raw) return 'model';

    if (normalized === 'ollama') {
        return raw;
    }

    // An Ollama tag is not a Hugging Face repository. Do not invent a repo for
    // a GGUF/Transformers workflow when the catalog does not provide one.
    if (['llama.cpp', 'transformers'].includes(normalized) && raw.includes(':') && !raw.includes('/')) return null;

    if (raw.includes('/')) {
        return raw;
    }

    // Remove Ollama-style tag suffix for non-Ollama runtimes.
    const base = raw.split(':')[0].trim();
    if (base) {
        return /\s/.test(base) ? slugifyModelName(base) : base;
    }

    return slugifyModelName(raw);
}

function getRuntimeInstallCommand(runtime = 'ollama') {
    const normalized = normalizeRuntime(runtime);
    if (!normalized || normalized === 'auto') return null;
    if (normalized === 'transformers') return 'python -m pip install -U transformers torch huggingface_hub';
    if (normalized === 'llama.cpp') {
        if (normalizePlatform() === 'win32') return 'winget install llama.cpp';
        if (normalizePlatform() === 'darwin') return 'brew install llama.cpp';
        return 'conda install -c conda-forge llama.cpp';
    }

    if (normalized === 'vllm') {
        return 'pip install -U "vllm>=0.6.0"';
    }

    if (normalized === 'mlx') {
        return 'pip install -U mlx-lm';
    }

    if (isTermuxEnvironment()) {
        return 'pkg install ollama';
    }

    const platform = normalizePlatform();
    if (platform === 'darwin') {
        return 'brew install ollama';
    }
    if (platform === 'win32') {
        return 'winget install Ollama.Ollama';
    }

    return 'curl -fsSL https://ollama.com/install.sh | sh';
}

function getRuntimePullCommand(model = {}, runtime = 'ollama') {
    const normalized = resolveCommandRuntime(model, runtime);
    const modelRef = getRuntimeModelRef(model, normalized);
    if (!normalized || !modelRef) return null;
    if (normalized === 'transformers') return `hf download ${shellEscapeArg(modelRef)}`;
    if (normalized === 'llama.cpp') {
        const file = getGgufFilename(model);
        if (!file || !modelRef.includes('/')) return null;
        const url = model.artifact?.download_url || model.downloadUrl ||
            `https://huggingface.co/${modelRef}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`;
        return `curl --fail --location ${shellEscapeArg(url)} --output ${shellEscapeArg(`./${file.split('/').pop()}`)}`;
    }

    if (normalized === 'vllm') {
        return `huggingface-cli download ${shellEscapeArg(modelRef)}`;
    }

    if (normalized === 'mlx') {
        const localName = slugifyModelName(modelRef);
        return `python -m mlx_lm.convert --hf-path ${shellEscapeArg(modelRef)} --mlx-path ./models/${localName}`;
    }

    return `ollama pull ${modelRef}`;
}

function getRuntimeRunCommand(model = {}, runtime = 'ollama') {
    const normalized = resolveCommandRuntime(model, runtime);
    const modelRef = getRuntimeModelRef(model, normalized);
    if (!normalized || !modelRef) return null;
    if (normalized === 'llama.cpp') {
        const file = getGgufFilename(model);
        if (!file) return null;
        return `llama-cli --model ${shellEscapeArg(model.localPath || `./${file.split('/').pop()}`)} --prompt "Hello" --n-predict 64 --single-turn`;
    }
    if (normalized === 'transformers') {
        const script = 'import sys; from transformers import pipeline; print(pipeline("text-generation", model=sys.argv[1])("Hello", max_new_tokens=64)[0]["generated_text"])';
        return `python -c ${shellEscapeArg(script)} ${shellEscapeArg(modelRef)}`;
    }

    if (normalized === 'vllm') {
        return `python -m vllm.entrypoints.openai.api_server --model ${shellEscapeArg(modelRef)} --host 0.0.0.0 --port 8000`;
    }

    if (normalized === 'mlx') {
        return `python -m mlx_lm.generate --model ${shellEscapeArg(modelRef)} --prompt "Hello"`;
    }

    return `ollama run ${modelRef}`;
}

function getRuntimeCommandSet(model = {}, runtime = 'ollama') {
    const normalized = resolveCommandRuntime(model, runtime);
    return {
        runtime: normalized,
        displayName: getRuntimeDisplayName(normalized),
        modelRef: getRuntimeModelRef(model, normalized),
        install: getRuntimeInstallCommand(normalized),
        pull: getRuntimePullCommand(model, normalized),
        run: getRuntimeRunCommand(model, normalized)
    };
}

function getGgufFilename(model) {
    const file = model.artifact?.filename || model.filename || model.localPath || '';
    return /\.gguf$/i.test(file) ? file : null;
}

function resolveCommandRuntime(model, runtime) {
    const normalized = normalizeRuntime(runtime);
    if (normalized !== 'auto') return normalized;
    const preferred = normalizeRuntime(model.preferredRuntime || model.runtime || null);
    if (preferred && preferred !== 'auto') return preferred;
    if (getGgufFilename(model) || model.artifact?.format === 'gguf') return 'llama.cpp';
    if (model.hfModel || model.hfId || model.huggingfaceId || model.artifact?.source_id === 'huggingface') return 'transformers';
    return 'ollama';
}

module.exports = {
    SUPPORTED_RUNTIMES,
    normalizeRuntime,
    getRuntimeDisplayName,
    runtimeSupportedOnHardware,
    runtimeSupportsSpeculativeDecoding,
    getRuntimeModelRef,
    getRuntimeInstallCommand,
    getRuntimePullCommand,
    getRuntimeRunCommand,
    getRuntimeCommandSet
};
