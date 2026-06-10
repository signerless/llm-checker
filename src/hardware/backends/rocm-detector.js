/**
 * ROCm Detector
 * Detects AMD GPUs using rocm-smi, rocminfo, lspci, and sysfs
 * Supports multi-GPU setups and ROCm capabilities
 * Falls back to lspci/sysfs when ROCm tools are not installed
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class ROCmDetector {
    constructor() {
        this.cache = null;
        this.isAvailable = null;
        this.detectionMethod = null;  // 'rocm-smi', 'rocminfo', 'lspci', 'sysfs'
    }

    // AMD PCI device IDs for model name resolution
    static AMD_DEVICE_IDS = {
        // RDNA 4 / Radeon AI PRO
        '7551': { name: 'AMD Radeon AI PRO R9700', vram: 32 },
        '7590': { name: 'AMD Radeon RX 9060 XT', vram: 16 },
        '7580': { name: 'AMD Radeon RX 9070 XT', vram: 16 },
        '7581': { name: 'AMD Radeon RX 9070', vram: 16 },
        // RDNA 3 (RX 7000 series)
        '744c': { name: 'AMD Radeon RX 7900 XTX', vram: 24 },
        '7448': { name: 'AMD Radeon RX 7900 XT', vram: 20 },
        '7460': { name: 'AMD Radeon RX 7900 GRE', vram: 16 },
        '7480': { name: 'AMD Radeon RX 7800 XT', vram: 16 },
        '7481': { name: 'AMD Radeon RX 7700 XT', vram: 12 },
        '7483': { name: 'AMD Radeon RX 7600', vram: 8 },
        '7484': { name: 'AMD Radeon RX 7600 XT', vram: 16 },
        // RDNA 2 (RX 6000 series)
        '73a5': { name: 'AMD Radeon RX 6950 XT', vram: 16 },
        '73bf': { name: 'AMD Radeon RX 6900 XT', vram: 16 },
        '73a3': { name: 'AMD Radeon RX 6800 XT', vram: 16 },
        '73a2': { name: 'AMD Radeon RX 6800', vram: 16 },
        '73df': { name: 'AMD Radeon RX 6700 XT', vram: 12 },
        '73ff': { name: 'AMD Radeon RX 6600 XT', vram: 8 },
        '73e3': { name: 'AMD Radeon RX 6600', vram: 8 },
        // CDNA / Instinct
        '740f': { name: 'AMD Instinct MI300X', vram: 192 },
        '740c': { name: 'AMD Instinct MI300A', vram: 128 },
        '7408': { name: 'AMD Instinct MI250X', vram: 128 },
        '740a': { name: 'AMD Instinct MI250', vram: 64 },
        '738c': { name: 'AMD Instinct MI210', vram: 64 },
        '7388': { name: 'AMD Instinct MI100', vram: 32 },
    };

    /**
     * Check if AMD GPU is available (ROCm tools, lspci, or sysfs)
     */
    checkAvailability() {
        if (this.isAvailable !== null) {
            return this.isAvailable;
        }

        // Only check on Linux
        if (process.platform !== 'linux') {
            // On non-Linux, only ROCm tools matter
            try {
                execSync('rocm-smi --version', {
                    encoding: 'utf8',
                    timeout: 5000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                this.isAvailable = true;
                this.detectionMethod = 'rocm-smi';
                return true;
            } catch (e) {
                this.isAvailable = false;
                return false;
            }
        }

        // 1. Try rocm-smi
        try {
            execSync('rocm-smi --version', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            this.isAvailable = true;
            this.detectionMethod = 'rocm-smi';
            return true;
        } catch (e) {
            // Continue to next method
        }

        // 2. Try rocminfo
        try {
            execSync('rocminfo', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            this.isAvailable = true;
            this.detectionMethod = 'rocminfo';
            return true;
        } catch (e) {
            // Continue to next method
        }

        // 3. Try lspci for AMD GPUs (vendor ID 1002)
        try {
            const lspci = execSync('lspci | grep -i "VGA\\|3D\\|Display" | grep -i "AMD\\|ATI\\|Radeon"', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            if (lspci.trim().length > 0) {
                this.isAvailable = true;
                this.detectionMethod = 'lspci';
                return true;
            }
        } catch (e) {
            // Continue to next method
        }

        // 4. Try sysfs for AMD GPUs (vendor 0x1002)
        try {
            const drmPath = '/sys/class/drm';
            const entries = fs.readdirSync(drmPath);
            const hasAMD = entries.some(node => {
                try {
                    const vendorPath = path.join(drmPath, node, 'device/vendor');
                    const vendor = fs.readFileSync(vendorPath, 'utf8').trim();
                    return vendor === '0x1002';  // AMD vendor ID
                } catch (e) {
                    return false;
                }
            });
            if (hasAMD) {
                this.isAvailable = true;
                this.detectionMethod = 'sysfs';
                return true;
            }
        } catch (e) {
            // No sysfs access
        }

        this.isAvailable = false;
        return false;
    }

    /**
     * Detect all AMD GPUs and their capabilities
     */
    detect() {
        if (!this.checkAvailability()) {
            return null;
        }

        if (this.cache) {
            return this.cache;
        }

        try {
            const info = this.getGPUInfo();
            this.cache = info;
            return info;
        } catch (error) {
            return null;
        }
    }

    /**
     * Get detailed GPU information using best available method
     */
    getGPUInfo() {
        const result = {
            gpus: [],
            rocmVersion: null,
            totalVRAM: 0,
            totalSharedMemory: 0,
            backend: 'rocm',
            isMultiGPU: false,
            speedCoefficient: 0
        };

        // Try methods in order of detail level
        let detected = false;

        // 1. Try rocm-smi (most detailed)
        if (this.detectionMethod === 'rocm-smi' || !this.detectionMethod) {
            detected = this._detectViaRocmSmi(result);
        }

        // 2. Try rocminfo
        if (!detected && (this.detectionMethod === 'rocminfo' || !this.detectionMethod)) {
            detected = this._detectViaRocmInfo(result);
        }

        // 3. Try lspci
        if (!detected && (this.detectionMethod === 'lspci' || !this.detectionMethod)) {
            detected = this._detectViaLspci(result);
        }

        // 4. Try sysfs
        if (!detected && (this.detectionMethod === 'sysfs' || !this.detectionMethod)) {
            detected = this._detectViaSysfs(result);
        }

        if (!detected || result.gpus.length === 0) {
            return null;
        }

        result.isMultiGPU = result.gpus.length > 1;
        result.speedCoefficient = result.gpus.length > 0
            ? Math.max(...result.gpus.map(g => g.speedCoefficient))
            : 0;

        return result;
    }

    /**
     * Detect GPUs via rocm-smi
     */
    _detectViaRocmSmi(result) {
        // Get ROCm version
        try {
            const versionOutput = execSync('rocm-smi --version', {
                encoding: 'utf8',
                timeout: 5000
            });
            const match = versionOutput.match(/(\d+\.\d+\.?\d*)/);
            if (match) {
                result.rocmVersion = match[1];
            }
        } catch (e) {
            return false;
        }

        try {
            // Get GPU list using rocm-smi
            const gpuList = execSync('rocm-smi --showproductname', {
                encoding: 'utf8',
                timeout: 10000
            });

            const gpuNames = this.parseRocmSmiProductNames(gpuList);

            // Get VRAM info
            const memInfo = execSync('rocm-smi --showmeminfo vram', {
                encoding: 'utf8',
                timeout: 10000
            });

            const gpuMemory = this.parseRocmSmiMemoryInfo(memInfo);

            // Get temperature and utilization
            let temps = {};
            let utils = {};
            try {
                const tempInfo = execSync('rocm-smi --showtemp', {
                    encoding: 'utf8',
                    timeout: 5000
                });
                const tempMatches = tempInfo.matchAll(/GPU\[(\d+)\].*?Temperature.*?:\s*(\d+\.?\d*)/g);
                for (const match of tempMatches) {
                    temps[parseInt(match[1])] = parseFloat(match[2]);
                }

                const utilInfo = execSync('rocm-smi --showuse', {
                    encoding: 'utf8',
                    timeout: 5000
                });
                const utilMatches = utilInfo.matchAll(/GPU\[(\d+)\].*?GPU use.*?:\s*(\d+)/g);
                for (const match of utilMatches) {
                    utils[parseInt(match[1])] = parseInt(match[2]);
                }
            } catch (e) {
                // Continue without temp/util
            }

            // Build GPU list
            const numGPUs = Math.max(gpuNames.length, Object.keys(gpuMemory).length);
            for (let i = 0; i < numGPUs; i++) {
                const name = gpuNames[i] || `AMD GPU ${i}`;
                const detectedVram = gpuMemory[i];
                const memoryProfile = this.resolveGpuMemoryProfile(name, detectedVram);
                const vram = memoryProfile.total;

                if (!Number.isFinite(vram) || vram <= 0) {
                    continue;
                }

                const gpu = {
                    index: i,
                    name: name,
                    type: memoryProfile.type,
                    memory: {
                        total: vram,
                        free: vram,
                        used: 0,
                        dedicated: memoryProfile.dedicated,
                        shared: memoryProfile.shared
                    },
                    dedicatedMemory: memoryProfile.dedicated,
                    sharedMemory: memoryProfile.shared,
                    unifiedMemory: memoryProfile.type === 'integrated' ? memoryProfile.shared : 0,
                    temperature: temps[i] || 0,
                    utilization: utils[i] || 0,
                    capabilities: this.getGPUCapabilities(name),
                    speedCoefficient: this.calculateSpeedCoefficient(name, vram)
                };

                result.gpus.push(gpu);
                result.totalVRAM += memoryProfile.type === 'integrated' ? memoryProfile.dedicated : vram;
                result.totalSharedMemory += memoryProfile.type === 'integrated' ? memoryProfile.shared : 0;
            }

            return result.gpus.length > 0;
        } catch (e) {
            return false;
        }
    }

    parseRocmSmiProductNames(productOutput) {
        const names = [];
        const gfxFallbacks = {};
        const deviceFallbacks = {};
        const lines = String(productOutput || '').split('\n');

        for (const line of lines) {
            let match = line.match(/GPU\[(\d+)\]\s*:\s*Card Series\s*:\s*(.+)$/i);
            if (match) {
                names[parseInt(match[1], 10)] = this.normalizeRocmGpuName(match[2]);
                continue;
            }

            match = line.match(/GPU\[(\d+)\]\s*:\s*Card Model\s*:\s*(?:0x)?([0-9a-f]{4})/i);
            if (match) {
                const deviceInfo = ROCmDetector.AMD_DEVICE_IDS[String(match[2]).toLowerCase()];
                if (deviceInfo?.name) {
                    deviceFallbacks[parseInt(match[1], 10)] = deviceInfo.name;
                }
                continue;
            }

            match = line.match(/GPU\[(\d+)\]\s*:\s*GFX Version\s*:\s*(gfx\d+)/i);
            if (match) {
                gfxFallbacks[parseInt(match[1], 10)] = match[2].toLowerCase();
            }
        }

        const maxIndex = Math.max(
            names.length - 1,
            ...Object.keys(gfxFallbacks).map(Number),
            ...Object.keys(deviceFallbacks).map(Number),
            -1
        );

        for (let index = 0; index <= maxIndex; index += 1) {
            if (!names[index]) {
                names[index] = deviceFallbacks[index] || this.resolveGfxDisplayName(gfxFallbacks[index]);
            }
        }

        return names;
    }

    normalizeRocmGpuName(value) {
        return String(value || '')
            .replace(/^GFX Version\s*:\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    resolveGfxDisplayName(gfxVersion) {
        const gfx = String(gfxVersion || '').toLowerCase().trim();
        if (!gfx) return null;

        if (gfx === 'gfx1151') return 'AMD Radeon 8060S (gfx1151)';
        if (gfx === 'gfx1150' || gfx === 'gfx1152') return `AMD Strix Halo GPU (${gfx})`;
        if (gfx === 'gfx1103') return 'AMD Radeon 780M (gfx1103)';
        if (gfx === 'gfx1200' || gfx === 'gfx1201') return `AMD RDNA 4 GPU (${gfx})`;

        return gfx;
    }

    parseRocmSmiMemoryInfo(memInfo) {
        const gpuMemory = {};
        const memLines = String(memInfo || '').split('\n');

        for (const line of memLines) {
            if (/Total\s+Used\s+Memory/i.test(line)) continue;

            const lineMatch =
                line.match(/GPU\[(\d+)\]\s*:\s*VRAM\s+Total\s+Memory\s*(?:\(([^)]+)\))?\s*:\s*(\d+)/i) ||
                line.match(/GPU\[(\d+)\].*?\bTotal\s+Memory\s*(?:\(([^)]+)\))?\s*:\s*(\d+)/i);
            if (!lineMatch) continue;

            const idx = parseInt(lineMatch[1], 10);
            const unitHint = lineMatch[2] || '';
            const rawValue = parseInt(lineMatch[3], 10);

            if (!Number.isFinite(rawValue) || rawValue <= 0) continue;
            gpuMemory[idx] = this.normalizeRocmMemoryToGB(rawValue, unitHint);
        }

        return gpuMemory;
    }

    /**
     * Normalize rocm-smi memory values to GB.
     * rocm-smi may report bytes "(B)" or MiB depending on version/system.
     */
    normalizeRocmMemoryToGB(value, unitHint = '') {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue) || numericValue <= 0) {
            return 0;
        }

        const unit = String(unitHint || '').toLowerCase();

        if (unit.includes('gib') || unit.includes('gb')) {
            return Math.round(numericValue);
        }

        if (unit.includes('mib') || unit.includes('mb')) {
            return Math.round(numericValue / 1024);
        }

        if (unit.includes('kib') || unit.includes('kb')) {
            return Math.round(numericValue / (1024 * 1024));
        }

        if (unit === 'b' || unit === 'bytes') {
            return Math.round(numericValue / (1024 ** 3));
        }

        // Unit was not provided. Use value magnitude heuristics.
        if (numericValue >= 1024 ** 3) {
            return Math.round(numericValue / (1024 ** 3));
        }
        if (numericValue >= 1024) {
            return Math.round(numericValue / 1024);
        }

        return Math.round(numericValue);
    }

    /**
     * Parse rocminfo output into deduplicated GPU agents.
     */
    parseRocmInfoGpuAgents(rocmInfoOutput) {
        const text = String(rocmInfoOutput || '');
        if (!text.trim()) {
            return [];
        }

        const lines = text.split('\n');
        const agents = [];
        let current = null;

        const pushCurrent = () => {
            if (current) {
                agents.push(current);
                current = null;
            }
        };

        for (const rawLine of lines) {
            const line = String(rawLine || '');

            const agentMatch = line.match(/^\s*Agent\s+(\d+)\s*:?\s*$/i);
            if (agentMatch) {
                pushCurrent();
                current = { index: parseInt(agentMatch[1], 10) };
                continue;
            }

            if (!current) continue;

            let match = line.match(/^\s*Name:\s*(.+)$/i);
            if (match) {
                const value = match[1].trim();
                if (!current.name) {
                    current.name = value;
                } else {
                    if (!Array.isArray(current.aliases)) {
                        current.aliases = [];
                    }
                    current.aliases.push(value);
                }
                continue;
            }

            match = line.match(/^\s*Marketing Name:\s*(.+)$/i);
            if (match) {
                current.marketingName = match[1].trim();
                continue;
            }

            match = line.match(/^\s*Device Type:\s*(.+)$/i);
            if (match) {
                current.deviceType = match[1].trim().toLowerCase();
                continue;
            }

            match = line.match(/^\s*Uuid:\s*(.+)$/i);
            if (match) {
                current.uuid = match[1].trim();
            }
        }

        pushCurrent();

        const deduped = new Map();
        for (const agent of agents) {
            if (!this.isRocmGpuAgent(agent)) continue;

            const displayName = this.getRocmAgentDisplayName(agent);
            const key = this.getRocmAgentKey(agent, displayName);
            if (!deduped.has(key)) {
                deduped.set(key, { name: displayName, source: agent });
            }
        }

        return Array.from(deduped.values());
    }

    isRocmGpuAgent(agent = {}) {
        const deviceType = String(agent.deviceType || '').toLowerCase();
        if (deviceType && deviceType !== 'gpu') {
            return false;
        }

        const probe = [
            agent.marketingName,
            agent.name,
            ...(Array.isArray(agent.aliases) ? agent.aliases : [])
        ].join(' ').toLowerCase();

        if (!probe) return false;
        if (probe.includes('cpu')) return false;

        return /(gfx\d{3,}|amd|radeon|instinct|rx\s*\d{3,4}|mi\d{3,4})/i.test(probe);
    }

    getRocmAgentDisplayName(agent = {}) {
        const candidates = [
            agent.marketingName,
            agent.name,
            ...(Array.isArray(agent.aliases) ? agent.aliases : [])
        ]
            .map((item) => String(item || '').trim())
            .filter(Boolean)
            .filter((item) => item.toLowerCase() !== 'n/a');

        const descriptive = candidates.find((item) => !this.isGenericRocmName(item) && !/^gfx\d+$/i.test(item));
        if (descriptive) return descriptive;

        const gfx = candidates.find((item) => /^gfx\d+$/i.test(item) || /--gfx\d+/i.test(item));
        if (gfx) return this.resolveGfxDisplayName((gfx.match(/gfx\d+/i) || [gfx])[0]) || gfx;

        const fallback = candidates.find((item) => !this.isGenericRocmName(item));
        if (fallback) return fallback;

        return 'AMD GPU';
    }

    getRocmAgentKey(agent = {}, resolvedName = '') {
        const uuid = String(agent.uuid || '').trim().toLowerCase();
        if (uuid) {
            return `uuid:${uuid}`;
        }

        const probe = [
            resolvedName,
            agent.marketingName,
            agent.name,
            ...(Array.isArray(agent.aliases) ? agent.aliases : [])
        ].join(' ').toLowerCase();
        const gfxMatch = probe.match(/\bgfx\d{3,4}\b/);
        if (gfxMatch) {
            return `gfx:${gfxMatch[0]}`;
        }

        const normalizedName = String(resolvedName || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();

        if (normalizedName) {
            return `name:${normalizedName}`;
        }

        return `agent:${agent.index || 0}`;
    }

    isGenericRocmName(name = '') {
        const lower = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
        return lower === 'amd' ||
            lower === 'advanced micro devices' ||
            lower === 'advanced micro devices, inc.' ||
            lower === 'advanced micro devices, inc. [amd/ati]' ||
            lower.startsWith('amdgcn-amd-amdhsa--');
    }

    isLikelyIntegratedGPU(name = '') {
        const nameLower = String(name || '').toLowerCase();
        if (!nameLower) return false;

        if (nameLower.includes('integrated') || nameLower.includes('apu')) return true;
        if (nameLower.includes('radeon graphics') && !nameLower.includes('rx')) return true;
        if (nameLower.includes('radeon 8060s') || nameLower.includes('radeon 890m') ||
            nameLower.includes('radeon 880m') || nameLower.includes('radeon 780m') ||
            nameLower.includes('radeon 680m')) return true;
        if (nameLower.includes('gfx1150') || nameLower.includes('gfx1151') || nameLower.includes('gfx1152')) return true;
        if (nameLower.includes('gfx1103') || nameLower.includes('gfx1035')) return true;

        return false;
    }

    applyIntegratedVramHeuristic(name, vramGB) {
        const numericVram = Number(vramGB);
        if (!Number.isFinite(numericVram) || numericVram <= 0) {
            return numericVram;
        }

        if (!this.isLikelyIntegratedGPU(name)) {
            return numericVram;
        }

        if (numericVram >= 4) {
            return numericVram;
        }

        const estimated = this.estimateVRAMFromModel(name);
        if (Number.isFinite(estimated) && estimated > numericVram) {
            return estimated;
        }

        return 8;
    }

    resolveGpuMemoryProfile(name, detectedVramGB) {
        const detected = Number(detectedVramGB);
        const detectedVram = Number.isFinite(detected) && detected > 0 ? detected : 0;

        if (!this.isLikelyIntegratedGPU(name)) {
            const total = detectedVram || this.estimateVRAMFromModel(name) || 8;
            return {
                type: 'dedicated',
                total,
                dedicated: total,
                shared: 0
            };
        }

        const sysfsProfile = this.getIntegratedMemoryProfile();
        const estimatedShared = this.applyIntegratedVramHeuristic(
            name,
            detectedVram || this.estimateVRAMFromModel(name)
        );
        const dedicated = sysfsProfile.dedicated || detectedVram || 0;
        const shared = Math.max(sysfsProfile.shared || 0, estimatedShared || 0, dedicated);
        const total = shared || dedicated || this.estimateVRAMFromModel(name) || 8;

        return {
            type: 'integrated',
            total,
            dedicated,
            shared: total
        };
    }

    getIntegratedMemoryProfile() {
        const dedicatedValues = this.readAmdSysfsMemoryValues('mem_info_vram_total');
        const sharedValues = this.readAmdSysfsMemoryValues('mem_info_gtt_total');
        const totalSystemGB = Math.max(1, Math.round(os.totalmem() / (1024 ** 3)));
        const rawShared = sharedValues.length > 0 ? Math.max(...sharedValues) : 0;

        return {
            dedicated: dedicatedValues.length > 0 ? Math.max(...dedicatedValues) : 0,
            shared: rawShared > 0 ? Math.min(rawShared, Math.round(totalSystemGB * 0.95)) : 0
        };
    }

    readAmdSysfsMemoryValues(fileName) {
        const values = [];
        const candidatePaths = [];

        try {
            const moduleRoot = '/sys/module/amdgpu/drivers/pci:amdgpu';
            for (const entry of fs.readdirSync(moduleRoot)) {
                candidatePaths.push(path.join(moduleRoot, entry, fileName));
            }
        } catch (e) {
            // sysfs may be unavailable or restricted
        }

        try {
            const drmRoot = '/sys/class/drm';
            for (const entry of fs.readdirSync(drmRoot)) {
                if (!/^card\d+$/.test(entry)) continue;
                candidatePaths.push(path.join(drmRoot, entry, 'device', fileName));
            }
        } catch (e) {
            // sysfs may be unavailable or restricted
        }

        const seen = new Set();
        for (const candidatePath of candidatePaths) {
            if (seen.has(candidatePath)) continue;
            seen.add(candidatePath);

            try {
                const raw = parseInt(fs.readFileSync(candidatePath, 'utf8').trim(), 10);
                const gb = this.normalizeRocmMemoryToGB(raw, 'B');
                if (Number.isFinite(gb) && gb > 0) {
                    values.push(gb);
                }
            } catch (e) {
                continue;
            }
        }

        return values;
    }

    /**
     * Detect GPUs via rocminfo
     */
    _detectViaRocmInfo(result) {
        try {
            const rocmInfo = execSync('rocminfo', {
                encoding: 'utf8',
                timeout: 10000
            });

            const agents = this.parseRocmInfoGpuAgents(rocmInfo);
            for (let index = 0; index < agents.length; index += 1) {
                const name = agents[index].name;
                let vram = this.estimateVRAMFromGfxName(name);
                const memoryProfile = this.resolveGpuMemoryProfile(name, vram);
                vram = memoryProfile.total;

                if (!Number.isFinite(vram) || vram <= 0) {
                    vram = 8;
                }

                result.gpus.push({
                    index,
                    name,
                    type: memoryProfile.type,
                    memory: {
                        total: vram,
                        free: vram,
                        used: 0,
                        dedicated: memoryProfile.dedicated,
                        shared: memoryProfile.shared
                    },
                    dedicatedMemory: memoryProfile.dedicated,
                    sharedMemory: memoryProfile.shared,
                    unifiedMemory: memoryProfile.type === 'integrated' ? memoryProfile.shared : 0,
                    capabilities: this.getGPUCapabilities(name),
                    speedCoefficient: this.calculateSpeedCoefficient(name, vram)
                });
                result.totalVRAM += memoryProfile.type === 'integrated' ? memoryProfile.dedicated : vram;
                result.totalSharedMemory += memoryProfile.type === 'integrated' ? memoryProfile.shared : 0;
            }

            return result.gpus.length > 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * Detect GPUs via lspci (fallback when ROCm is not installed)
     */
    _detectViaLspci(result) {
        try {
            const lspciOutput = execSync('lspci -nn | grep -i "VGA\\|3D\\|Display"', {
                encoding: 'utf8',
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            const lines = lspciOutput.trim().split('\n');
            let idx = 0;

            for (const line of lines) {
                // Match AMD/ATI VGA devices: "03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XT/7900 XTX/7900M] [1002:744c]"
                const amdMatch = line.match(/\[(?:AMD|ATI)\].*?\[([0-9a-f]{4}):([0-9a-f]{4})\]/i) ||
                                 line.match(/(?:AMD|ATI|Radeon).*?\[([0-9a-f]{4}):([0-9a-f]{4})\]/i);

                if (!amdMatch) continue;

                const vendorId = amdMatch[1].toLowerCase();
                if (vendorId !== '1002') continue;  // Not AMD

                const deviceId = amdMatch[2].toLowerCase();

                // Try to get model name from device ID map
                const deviceInfo = ROCmDetector.AMD_DEVICE_IDS[deviceId];

                // Also try to extract name from lspci line itself
                let lspciName = null;
                const nameMatch = line.match(/\[(?:AMD|ATI)\]\s*(.+?)\s*\[/);
                if (nameMatch) {
                    lspciName = nameMatch[1].trim();
                }

                const name = deviceInfo?.name || this._resolveAMDModelName(lspciName, deviceId) || `AMD GPU (${deviceId})`;
                const vram = deviceInfo?.vram || this.estimateVRAMFromModel(name);

                // Try to get VRAM from sysfs for this specific device
                const sysfsVram = this._getVRAMFromSysfsForDevice(deviceId);

                result.gpus.push({
                    index: idx,
                    name: name,
                    memory: {
                        total: sysfsVram || vram,
                        free: sysfsVram || vram,
                        used: 0
                    },
                    capabilities: this.getGPUCapabilities(name),
                    speedCoefficient: this.calculateSpeedCoefficient(name, sysfsVram || vram)
                });
                result.totalVRAM += sysfsVram || vram;
                idx++;
            }

            return result.gpus.length > 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * Detect GPUs via sysfs (last resort fallback)
     */
    _detectViaSysfs(result) {
        try {
            const drmPath = '/sys/class/drm';
            const cards = fs.readdirSync(drmPath).filter(f => f.startsWith('card') && !f.includes('-'));
            let idx = 0;

            for (const card of cards) {
                try {
                    const vendorPath = path.join(drmPath, card, 'device/vendor');
                    const vendor = fs.readFileSync(vendorPath, 'utf8').trim();
                    if (vendor !== '0x1002') continue;  // Not AMD

                    const devicePath = path.join(drmPath, card, 'device/device');
                    const deviceId = fs.readFileSync(devicePath, 'utf8').trim().replace('0x', '').toLowerCase();

                    const deviceInfo = ROCmDetector.AMD_DEVICE_IDS[deviceId];
                    const name = deviceInfo?.name || `AMD GPU (${deviceId})`;
                    let vram = deviceInfo?.vram || this.estimateVRAMFromModel(name);

                    // Try to read VRAM from sysfs
                    const vramPaths = [
                        path.join(drmPath, card, 'device/mem_info_vram_total'),
                        path.join(drmPath, card, 'device/resource'),
                    ];

                    for (const vramPath of vramPaths) {
                        try {
                            if (vramPath.endsWith('mem_info_vram_total')) {
                                const bytes = parseInt(fs.readFileSync(vramPath, 'utf8').trim());
                                if (bytes > 0) {
                                    vram = Math.round(bytes / (1024 * 1024 * 1024));
                                    break;
                                }
                            }
                        } catch (e) {
                            continue;
                        }
                    }

                    result.gpus.push({
                        index: idx,
                        name: name,
                        memory: { total: vram, free: vram, used: 0 },
                        capabilities: this.getGPUCapabilities(name),
                        speedCoefficient: this.calculateSpeedCoefficient(name, vram)
                    });
                    result.totalVRAM += vram;
                    idx++;
                } catch (e) {
                    continue;
                }
            }

            return result.gpus.length > 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * Try to get VRAM from sysfs for a specific device ID
     */
    _getVRAMFromSysfsForDevice(deviceId) {
        try {
            const drmPath = '/sys/class/drm';
            const cards = fs.readdirSync(drmPath).filter(f => f.startsWith('card') && !f.includes('-'));

            for (const card of cards) {
                try {
                    const devPath = path.join(drmPath, card, 'device/device');
                    const devId = fs.readFileSync(devPath, 'utf8').trim().replace('0x', '').toLowerCase();
                    if (devId !== deviceId) continue;

                    const vramPath = path.join(drmPath, card, 'device/mem_info_vram_total');
                    const bytes = parseInt(fs.readFileSync(vramPath, 'utf8').trim());
                    if (bytes > 0) {
                        return Math.round(bytes / (1024 * 1024 * 1024));
                    }
                } catch (e) {
                    continue;
                }
            }
        } catch (e) {
            // sysfs not available
        }
        return null;
    }

    /**
     * Resolve AMD model name from lspci description and device ID
     */
    _resolveAMDModelName(lspciName, deviceId) {
        if (!lspciName) return null;

        // lspci often shows names like "Navi 31 [Radeon RX 7900 XT/7900 XTX/7900M]"
        // Extract the bracketed name if present
        const bracketMatch = lspciName.match(/\[(.+?)\]/);
        if (bracketMatch) {
            const bracketName = bracketMatch[1];
            // If it contains multiple variants separated by /, pick based on device ID
            if (bracketName.includes('/')) {
                const variants = bracketName.split('/').map(v => v.trim());
                // Try to match device ID to specific variant
                const deviceInfo = ROCmDetector.AMD_DEVICE_IDS[deviceId];
                if (deviceInfo) return deviceInfo.name;
                // Unknown device ID: lspci groups several SKUs behind one string
                // (e.g. "Radeon RX 7900 XT/7900 XTX/7900M"). Committing to variants[0]
                // mislabels the card as the lowest-tier SKU and yields the wrong VRAM,
                // so keep the full variant list — honestly ambiguous beats confidently
                // wrong.
                return `AMD Radeon ${variants.join('/')}`;
            }
            return `AMD Radeon ${bracketName}`;
        }

        // If name already looks like a GPU model, use it
        if (lspciName.match(/R[X5-9]\s*\d+/i) || lspciName.match(/MI\d+/i)) {
            return `AMD ${lspciName}`;
        }

        return null;
    }

    /**
     * Get GPU capabilities based on model name
     */
    getGPUCapabilities(name) {
        const nameLower = (name || '').toLowerCase();

        const capabilities = {
            fp16: true,
            bf16: false,
            int8: true,
            matrixCores: false,
            infinityCache: false,
            architecture: 'Unknown',
            gfxVersion: null
        };

        // RDNA 4 / Radeon AI PRO
        if (nameLower.includes('r9700') || nameLower.includes('ai pro') ||
            nameLower.includes('rx 9070') || nameLower.includes('rx 9060') ||
            nameLower.includes('gfx1200') || nameLower.includes('gfx1201')) {
            capabilities.bf16 = true;
            capabilities.matrixCores = true;
            capabilities.infinityCache = true;
            capabilities.architecture = 'RDNA 4';
            capabilities.gfxVersion = 'gfx1200';
        }
        // RDNA 3 (RX 7000 series)
        else if (nameLower.includes('7900') || nameLower.includes('7800') ||
            nameLower.includes('7700') || nameLower.includes('7600') ||
            nameLower.includes('gfx1100') || nameLower.includes('gfx1101') ||
            nameLower.includes('gfx1102')) {
            capabilities.bf16 = true;
            capabilities.matrixCores = true;  // AI Accelerators
            capabilities.infinityCache = true;
            capabilities.architecture = 'RDNA 3';
            capabilities.gfxVersion = 'gfx1100';
        }
        // RDNA 2 (RX 6000 series)
        else if (nameLower.includes('6900') || nameLower.includes('6800') ||
                 nameLower.includes('6700') || nameLower.includes('6600') ||
                 nameLower.includes('gfx1030') || nameLower.includes('gfx1031') ||
                 nameLower.includes('gfx1032')) {
            capabilities.infinityCache = true;
            capabilities.architecture = 'RDNA 2';
            capabilities.gfxVersion = 'gfx1030';
        }
        // CDNA 2/3 (Instinct MI200/MI300 series)
        else if (nameLower.includes('mi300') || nameLower.includes('mi250') ||
                 nameLower.includes('mi210') || nameLower.includes('gfx940') ||
                 nameLower.includes('gfx90a')) {
            capabilities.bf16 = true;
            capabilities.matrixCores = true;
            capabilities.architecture = 'CDNA';
            capabilities.gfxVersion = nameLower.includes('mi300') ? 'gfx940' : 'gfx90a';
        }
        // CDNA (Instinct MI100)
        else if (nameLower.includes('mi100') || nameLower.includes('gfx908')) {
            capabilities.bf16 = true;
            capabilities.matrixCores = true;
            capabilities.architecture = 'CDNA';
            capabilities.gfxVersion = 'gfx908';
        }
        // RDNA 1 (RX 5000 series)
        else if (nameLower.includes('5700') || nameLower.includes('5600') ||
                 nameLower.includes('5500') || nameLower.includes('gfx1010')) {
            capabilities.architecture = 'RDNA 1';
            capabilities.gfxVersion = 'gfx1010';
        }

        return capabilities;
    }

    /**
     * Estimate VRAM from model name
     */
    estimateVRAMFromModel(name) {
        const nameLower = (name || '').toLowerCase();

        // Known integrated/APU labels where ROCm can report small dedicated aperture
        if (nameLower.includes('gfx1151') || nameLower.includes('gfx1150') || nameLower.includes('gfx1152')) return 16;
        if (nameLower.includes('radeon 8060s')) return 16;
        if (nameLower.includes('radeon 890m')) return 16;
        if (nameLower.includes('radeon 880m')) return 12;
        if (nameLower.includes('radeon 780m')) return 8;
        if (nameLower.includes('radeon 680m')) return 8;

        // RDNA 4 / Radeon AI PRO
        if (nameLower.includes('rx 9070 xt')) return 16;
        if (nameLower.includes('rx 9070')) return 16;
        if (nameLower.includes('rx 9060 xt')) return 16;
        if (nameLower.includes('rx 9060')) return 8;
        if (nameLower.includes('r9700') || nameLower.includes('ai pro r9700')) return 32;

        // RX 7000 series
        if (nameLower.includes('7900 xtx')) return 24;
        if (nameLower.includes('7900 xt')) return 20;
        if (nameLower.includes('7900 gre')) return 16;
        if (nameLower.includes('7800 xt')) return 16;
        if (nameLower.includes('7700 xt')) return 12;
        if (nameLower.includes('7600')) return 8;

        // RX 6000 series
        if (nameLower.includes('6950 xt')) return 16;
        if (nameLower.includes('6900 xt')) return 16;
        if (nameLower.includes('6800 xt')) return 16;
        if (nameLower.includes('6800')) return 16;
        if (nameLower.includes('6750 xt')) return 12;
        if (nameLower.includes('6700 xt')) return 12;
        if (nameLower.includes('6700')) return 10;
        if (nameLower.includes('6650 xt')) return 8;
        if (nameLower.includes('6600')) return 8;

        // Instinct series
        if (nameLower.includes('mi300x')) return 192;
        if (nameLower.includes('mi300')) return 128;
        if (nameLower.includes('mi250x')) return 128;
        if (nameLower.includes('mi250')) return 64;
        if (nameLower.includes('mi210')) return 64;
        if (nameLower.includes('mi100')) return 32;

        return 8;  // Default
    }

    /**
     * Estimate VRAM from gfx name
     */
    estimateVRAMFromGfxName(name) {
        const nameLower = (name || '').toLowerCase();

        if (nameLower.includes('gfx1200') || nameLower.includes('gfx1201')) return 16; // RDNA 4 desktop default
        if (nameLower.includes('gfx1150') || nameLower.includes('gfx1151') || nameLower.includes('gfx1152')) return 16; // Strix Halo / Radeon 890M class
        if (nameLower.includes('gfx1100')) return 24;  // RX 7900 XTX
        if (nameLower.includes('gfx1101')) return 16;  // RX 7800
        if (nameLower.includes('gfx1102')) return 8;   // RX 7600
        if (nameLower.includes('gfx1103')) return 8;   // 780M class iGPU
        if (nameLower.includes('gfx1030')) return 16;  // RX 6900/6800
        if (nameLower.includes('gfx1031')) return 12;  // RX 6700
        if (nameLower.includes('gfx1032')) return 8;   // RX 6600
        if (nameLower.includes('gfx940')) return 128;  // MI300
        if (nameLower.includes('gfx90a')) return 64;   // MI250

        return 8;
    }

    /**
     * Calculate speed coefficient for LLM inference
     */
    calculateSpeedCoefficient(name, vramGB) {
        const nameLower = (name || '').toLowerCase();

        // Speed coefficients (tokens/sec per B params at Q4)
        const speedMap = new Map([
            // RDNA 4 / Radeon AI PRO
            ['ai pro r9700', 230],
            ['r9700', 230],
            ['rx 9070 xt', 190],
            ['rx 9070', 175],
            ['rx 9060 xt', 170],
            ['rx 9060', 150],
            ['radeon 8060s', 160],
            ['gfx1151', 160],
            ['gfx1150', 150],
            ['gfx1152', 150],

            // RX 7000 series (RDNA 3)
            ['7900 xtx', 200],
            ['7900 xt', 180],
            ['7900 gre', 160],
            ['7800 xt', 150],
            ['7700 xt', 120],
            ['7600', 90],

            // RX 6000 series (RDNA 2)
            ['6950 xt', 150],
            ['6900 xt', 140],
            ['6800 xt', 130],
            ['6800', 120],
            ['6750 xt', 100],
            ['6700 xt', 90],
            ['6700', 80],
            ['6600 xt', 70],
            ['6600', 60],

            // Instinct series
            ['mi300x', 400],
            ['mi300', 350],
            ['mi250x', 280],
            ['mi250', 250],
            ['mi210', 200],
            ['mi100', 150]
        ]);

        for (const [model, speed] of speedMap) {
            if (nameLower.includes(model)) {
                return speed;
            }
        }

        // Estimate based on VRAM if model not found
        if (vramGB >= 24) return 180;
        if (vramGB >= 16) return 140;
        if (vramGB >= 12) return 100;
        if (vramGB >= 8) return 70;
        return 40;
    }

    /**
     * Get primary GPU
     */
    getPrimaryGPU() {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return null;

        return info.gpus.reduce((best, gpu) => {
            if (!best) return gpu;
            if (gpu.memory.total > best.memory.total) return gpu;
            if (gpu.memory.total === best.memory.total &&
                gpu.speedCoefficient > best.speedCoefficient) return gpu;
            return best;
        }, null);
    }

    /**
     * Get hardware fingerprint for benchmarks
     */
    getFingerprint() {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return null;

        const primary = this.getPrimaryGPU();
        const gpuName = primary.name.toLowerCase()
            .replace(/amd|radeon|rx/gi, '')
            .replace(/\s+/g, '-')
            .trim();

        return `rocm-${gpuName}-${info.totalVRAM}gb${info.isMultiGPU ? '-x' + info.gpus.length : ''}`;
    }

    /**
     * Estimate inference speed for a model size
     */
    estimateTokensPerSecond(paramsB, quantization = 'Q4_K_M') {
        const info = this.detect();
        if (!info || info.gpus.length === 0) return 0;

        const gpu = this.getPrimaryGPU();

        const quantMult = {
            'FP16': 1.0,
            'Q8_0': 1.4,
            'Q6_K': 1.6,
            'Q5_K_M': 1.8,
            'Q5_0': 1.8,
            'Q4_K_M': 2.2,
            'Q4_0': 2.4,
            'Q3_K_M': 2.6,
            'Q2_K': 3.0,
            'IQ4_XS': 2.3,
            'IQ3_XXS': 2.8
        };

        const mult = quantMult[quantization] || 1.8;
        const baseSpeed = gpu.speedCoefficient / paramsB * mult;

        return Math.round(baseSpeed);
    }
}

module.exports = ROCmDetector;
