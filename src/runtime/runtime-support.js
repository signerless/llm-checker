const SUPPORTED_RUNTIMES = ['ollama', 'vllm', 'mlx'];

function normalizeRuntime(runtime = 'ollama') {
    const normalized = String(runtime || 'ollama').trim().toLowerCase();
    return SUPPORTED_RUNTIMES.includes(normalized) ? normalized : 'ollama';
}

function getRuntimeDisplayName(runtime = 'ollama') {
    const normalized = normalizeRuntime(runtime);
    if (normalized === 'vllm') return 'vLLM';
    if (normalized === 'mlx') return 'MLX-LM';
    return 'Ollama';
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
    if (normalized === 'mlx') {
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
    const normalized = normalizeRuntime(runtime);

    const candidates = [
        model.hfModel,
        model.hfId,
        model.huggingfaceId,
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

    if (normalized === 'vllm') {
        return 'pip install -U "vllm>=0.6.0"';
    }

    if (normalized === 'mlx') {
        return 'pip install -U mlx-lm';
    }

    return 'ollama --version || (brew install ollama)';
}

function getRuntimePullCommand(model = {}, runtime = 'ollama') {
    const normalized = normalizeRuntime(runtime);
    const modelRef = getRuntimeModelRef(model, runtime);

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
    const normalized = normalizeRuntime(runtime);
    const modelRef = getRuntimeModelRef(model, runtime);

    if (normalized === 'vllm') {
        return `python -m vllm.entrypoints.openai.api_server --model ${shellEscapeArg(modelRef)} --host 0.0.0.0 --port 8000`;
    }

    if (normalized === 'mlx') {
        return `python -m mlx_lm.generate --model ${shellEscapeArg(modelRef)} --prompt "Hello"`;
    }

    return `ollama run ${modelRef}`;
}

function getRuntimeCommandSet(model = {}, runtime = 'ollama') {
    const normalized = normalizeRuntime(runtime);
    return {
        runtime: normalized,
        displayName: getRuntimeDisplayName(normalized),
        modelRef: getRuntimeModelRef(model, normalized),
        install: getRuntimeInstallCommand(normalized),
        pull: getRuntimePullCommand(model, normalized),
        run: getRuntimeRunCommand(model, normalized)
    };
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
