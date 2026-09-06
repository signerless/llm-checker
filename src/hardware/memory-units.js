// systeminformation graphics controllers report vram (and NVIDIA memoryTotal)
// in MB. The numeric value cannot distinguish a 256 MB aperture from 256 GB.
function megabytesToGB(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return number >= 1024 ? Math.round(number / 1024) : number / 1024;
}

function clampSharedMemory(value, systemGB) {
    const memory = Math.max(0, Number(value) || 0);
    const total = Number(systemGB);
    return Number.isFinite(total) && total > 0
        ? Math.min(memory, total, Math.max(1, Math.round(total * 0.95)))
        : memory;
}

module.exports = { megabytesToGB, clampSharedMemory };
