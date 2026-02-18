const { estimateTokenSpeedFromHardware } = require('../utils/token-speed-estimator');

class ExpandedModelsDatabase {
    constructor() {
        this.models = this.initializeExpandedModels();
        this.compatibilityMatrix = this.initializeCompatibilityMatrix();
    }

    initializeExpandedModels() {
        return [
            // Ultra-Small Models (< 1B parámetros)
            {
                name: "Qwen 0.5B",
                size: "0.5B",
                type: "local",
                category: "ultra_small",
                requirements: {
                    ram: 1,
                    vram: 0,
                    cpu_cores: 1,
                    storage: 0.5,
                    recommended_ram: 2
                },
                frameworks: ["ollama", "transformers"],
                quantization: ["Q4_0", "Q8_0"],
                performance: {
                    speed: "very_fast",
                    quality: "basic",
                    context_length: 2048,
                    tokens_per_second_estimate: "100-200"
                },
                installation: {
                    ollama: "ollama pull qwen:0.5b",
                    description: "Ultra-lightweight model for testing and basic tasks"
                },
                specialization: "general",
                languages: ["en", "zh"],
                year: 2024
            },
            {
                name: "LaMini-GPT 774M",
                size: "774M",
                type: "local",
                category: "ultra_small",
                requirements: {
                    ram: 1.5,
                    vram: 0,
                    cpu_cores: 1,
                    storage: 0.8,
                    recommended_ram: 2
                },
                frameworks: ["transformers", "llama.cpp"],
                quantization: ["Q4_0", "Q8_0"],
                performance: {
                    speed: "very_fast",
                    quality: "basic",
                    context_length: 2048,
                    tokens_per_second_estimate: "80-150"
                },
                installation: {
                    description: "Multilingual compact model via knowledge distillation"
                },
                specialization: "multilingual",
                languages: ["en", "es", "fr", "de", "zh", "ja"],
                year: 2024
            },

            // Small Models (1B - 4B parámetros)
            {
                name: "TinyLlama 1.1B",
                size: "1.1B",
                type: "local",
                category: "small",
                requirements: {
                    ram: 2,
                    vram: 0,
                    cpu_cores: 2,
                    storage: 1.2,
                    recommended_ram: 4
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                quantization: ["Q2_K", "Q3_K", "Q4_0", "Q4_1", "Q5_0", "Q5_1", "Q8_0"],
                performance: {
                    speed: "very_fast",
                    quality: "basic",
                    context_length: 2048,
                    tokens_per_second_estimate: "50-100"
                },
                installation: {
                    ollama: "ollama pull tinyllama:1.1b",
                    llamacpp: "Download from HuggingFace: TinyLlama/TinyLlama-1.1B-Chat-v1.0",
                    description: "Perfect entry point for testing LLM capabilities"
                },
                specialization: "general",
                languages: ["en"],
                year: 2023
            },
            {
                name: "MobileLLaMA 1.4B",
                size: "1.4B",
                type: "local",
                category: "small",
                requirements: {
                    ram: 2.5,
                    vram: 0,
                    cpu_cores: 2,
                    storage: 1.5,
                    recommended_ram: 4
                },
                frameworks: ["transformers", "llama.cpp"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q8_0"],
                performance: {
                    speed: "very_fast",
                    quality: "good",
                    context_length: 2048,
                    tokens_per_second_estimate: "60-120",
                    mobile_optimized: true
                },
                installation: {
                    description: "Optimized for mobile and edge devices (40% faster than TinyLLaMA)"
                },
                specialization: "mobile",
                languages: ["en"],
                year: 2024
            },
            {
                name: "MobileLLaMA 2.7B",
                size: "2.7B",
                type: "local",
                category: "small",
                requirements: {
                    ram: 3.5,
                    vram: 1,
                    cpu_cores: 2,
                    storage: 2.8,
                    recommended_ram: 6
                },
                frameworks: ["transformers", "llama.cpp"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q8_0"],
                performance: {
                    speed: "fast",
                    quality: "good",
                    context_length: 4096,
                    tokens_per_second_estimate: "40-80",
                    mobile_optimized: true
                },
                installation: {
                    description: "Larger MobileLLaMA variant for better quality on mobile"
                },
                specialization: "mobile",
                languages: ["en"],
                year: 2024
            },
            {
                name: "Gemma 2B",
                size: "2B",
                type: "local",
                category: "small",
                requirements: {
                    ram: 3,
                    vram: 1,
                    cpu_cores: 2,
                    storage: 2.2,
                    recommended_ram: 6
                },
                frameworks: ["ollama", "transformers", "llama.cpp"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "fast",
                    quality: "very_good",
                    context_length: 8192,
                    tokens_per_second_estimate: "30-70"
                },
                installation: {
                    ollama: "ollama pull gemma2:2b",
                    description: "Google's efficient small model with strong performance"
                },
                specialization: "general",
                languages: ["en"],
                year: 2024
            },
            {
                name: "Gemma 3 1B",
                size: "1B",
                type: "local",
                category: "small",
                requirements: {
                    ram: 2,
                    vram: 0,
                    cpu_cores: 2,
                    storage: 1.1,
                    recommended_ram: 4
                },
                frameworks: ["ollama", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q8_0"],
                performance: {
                    speed: "very_fast",
                    quality: "good",
                    context_length: 32768,
                    tokens_per_second_estimate: "70-140"
                },
                installation: {
                    ollama: "ollama pull gemma3:1b",
                    description: "Latest Gemma optimized for mobile devices"
                },
                specialization: "mobile",
                languages: ["en"],
                year: 2025
            },
            {
                name: "Phi-3 Mini 3.8B",
                size: "3.8B",
                type: "local",
                category: "small",
                requirements: {
                    ram: 4,
                    vram: 2,
                    cpu_cores: 4,
                    storage: 4,
                    recommended_ram: 8
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "fast",
                    quality: "very_good",
                    context_length: 4096,
                    tokens_per_second_estimate: "25-50"
                },
                installation: {
                    ollama: "ollama pull phi3:mini",
                    description: "Microsoft's efficient small model with excellent reasoning"
                },
                specialization: "reasoning",
                languages: ["en"],
                year: 2024
            },
            {
                name: "Phi-4 14B",
                size: "14B",
                type: "local",
                category: "medium",
                requirements: {
                    ram: 16,
                    vram: 8,
                    cpu_cores: 6,
                    storage: 14,
                    recommended_ram: 24
                },
                frameworks: ["ollama", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M"],
                performance: {
                    speed: "medium",
                    quality: "excellent",
                    context_length: 16384,
                    tokens_per_second_estimate: "15-30"
                },
                installation: {
                    ollama: "ollama pull phi4:14b",
                    description: "Latest Microsoft Phi model with enhanced capabilities"
                },
                specialization: "reasoning",
                languages: ["en"],
                year: 2024
            },
            {
                name: "Llama 3.2 1B",
                size: "1B",
                type: "local",
                category: "small",
                requirements: {
                    ram: 2,
                    vram: 0,
                    cpu_cores: 2,
                    storage: 1.1,
                    recommended_ram: 4
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "very_fast",
                    quality: "good",
                    context_length: 8192,
                    tokens_per_second_estimate: "60-120"
                },
                installation: {
                    ollama: "ollama pull llama3.2:1b",
                    description: "Ultra-compact Llama for mobile and edge devices"
                },
                specialization: "general",
                languages: ["en"],
                year: 2024
            },
            {
                name: "Llama 3.2 3B",
                size: "3B",
                type: "local",
                category: "small",
                requirements: {
                    ram: 4,
                    vram: 2,
                    cpu_cores: 4,
                    storage: 3.2,
                    recommended_ram: 8
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "fast",
                    quality: "very_good",
                    context_length: 8192,
                    tokens_per_second_estimate: "30-60"
                },
                installation: {
                    ollama: "ollama pull llama3.2:3b",
                    description: "Balanced performance and efficiency from Meta"
                },
                specialization: "general",
                languages: ["en"],
                year: 2024
            },

            // Medium Models (5B - 15B parámetros)
            {
                name: "Gemma 3 4B",
                size: "4B",
                type: "local",
                category: "medium",
                requirements: {
                    ram: 6,
                    vram: 3,
                    cpu_cores: 4,
                    storage: 4.5,
                    recommended_ram: 12
                },
                frameworks: ["ollama", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "fast",
                    quality: "excellent",
                    context_length: 128000,
                    tokens_per_second_estimate: "20-40"
                },
                installation: {
                    ollama: "ollama pull gemma3:4b",
                    description: "Multimodal Gemma with long context support"
                },
                specialization: "multimodal",
                languages: ["en"],
                year: 2025,
                multimodal: true
            },
            {
                name: "Qwen 2.5 7B",
                size: "7B",
                type: "local",
                category: "medium",
                requirements: {
                    ram: 8,
                    vram: 4,
                    cpu_cores: 4,
                    storage: 7.5,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "transformers", "vllm"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "excellent",
                    context_length: 32768,
                    tokens_per_second_estimate: "15-35"
                },
                installation: {
                    ollama: "ollama pull qwen2.5:7b",
                    description: "Alibaba's latest multilingual model with strong coding abilities"
                },
                specialization: "code",
                languages: ["en", "zh", "ja", "ko", "es", "fr", "de"],
                year: 2024
            },
            {
                name: "Llama 3.1 8B",
                size: "8B",
                type: "local",
                category: "medium",
                requirements: {
                    ram: 8,
                    vram: 4,
                    cpu_cores: 4,
                    storage: 8.5,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "llama.cpp", "transformers", "vllm"],
                quantization: ["Q2_K", "Q3_K_M", "Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q6_K", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "excellent",
                    context_length: 128000,
                    tokens_per_second_estimate: "12-30"
                },
                installation: {
                    ollama: "ollama pull llama3.1:8b",
                    description: "Outstanding balance of performance and efficiency"
                },
                specialization: "general",
                languages: ["en"],
                year: 2024
            },
            {
                name: "Mistral 7B v0.3",
                size: "7B",
                type: "local",
                category: "medium",
                requirements: {
                    ram: 8,
                    vram: 4,
                    cpu_cores: 4,
                    storage: 7.2,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "llama.cpp", "transformers", "vllm"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q6_K", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "excellent",
                    context_length: 32768,
                    tokens_per_second_estimate: "15-32"
                },
                installation: {
                    ollama: "ollama pull mistral:7b",
                    description: "High-quality European model with strong reasoning"
                },
                specialization: "reasoning",
                languages: ["en", "fr", "de", "es", "it"],
                year: 2024
            },
            {
                name: "Mistral Small 3.1",
                size: "22B",
                type: "local",
                category: "large",
                requirements: {
                    ram: 24,
                    vram: 12,
                    cpu_cores: 6,
                    storage: 22,
                    recommended_ram: 32
                },
                frameworks: ["ollama", "vllm", "transformers"],
                quantization: ["Q3_K_M", "Q4_0", "Q4_K_M", "Q5_K_M"],
                performance: {
                    speed: "slow",
                    quality: "excellent",
                    context_length: 128000,
                    tokens_per_second_estimate: "8-20"
                },
                installation: {
                    ollama: "ollama pull mistral-small:22b",
                    description: "Latest Mistral model with enhanced capabilities"
                },
                specialization: "reasoning",
                languages: ["en", "fr", "de", "es", "it"],
                year: 2024
            },
            {
                name: "CodeLlama 7B",
                size: "7B",
                type: "local",
                category: "medium",
                specialization: "code",
                requirements: {
                    ram: 8,
                    vram: 4,
                    cpu_cores: 4,
                    storage: 7.2,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "excellent_for_code",
                    context_length: 16384,
                    tokens_per_second_estimate: "15-30"
                },
                installation: {
                    ollama: "ollama pull codellama:7b",
                    description: "Meta's specialized coding assistant"
                },
                languages: ["python", "javascript", "java", "c++", "c", "php", "ruby"],
                year: 2023
            },
            {
                name: "DeepSeek Coder 6.7B",
                size: "6.7B",
                type: "local",
                category: "medium",
                specialization: "code",
                requirements: {
                    ram: 8,
                    vram: 4,
                    cpu_cores: 4,
                    storage: 7,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "excellent_for_code",
                    context_length: 16384,
                    tokens_per_second_estimate: "18-35"
                },
                installation: {
                    ollama: "ollama pull deepseek-coder:6.7b",
                    description: "Specialized for code generation and analysis"
                },
                languages: ["python", "javascript", "java", "c++", "go", "rust"],
                year: 2024
            },

            // Large Models (15B+ parámetros)
            {
                name: "Gemma 3 12B",
                size: "12B",
                type: "local",
                category: "large",
                requirements: {
                    ram: 16,
                    vram: 8,
                    cpu_cores: 6,
                    storage: 13,
                    recommended_ram: 24
                },
                frameworks: ["ollama", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M"],
                performance: {
                    speed: "medium_slow",
                    quality: "excellent",
                    context_length: 128000,
                    tokens_per_second_estimate: "10-25"
                },
                installation: {
                    ollama: "ollama pull gemma3:12b",
                    description: "Large multimodal Gemma with advanced capabilities"
                },
                specialization: "multimodal",
                languages: ["en"],
                year: 2025,
                multimodal: true
            },
            {
                name: "Gemma 3 27B",
                size: "27B",
                type: "local",
                category: "large",
                requirements: {
                    ram: 32,
                    vram: 16,
                    cpu_cores: 8,
                    storage: 28,
                    recommended_ram: 48
                },
                frameworks: ["transformers", "vllm"],
                quantization: ["Q3_K_M", "Q4_0", "Q4_K_M", "Q5_K_M"],
                performance: {
                    speed: "slow",
                    quality: "excellent",
                    context_length: 128000,
                    tokens_per_second_estimate: "5-15"
                },
                installation: {
                    description: "Flagship multimodal Gemma model"
                },
                specialization: "multimodal",
                languages: ["en"],
                year: 2025,
                multimodal: true
            },
            {
                name: "Llama 3.3 70B",
                size: "70B",
                type: "local",
                category: "large",
                requirements: {
                    ram: 48,
                    vram: 24,
                    cpu_cores: 8,
                    storage: 72,
                    recommended_ram: 64,
                    recommended_vram: 48
                },
                frameworks: ["ollama", "vllm", "transformers"],
                quantization: ["Q2_K", "Q3_K_M", "Q4_0", "Q4_K_M", "Q5_K_M"],
                performance: {
                    speed: "slow",
                    quality: "excellent",
                    context_length: 128000,
                    tokens_per_second_estimate: "3-12"
                },
                installation: {
                    ollama: "ollama pull llama3.3:70b",
                    description: "Latest flagship Llama model with enhanced capabilities"
                },
                specialization: "general",
                languages: ["en"],
                year: 2024
            },
            {
                name: "DeepSeek-R1 70B",
                size: "70B",
                type: "local",
                category: "large",
                requirements: {
                    ram: 50,
                    vram: 25,
                    cpu_cores: 8,
                    storage: 75,
                    recommended_ram: 64,
                    recommended_vram: 50
                },
                frameworks: ["ollama", "vllm"],
                quantization: ["Q2_K", "Q3_K_M", "Q4_0", "Q4_K_M"],
                performance: {
                    speed: "slow",
                    quality: "excellent",
                    context_length: 65536,
                    tokens_per_second_estimate: "2-10"
                },
                installation: {
                    ollama: "ollama pull deepseek-r1:70b",
                    description: "Advanced reasoning model with o1-like capabilities"
                },
                specialization: "reasoning",
                languages: ["en", "zh"],
                year: 2025
            },

            // Multimodal Models
            {
                name: "LLaVA 7B",
                size: "7B",
                type: "local",
                category: "medium",
                specialization: "multimodal",
                requirements: {
                    ram: 10,
                    vram: 6,
                    cpu_cores: 4,
                    storage: 8,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "good",
                    context_length: 4096,
                    tokens_per_second_estimate: "12-25"
                },
                installation: {
                    ollama: "ollama pull llava:7b",
                    description: "Vision-language model for image understanding"
                },
                languages: ["en"],
                year: 2023,
                multimodal: true
            },
            {
                name: "LLaVA-NeXT 34B",
                size: "34B",
                type: "local",
                category: "large",
                specialization: "multimodal",
                requirements: {
                    ram: 36,
                    vram: 18,
                    cpu_cores: 8,
                    storage: 36,
                    recommended_ram: 48
                },
                frameworks: ["transformers"],
                quantization: ["Q3_K_M", "Q4_0", "Q4_K_M"],
                performance: {
                    speed: "slow",
                    quality: "excellent",
                    context_length: 8192,
                    tokens_per_second_estimate: "4-12"
                },
                installation: {
                    description: "Advanced multimodal model with enhanced vision capabilities"
                },
                languages: ["en"],
                year: 2024,
                multimodal: true
            },

            // Embedding Models
            {
                name: "all-MiniLM-L6-v2",
                size: "22M",
                type: "local",
                category: "embedding",
                specialization: "embeddings",
                requirements: {
                    ram: 0.5,
                    vram: 0,
                    cpu_cores: 1,
                    storage: 0.1,
                    recommended_ram: 1
                },
                frameworks: ["sentence-transformers", "ollama"],
                performance: {
                    speed: "very_fast",
                    quality: "good",
                    context_length: 512,
                    dimensions: 384
                },
                installation: {
                    ollama: "ollama pull all-minilm",
                    description: "Compact embedding model for semantic search"
                },
                languages: ["en"],
                year: 2023
            },
            {
                name: "BGE-small-en-v1.5",
                size: "33M",
                type: "local",
                category: "embedding",
                specialization: "embeddings",
                requirements: {
                    ram: 0.5,
                    vram: 0,
                    cpu_cores: 1,
                    storage: 0.1,
                    recommended_ram: 1
                },
                frameworks: ["sentence-transformers", "transformers"],
                performance: {
                    speed: "very_fast",
                    quality: "very_good",
                    context_length: 512,
                    dimensions: 384
                },
                installation: {
                    description: "High-quality English embedding model"
                },
                languages: ["en"],
                year: 2023
            }
        ];
    }

    initializeCompatibilityMatrix() {
        return {
            // Hardware tiers
            tiers: {
                ultra_low: { ram: 4, vram: 0, cpu_cores: 2 },
                low: { ram: 8, vram: 2, cpu_cores: 4 },
                medium: { ram: 16, vram: 8, cpu_cores: 6 },
                high: { ram: 32, vram: 16, cpu_cores: 8 },
                ultra_high: { ram: 64, vram: 32, cpu_cores: 12 }
            },

            // Compatibility scores by category and tier
            compatibility: {
                ultra_small: {
                    ultra_low: 95, low: 100, medium: 100, high: 100, ultra_high: 100
                },
                small: {
                    ultra_low: 70, low: 90, medium: 100, high: 100, ultra_high: 100
                },
                medium: {
                    ultra_low: 20, low: 60, medium: 85, high: 95, ultra_high: 100
                },
                large: {
                    ultra_low: 5, low: 25, medium: 50, high: 80, ultra_high: 95
                },
                embedding: {
                    ultra_low: 100, low: 100, medium: 100, high: 100, ultra_high: 100
                }
            },

            // Performance multipliers
            architecture_bonuses: {
                'Apple Silicon': 1.15,
                'x86_64_modern': 1.05,
                'ARM64': 0.95
            },

            // Quantization effectiveness
            quantization_savings: {
                'Q2_K': 0.6,   // 60% size reduction
                'Q3_K_M': 0.7, // 70% of original size
                'Q4_0': 0.75,  // 75% of original size
                'Q4_K_M': 0.75,
                'Q5_0': 0.85,  // 85% of original size
                'Q5_K_M': 0.85,
                'Q6_K': 0.9,   // 90% of original size
                'Q8_0': 0.95   // 95% of original size
            }
        };
    }

    getAllModels() {
        return this.models;
    }

    getModelsByCategory(category) {
        return this.models.filter(model => model.category === category);
    }

    getUltraSmallModels() {
        return this.getModelsByCategory('ultra_small');
    }

    getSmallModels() {
        return this.getModelsByCategory('small');
    }

    getMediumModels() {
        return this.getModelsByCategory('medium');
    }

    getLargeModels() {
        return this.getModelsByCategory('large');
    }

    getEmbeddingModels() {
        return this.getModelsByCategory('embedding');
    }

    getMultimodalModels() {
        return this.models.filter(model => model.multimodal === true);
    }

    getModelsBySpecialization(specialization) {
        return this.models.filter(model => model.specialization === specialization);
    }

    getModelsByLanguage(language) {
        return this.models.filter(model =>
            model.languages && model.languages.includes(language)
        );
    }

    getModelsByYear(year) {
        return this.models.filter(model => model.year === year);
    }

    getRecentModels(yearsBack = 1) {
        const currentYear = new Date().getFullYear();
        const cutoffYear = currentYear - yearsBack;
        return this.models.filter(model => model.year >= cutoffYear);
    }

    findModel(name) {
        return this.models.find(model =>
            model.name.toLowerCase().includes(name.toLowerCase())
        );
    }

    getHardwareTier(hardware) {
        const { memory, gpu, cpu } = hardware;
        const ram = memory.total;
        const vram = gpu.vram || 0;
        const cores = cpu.cores;
        
        // Check if it's Apple Silicon (unified memory architecture)
        const isAppleSilicon = cpu?.architecture === 'Apple Silicon' || 
                              (gpu?.model && gpu.model.toLowerCase().includes('apple')) ||
                              (cpu?.brand && cpu.brand.toLowerCase().includes('apple'));

        // Apple Silicon uses unified memory, so evaluate differently
        if (isAppleSilicon) {
            if (ram >= 64) return 'ultra_high';
            if (ram >= 24) return 'high';  // M4 Pro with 24GB should be high tier
            if (ram >= 16) return 'medium';
            if (ram >= 8) return 'low';
            return 'ultra_low';
        }

        // Traditional discrete GPU systems  
        if (ram >= 64 && vram >= 32 && cores >= 12) return 'ultra_high';
        if (ram >= 32 && vram >= 16 && cores >= 8) return 'high';
        if (ram >= 16 && vram >= 8 && cores >= 6) return 'medium';
        if (ram >= 8 && vram >= 2 && cores >= 4) return 'low';
        return 'ultra_low';
    }

    getCompatibilityScore(model, hardware) {
        const tier = this.getHardwareTier(hardware);
        const baseScore = this.compatibilityMatrix.compatibility[model.category]?.[tier] || 0;

        // Apply architecture bonus
        const architectureBonus = this.compatibilityMatrix.architecture_bonuses[hardware.cpu.architecture] || 1.0;

        // Apply quantization bonus if available
        let quantizationBonus = 1.0;
        if (model.quantization && model.quantization.length > 0) {
            // Use most aggressive quantization for limited hardware
            if (tier === 'ultra_low' || tier === 'low') {
                quantizationBonus = 1.2; // Quantization is very valuable
            }
        }

        return Math.min(100, Math.round(baseScore * architectureBonus * quantizationBonus));
    }

    getDetailedCompatibilityAnalysis(model, hardware) {
        const score = this.getCompatibilityScore(model, hardware);
        const tier = this.getHardwareTier(hardware);
        const issues = [];
        const recommendations = [];

        // Check specific requirements
        if (hardware.memory.total < model.requirements.ram) {
            issues.push(`Insufficient RAM: ${hardware.memory.total}GB < ${model.requirements.ram}GB required`);
            recommendations.push(`Upgrade to at least ${model.requirements.ram}GB RAM`);
        }

        if (hardware.gpu.vram < model.requirements.vram) {
            issues.push(`Insufficient VRAM: ${hardware.gpu.vram}GB < ${model.requirements.vram}GB required`);
            if (model.quantization && model.quantization.includes('Q4_0')) {
                recommendations.push('Consider using Q4_0 quantization to reduce VRAM usage');
            }
        }

        if (hardware.cpu.cores < model.requirements.cpu_cores) {
            issues.push(`Limited CPU cores: ${hardware.cpu.cores} < ${model.requirements.cpu_cores} recommended`);
        }

        // Performance estimation
        const estimatedPerformance = this.estimatePerformance(model, hardware);

        return {
            score,
            tier,
            issues,
            recommendations,
            canRun: score >= 60,
            estimatedPerformance,
            bestQuantization: this.getBestQuantization(model, hardware)
        };
    }

    estimatePerformance(model, hardware) {
        // Use realistic performance estimation instead of optimistic predefined values
        const estimatedTokensPerSecond = this.calculateRealisticTokensPerSecond(model, hardware);

        return {
            tokensPerSecond: estimatedTokensPerSecond,
            category: estimatedTokensPerSecond > 50 ? 'fast' :
                estimatedTokensPerSecond > 20 ? 'medium' :
                    estimatedTokensPerSecond > 5 ? 'slow' : 'very_slow',
            memoryUsage: this.estimateMemoryUsage(model),
            powerConsumption: this.estimatePowerConsumption(model, hardware)
        };
    }

    calculateRealisticTokensPerSecond(model, hardware) {
        const modelParams = this.extractModelParams(model);
        const speedProfile = estimateTokenSpeedFromHardware(hardware, {
            modelSizeB: modelParams,
            modelName: model.name
        });
        return speedProfile.tokensPerSecond;
    }

    extractModelParams(model) {
        // Try to extract parameter count from model name
        const name = model.name.toLowerCase();
        
        // Look for patterns like "7b", "3.8b", "0.5b", etc.
        const paramMatch = name.match(/(\d+\.?\d*)\s*([bm])(?:\s|$)/);
        if (paramMatch) {
            const value = parseFloat(paramMatch[1]);
            const unit = paramMatch[2].toLowerCase();
            // Convert millions to billions if needed
            return unit === 'm' ? value / 1000 : value;
        }
        
        // Fallback to size-based estimation
        const sizeGB = model.size ? parseFloat(model.size.toString()) : 4;
        // Rough estimate: 1B params ≈ 2GB in Q4 quantization
        return Math.max(0.5, sizeGB / 2);
    }

    getBestQuantization(model, hardware) {
        if (!model.quantization || model.quantization.length === 0) {
            return null;
        }

        const tier = this.getHardwareTier(hardware);

        const recommendations = {
            ultra_low: ['Q2_K', 'Q3_K_M'],
            low: ['Q4_0', 'Q4_K_M'],
            medium: ['Q4_K_M', 'Q5_0'],
            high: ['Q5_K_M', 'Q6_K'],
            ultra_high: ['Q8_0', 'Q6_K']
        };

        const recommended = recommendations[tier] || ['Q4_0'];
        return model.quantization.find(q => recommended.includes(q)) || model.quantization[0];
    }

    estimateMemoryUsage(model) {
        const sizeGB = parseFloat(model.size.replace(/[^\d.]/g, ''));

        // Rough estimates including model loading overhead
        return {
            minimal: Math.round(sizeGB * 1.2), // With quantization
            typical: Math.round(sizeGB * 1.5), // Standard loading
            maximum: Math.round(sizeGB * 2.0)  // With full context
        };
    }

    estimatePowerConsumption(model, hardware) {
        const sizeGB = parseFloat(model.size.replace(/[^\d.]/g, ''));
        const tier = this.getHardwareTier(hardware);

        const basePower = {
            ultra_low: 15,
            low: 25,
            medium: 45,
            high: 85,
            ultra_high: 150
        };

        const modelMultiplier = Math.log10(sizeGB + 1) * 0.5 + 1;

        return {
            idle: Math.round((basePower[tier] || 25) * 0.3),
            inference: Math.round((basePower[tier] || 25) * modelMultiplier),
            unit: 'watts'
        };
    }

    getModelRecommendations(hardware, useCase = 'general') {
        const tier = this.getHardwareTier(hardware);
        const allModels = this.getAllModels();

        // Filter by use case
        let relevantModels = allModels;
        if (useCase !== 'general') {
            relevantModels = allModels.filter(model =>
                model.specialization === useCase ||
                (useCase === 'chat' && !model.specialization)
            );
        }

        // Score and sort models
        const scoredModels = relevantModels.map(model => ({
            ...model,
            compatibilityScore: this.getCompatibilityScore(model, hardware)
        }));

        scoredModels.sort((a, b) => b.compatibilityScore - a.compatibilityScore);

        return {
            tier,
            topRecommendations: scoredModels.slice(0, 5),
            byCategory: {
                ultra_small: scoredModels.filter(m => m.category === 'ultra_small').slice(0, 3),
                small: scoredModels.filter(m => m.category === 'small').slice(0, 3),
                medium: scoredModels.filter(m => m.category === 'medium').slice(0, 3),
                large: scoredModels.filter(m => m.category === 'large').slice(0, 2)
            }
        };
    }
}

module.exports = ExpandedModelsDatabase;
