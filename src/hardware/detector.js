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
        
        // Debug logging to help diagnose GPU detection issues
        if (process.env.DEBUG_GPU) {
            console.log('GPU Detection Debug:', JSON.stringify(controllers, null, 2));
        }


        // Filter out invalid/virtualized GPUs first
        const validGPUs = controllers.filter(gpu => {
            const model = (gpu.model || '').toLowerCase();
            const vendor = (gpu.vendor || '').toLowerCase();
            
            // Skip GPUs with empty/invalid data (like virtualized GPUs)
            if (!model || !vendor || model === 'unknown' || vendor === '') {
                return false;
            }
            
            // Skip very generic/placeholder entries
            if (model.includes('standard vga') || model.includes('microsoft basic')) {
                return false;
            }
            
            return true;
        });

        // Find all dedicated GPUs from valid GPUs
        const dedicatedGPUs = validGPUs.filter(gpu => {
            const model = (gpu.model || '').toLowerCase();
            const isDedicated = !this.isIntegratedGPU(gpu.model) && (
                gpu.vram > 0 || // Has dedicated VRAM
                model.includes('rtx') || // NVIDIA RTX series
                model.includes('gtx') || // NVIDIA GTX series  
                model.includes('radeon rx') || // AMD RX series
                model.includes('tesla') || // NVIDIA Tesla
                model.includes('quadro') || // NVIDIA Quadro
                model.includes('geforce') // NVIDIA GeForce
            );
            return isDedicated;
        });

        // Find integrated GPUs from valid GPUs
        const integratedGPUs = validGPUs.filter(gpu =>
            this.isIntegratedGPU(gpu.model)
        );

        // Select the best GPU using smart selection logic
        const primaryGPU = this.selectBestGPU(dedicatedGPUs, integratedGPUs, validGPUs);

        if (!primaryGPU) {
            return {
                model: 'No GPU detected',
                vendor: 'Unknown',
                vram: 0,
                dedicated: false,
                score: 0
            };
        }
        
        // Enhance model detection using device ID when model is generic or missing
        let enhancedModel = primaryGPU.model || 'Unknown GPU';
        if (primaryGPU.deviceId && (
            !primaryGPU.model || 
            primaryGPU.model === 'Unknown' || 
            primaryGPU.model.includes('NVIDIA Corporation Device')
        )) {
            enhancedModel = this.getGPUModelFromDeviceId(primaryGPU.deviceId) || enhancedModel;
        }

        // Enhanced VRAM detection using the new normalizeVRAM function
        let vram = this.normalizeVRAM(primaryGPU.vram || 0);
        
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

        // Calculate total VRAM from all dedicated GPUs (for multi-GPU setups)
        let totalDedicatedVRAM = 0;
        let gpuCount = 0;

        dedicatedGPUs.forEach(gpu => {
            const gpuVram = this.normalizeVRAM(gpu.vram || 0) || this.estimateVRAMFromModel(gpu.model);
            if (gpuVram > 0) {
                totalDedicatedVRAM += gpuVram;
                gpuCount++;
            }
        });

        // If we have multiple dedicated GPUs, use the combined VRAM
        const effectiveVRAM = gpuCount > 1 ? totalDedicatedVRAM : vram;

        return {
            model: enhancedModel,
            vendor: primaryGPU.vendor || 'Unknown',
            vram: effectiveVRAM,
            vramPerGPU: vram, // VRAM of primary GPU for reference
            vramDynamic: primaryGPU.vramDynamic || false,
            dedicated: !this.isIntegratedGPU(enhancedModel),
            driverVersion: primaryGPU.driverVersion || 'Unknown',
            gpuCount: gpuCount > 0 ? gpuCount : (dedicatedGPUs.length > 0 ? dedicatedGPUs.length : 1),
            isMultiGPU: gpuCount > 1,
            all: controllers.map(gpu => ({
                model: gpu.model,
                vram: this.normalizeVRAM(gpu.vram || 0),
                vendor: gpu.vendor
            })),
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
        // Check if GPU is integrated (on-chip or shared memory, not discrete)
        // Note: && has higher precedence than ||, each line is grouped with ()
        return (modelLower.includes('intel') && !modelLower.includes('arc')) ||
            (modelLower.includes('amd') && modelLower.includes('graphics') && !modelLower.includes(' rx ')) ||
            (modelLower.includes('radeon') && modelLower.includes('graphics')) ||
            modelLower.includes('iris') ||
            modelLower.includes('uhd') ||
            modelLower.includes('hd graphics') ||
            modelLower.includes('apple');
    }

    getGPUModelFromDeviceId(deviceId) {
        if (!deviceId) return null;
        
        // Normalize device ID (remove 0x prefix if present and convert to lowercase)
        const normalizedId = deviceId.toLowerCase().replace('0x', '');
        
        // NVIDIA RTX 50 series device IDs
        const deviceIdMap = {
            '2d04': 'NVIDIA GeForce RTX 5060 Ti',
            '2d05': 'NVIDIA GeForce RTX 5060',
            '2d06': 'NVIDIA GeForce RTX 5070',
            '2d07': 'NVIDIA GeForce RTX 5070 Ti',
            '2d08': 'NVIDIA GeForce RTX 5080',
            '2d09': 'NVIDIA GeForce RTX 5090',
            
            // NVIDIA RTX 40 series device IDs
            '2684': 'NVIDIA GeForce RTX 4090',
            '2685': 'NVIDIA GeForce RTX 4080',
            '2786': 'NVIDIA GeForce RTX 4070 Ti',
            '2787': 'NVIDIA GeForce RTX 4070',
            '27a0': 'NVIDIA GeForce RTX 4060 Ti',
            '27a1': 'NVIDIA GeForce RTX 4060',
            
            // NVIDIA RTX 30 series device IDs
            '2204': 'NVIDIA GeForce RTX 3090',
            '2206': 'NVIDIA GeForce RTX 3080',
            '2484': 'NVIDIA GeForce RTX 3070',
            '2487': 'NVIDIA GeForce RTX 3060 Ti',
            '2504': 'NVIDIA GeForce RTX 3060'
        };
        
        return deviceIdMap[normalizedId] || null;
    }

    estimateVRAMFromModel(model) {
        if (!model) return 0;
        const modelLower = model.toLowerCase();
        
        // NVIDIA RTX 50 series
        if (modelLower.includes('rtx 5090')) return 32;
        if (modelLower.includes('rtx 5080')) return 16;
        if (modelLower.includes('rtx 5070 ti')) return 16;
        if (modelLower.includes('rtx 5070')) return 12;
        if (modelLower.includes('rtx 5060 ti')) return 16;
        if (modelLower.includes('rtx 5060')) return 8;
        
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
        if (model.includes('rtx 5090')) score += 30;
        else if (model.includes('rtx 5080')) score += 27;
        else if (model.includes('rtx 5070')) score += 24;
        else if (model.includes('rtx 5060')) score += 21;
        else if (model.includes('rtx 4090')) score += 25;
        else if (model.includes('rtx 4080')) score += 22;
        else if (model.includes('rtx 4070')) score += 20;
        else if (model.includes('rtx 30')) score += 18;
        else if (model.includes('rtx 20')) score += 15;
        else if (model.includes('gtx 16')) score += 12;
        else if (model.includes('apple m')) score += 15;

        return Math.min(Math.round(score), 100);
    }

    /**
     * Select the best GPU from multiple available GPUs
     * Prioritizes: 1) Dedicated GPUs by VRAM, 2) Model tier, 3) Integrated GPUs
     */
    selectBestGPU(dedicatedGPUs, integratedGPUs, validGPUs) {
        // If we have dedicated GPUs, choose the best one
        if (dedicatedGPUs.length > 0) {
            // Sort dedicated GPUs by a combination of VRAM and model tier
            return dedicatedGPUs.sort((a, b) => {
                // First priority: VRAM amount
                const vramA = this.normalizeVRAM(a.vram || 0);
                const vramB = this.normalizeVRAM(b.vram || 0);
                
                if (vramA !== vramB) {
                    return vramB - vramA; // Higher VRAM first
                }
                
                // Second priority: GPU tier (RTX 50xx > RTX 40xx > RTX 30xx, etc.)
                const tierA = this.getGPUTier(a.model || '');
                const tierB = this.getGPUTier(b.model || '');
                
                if (tierA !== tierB) {
                    return tierB - tierA; // Higher tier first
                }
                
                // Third priority: Vendor preference (NVIDIA > AMD > Intel)
                const vendorA = this.getVendorPriority(a.vendor || '');
                const vendorB = this.getVendorPriority(b.vendor || '');
                
                return vendorB - vendorA;
            })[0];
        }
        
        // If no dedicated GPUs, use the best integrated GPU
        if (integratedGPUs.length > 0) {
            return integratedGPUs.sort((a, b) => {
                const tierA = this.getGPUTier(a.model || '');
                const tierB = this.getGPUTier(b.model || '');
                return tierB - tierA;
            })[0];
        }
        
        // Fallback to any valid GPU (should rarely happen)
        return validGPUs.length > 0 ? validGPUs[0] : null;
    }
    
    /**
     * Normalize VRAM values (handle different units and wrong totals)
     */
    normalizeVRAM(vram) {
        if (!vram || vram <= 0) return 0;
        
        let vramValue = vram;
        
        // Handle VRAM in bytes (some systems report this way)  
        if (vramValue > 100000) {
            vramValue = Math.round(vramValue / (1024 * 1024)); // Convert bytes to MB
        }
        
        // Now determine if we have MB or GB values
        if (vramValue >= 1024) {
            // Values >= 1024 are likely MB, convert to GB
            vramValue = Math.round(vramValue / 1024);
        } else if (vramValue >= 512 && vramValue < 1024) {
            // 512-1023 MB, round to 1GB
            vramValue = 1;
        } else if (vramValue > 80) {
            // Values between 80-511 are likely incorrect MB values, treat as MB
            vramValue = Math.round(vramValue / 1024) || 1;
        } else if (vramValue >= 1 && vramValue <= 80) {
            // Values 1-80 are likely already in GB, keep as is
            vramValue = vramValue;
        } else {
            // Values < 1 round to 0
            vramValue = 0;
        }
        
        return vramValue;
    }
    
    /**
     * Get GPU tier score for prioritization
     */
    getGPUTier(model) {
        const modelLower = model.toLowerCase();
        
        // NVIDIA RTX series
        if (modelLower.includes('rtx 50')) return 100;
        if (modelLower.includes('rtx 4090')) return 95;
        if (modelLower.includes('rtx 40')) return 90;
        if (modelLower.includes('rtx 3090')) return 85;
        if (modelLower.includes('rtx 30')) return 80;
        if (modelLower.includes('rtx 20')) return 70;
        if (modelLower.includes('gtx 16')) return 60;
        if (modelLower.includes('gtx 10')) return 50;
        
        // NVIDIA Professional
        if (modelLower.includes('a100')) return 98;
        if (modelLower.includes('h100')) return 99;
        if (modelLower.includes('tesla')) return 75;
        if (modelLower.includes('quadro')) return 65;
        
        // AMD
        if (modelLower.includes('rx 7900')) return 85;
        if (modelLower.includes('rx 7800')) return 80;
        if (modelLower.includes('rx 7700')) return 75;
        if (modelLower.includes('rx 6900')) return 70;
        if (modelLower.includes('rx 6800')) return 65;
        
        // Intel
        if (modelLower.includes('arc a7')) return 55;
        if (modelLower.includes('arc a5')) return 45;
        
        // Apple Silicon
        if (modelLower.includes('apple') || modelLower.includes('m1') || 
            modelLower.includes('m2') || modelLower.includes('m3') || 
            modelLower.includes('m4')) return 80;
        
        return 10; // Default for unknown
    }
    
    /**
     * Get vendor priority score
     */
    getVendorPriority(vendor) {
        const vendorLower = vendor.toLowerCase();
        if (vendorLower.includes('nvidia')) return 3;
        if (vendorLower.includes('amd') || vendorLower.includes('ati')) return 2;
        if (vendorLower.includes('intel')) return 1;
        if (vendorLower.includes('apple')) return 3;
        return 0;
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