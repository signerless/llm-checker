const HardwareSpecs = require('./specs');

const specs = new HardwareSpecs();

// Curated hardware profiles for simulation
const HARDWARE_PROFILES = {
    // NVIDIA Data Center
    h100: {
        displayName: 'NVIDIA H100 80GB (Data Center)',
        category: 'data_center',
        gpu: { model: 'NVIDIA H100', vendor: 'NVIDIA', vram: 80, dedicated: true },
        cpu: { brand: 'AMD EPYC 9654', cores: 96, physicalCores: 96, speed: 2.4, architecture: 'x86_64' },
        memory: { total: 256 },
        backend: 'cuda',
        os: { platform: 'linux' }
    },
    a100: {
        displayName: 'NVIDIA A100 80GB (Data Center)',
        category: 'data_center',
        gpu: { model: 'NVIDIA A100', vendor: 'NVIDIA', vram: 80, dedicated: true },
        cpu: { brand: 'AMD EPYC 7763', cores: 64, physicalCores: 64, speed: 2.45, architecture: 'x86_64' },
        memory: { total: 128 },
        backend: 'cuda',
        os: { platform: 'linux' }
    },

    // NVIDIA Desktop
    rtx4090: {
        displayName: 'NVIDIA RTX 4090 (Desktop)',
        category: 'nvidia_desktop',
        gpu: { model: 'NVIDIA GeForce RTX 4090', vendor: 'NVIDIA', vram: 24, dedicated: true },
        cpu: { brand: 'AMD Ryzen 9 7950X', cores: 16, physicalCores: 16, speed: 4.5, architecture: 'x86_64' },
        memory: { total: 64 },
        backend: 'cuda',
        os: { platform: 'linux' }
    },
    rtx3090: {
        displayName: 'NVIDIA RTX 3090 (Desktop)',
        category: 'nvidia_desktop',
        gpu: { model: 'NVIDIA GeForce RTX 3090', vendor: 'NVIDIA', vram: 24, dedicated: true },
        cpu: { brand: 'AMD Ryzen 9 5950X', cores: 16, physicalCores: 16, speed: 3.4, architecture: 'x86_64' },
        memory: { total: 64 },
        backend: 'cuda',
        os: { platform: 'linux' }
    },
    rtx4070ti: {
        displayName: 'NVIDIA RTX 4070 Ti (Desktop)',
        category: 'nvidia_desktop',
        gpu: { model: 'NVIDIA GeForce RTX 4070 Ti', vendor: 'NVIDIA', vram: 12, dedicated: true },
        cpu: { brand: 'Intel Core i7-13700K', cores: 16, physicalCores: 16, speed: 3.4, architecture: 'x86_64' },
        memory: { total: 32 },
        backend: 'cuda',
        os: { platform: 'linux' }
    },
    rtx3060: {
        displayName: 'NVIDIA RTX 3060 (Desktop)',
        category: 'nvidia_desktop',
        gpu: { model: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', vram: 12, dedicated: true },
        cpu: { brand: 'Intel Core i5-12600K', cores: 10, physicalCores: 10, speed: 3.7, architecture: 'x86_64' },
        memory: { total: 32 },
        backend: 'cuda',
        os: { platform: 'linux' }
    },

    // Apple Silicon
    m4max48: {
        displayName: 'Apple M4 Max 48GB',
        category: 'apple_silicon',
        gpu: { model: 'Apple M4 Max', vendor: 'Apple', vram: 0, dedicated: false, unified: true },
        cpu: { brand: 'Apple M4 Max', cores: 16, physicalCores: 16, speed: 4.5, architecture: 'Apple Silicon' },
        memory: { total: 48 },
        backend: 'metal',
        os: { platform: 'darwin' }
    },
    m4pro24: {
        displayName: 'Apple M4 Pro 24GB',
        category: 'apple_silicon',
        gpu: { model: 'Apple M4 Pro', vendor: 'Apple', vram: 0, dedicated: false, unified: true },
        cpu: { brand: 'Apple M4 Pro', cores: 14, physicalCores: 14, speed: 4.5, architecture: 'Apple Silicon' },
        memory: { total: 24 },
        backend: 'metal',
        os: { platform: 'darwin' }
    },
    m3_16: {
        displayName: 'Apple M3 16GB',
        category: 'apple_silicon',
        gpu: { model: 'Apple M3', vendor: 'Apple', vram: 0, dedicated: false, unified: true },
        cpu: { brand: 'Apple M3', cores: 8, physicalCores: 8, speed: 4.0, architecture: 'Apple Silicon' },
        memory: { total: 16 },
        backend: 'metal',
        os: { platform: 'darwin' }
    },
    m1_16: {
        displayName: 'Apple M1 16GB',
        category: 'apple_silicon',
        gpu: { model: 'Apple M1', vendor: 'Apple', vram: 0, dedicated: false, unified: true },
        cpu: { brand: 'Apple M1', cores: 8, physicalCores: 8, speed: 3.2, architecture: 'Apple Silicon' },
        memory: { total: 16 },
        backend: 'metal',
        os: { platform: 'darwin' }
    },

    // AMD Desktop
    rx7900xtx: {
        displayName: 'AMD RX 7900 XTX (Desktop)',
        category: 'amd_desktop',
        gpu: { model: 'AMD Radeon RX 7900 XTX', vendor: 'AMD', vram: 24, dedicated: true },
        cpu: { brand: 'AMD Ryzen 9 7900X', cores: 12, physicalCores: 12, speed: 4.7, architecture: 'x86_64' },
        memory: { total: 64 },
        backend: 'rocm',
        os: { platform: 'linux' }
    },

    // CPU Only
    cpu_high: {
        displayName: 'CPU Only (32GB RAM)',
        category: 'cpu_only',
        gpu: { model: '', vendor: '', vram: 0, dedicated: false },
        cpu: { brand: 'Intel Core i9-13900K', cores: 24, physicalCores: 24, speed: 3.0, architecture: 'x86_64' },
        memory: { total: 32 },
        backend: 'cpu',
        os: { platform: 'linux' }
    },
    cpu_mid: {
        displayName: 'CPU Only (16GB RAM)',
        category: 'cpu_only',
        gpu: { model: '', vendor: '', vram: 0, dedicated: false },
        cpu: { brand: 'AMD Ryzen 7 5800X', cores: 8, physicalCores: 8, speed: 3.8, architecture: 'x86_64' },
        memory: { total: 16 },
        backend: 'cpu',
        os: { platform: 'linux' }
    },
    cpu_low: {
        displayName: 'CPU Only (8GB RAM)',
        category: 'cpu_only',
        gpu: { model: '', vendor: '', vram: 0, dedicated: false },
        cpu: { brand: 'Intel Core i5-12600K', cores: 10, physicalCores: 10, speed: 3.7, architecture: 'x86_64' },
        memory: { total: 8 },
        backend: 'cpu',
        os: { platform: 'linux' }
    }
};

const CATEGORY_LABELS = {
    data_center: 'Data Center',
    nvidia_desktop: 'NVIDIA Desktop',
    apple_silicon: 'Apple Silicon',
    amd_desktop: 'AMD Desktop',
    cpu_only: 'CPU Only'
};

function buildFullHardwareObject(profileKey) {
    const profile = HARDWARE_PROFILES[profileKey];
    if (!profile) return null;

    const isApple = profile.os.platform === 'darwin';
    const isUnified = Boolean(profile.gpu.unified);
    const totalRAM = profile.memory.total;
    const vram = profile.gpu.vram;

    // Compute effective memory (matches unified-detector logic)
    const effectiveMemory = isUnified
        ? totalRAM
        : (vram > 0 ? vram : Math.round(totalRAM * 0.7));

    // Get scores from HardwareSpecs where available
    const cpuSpecs = specs.getCPUScore(profile.cpu.brand);
    const gpuSpecs = profile.gpu.model ? specs.getGPUScore(profile.gpu.model) : { score: 0 };

    // Simulate ~60% free memory
    const freeRAM = Math.round(totalRAM * 0.6);
    const usedRAM = totalRAM - freeRAM;

    // Build the full hardware object (Shape A - matches HardwareDetector.getSystemInfo() output)
    const hardware = {
        cpu: {
            brand: profile.cpu.brand,
            manufacturer: isApple ? 'Apple' : (profile.cpu.brand.includes('Intel') ? 'Intel' : 'AMD'),
            family: 'Unknown',
            model: 'Unknown',
            speed: profile.cpu.speed,
            speedMax: profile.cpu.speed,
            cores: profile.cpu.cores,
            physicalCores: profile.cpu.physicalCores,
            processors: 1,
            cache: { l1d: 0, l1i: 0, l2: 0, l3: 0 },
            architecture: profile.cpu.architecture,
            score: cpuSpecs.score || 70
        },
        memory: {
            total: totalRAM,
            free: freeRAM,
            used: usedRAM,
            available: freeRAM,
            usagePercent: Math.round((usedRAM / totalRAM) * 100),
            swapTotal: 0,
            swapUsed: 0,
            score: totalRAM >= 64 ? 55 : (totalRAM >= 32 ? 50 : (totalRAM >= 16 ? 40 : 25))
        },
        gpu: {
            model: profile.gpu.model || 'No GPU detected',
            vendor: profile.gpu.vendor || 'Unknown',
            vram: vram,
            vramPerGPU: vram,
            vramDynamic: false,
            dedicated: profile.gpu.dedicated,
            driverVersion: 'Simulated',
            gpuCount: 1,
            isMultiGPU: false,
            all: profile.gpu.model ? [{
                model: profile.gpu.model,
                vram: vram,
                vendor: profile.gpu.vendor
            }] : [],
            displays: 1,
            score: gpuSpecs.score || 0,
            unified: isUnified,
            backend: profile.backend
        },
        system: {
            manufacturer: isApple ? 'Apple' : 'Simulated System',
            model: profile.displayName,
            version: 'Simulated'
        },
        os: {
            platform: profile.os.platform,
            distro: isApple ? 'macOS' : 'Linux',
            release: 'Simulated',
            codename: 'Simulated',
            kernel: 'Simulated',
            arch: profile.cpu.architecture === 'Apple Silicon' ? 'arm64' : 'x64',
            hostname: 'simulated-host',
            logofile: ''
        },
        timestamp: Date.now(),

        // Shape B - for ScoringEngine / test compatibility
        summary: {
            bestBackend: profile.backend,
            gpuModel: profile.gpu.model,
            effectiveMemory: effectiveMemory,
            systemRAM: totalRAM,
            totalVRAM: vram
        }
    };

    // Add CPU capabilities for scoring engine
    hardware.cpu.capabilities = {};
    if (profile.cpu.architecture === 'Apple Silicon') {
        hardware.cpu.capabilities.neon = true;
    } else {
        hardware.cpu.capabilities.avx2 = true;
        if (profile.cpu.cores >= 64) {
            hardware.cpu.capabilities.avx512 = true;
        }
    }

    return hardware;
}

function inferGpuDetails(gpuName) {
    if (!gpuName) return { model: '', vendor: '', vram: 0, dedicated: false, unified: false, backend: 'cpu', platform: 'linux' };

    const lower = gpuName.toLowerCase();
    let vendor = 'Unknown';
    let dedicated = true;
    let unified = false;
    let backend = 'cuda';
    let platform = 'linux';

    if (lower.includes('nvidia') || lower.includes('rtx') || lower.includes('gtx') || lower.includes('geforce')) {
        vendor = 'NVIDIA';
        backend = 'cuda';
    } else if (lower.includes('amd') || lower.includes('radeon') || lower.includes('rx ')) {
        vendor = 'AMD';
        backend = 'rocm';
    } else if (lower.includes('apple') || /\bm[1-9]\b/.test(lower)) {
        vendor = 'Apple';
        backend = 'metal';
        platform = 'darwin';
        dedicated = false;
        unified = true;
    } else if (lower.includes('intel') && (lower.includes('arc') || lower.includes('iris') || lower.includes('uhd'))) {
        vendor = 'Intel';
        backend = 'cpu';
        dedicated = lower.includes('arc');
    }

    // Normalize model name to match what estimateVRAMFromModel expects
    let model = gpuName;
    if (vendor === 'NVIDIA' && !lower.includes('nvidia')) {
        model = `NVIDIA GeForce ${gpuName}`;
    }

    // Use HardwareDetector's VRAM estimation logic
    const HardwareDetector = require('./detector');
    const detector = new HardwareDetector();
    const estimatedVram = detector.estimateVRAMFromModel(model);

    return { model, vendor, vram: estimatedVram, dedicated, unified, backend, platform };
}

function inferCpuDetails(cpuName) {
    if (!cpuName) return { brand: 'Unknown CPU', cores: 8, physicalCores: 8, speed: 3.5, architecture: 'x86_64', manufacturer: 'Unknown' };

    const lower = cpuName.toLowerCase();
    const cpuSpecs = specs.getCPUScore(cpuName);
    let manufacturer = 'Unknown';
    let architecture = 'x86_64';

    if (lower.includes('apple') || /\bm[1-9]\b/.test(lower)) {
        manufacturer = 'Apple';
        architecture = 'Apple Silicon';
    } else if (lower.includes('intel')) {
        manufacturer = 'Intel';
    } else if (lower.includes('amd') || lower.includes('ryzen') || lower.includes('epyc')) {
        manufacturer = 'AMD';
    }

    return {
        brand: cpuName,
        cores: cpuSpecs.cores || 8,
        physicalCores: cpuSpecs.cores || 8,
        speed: 3.5,
        architecture,
        manufacturer
    };
}

function buildCustomHardwareObject({ gpu, ram, cpu, vram: overrideVram }) {
    const gpuDetails = inferGpuDetails(gpu);
    const cpuDetails = inferCpuDetails(cpu);

    const totalRAM = ram || 16;
    const vram = overrideVram != null ? overrideVram : gpuDetails.vram;
    const isApple = gpuDetails.platform === 'darwin' || cpuDetails.architecture === 'Apple Silicon';
    const isUnified = gpuDetails.unified || isApple;
    const platform = isApple ? 'darwin' : 'linux';
    const backend = gpuDetails.backend;

    const effectiveMemory = isUnified
        ? totalRAM
        : (vram > 0 ? vram : Math.round(totalRAM * 0.7));

    const gpuSpecs = gpuDetails.model ? specs.getGPUScore(gpuDetails.model) : { score: 0 };
    const cpuScore = specs.getCPUScore(cpuDetails.brand);
    const freeRAM = Math.round(totalRAM * 0.6);
    const usedRAM = totalRAM - freeRAM;

    const displayParts = [];
    if (cpuDetails.brand && cpuDetails.brand !== 'Unknown CPU') displayParts.push(cpuDetails.brand);
    displayParts.push(`${totalRAM}GB RAM`);
    if (gpuDetails.model) displayParts.push(gpuDetails.model);
    const displayName = `Custom: ${displayParts.join(' + ')}`;

    const hardware = {
        cpu: {
            brand: cpuDetails.brand,
            manufacturer: cpuDetails.manufacturer,
            family: 'Unknown',
            model: 'Unknown',
            speed: cpuDetails.speed,
            speedMax: cpuDetails.speed,
            cores: cpuDetails.cores,
            physicalCores: cpuDetails.physicalCores,
            processors: 1,
            cache: { l1d: 0, l1i: 0, l2: 0, l3: 0 },
            architecture: cpuDetails.architecture,
            score: cpuScore.score || 70
        },
        memory: {
            total: totalRAM,
            free: freeRAM,
            used: usedRAM,
            available: freeRAM,
            usagePercent: Math.round((usedRAM / totalRAM) * 100),
            swapTotal: 0,
            swapUsed: 0,
            score: totalRAM >= 64 ? 55 : (totalRAM >= 32 ? 50 : (totalRAM >= 16 ? 40 : 25))
        },
        gpu: {
            model: gpuDetails.model || 'No GPU detected',
            vendor: gpuDetails.vendor || 'Unknown',
            vram: vram,
            vramPerGPU: vram,
            vramDynamic: false,
            dedicated: gpuDetails.dedicated,
            driverVersion: 'Simulated',
            gpuCount: 1,
            isMultiGPU: false,
            all: gpuDetails.model ? [{
                model: gpuDetails.model,
                vram: vram,
                vendor: gpuDetails.vendor
            }] : [],
            displays: 1,
            score: gpuSpecs.score || 0,
            unified: isUnified,
            backend: backend
        },
        system: {
            manufacturer: isApple ? 'Apple' : 'Simulated System',
            model: displayName,
            version: 'Simulated'
        },
        os: {
            platform: platform,
            distro: isApple ? 'macOS' : 'Linux',
            release: 'Simulated',
            codename: 'Simulated',
            kernel: 'Simulated',
            arch: cpuDetails.architecture === 'Apple Silicon' ? 'arm64' : 'x64',
            hostname: 'simulated-host',
            logofile: ''
        },
        timestamp: Date.now(),
        summary: {
            bestBackend: backend,
            gpuModel: gpuDetails.model,
            effectiveMemory: effectiveMemory,
            systemRAM: totalRAM,
            totalVRAM: vram
        },
        _displayName: displayName
    };

    hardware.cpu.capabilities = {};
    if (cpuDetails.architecture === 'Apple Silicon') {
        hardware.cpu.capabilities.neon = true;
    } else {
        hardware.cpu.capabilities.avx2 = true;
    }

    return hardware;
}

function getProfile(key) {
    return HARDWARE_PROFILES[key] || null;
}

function getProfileKeys() {
    return Object.keys(HARDWARE_PROFILES);
}

function getProfilesByCategory() {
    const grouped = {};
    for (const [key, profile] of Object.entries(HARDWARE_PROFILES)) {
        const cat = profile.category;
        if (!grouped[cat]) grouped[cat] = {};
        grouped[cat][key] = profile;
    }
    return grouped;
}

function listProfiles() {
    const lines = [];
    const grouped = getProfilesByCategory();

    for (const [category, profiles] of Object.entries(grouped)) {
        const label = CATEGORY_LABELS[category] || category;
        lines.push(`\n  ${label}:`);
        for (const [key, profile] of Object.entries(profiles)) {
            const vramLabel = profile.gpu.unified
                ? `${profile.memory.total}GB unified`
                : (profile.gpu.vram > 0 ? `${profile.gpu.vram}GB VRAM` : 'No GPU');
            const ramLabel = profile.gpu.unified ? '' : `, ${profile.memory.total}GB RAM`;
            lines.push(`    ${key.padEnd(14)} ${profile.displayName.padEnd(38)} ${vramLabel}${ramLabel}`);
        }
    }

    return lines;
}

module.exports = {
    HARDWARE_PROFILES,
    buildFullHardwareObject,
    buildCustomHardwareObject,
    getProfile,
    getProfileKeys,
    getProfilesByCategory,
    listProfiles,
    CATEGORY_LABELS
};
