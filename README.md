# LLM Checker - Intelligent Ollama Model Selector

**AI-powered CLI tool that analyzes your hardware and recommends optimal LLM models from 6900+ variants across 200+ Ollama models.**

[![npm version](https://badge.fury.io/js/ollama-checker.svg)](https://www.npmjs.com/package/ollama-checker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)

---

## Features

- **6900+ Model Variants** - Complete Ollama library with all quantizations (Q2-Q8, FP16)
- **Smart Scoring Engine** - Multi-dimensional scoring: Quality, Speed, Fit, Context
- **Hardware Detection** - Apple Silicon, NVIDIA CUDA, AMD ROCm, Intel Arc, CPU
- **Instant Search** - SQLite-powered search across all models
- **Zero Native Dependencies** - Pure JavaScript, works with any Node.js version

---

## Quick Start

### Installation

```bash
npm install -g ollama-checker
```

### Basic Usage

```bash
# Detect your hardware
ollama-checker hw-detect

# Get smart recommendations
ollama-checker smart-recommend

# Search for specific models
ollama-checker search qwen -l 5

# Sync model database (first time)
ollama-checker sync
```

---

## Commands

### `hw-detect` - Hardware Detection

Analyzes your system and shows compatible backends:

```bash
ollama-checker hw-detect
```

Output:
```
=== Hardware Detection ===

Summary:
  Apple M4 Pro (24GB Unified Memory)
  Tier: MEDIUM HIGH
  Max model size: 15GB
  Best backend: metal

CPU:
  Apple M4 Pro
  Cores: 12 (12 physical)
  SIMD: NEON

METAL:
  GPU Cores: 16
  Unified Memory: 24GB
  Memory Bandwidth: 273GB/s
```

### `smart-recommend` - Intelligent Recommendations

Gets the best models for your hardware:

```bash
ollama-checker smart-recommend
ollama-checker smart-recommend --use-case coding
ollama-checker smart-recommend -l 10
```

Output:
```
=== Top Recommendations ===

Best Overall:
  qwen2.5-coder:7b-base-q8_0
  7B params | 7GB | Q8_0
  Score: 100/100 (Q:99 S:100 F:100)
  ~58 tokens/sec
  ollama pull qwen2.5-coder:7b-base-q8_0

Highest Quality:
  qwen2.5-coder:14b-base-q6_K
  14B | 10.5GB | Quality: 100/100
```

### `search` - Find Models

Search with intelligent scoring:

```bash
ollama-checker search llama -l 5
ollama-checker search coding --use-case coding
ollama-checker search qwen --quant Q4_K_M
```

Options:
- `-l, --limit <n>` - Number of results (default: 10)
- `-u, --use-case <case>` - Optimize for: general, coding, chat, reasoning, creative
- `--max-size <gb>` - Maximum model size
- `--quant <type>` - Filter by quantization (Q4_K_M, Q8_0, etc.)
- `--family <name>` - Filter by model family

### `sync` - Update Database

Downloads latest models from Ollama:

```bash
ollama-checker sync
```

---

## Scoring System

Models are scored on 4 dimensions:

| Component | Description | Weight (General) |
|-----------|-------------|------------------|
| **Q** Quality | Model family + params + quantization | 40% |
| **S** Speed | Estimated tokens/sec on your hardware | 35% |
| **F** Fit | How well it fits in your memory | 15% |
| **C** Context | Context length capability | 10% |

### Use Case Weights

| Use Case | Quality | Speed | Fit | Context |
|----------|---------|-------|-----|---------|
| general | 40% | 35% | 15% | 10% |
| coding | 55% | 20% | 15% | 10% |
| reasoning | 60% | 15% | 10% | 15% |
| chat | 40% | 40% | 15% | 5% |
| fast | 25% | 55% | 15% | 5% |

---

## Supported Hardware

### Apple Silicon
- M1, M1 Pro, M1 Max, M1 Ultra
- M2, M2 Pro, M2 Max, M2 Ultra
- M3, M3 Pro, M3 Max
- M4, M4 Pro, M4 Max

### NVIDIA (CUDA)
- RTX 40 Series (4090, 4080, 4070, etc.)
- RTX 30 Series (3090, 3080, 3070, etc.)
- Data Center (H100, A100, etc.)

### AMD (ROCm)
- RX 7900 XTX, 7900 XT, 7800 XT
- RX 6900 XT, 6800 XT
- MI300, MI250

### Intel
- Arc A770, A750
- Integrated Iris/UHD

### CPU
- AVX-512 + AMX (Intel Sapphire Rapids+)
- AVX-512
- AVX2
- ARM NEON (Apple Silicon, ARM servers)

---

## Requirements

- **Node.js 16+** (any version: 16, 18, 20, 22, 24...)
- **Ollama** installed for running models (https://ollama.ai)

---

## How It Works

1. **Hardware Detection** - Detects GPU/CPU capabilities and available memory
2. **Database Sync** - Downloads model info from Ollama (cached locally in SQLite)
3. **Scoring** - Calculates multi-dimensional scores for each model variant
4. **Recommendations** - Returns models sorted by compatibility score

---

## Examples

### Find the best coding model

```bash
ollama-checker smart-recommend --use-case coding -l 3
```

### Search for small, fast models

```bash
ollama-checker search "3b OR 7b" --max-size 5 -l 10
```

### Get all Qwen variants

```bash
ollama-checker search qwen -l 20
```

---

## Development

```bash
git clone https://github.com/Pavelevich/ollama-checker.git
cd ollama-checker
npm install
node bin/enhanced_cli.js hw-detect
```

---

## License

MIT License - see LICENSE for details.

---

## Links

- GitHub: https://github.com/Pavelevich/ollama-checker
- npm: https://www.npmjs.com/package/ollama-checker
- Issues: https://github.com/Pavelevich/ollama-checker/issues
