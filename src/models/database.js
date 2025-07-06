class ModelsDatabase {
    constructor() {
        this.models = this.initializeModels();
    }

    initializeModels() {
        return [

            {
                name: "TinyLlama 1.1B",
                size: "1.1B",
                type: "local",
                category: "small",
                requirements: {
                    ram: 2,
                    vram: 0,
                    cpu_cores: 2,
                    storage: 2,
                    recommended_ram: 4
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                quantization: ["Q4_0", "Q4_1", "Q5_0", "Q5_1", "Q8_0"],
                performance: {
                    speed: "very_fast",
                    quality: "basic",
                    context_length: 2048
                },
                installation: {
                    ollama: "ollama pull tinyllama",
                    llamacpp: "Download from HuggingFace: TinyLlama/TinyLlama-1.1B-Chat-v1.0",
                    description: "Perfect for testing and basic tasks on limited hardware"
                }
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
                quantization: ["Q4_0", "Q4_1", "Q5_0", "Q5_1", "Q8_0"],
                performance: {
                    speed: "fast",
                    quality: "good",
                    context_length: 4096
                },
                installation: {
                    ollama: "ollama pull phi3:mini",
                    description: "Microsoft's efficient small model with good performance"
                }
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
                    storage: 3,
                    recommended_ram: 8
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "fast",
                    quality: "good",
                    context_length: 8192
                },
                installation: {
                    ollama: "ollama pull llama3.2:3b",
                    description: "Latest Llama model optimized for efficiency"
                }
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
                    storage: 8,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "llama.cpp", "transformers", "vllm"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q6_K", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "very_good",
                    context_length: 128000
                },
                installation: {
                    ollama: "ollama pull llama3.1:8b",
                    description: "Excellent balance between performance and resource usage"
                }
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
                    storage: 7,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "llama.cpp", "transformers", "vllm"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q6_K", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "very_good",
                    context_length: 32768
                },
                installation: {
                    ollama: "ollama pull mistral:7b",
                    description: "High-quality model from Mistral AI"
                }
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
                    storage: 7,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "excellent_for_code",
                    context_length: 16384
                },
                installation: {
                    ollama: "ollama pull codellama:7b",
                    description: "Specialized for code generation and analysis"
                }
            },

            // Modelos grandes
            {
                name: "Llama 3.1 70B",
                size: "70B",
                type: "local",
                category: "large",
                requirements: {
                    ram: 48,
                    vram: 24,
                    cpu_cores: 8,
                    storage: 70,
                    recommended_ram: 64,
                    recommended_vram: 48
                },
                frameworks: ["ollama", "llama.cpp", "transformers", "vllm"],
                quantization: ["Q2_K", "Q3_K_M", "Q4_0", "Q4_K_M", "Q5_K_M"],
                performance: {
                    speed: "slow",
                    quality: "excellent",
                    context_length: 128000
                },
                installation: {
                    ollama: "ollama pull llama3.1:70b",
                    description: "High-end model requiring significant resources"
                }
            },
            {
                name: "CodeLlama 34B",
                size: "34B",
                type: "local",
                category: "large",
                specialization: "code",
                requirements: {
                    ram: 24,
                    vram: 12,
                    cpu_cores: 8,
                    storage: 34,
                    recommended_ram: 32,
                    recommended_vram: 20
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                quantization: ["Q3_K_M", "Q4_0", "Q4_K_M", "Q5_K_M"],
                performance: {
                    speed: "slow",
                    quality: "excellent_for_code",
                    context_length: 16384
                },
                installation: {
                    ollama: "ollama pull codellama:34b",
                    description: "Large model specialized for complex coding tasks"
                }
            },
            {
                name: "Mixtral 8x7B",
                size: "47B",
                type: "local",
                category: "large",
                architecture: "mixture_of_experts",
                requirements: {
                    ram: 32,
                    vram: 16,
                    cpu_cores: 8,
                    storage: 47,
                    recommended_ram: 48,
                    recommended_vram: 24
                },
                frameworks: ["ollama", "llama.cpp", "transformers", "vllm"],
                quantization: ["Q2_K", "Q3_K_M", "Q4_0", "Q4_K_M", "Q5_K_M"],
                performance: {
                    speed: "medium_slow",
                    quality: "excellent",
                    context_length: 32768
                },
                installation: {
                    ollama: "ollama pull mixtral:8x7b",
                    description: "Mixture of experts model with excellent performance"
                }
            },


            {
                name: "Stable Code 3B",
                size: "3B",
                type: "local",
                category: "small",
                specialization: "code",
                requirements: {
                    ram: 4,
                    vram: 2,
                    cpu_cores: 4,
                    storage: 3,
                    recommended_ram: 8
                },
                frameworks: ["ollama", "transformers"],
                performance: {
                    speed: "fast",
                    quality: "good_for_code",
                    context_length: 16384
                },
                installation: {
                    description: "Stability AI's code model for programming tasks"
                }
            },
            {
                name: "Neural Chat 7B",
                size: "7B",
                type: "local",
                category: "medium",
                specialization: "chat",
                requirements: {
                    ram: 8,
                    vram: 4,
                    cpu_cores: 4,
                    storage: 7,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                performance: {
                    speed: "medium",
                    quality: "very_good",
                    context_length: 8192
                },
                installation: {
                    ollama: "ollama pull neural-chat:7b",
                    description: "Intel's conversational AI model"
                }
            },

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
                performance: {
                    speed: "medium",
                    quality: "good",
                    context_length: 4096
                },
                installation: {
                    ollama: "ollama pull llava:7b",
                    description: "Vision-language model for image understanding"
                }
            },


            {
                name: "GPT-4",
                size: "Unknown",
                type: "cloud",
                category: "large",
                provider: "OpenAI",
                requirements: {
                    ram: 0,
                    vram: 0,
                    cpu_cores: 0,
                    storage: 0,
                    internet: true
                },
                performance: {
                    speed: "depends_on_api",
                    quality: "excellent",
                    context_length: 128000
                },
                cost: "Pay per token",
                installation: {
                    description: "Requires OpenAI API key and internet connection"
                }
            },
            {
                name: "Claude 3.5 Sonnet",
                size: "Unknown",
                type: "cloud",
                category: "large",
                provider: "Anthropic",
                requirements: {
                    ram: 0,
                    vram: 0,
                    cpu_cores: 0,
                    storage: 0,
                    internet: true
                },
                performance: {
                    speed: "depends_on_api",
                    quality: "excellent",
                    context_length: 200000
                },
                cost: "Pay per token",
                installation: {
                    description: "Requires Anthropic API key and internet connection"
                }
            }
        ];
    }

    getAllModels() {
        return this.models;
    }

    getModelsByCategory(category) {
        return this.models.filter(model => model.category === category);
    }

    getModelsByType(type) {
        return this.models.filter(model => model.type === type);
    }

    getModelsBySpecialization(specialization) {
        return this.models.filter(model => model.specialization === specialization);
    }

    getLocalModels() {
        return this.models.filter(model => model.type === 'local');
    }

    getCloudModels() {
        return this.models.filter(model => model.type === 'cloud');
    }

    findModel(name) {
        return this.models.find(model =>
            model.name.toLowerCase().includes(name.toLowerCase())
        );
    }

    getModelRequirements(modelName) {
        const model = this.findModel(modelName);
        return model ? model.requirements : null;
    }

    getInstallationInstructions(modelName) {
        const model = this.findModel(modelName);
        if (!model) return null;

        let instructions = `Model: ${model.name}\n`;
        instructions += `Size: ${model.size} parameters\n`;
        instructions += `Type: ${model.type}\n`;

        if (model.requirements) {
            instructions += `\nRequirements:\n`;
            instructions += `- RAM: ${model.requirements.ram}GB (recommended: ${model.requirements.recommended_ram || model.requirements.ram}GB)\n`;
            instructions += `- VRAM: ${model.requirements.vram}GB\n`;
            instructions += `- CPU Cores: ${model.requirements.cpu_cores}\n`;
            instructions += `- Storage: ${model.requirements.storage}GB\n`;
        }

        if (model.installation) {
            instructions += `\nInstallation:\n`;
            if (model.installation.ollama) {
                instructions += `- Ollama: ${model.installation.ollama}\n`;
            }
            if (model.installation.llamacpp) {
                instructions += `- Llama.cpp: ${model.installation.llamacpp}\n`;
            }
            if (model.installation.description) {
                instructions += `- ${model.installation.description}\n`;
            }
        }

        if (model.frameworks) {
            instructions += `\nSupported frameworks: ${model.frameworks.join(', ')}\n`;
        }

        return instructions;
    }

    getRecommendedModels(hardware) {
        const recommendations = [];

        const { memory, gpu, cpu } = hardware;

        if (memory.total >= 32 && gpu.vram >= 16) {
            recommendations.push(
                "Your system can handle large models like Llama 3.1 70B or Mixtral 8x7B",
                "Consider using Q4_K_M quantization for optimal performance",
                "You can run multiple smaller models simultaneously"
            );
        } else if (memory.total >= 16 && gpu.vram >= 8) {
            recommendations.push(
                "Perfect for medium models like Llama 3.1 8B or Mistral 7B",
                "You can experiment with larger models using heavy quantization",
                "Consider specialized models like CodeLlama for programming tasks"
            );
        } else if (memory.total >= 8) {
            recommendations.push(
                "Great for small to medium models like Phi-3 Mini or Llama 3.2 3B",
                "Use Q4_0 quantization for better performance",
                "TinyLlama is perfect for testing and basic tasks"
            );
        } else {
            recommendations.push(
                "Your system is best suited for very small models like TinyLlama",
                "Consider using cloud-based models for complex tasks",
                "Upgrading RAM would significantly improve model compatibility"
            );
        }

        if (cpu.architecture === 'Apple Silicon') {
            recommendations.push(
                "Apple Silicon optimizations available in llama.cpp",
                "Metal GPU acceleration supported for better performance"
            );
        }

        return recommendations;
    }
}

module.exports = ModelsDatabase;