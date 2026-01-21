<p align="center">
  <h1 align="center">LLM Checker</h1>
  <p align="center">
    <strong>Intelligent Ollama Model Selector</strong>
  </p>
  <p align="center">
    AI-powered CLI that analyzes your hardware and recommends optimal LLM models<br/>
    from <b>6,900+ variants</b> across <b>200+ Ollama models</b>
  </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ollama-checker"><img src="https://img.shields.io/npm/v/ollama-checker?style=flat-square&color=0066FF" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/ollama-checker"><img src="https://img.shields.io/npm/dm/ollama-checker?style=flat-square&color=0066FF" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-0066FF?style=flat-square" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D16-0066FF?style=flat-square" alt="Node.js"></a>
</p>

<p align="center">
  <a href="#installation">Installation</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#commands">Commands</a> •
  <a href="#scoring-system">Scoring</a> •
  <a href="#supported-hardware">Hardware</a>
</p>

---

## Why LLM Checker?

Choosing the right LLM for your hardware is complex. With thousands of model variants, quantization levels, and hardware configurations, finding the optimal model requires understanding memory bandwidth, VRAM limits, and performance characteristics.

**LLM Checker solves this.** It analyzes your system, scores every compatible model, and delivers actionable recommendations in seconds.

---

## Features

| | Feature | Description |
|:---:|---|---|
| **6,900+** | Model Variants | Complete Ollama library with all quantizations (Q2-Q8, FP16) |
| **Multi-GPU** | Hardware Detection | Apple Silicon, NVIDIA CUDA, AMD ROCm, Intel Arc, CPU |
| **4D** | Scoring Engine | Quality, Speed, Fit, Context — weighted by use case |
| **SQLite** | Instant Search | Sub-second queries across the entire model database |
| **Zero** | Native Dependencies | Pure JavaScript — works on any Node.js 16+ system |

---

## Installation

```bash
# Install globally
npm install -g ollama-checker

# Or run directly with npx
npx ollama-checker hw-detect
```

**Requirements:**
- Node.js 16+ (any version: 16, 18, 20, 22, 24)
- [Ollama](https://ollama.ai) installed for running models

---

## Quick Start

```bash
# 1. Detect your hardware capabilities
ollama-checker hw-detect

# 2. Sync the model database (first run)
ollama-checker sync

# 3. Get personalized recommendations
ollama-checker smart-recommend

# 4. Search for specific models
ollama-checker search qwen --use-case coding
```

---

## Commands

### `hw-detect` — Hardware Analysis

Detects GPU/CPU capabilities, memory bandwidth, and compatible backends.

```bash
ollama-checker hw-detect
```

```
Hardware Detection

Summary:
  Apple M4 Pro (24GB Unified Memory)
  Tier: MEDIUM HIGH
  Max model size: 15GB
  Best backend: metal

CPU:
  Apple M4 Pro
  Cores: 12 (12 physical)
  SIMD: NEON

Metal:
  GPU Cores: 16
  Unified Memory: 24GB
  Memory Bandwidth: 273GB/s
```

### `smart-recommend` — Intelligent Recommendations

Returns optimal models for your hardware, scored and ranked.

```bash
ollama-checker smart-recommend
ollama-checker smart-recommend --use-case coding
ollama-checker smart-recommend --use-case reasoning -l 10
```

```
Top Recommendations

Best Overall:
  qwen2.5-coder:7b-base-q8_0
  7B params | 7GB | Q8_0
  Score: 100/100 (Q:99 S:100 F:100)
  ~58 tokens/sec
  → ollama pull qwen2.5-coder:7b-base-q8_0

Highest Quality:
  qwen2.5-coder:14b-base-q6_K
  14B | 10.5GB | Quality: 100/100
```

### `search` — Model Search

Query the database with filters and scoring.

```bash
ollama-checker search llama -l 5
ollama-checker search coding --use-case coding
ollama-checker search qwen --quant Q4_K_M --max-size 8
```

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Number of results (default: 10) |
| `-u, --use-case <type>` | Optimize for: `general`, `coding`, `chat`, `reasoning`, `creative`, `fast` |
| `--max-size <gb>` | Maximum model size in GB |
| `--quant <type>` | Filter by quantization: `Q4_K_M`, `Q8_0`, `FP16`, etc. |
| `--family <name>` | Filter by model family |

### `sync` — Database Update

Downloads the latest model catalog from Ollama.

```bash
ollama-checker sync
```

---

## Scoring System

Models are evaluated across four dimensions, weighted by use case:

| Dimension | Description |
|-----------|-------------|
| **Q** Quality | Model family reputation + parameter count + quantization level |
| **S** Speed | Estimated tokens/sec based on your hardware bandwidth |
| **F** Fit | Memory utilization efficiency (how well it fits your VRAM) |
| **C** Context | Maximum context window capability |

### Use Case Weights

| Use Case | Quality | Speed | Fit | Context |
|----------|:-------:|:-----:|:---:|:-------:|
| `general` | 40% | 35% | 15% | 10% |
| `coding` | 55% | 20% | 15% | 10% |
| `reasoning` | 60% | 15% | 10% | 15% |
| `chat` | 40% | 40% | 15% | 5% |
| `fast` | 25% | 55% | 15% | 5% |

---

## Supported Hardware

<details>
<summary><strong>Apple Silicon</strong></summary>

- M1, M1 Pro, M1 Max, M1 Ultra
- M2, M2 Pro, M2 Max, M2 Ultra
- M3, M3 Pro, M3 Max
- M4, M4 Pro, M4 Max

</details>

<details>
<summary><strong>NVIDIA (CUDA)</strong></summary>

- RTX 40 Series (4090, 4080, 4070 Ti, 4070, 4060 Ti, 4060)
- RTX 30 Series (3090 Ti, 3090, 3080 Ti, 3080, 3070 Ti, 3070, 3060 Ti, 3060)
- Data Center (H100, A100, A10, L40, T4)

</details>

<details>
<summary><strong>AMD (ROCm)</strong></summary>

- RX 7900 XTX, 7900 XT, 7800 XT, 7700 XT
- RX 6900 XT, 6800 XT, 6800
- Instinct MI300X, MI300A, MI250X, MI210

</details>

<details>
<summary><strong>Intel</strong></summary>

- Arc A770, A750, A580, A380
- Integrated Iris Xe, UHD Graphics

</details>

<details>
<summary><strong>CPU Backends</strong></summary>

- AVX-512 + AMX (Intel Sapphire Rapids, Emerald Rapids)
- AVX-512 (Intel Ice Lake+, AMD Zen 4)
- AVX2 (Most modern x86 CPUs)
- ARM NEON (Apple Silicon, AWS Graviton, Ampere Altra)

</details>

---

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Hardware       │────▶│  Model          │────▶│  Scoring        │
│  Detection      │     │  Database       │     │  Engine         │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
   Detects GPU/CPU         SQLite cache            4D scoring
   Memory bandwidth        6,900+ variants         Use case weights
   Backend support         Auto-sync               TPS estimation
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │  Ranked         │
                                               │  Recommendations│
                                               └─────────────────┘
```

---

## Examples

**Find the best coding model for your system:**
```bash
ollama-checker smart-recommend --use-case coding -l 3
```

**Search for small, fast models under 5GB:**
```bash
ollama-checker search "7b" --max-size 5 --use-case fast
```

**List all Qwen variants with Q4_K_M quantization:**
```bash
ollama-checker search qwen --quant Q4_K_M -l 20
```

**Get high-quality reasoning models:**
```bash
ollama-checker smart-recommend --use-case reasoning
```

---

## Development

```bash
git clone https://github.com/Pavelevich/llm-checker.git
cd llm-checker
npm install
node bin/enhanced_cli.js hw-detect
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <a href="https://github.com/Pavelevich/llm-checker">GitHub</a> •
  <a href="https://www.npmjs.com/package/ollama-checker">npm</a> •
  <a href="https://github.com/Pavelevich/llm-checker/issues">Issues</a>
</p>
