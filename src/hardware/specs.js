
class HardwareSpecs {
    constructor() {
        this.cpuBenchmarks = this.initializeCPUBenchmarks();
        this.gpuBenchmarks = this.initializeGPUBenchmarks();
        this.memorySpecs = this.initializeMemorySpecs();
    }

    initializeCPUBenchmarks() {
        return {
            // Apple Silicon
            'Apple M3 Max': { score: 95, cores: 16, tdp: 30 },
            'Apple M3 Pro': { score: 90, cores: 12, tdp: 25 },
            'Apple M3': { score: 85, cores: 8, tdp: 20 },
            'Apple M2 Ultra': { score: 98, cores: 24, tdp: 60 },
            'Apple M2 Max': { score: 92, cores: 12, tdp: 30 },
            'Apple M2 Pro': { score: 88, cores: 10, tdp: 25 },
            'Apple M2': { score: 82, cores: 8, tdp: 20 },
            'Apple M1 Ultra': { score: 94, cores: 20, tdp: 60 },
            'Apple M1 Max': { score: 88, cores: 10, tdp: 30 },
            'Apple M1 Pro': { score: 84, cores: 8, tdp: 20 },
            'Apple M1': { score: 78, cores: 8, tdp: 15 },

            // Intel Desktop
            'Intel Core i9-13900K': { score: 95, cores: 24, tdp: 125 },
            'Intel Core i7-13700K': { score: 90, cores: 16, tdp: 125 },
            'Intel Core i5-13600K': { score: 85, cores: 14, tdp: 125 },
            'Intel Core i9-12900K': { score: 92, cores: 16, tdp: 125 },
            'Intel Core i7-12700K': { score: 87, cores: 12, tdp: 125 },
            'Intel Core i5-12600K': { score: 82, cores: 10, tdp: 125 },

            // AMD Desktop
            'AMD Ryzen 9 7950X': { score: 98, cores: 16, tdp: 170 },
            'AMD Ryzen 9 7900X': { score: 95, cores: 12, tdp: 170 },
            'AMD Ryzen 7 7700X': { score: 90, cores: 8, tdp: 105 },
            'AMD Ryzen 5 7600X': { score: 85, cores: 6, tdp: 105 },
            'AMD Ryzen 9 5950X': { score: 94, cores: 16, tdp: 105 },
            'AMD Ryzen 9 5900X': { score: 90, cores: 12, tdp: 105 },
            'AMD Ryzen 7 5800X': { score: 86, cores: 8, tdp: 105 },
            'AMD Ryzen 5 5600X': { score: 80, cores: 6, tdp: 65 },

            // Intel Mobile
            'Intel Core i9-13980HX': { score: 90, cores: 24, tdp: 55 },
            'Intel Core i7-13700H': { score: 85, cores: 14, tdp: 45 },
            'Intel Core i5-13500H': { score: 78, cores: 12, tdp: 45 },

            // AMD Mobile
            'AMD Ryzen 9 7945HX': { score: 92, cores: 16, tdp: 55 },
            'AMD Ryzen 7 7735HS': { score: 85, cores: 8, tdp: 35 },
            'AMD Ryzen 5 7535HS': { score: 78, cores: 6, tdp: 35 }
        };
    }

    initializeGPUBenchmarks() {
        return {
            // NVIDIA RTX 40 Series
            'NVIDIA GeForce RTX 4090': { score: 100, vram: 24, tdp: 450, dedicated: true },
            'NVIDIA GeForce RTX 4080': { score: 90, vram: 16, tdp: 320, dedicated: true },
            'NVIDIA GeForce RTX 4070 Ti': { score: 85, vram: 12, tdp: 285, dedicated: true },
            'NVIDIA GeForce RTX 4070': { score: 80, vram: 12, tdp: 200, dedicated: true },
            'NVIDIA GeForce RTX 4060 Ti': { score: 75, vram: 16, tdp: 165, dedicated: true },
            'NVIDIA GeForce RTX 4060': { score: 70, vram: 8, tdp: 115, dedicated: true },

            // NVIDIA RTX 30 Series
            'NVIDIA GeForce RTX 3090 Ti': { score: 95, vram: 24, tdp: 450, dedicated: true },
            'NVIDIA GeForce RTX 3090': { score: 92, vram: 24, tdp: 350, dedicated: true },
            'NVIDIA GeForce RTX 3080 Ti': { score: 88, vram: 12, tdp: 350, dedicated: true },
            'NVIDIA GeForce RTX 3080': { score: 85, vram: 10, tdp: 320, dedicated: true },
            'NVIDIA GeForce RTX 3070 Ti': { score: 80, vram: 8, tdp: 290, dedicated: true },
            'NVIDIA GeForce RTX 3070': { score: 78, vram: 8, tdp: 220, dedicated: true },
            'NVIDIA GeForce RTX 3060 Ti': { score: 75, vram: 8, tdp: 200, dedicated: true },
            'NVIDIA GeForce RTX 3060': { score: 70, vram: 12, tdp: 170, dedicated: true },

            // AMD RX 7000 Series
            'AMD Radeon RX 7900 XTX': { score: 92, vram: 24, tdp: 355, dedicated: true },
            'AMD Radeon RX 7900 XT': { score: 88, vram: 20, tdp: 300, dedicated: true },
            'AMD Radeon RX 7800 XT': { score: 82, vram: 16, tdp: 263, dedicated: true },
            'AMD Radeon RX 7700 XT': { score: 78, vram: 12, tdp: 245, dedicated: true },
            'AMD Radeon RX 7600': { score: 70, vram: 8, tdp: 165, dedicated: true },

            // Apple GPU (integrated)
            'Apple M3 Max GPU': { score: 85, vram: 0, tdp: 30, dedicated: false, unified: true },
            'Apple M3 Pro GPU': { score: 75, vram: 0, tdp: 25, dedicated: false, unified: true },
            'Apple M3 GPU': { score: 65, vram: 0, tdp: 20, dedicated: false, unified: true },
            'Apple M2 Ultra GPU': { score: 90, vram: 0, tdp: 60, dedicated: false, unified: true },
            'Apple M2 Max GPU': { score: 80, vram: 0, tdp: 30, dedicated: false, unified: true },
            'Apple M2 Pro GPU': { score: 70, vram: 0, tdp: 25, dedicated: false, unified: true },
            'Apple M2 GPU': { score: 60, vram: 0, tdp: 20, dedicated: false, unified: true },

            // Intel Integrated
            'Intel Iris Xe Graphics': { score: 35, vram: 0, tdp: 15, dedicated: false },
            'Intel UHD Graphics 770': { score: 25, vram: 0, tdp: 15, dedicated: false },
            'Intel UHD Graphics 630': { score: 20, vram: 0, tdp: 15, dedicated: false },

            // AMD Integrated
            'AMD Radeon 780M': { score: 45, vram: 0, tdp: 15, dedicated: false },
            'AMD Radeon 680M': { score: 40, vram: 0, tdp: 15, dedicated: false },
            'AMD Radeon Graphics': { score: 30, vram: 0, tdp: 15, dedicated: false }
        };
    }

    initializeMemorySpecs() {
        return {
            ddr5: {
                speeds: [4800, 5600, 6400, 7200, 8000],
                efficiency: 1.2,
                powerConsumption: 1.1
            },
            ddr4: {
                speeds: [2133, 2400, 2666, 3200, 3600],
                efficiency: 1.0,
                powerConsumption: 1.0
            },
            lpddr5: {
                speeds: [6400, 7500, 8533],
                efficiency: 1.3,
                powerConsumption: 0.8
            },
            lpddr4: {
                speeds: [3200, 4266],
                efficiency: 1.1,
                powerConsumption: 0.9
            },
            unified: { // Apple Silicon
                speeds: [6400, 7500, 8000],
                efficiency: 1.5,
                powerConsumption: 0.7
            }
        };
    }

    getCPUScore(cpuModel) {

        if (this.cpuBenchmarks[cpuModel]) {
            return this.cpuBenchmarks[cpuModel];
        }


        const modelLower = cpuModel.toLowerCase();
        for (const [benchmark, specs] of Object.entries(this.cpuBenchmarks)) {
            if (modelLower.includes(benchmark.toLowerCase()) ||
                benchmark.toLowerCase().includes(modelLower)) {
                return specs;
            }
        }

        return this.estimateCPUScore(cpuModel);
    }

    getGPUScore(gpuModel) {

        if (this.gpuBenchmarks[gpuModel]) {
            return this.gpuBenchmarks[gpuModel];
        }


        const modelLower = gpuModel.toLowerCase();
        for (const [benchmark, specs] of Object.entries(this.gpuBenchmarks)) {
            if (modelLower.includes(benchmark.toLowerCase()) ||
                benchmark.toLowerCase().includes(modelLower)) {
                return specs;
            }
        }

        // Score estimado basado en patrones
        return this.estimateGPUScore(gpuModel);
    }

    estimateCPUScore(cpuModel) {
        const modelLower = cpuModel.toLowerCase();
        let score = 50; // Base score
        let cores = 4;   // Default cores
        let tdp = 65;    // Default TDP

        // Detectar marca
        if (modelLower.includes('apple')) {
            score += 20;
            tdp = 25;
            if (modelLower.includes('m3')) score += 15;
            else if (modelLower.includes('m2')) score += 10;
            else if (modelLower.includes('m1')) score += 5;
        } else if (modelLower.includes('intel')) {
            if (modelLower.includes('i9')) { score += 25; cores = 16; }
            else if (modelLower.includes('i7')) { score += 20; cores = 8; }
            else if (modelLower.includes('i5')) { score += 15; cores = 6; }
            else if (modelLower.includes('i3')) { score += 10; cores = 4; }
        } else if (modelLower.includes('amd')) {
            if (modelLower.includes('ryzen 9')) { score += 25; cores = 12; }
            else if (modelLower.includes('ryzen 7')) { score += 20; cores = 8; }
            else if (modelLower.includes('ryzen 5')) { score += 15; cores = 6; }
            else if (modelLower.includes('ryzen 3')) { score += 10; cores = 4; }
        }

        // Detectar generación
        if (modelLower.includes('13th') || modelLower.includes('7000')) score += 10;
        else if (modelLower.includes('12th') || modelLower.includes('6000')) score += 5;

        return { score: Math.min(score, 100), cores, tdp };
    }

    estimateGPUScore(gpuModel) {
        const modelLower = gpuModel.toLowerCase();
        let score = 30; // Base score
        let vram = 4;   // Default VRAM
        let dedicated = !this.isIntegratedGPU(gpuModel);
        let tdp = dedicated ? 200 : 15;

        if (modelLower.includes('rtx')) {
            dedicated = true;
            if (modelLower.includes('4090')) { score = 100; vram = 24; }
            else if (modelLower.includes('4080')) { score = 90; vram = 16; }
            else if (modelLower.includes('4070')) { score = 82; vram = 12; }
            else if (modelLower.includes('4060')) { score = 72; vram = 8; }
            else if (modelLower.includes('30')) { score += 20; vram = 8; }
            else if (modelLower.includes('20')) { score += 15; vram = 6; }
        } else if (modelLower.includes('apple')) {
            dedicated = false;
            vram = 0; // Unified memory
            if (modelLower.includes('ultra')) score = 90;
            else if (modelLower.includes('max')) score = 80;
            else if (modelLower.includes('pro')) score = 70;
            else score = 60;
        } else if (modelLower.includes('radeon rx')) {
            dedicated = true;
            if (modelLower.includes('7900')) { score = 90; vram = 20; }
            else if (modelLower.includes('7800')) { score = 82; vram = 16; }
            else if (modelLower.includes('7700')) { score = 78; vram = 12; }
            else if (modelLower.includes('6000')) { score += 15; vram = 8; }
        }

        return {
            score: Math.min(score, 100),
            vram,
            tdp,
            dedicated,
            unified: modelLower.includes('apple')
        };
    }

    isIntegratedGPU(gpuModel) {
        const modelLower = gpuModel.toLowerCase();
        const integratedKeywords = [
            'intel', 'iris', 'uhd', 'hd graphics',
            'amd radeon graphics', 'radeon 680m', 'radeon 780m',
            'apple', 'qualcomm', 'adreno'
        ];

        return integratedKeywords.some(keyword => modelLower.includes(keyword)) &&
            !modelLower.includes('rx ') && // Exclude dedicated AMD RX cards
            !modelLower.includes('rtx') && // Exclude NVIDIA RTX
            !modelLower.includes('gtx');   // Exclude NVIDIA GTX
    }

    getMemoryEfficiency(memoryType) {
        const type = memoryType.toLowerCase();

        if (type.includes('lpddr5') || type.includes('unified')) {
            return this.memorySpecs.lpddr5 || this.memorySpecs.unified;
        } else if (type.includes('lpddr4')) {
            return this.memorySpecs.lpddr4;
        } else if (type.includes('ddr5')) {
            return this.memorySpecs.ddr5;
        } else {
            return this.memorySpecs.ddr4;
        }
    }

    calculateSystemEfficiency(cpu, gpu, memory) {
        const cpuSpecs = this.getCPUScore(cpu.brand);
        const gpuSpecs = this.getGPUScore(gpu.model);
        const memSpecs = this.getMemoryEfficiency('ddr4'); // Default

        const efficiency = {
            cpu: cpuSpecs.score / cpuSpecs.tdp,
            gpu: gpuSpecs.score / gpuSpecs.tdp,
            memory: memSpecs.efficiency,
            overall: 0
        };

        efficiency.overall = (efficiency.cpu + efficiency.gpu + efficiency.memory) / 3;

        return efficiency;
    }
}

module.exports = HardwareSpecs;