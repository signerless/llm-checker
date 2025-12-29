/**
 * CPU Detector
 * Detects CPU capabilities for LLM inference
 * Focuses on AVX2, AVX512, AMX, and other SIMD extensions
 */

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');

class CPUDetector {
    constructor() {
        this.cache = null;
    }

    /**
     * Detect CPU capabilities
     */
    detect() {
        if (this.cache) {
            return this.cache;
        }

        try {
            const info = this.getCPUInfo();
            this.cache = info;
            return info;
        } catch (error) {
            return this.getFallbackInfo();
        }
    }

    /**
     * Get detailed CPU information
     */
    getCPUInfo() {
        const cpus = os.cpus();
        const cpu = cpus[0] || {};

        const result = {
            brand: cpu.model || 'Unknown CPU',
            vendor: this.detectVendor(cpu.model),
            cores: {
                physical: this.getPhysicalCores(),
                logical: cpus.length,
                performance: 0,
                efficiency: 0
            },
            frequency: {
                base: cpu.speed || 0,
                max: this.getMaxFrequency()
            },
            cache: this.getCacheInfo(),
            capabilities: this.getCapabilities(),
            architecture: process.arch,
            backend: 'cpu',
            speedCoefficient: 0
        };

        // Detect P-core/E-core for hybrid CPUs (Intel 12th+ gen, Apple Silicon)
        const hybrid = this.detectHybridCores(result.brand);
        result.cores.performance = hybrid.performance;
        result.cores.efficiency = hybrid.efficiency;

        // Calculate speed coefficient
        result.speedCoefficient = this.calculateSpeedCoefficient(result);

        return result;
    }

    /**
     * Detect CPU vendor
     */
    detectVendor(brand) {
        const brandLower = (brand || '').toLowerCase();

        if (brandLower.includes('intel')) return 'Intel';
        if (brandLower.includes('amd')) return 'AMD';
        if (brandLower.includes('apple')) return 'Apple';
        if (brandLower.includes('arm')) return 'ARM';
        if (brandLower.includes('qualcomm')) return 'Qualcomm';

        return 'Unknown';
    }

    /**
     * Get physical core count
     */
    getPhysicalCores() {
        try {
            if (process.platform === 'darwin') {
                return parseInt(execSync('sysctl -n hw.physicalcpu', { encoding: 'utf8', timeout: 5000 }).trim());
            } else if (process.platform === 'linux') {
                const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
                const coreIds = new Set();
                const matches = cpuInfo.matchAll(/core id\s*:\s*(\d+)/g);
                for (const match of matches) {
                    coreIds.add(match[1]);
                }
                return coreIds.size || os.cpus().length;
            } else if (process.platform === 'win32') {
                const wmic = execSync('wmic cpu get NumberOfCores', { encoding: 'utf8', timeout: 5000 });
                const match = wmic.match(/\d+/);
                return match ? parseInt(match[0]) : os.cpus().length;
            }
        } catch (e) {
            return os.cpus().length;
        }
        return os.cpus().length;
    }

    /**
     * Get maximum CPU frequency
     */
    getMaxFrequency() {
        try {
            if (process.platform === 'darwin') {
                // macOS doesn't expose max frequency easily
                const cpus = os.cpus();
                return cpus.length > 0 ? cpus[0].speed : 0;
            } else if (process.platform === 'linux') {
                const maxFreq = fs.readFileSync(
                    '/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq',
                    'utf8'
                );
                return Math.round(parseInt(maxFreq) / 1000);  // kHz to MHz
            } else if (process.platform === 'win32') {
                const wmic = execSync('wmic cpu get MaxClockSpeed', { encoding: 'utf8', timeout: 5000 });
                const match = wmic.match(/\d+/);
                return match ? parseInt(match[0]) : 0;
            }
        } catch (e) {
            return os.cpus()[0]?.speed || 0;
        }
        return 0;
    }

    /**
     * Get CPU cache information
     */
    getCacheInfo() {
        const cache = {
            l1d: 0,
            l1i: 0,
            l2: 0,
            l3: 0
        };

        try {
            if (process.platform === 'darwin') {
                cache.l1d = parseInt(execSync('sysctl -n hw.l1dcachesize', { encoding: 'utf8', timeout: 5000 })) / 1024 || 0;
                cache.l1i = parseInt(execSync('sysctl -n hw.l1icachesize', { encoding: 'utf8', timeout: 5000 })) / 1024 || 0;
                cache.l2 = parseInt(execSync('sysctl -n hw.l2cachesize', { encoding: 'utf8', timeout: 5000 })) / 1024 / 1024 || 0;
                cache.l3 = parseInt(execSync('sysctl -n hw.l3cachesize', { encoding: 'utf8', timeout: 5000 })) / 1024 / 1024 || 0;
            } else if (process.platform === 'linux') {
                // Parse from /sys/devices/system/cpu/cpu0/cache/
                const cachePath = '/sys/devices/system/cpu/cpu0/cache';
                if (fs.existsSync(cachePath)) {
                    const indexes = fs.readdirSync(cachePath).filter(f => f.startsWith('index'));
                    for (const idx of indexes) {
                        try {
                            const level = fs.readFileSync(`${cachePath}/${idx}/level`, 'utf8').trim();
                            const type = fs.readFileSync(`${cachePath}/${idx}/type`, 'utf8').trim();
                            const size = fs.readFileSync(`${cachePath}/${idx}/size`, 'utf8').trim();

                            const sizeKB = parseInt(size.replace(/[KMG]/g, ''));
                            const multiplier = size.includes('M') ? 1024 : size.includes('G') ? 1024 * 1024 : 1;
                            const finalSize = sizeKB * multiplier;

                            if (level === '1' && type === 'Data') cache.l1d = finalSize;
                            else if (level === '1' && type === 'Instruction') cache.l1i = finalSize;
                            else if (level === '2') cache.l2 = finalSize / 1024;  // MB
                            else if (level === '3') cache.l3 = finalSize / 1024;  // MB
                        } catch (e) {
                            continue;
                        }
                    }
                }
            }
        } catch (e) {
            // Return zeros
        }

        return cache;
    }

    /**
     * Get CPU SIMD and acceleration capabilities
     */
    getCapabilities() {
        const caps = {
            sse: false,
            sse2: false,
            sse3: false,
            ssse3: false,
            sse4_1: false,
            sse4_2: false,
            avx: false,
            avx2: false,
            avx512: false,
            avx512_vnni: false,
            amx: false,  // Intel Advanced Matrix Extensions
            fma: false,
            f16c: false,
            neon: false,  // ARM NEON
            sve: false,   // ARM SVE
            dotprod: false,  // ARM dot product
            bestSimd: 'none'
        };

        try {
            if (process.platform === 'darwin') {
                // For Apple Silicon (ARM64), use ARM features
                if (process.arch === 'arm64') {
                    caps.neon = true;  // All Apple Silicon has NEON
                    caps.dotprod = true;
                    caps.f16c = true;
                    // Apple Silicon has excellent FP16 support
                } else {
                    // Intel Mac - check via sysctl
                    try {
                        const features = execSync('sysctl -n machdep.cpu.features', {
                            encoding: 'utf8',
                            timeout: 5000
                        }).toLowerCase();

                        const leafFeatures = execSync('sysctl -n machdep.cpu.leaf7_features', {
                            encoding: 'utf8',
                            timeout: 5000
                        }).toLowerCase();

                        caps.sse = features.includes('sse');
                        caps.sse2 = features.includes('sse2');
                        caps.sse3 = features.includes('sse3');
                        caps.ssse3 = features.includes('ssse3');
                        caps.sse4_1 = features.includes('sse4.1');
                        caps.sse4_2 = features.includes('sse4.2');
                        caps.avx = features.includes('avx1.0') || features.includes('avx ');
                        caps.avx2 = leafFeatures.includes('avx2');
                        caps.fma = features.includes('fma');
                        caps.f16c = leafFeatures.includes('f16c');

                        // Check for AVX-512 on Intel Macs
                        caps.avx512 = leafFeatures.includes('avx512');
                    } catch (e) {
                        // Intel Mac sysctl failed, assume basic SSE
                        caps.sse = caps.sse2 = true;
                    }
                }

            } else if (process.platform === 'linux') {
                // Linux - check /proc/cpuinfo
                const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8').toLowerCase();
                const flags = cpuInfo.match(/flags\s*:\s*(.+)/)?.[1] || '';

                caps.sse = flags.includes('sse ') || flags.includes(' sse');
                caps.sse2 = flags.includes('sse2');
                caps.sse3 = flags.includes('sse3');
                caps.ssse3 = flags.includes('ssse3');
                caps.sse4_1 = flags.includes('sse4_1');
                caps.sse4_2 = flags.includes('sse4_2');
                caps.avx = flags.includes('avx ') || flags.includes(' avx');
                caps.avx2 = flags.includes('avx2');
                caps.avx512 = flags.includes('avx512f');
                caps.avx512_vnni = flags.includes('avx512_vnni');
                caps.amx = flags.includes('amx_tile') || flags.includes('amx_int8');
                caps.fma = flags.includes('fma');
                caps.f16c = flags.includes('f16c');

                // ARM features
                if (process.arch === 'arm64') {
                    caps.neon = flags.includes('asimd') || flags.includes('neon');
                    caps.sve = flags.includes('sve');
                    caps.dotprod = flags.includes('asimddp');
                }

            } else if (process.platform === 'win32') {
                // Windows - use WMIC or assume based on CPU model
                const cpuName = os.cpus()[0]?.model?.toLowerCase() || '';

                // All modern x64 CPUs have SSE through SSE4.2
                if (process.arch === 'x64') {
                    caps.sse = caps.sse2 = caps.sse3 = caps.ssse3 = true;
                    caps.sse4_1 = caps.sse4_2 = true;

                    // Most post-2013 CPUs have AVX/AVX2
                    if (cpuName.includes('ryzen') || cpuName.includes('core')) {
                        caps.avx = true;
                        // Ryzen and Intel 4th gen+ have AVX2
                        if (cpuName.includes('ryzen') ||
                            cpuName.match(/core.*i[3579].*[4-9]\d{3}|1[0-4]\d{3}/)) {
                            caps.avx2 = true;
                            caps.fma = true;
                            caps.f16c = true;
                        }
                    }

                    // Intel 12th gen+ and Xeon Scalable have AVX-512
                    if (cpuName.includes('xeon') ||
                        cpuName.match(/12\d{3}|13\d{3}|14\d{3}/)) {
                        caps.avx512 = true;
                    }
                }
            }
        } catch (e) {
            // Assume modern x64 CPU has basic SIMD
            if (process.arch === 'x64') {
                caps.sse = caps.sse2 = true;
            }
        }

        // Determine best SIMD level
        if (caps.amx) caps.bestSimd = 'AMX';
        else if (caps.avx512) caps.bestSimd = 'AVX512';
        else if (caps.avx2) caps.bestSimd = 'AVX2';
        else if (caps.avx) caps.bestSimd = 'AVX';
        else if (caps.neon) caps.bestSimd = 'NEON';
        else if (caps.sse4_2) caps.bestSimd = 'SSE4.2';
        else if (caps.sse2) caps.bestSimd = 'SSE2';

        return caps;
    }

    /**
     * Detect hybrid core configuration
     */
    detectHybridCores(brand) {
        const brandLower = (brand || '').toLowerCase();
        const logicalCores = os.cpus().length;

        // Intel 12th+ gen hybrid
        if (brandLower.includes('intel') && brandLower.match(/12\d{3}|13\d{3}|14\d{3}/)) {
            // Estimate P/E core split (varies by SKU)
            if (brandLower.includes('i9')) {
                return { performance: 8, efficiency: logicalCores - 16 };
            } else if (brandLower.includes('i7')) {
                return { performance: 8, efficiency: Math.max(0, logicalCores - 16) };
            } else if (brandLower.includes('i5')) {
                return { performance: 6, efficiency: Math.max(0, logicalCores - 12) };
            }
        }

        // Apple Silicon (handled by apple-silicon.js, but fallback here)
        if (brandLower.includes('apple') || brandLower.includes('m1') ||
            brandLower.includes('m2') || brandLower.includes('m3') ||
            brandLower.includes('m4')) {
            const pCores = Math.ceil(logicalCores * 0.5);
            return { performance: pCores, efficiency: logicalCores - pCores };
        }

        // Non-hybrid
        return { performance: logicalCores, efficiency: 0 };
    }

    /**
     * Calculate speed coefficient for LLM inference
     */
    calculateSpeedCoefficient(info) {
        let base = 30;  // Base tokens/sec per B params

        // Adjust based on SIMD capabilities
        switch (info.capabilities.bestSimd) {
            case 'AMX':
                base = 100;  // Intel AMX is excellent for matrix ops
                break;
            case 'AVX512':
                base = 70;
                break;
            case 'AVX2':
                base = 50;
                break;
            case 'NEON':
                base = 45;  // ARM NEON is quite good
                break;
            case 'AVX':
                base = 35;
                break;
            default:
                base = 25;
        }

        // Adjust for core count (more cores = more parallel processing)
        const coreBonus = Math.min(20, info.cores.physical * 1.5);
        base += coreBonus;

        // Adjust for frequency
        const freqBonus = Math.min(15, (info.frequency.max / 1000) * 3);
        base += freqBonus;

        // Adjust for L3 cache (important for LLM)
        if (info.cache.l3 >= 64) base += 15;
        else if (info.cache.l3 >= 32) base += 10;
        else if (info.cache.l3 >= 16) base += 5;

        return Math.round(base);
    }

    /**
     * Fallback info when detection fails
     */
    getFallbackInfo() {
        const cpus = os.cpus();
        const cpu = cpus[0] || {};

        return {
            brand: cpu.model || 'Unknown CPU',
            vendor: 'Unknown',
            cores: {
                physical: cpus.length,
                logical: cpus.length,
                performance: cpus.length,
                efficiency: 0
            },
            frequency: {
                base: cpu.speed || 0,
                max: cpu.speed || 0
            },
            cache: { l1d: 0, l1i: 0, l2: 0, l3: 0 },
            capabilities: {
                sse2: process.arch === 'x64',
                avx: false,
                avx2: false,
                avx512: false,
                neon: process.arch === 'arm64',
                bestSimd: process.arch === 'arm64' ? 'NEON' : 'SSE2'
            },
            architecture: process.arch,
            backend: 'cpu',
            speedCoefficient: 30
        };
    }

    /**
     * Get hardware fingerprint
     */
    getFingerprint() {
        const info = this.detect();
        const brandSlug = info.brand.toLowerCase()
            .replace(/\(r\)|\(tm\)|@|cpu|processor/gi, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .trim();

        return `cpu-${brandSlug}-${info.cores.logical}c-${info.capabilities.bestSimd.toLowerCase()}`;
    }

    /**
     * Estimate inference speed
     */
    estimateTokensPerSecond(paramsB, quantization = 'Q4_K_M') {
        const info = this.detect();

        // CPU quantization benefits
        const quantMult = {
            'FP16': 0.8,  // FP16 slower on CPU
            'Q8_0': 1.2,
            'Q6_K': 1.5,
            'Q5_K_M': 1.8,
            'Q5_0': 1.8,
            'Q4_K_M': 2.2,
            'Q4_0': 2.5,
            'Q3_K_M': 2.8,
            'Q2_K': 3.2,
            'IQ4_XS': 2.3,
            'IQ3_XXS': 2.9
        };

        const mult = quantMult[quantization] || 2.0;
        const baseSpeed = info.speedCoefficient / paramsB * mult;

        return Math.round(baseSpeed);
    }

    /**
     * Get recommended thread count for inference
     */
    getRecommendedThreads() {
        const info = this.detect();

        // Use performance cores if hybrid, otherwise physical cores
        // Leave 1-2 cores for system
        const available = info.cores.performance > 0
            ? info.cores.performance
            : info.cores.physical;

        return Math.max(1, available - 1);
    }
}

module.exports = CPUDetector;
