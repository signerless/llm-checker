# LLM Checker - Intelligent Ollama Model Selector

**Advanced CLI tool that analyzes your hardware and intelligently recommends the optimal Ollama LLM models for your system with automatic installation detection.**

> **Designed specifically for Ollama** - Integrates with 177+ models from the complete Ollama model library to find the best models for your hardware configuration.

[![npm version](https://badge.fury.io/js/llm-checker.svg)](https://www.npmjs.com/package/llm-checker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)

---

## ✨ **Key Features**

### 🎯 **Multiple Model Recommendations**
- **`--limit` flag**: Show multiple compatible models instead of just one
- **Ranked display**: See top 3, 5, or 10 models with compatibility scores
- **Smart alternatives**: Get backup options with unique installation commands
- **Hardware-aware filtering**: Automatically excludes unreasonably large models

### ✅ **Automatic Installation Detection**
- **Real-time detection**: Automatically detects already installed Ollama models
- **Smart Quick Start**: Shows `ollama run` for installed models, `ollama pull` for new ones
- **Status indicators**: Clear "Already installed" vs "Available for installation" status
- **No duplicate suggestions**: Won't suggest installing models you already have

### 🧠 **Intelligent Use Case Categories**
- **7 specialized categories**: coding, creative, reasoning, multimodal, embeddings, talking, general
- **Typo tolerance**: Handles common misspellings (e.g., "embedings" → "embeddings")
- **Smart filtering**: Each category shows models optimized for that specific use case
- **Category-aware scoring**: Different scoring weights for different use cases

### 📊 **Real Model Data**
- **177+ models** with accurate size data from Ollama Hub
- **Real file sizes**: Uses actual model sizes instead of parameter estimates
- **Pre-classified categories**: All models categorized by capabilities
- **Static database**: Stable, reliable model information without dynamic updates

### 🚀 **Advanced Algorithm**
- **Multi-objective ranking** with hardware-size matching
- **Hardware utilization scoring**: Penalizes models that underutilize high-end hardware
- **Smart size filtering**: Filters out models too large for your system
- **Cross-platform compatibility**: macOS, Windows, Linux with GPU detection

---

## 🚀 **Quick Start**

### Installation
```bash
npm install -g llm-checker
```

### Prerequisites
- **Node.js 16+**
- **Ollama** installed and running ([Download here](https://ollama.ai))

### Basic Usage
```bash
# Get the best model for your hardware
llm-checker check

# Show top 5 compatible models
llm-checker check --limit 5

# Get coding-specific models
llm-checker check --use-case coding --limit 3

# Find creative writing models
llm-checker check --use-case creative --limit 5
```

---

## 📋 **Available Use Cases**

| Use Case | Description | Example Models |
|----------|-------------|----------------|
| `coding` | Programming and code generation | CodeLlama, DeepSeek Coder, CodeQwen |
| `creative` | Creative writing and content | Dolphin, Wizard, Uncensored models |
| `reasoning` | Logic and mathematical reasoning | DeepSeek-R1, Phi4-reasoning, Llama3.2-vision |
| `multimodal` | Image analysis and vision tasks | Llama3.2-vision, LlaVa |
| `embeddings` | Text vectorization and search | BGE, E5, embedding models |
| `talking` | General conversation and chat | Llama, Mistral, Qwen (excluding specialized) |
| `general` | Balanced, versatile models | Mixed selection prioritizing chat/reasoning |

---

## 🛠️ **Command Reference**

### Main Commands

```bash
# Hardware analysis with model recommendations
llm-checker check [options]

# Get intelligent recommendations
llm-checker recommend [options]

# List available models
llm-checker list-models

# AI-powered model evaluation
llm-checker ai-check

# Ollama integration info
llm-checker ollama
```

### Options

```bash
# Show multiple models
--limit <number>          Number of models to show (default: 1)

# Use case filtering
--use-case <case>         Specify use case (coding, creative, reasoning, etc.)

# Output control
--no-verbose              Clean, minimal output
--include-cloud           Include cloud-based models

# Filtering
--filter <type>           Filter by model type
--ollama-only             Only show Ollama-available models
```

---

## 📖 **Examples**

### Basic Recommendations
```bash
# Single best model
llm-checker check
# Output: Shows #1 model with installation command

# Multiple options
llm-checker check --limit 5
# Output: Shows top 5 ranked models with scores
```

### Use Case Specific
```bash
# Coding models
llm-checker check --use-case coding --limit 3
# Output: CodeLlama, DeepSeek Coder, CodeQwen with install commands

# Creative writing
llm-checker check --use-case creative --limit 5
# Output: Dolphin, Wizard, creative-optimized models

# Reasoning tasks
llm-checker check --use-case reasoning --limit 3
# Output: DeepSeek-R1, Phi4-reasoning, specialized reasoning models
```

### Installation Detection
```bash
llm-checker check --limit 5 --use-case coding
```
Example output:
```
TOP 5 COMPATIBLE MODELS

#1 - CodeLlama 7B
Size: 3.8GB
Compatibility Score: 84.88/100
Status: Already installed in Ollama

#2 - Qwen 2.5 7B  
Size: 5.2GB
Compatibility Score: 83.78/100
Status: Available for installation

QUICK START
1. Start using your installed model:
   ollama run codellama:7b

Alternative options:
   2. ollama pull qwen2.5:7b
   3. ollama pull codeqwen
```

---

## 🔧 **Advanced Features**

### Hardware Tier Detection  
- **Flagship**: RTX 5090/H100 tier → 30B-175B models (new!)
- **Ultra High**: RTX 4090/A100 tier → 20B-105B models  
- **High**: RTX 4080/Apple Silicon 32GB → 8B-50B models
- **Medium**: RTX 4070/Apple Silicon 16GB → 3B-20B models
- **Low**: Budget systems → 1B-8B models
- **Ultra Low**: Very limited systems → <3B models

### Smart Filtering
- Automatically excludes models >25GB for systems with <32GB RAM
- Penalizes tiny models on high-end hardware
- Prioritizes models in the "sweet spot" for your hardware tier
- Removes duplicate commands from alternatives

### Cross-Platform Support
- **macOS**: Apple Silicon optimization with unified memory
- **Windows**: NVIDIA/AMD GPU detection with device ID mapping  
- **Linux**: Full GPU compatibility with proper driver detection

---

## 🔒 Security & Caching

- Installation guidance: For Ollama on Linux, prefer official package managers or documented methods rather than piping remote scripts into the shell. See the official installation docs: https://github.com/ollama/ollama/blob/main/docs/linux.md
- Cache location: The Ollama model cache used by LLM Checker is stored at `~/.llm-checker/cache/ollama`.
- Backward compatibility: Existing cache files in the legacy path (`src/ollama/.cache`) are still read if present, but new cache writes go to the home directory.

---

## 🚀 **What's New in v2.7.0**

### 🎯 **Complete Windows High-End GPU Optimization**
- **NEW Flagship Tier**: RTX 5090, H100, A100 now properly recognized  
- **Enhanced RTX 50xx Support**: Up to 50% RAM offload capacity (was 30%)
- **Smarter Memory Utilization**: 95% VRAM efficiency for flagship GPUs
- **Better Model Range**: Flagship systems now handle 30B-175B models

### 🔄 **Improved Compatibility Classification**
- **Realistic Thresholds**: Compatible 65%+ (was 75%+), Marginal 45-64%
- **Better Category Filtering**: All use cases now work correctly on both platforms
- **Cross-Platform Parity**: Windows and Mac now have similar model counts

### 🧠 **Enhanced Multi-Objective Scoring**
- **Hardware Match Priority**: Increased from 5% to 30% weight for better sizing
- **Platform-Specific Optimization**: Apple Silicon vs Windows GPU paths
- **Quality-Speed Balance**: Reduced speed emphasis for high-end hardware

### 🛠️ **Bug Fixes**
- **Chat Category Filter**: Now correctly excludes coding models
- **Embeddings Fallback**: Proper filtering when no compatible models found  
- **Score Display**: Fixed 5/100 score bug in CLI output
- **Platform Detection**: Now uses hardware OS for simulation support

---

## 🤝 **Contributing**

Contributions are welcome! Please feel free to submit a Pull Request.

### Development
```bash
git clone https://github.com/Pavelevich/llm-checker.git
cd llm-checker
npm install

# Run locally
node bin/enhanced_cli.js check --limit 5
```

---

## 📄 **License**

MIT License - see [LICENSE](LICENSE) file for details.

---

## 👨‍💻 **Author**

**Pavelevich** - [GitHub](https://github.com/Pavelevich)

---

## ⭐ **Support**

If you find LLM Checker useful, please consider:
- Starring the repository ⭐
- Contributing improvements 🛠️
- Reporting issues 🐛
- Sharing with others 📢
