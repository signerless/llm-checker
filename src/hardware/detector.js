const si = require('systeminformation');

class HardwareDetector {
    constructor() {
        this.cache = null;
        this.cacheExpiry = 5 * 60 * 1000;
        this.cacheTime = 0;
    }

    async getSystemInfo() {

        if (this.cache && (Date.now() - this.cacheTime < this.cacheExpiry)) {
            return this.cache;
        }

        try {
            const [cpu, memory, graphics, system, osInfo] = await Promise.all([
                si.cpu(),
                si.mem(),
                si.graphics(),
                si.system(),
                si.osInfo()
            ]);

            const systemInfo = {
                cpu: this.processCPUInfo(cpu),
                memory: this.processMemoryInfo(memory),
                gpu: this.processGPUInfo(graphics),
                system: this.processSystemInfo(system),
                os: this.processOSInfo(osInfo),
                timestamp: Date.now()
            };

            this.cache = systemInfo;
            this.cacheTime = Date.now();

            return systemInfo;
        } catch (error) {
            throw new Error(`Failed to detect hardware: ${error.message}`);
        }
    }

    processCPUInfo(cpu) {
        return {
            brand: cpu.brand || 'Unknown',
            manufacturer: cpu.manufacturer || 'Unknown',
            family: cpu.family || 'Unknown',
            model: cpu.model || 'Unknown',
            speed: cpu.speed || 0,
            speedMax: cpu.speedMax || cpu.speed || 0,
            cores: cpu.cores || 1,
            physicalCores: cpu.physicalCores || cpu.cores || 1,
            processors: cpu.processors || 1,
            cache: {
                l1d: cpu.cache?.l1d || 0,
                l1i: cpu.cache?.l1i || 0,
                l2: cpu.cache?.l2 || 0,
                l3: cpu.cache?.l3 || 0
            },
            architecture: this.detectArchitecture(cpu),
            score: this.calculateCPUScore(cpu)
        };
    }

    processMemoryInfo(memory) {
        const totalGB = Math.round(memory.total / (1024 ** 3));
        const freeGB = Math.round(memory.free / (1024 ** 3));
        const usedGB = totalGB - freeGB;

        return {
            total: totalGB,
            free: freeGB,
            used: usedGB,
            available: Math.round(memory.available / (1024 ** 3)),
            usagePercent: Math.round((usedGB / totalGB) * 100),
            swapTotal: Math.round(memory.swaptotal / (1024 ** 3)),
            swapUsed: Math.round(memory.swapused / (1024 ** 3)),
            score: this.calculateMemoryScore(totalGB, freeGB)
        };
    }

    processGPUInfo(graphics) {
        const controllers = graphics.controllers || [];
        const displays = graphics.displays || [];


        const dedicatedGPU = controllers.find(gpu => {
            const model = (gpu.model || '').toLowerCase();
            // Check for dedicated GPU indicators - improved detection for NVIDIA RTX cards
            const isDedicated = !this.isIntegratedGPU(gpu.model) && (
                gpu.vram > 0 || // Has dedicated VRAM
                model.includes('rtx') || // NVIDIA RTX series
                model.includes('gtx') || // NVIDIA GTX series  
                model.includes('radeon rx') || // AMD RX series
                model.includes('tesla') || // NVIDIA Tesla
                model.includes('quadro') // NVIDIA Quadro
            );
            return isDedicated;
        });

        const integratedGPU = controllers.find(gpu =>
            this.isIntegratedGPU(gpu.model)
        );

        const primaryGPU = dedicatedGPU || integratedGPU || controllers[0];

        if (!primaryGPU) {
            return {
                model: 'No GPU detected',
                vendor: 'Unknown',
                vram: 0,
                dedicated: false,
                score: 0
            };
        }

        // Enhanced VRAM detection
        let vram = primaryGPU.vram || 0;
        
        // For Windows, sometimes VRAM is reported in bytes instead of MB
        if (vram > 100000) {
            vram = Math.round(vram / (1024 * 1024)); // Convert bytes to MB
        }
        
        // Convert MB to GB
        vram = Math.round(vram / 1024);
        
        // If VRAM is still 0, try to estimate based on model or handle unified memory
        if (vram === 0 && primaryGPU.model) {
            const modelLower = primaryGPU.model.toLowerCase();
            if (modelLower.includes('apple') || modelLower.includes('unified')) {
                // Apple Silicon uses unified memory - return 0 to indicate this
                vram = 0;
            } else {
                vram = this.estimateVRAMFromModel(primaryGPU.model);
            }
        }

        return {
            model: primaryGPU.model || 'Unknown GPU',
            vendor: primaryGPU.vendor || 'Unknown',
            vram: vram,
            vramDynamic: primaryGPU.vramDynamic || false,
            dedicated: !this.isIntegratedGPU(primaryGPU.model),
            driverVersion: primaryGPU.driverVersion || 'Unknown',
            all: controllers.map(gpu => {
                let gpuVram = gpu.vram || 0;
                if (gpuVram > 100000) {
                    gpuVram = Math.round(gpuVram / (1024 * 1024));
                }
                return {
                    model: gpu.model,
                    vram: Math.round(gpuVram / 1024),
                    vendor: gpu.vendor
                };
            }),
            displays: displays.length,
            score: this.calculateGPUScore(primaryGPU)
        };
    }

    processSystemInfo(system) {
        return {
            manufacturer: system.manufacturer || 'Unknown',
            model: system.model || 'Unknown',
            version: system.version || 'Unknown',
            serial: system.serial || 'Unknown',
            uuid: system.uuid || 'Unknown',
            sku: system.sku || 'Unknown'
        };
    }

    processOSInfo(osInfo) {
        return {
            platform: osInfo.platform || process.platform,
            distro: osInfo.distro || 'Unknown',
            release: osInfo.release || 'Unknown',
            codename: osInfo.codename || 'Unknown',
            kernel: osInfo.kernel || 'Unknown',
            arch: osInfo.arch || process.arch,
            hostname: osInfo.hostname || 'Unknown',
            logofile: osInfo.logofile || ''
        };
    }

    detectArchitecture(cpu) {
        const brand = (cpu.brand || '').toLowerCase();
        const model = (cpu.model || '').toLowerCase();
        const manufacturer = (cpu.manufacturer || '').toLowerCase();

        if (manufacturer.includes('apple') || brand.includes('apple') || brand.includes('m1') || brand.includes('m2') || brand.includes('m3') || brand.includes('m4')) {
            return 'Apple Silicon';
        } else if (brand.includes('intel')) {
            return 'x86_64';
        } else if (brand.includes('amd')) {
            return 'x86_64';
        } else if (process.arch === 'arm64') {
            return 'ARM64';
        } else {
            return process.arch || 'Unknown';
        }
    }

    isIntegratedGPU(model) {
        if (!model) return false;
        const modelLower = model.toLowerCase();
        return modelLower.includes('intel') && !modelLower.includes('arc') ||
            modelLower.includes('amd') && modelLower.includes('graphics') && !modelLower.includes(' rx ') ||
            modelLower.includes('radeon') && modelLower.includes('graphics') ||
            modelLower.includes('iris') ||
            modelLower.includes('uhd') ||
            modelLower.includes('hd graphics') ||
            modelLower.includes('apple');
    }

    estimateVRAMFromModel(model) {
        if (!model) return 0;
        const modelLower = model.toLowerCase();
        
        // NVIDIA RTX 40 series
        if (modelLower.includes('rtx 4090')) return 24;
        if (modelLower.includes('rtx 4080')) return 16;
        if (modelLower.includes('rtx 4070 ti')) return 12;
        if (modelLower.includes('rtx 4070')) return 12;
        if (modelLower.includes('rtx 4060 ti')) return 16;
        if (modelLower.includes('rtx 4060')) return 8;
        
        // NVIDIA RTX 30 series
        if (modelLower.includes('rtx 3090')) return 24;
        if (modelLower.includes('rtx 3080 ti')) return 12;
        if (modelLower.includes('rtx 3080')) return 10;
        if (modelLower.includes('rtx 3070')) return 8;
        if (modelLower.includes('rtx 3060 ti')) return 8;
        if (modelLower.includes('rtx 3060')) return 12;
        
        // AMD RX 7000 series
        if (modelLower.includes('rx 7900')) return 24;
        if (modelLower.includes('rx 7800')) return 16;
        if (modelLower.includes('rx 7700')) return 12;
        if (modelLower.includes('rx 7600')) return 8;
        
        // Generic estimates
        if (modelLower.includes('rtx')) return 8; // Default for RTX
        if (modelLower.includes('gtx')) return 4; // Default for GTX
        if (modelLower.includes('rx ')) return 8; // Default for AMD RX
        
        return 0; // Unknown or integrated
    }

    calculateCPUScore(cpu) {
        let score = 0;

        // Base score por número de cores
        score += (cpu.cores || 1) * 5;
        score += (cpu.physicalCores || cpu.cores || 1) * 3;

        // Score por velocidad
        const speed = cpu.speedMax || cpu.speed || 0;
        score += speed * 10;

        // Bonus por arquitectura moderna
        const brand = (cpu.brand || '').toLowerCase();
        if (brand.includes('apple m')) {
            score += 20; // Apple Silicon bonus
        } else if (brand.includes('intel') && speed > 3.0) {
            score += 15;
        } else if (brand.includes('amd') && speed > 3.0) {
            score += 15;
        }

        return Math.min(Math.round(score), 100);
    }

    calculateMemoryScore(totalGB, freeGB) {
        let score = 0;

        // Score basado en RAM total
        if (totalGB >= 64) score += 40;
        else if (totalGB >= 32) score += 35;
        else if (totalGB >= 16) score += 25;
        else if (totalGB >= 8) score += 15;
        else score += totalGB * 2;

        // Score basado en RAM disponible
        const freePercent = (freeGB / totalGB) * 100;
        if (freePercent > 50) score += 20;
        else if (freePercent > 30) score += 15;
        else if (freePercent > 20) score += 10;
        else score += 5;

        return Math.min(Math.round(score), 100);
    }

    calculateGPUScore(gpu) {
        if (!gpu || !gpu.model) return 0;

        let score = 0;
        const model = gpu.model.toLowerCase();
        const vram = gpu.vram || 0;


        score += vram * 8;


        if (!this.isIntegratedGPU(gpu.model)) {
            score += 20;
        }

        // Bonus por marcas/modelos específicos
        if (model.includes('rtx 4090')) score += 25;
        else if (model.includes('rtx 4080')) score += 22;
        else if (model.includes('rtx 4070')) score += 20;
        else if (model.includes('rtx 30')) score += 18;
        else if (model.includes('rtx 20')) score += 15;
        else if (model.includes('gtx 16')) score += 12;
        else if (model.includes('apple m')) score += 15;

        return Math.min(Math.round(score), 100);
    }

    async runQuickBenchmark() {

        const start = process.hrtime.bigint();


        let cpuResult = 0;
        for (let i = 0; i < 1000000; i++) {
            cpuResult += Math.sqrt(i);
        }

        const end = process.hrtime.bigint();
        const cpuTime = Number(end - start) / 1000000; // ms

        const memStart = process.hrtime.bigint();
        const largeArray = new Array(1000000).fill(0).map((_, i) => i);
        largeArray.sort((a, b) => b - a);
        const memEnd = process.hrtime.bigint();
        const memTime = Number(memEnd - memStart) / 1000000;

        return {
            cpu: Math.max(0, Math.min(100, 100 - (cpuTime / 100))),
            memory: Math.max(0, Math.min(100, 100 - (memTime / 50))),
            overall: Math.round((
                Math.max(0, Math.min(100, 100 - (cpuTime / 100))) +
                Math.max(0, Math.min(100, 100 - (memTime / 50)))
            ) / 2)
        };
    }
}

module.exports = HardwareDetector;