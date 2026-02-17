# Advanced Usage Guide – LLM Checker 2.0 🎛️

This document goes beyond the quick‑start, showing how to **tweak, automate and extend LLM Checker for professional workflows**.

---

## 🎛️ Advanced Configuration

### Custom configuration file

Create `~/.llm-checker.json` to override defaults:

```json
{
  "analysis": {
    "defaultUseCase": "code",
    "performanceTesting": true
  },
  "display": {
    "maxModelsPerTable": 15,
    "compactMode": true
  },
  "filters": {
    "minCompatibilityScore": 75,
    "excludeModels": ["very-large-model"]
  }
}
```

### Environment variables

```bash
# Disable GPU detection (handy for unit tests)
export LLM_CHECKER_NO_GPU=true

# Force VRAM if auto‑detection fails
export LLM_CHECKER_VRAM_GB=8

# Point to a remote Ollama daemon
export OLLAMA_BASE_URL=http://remote-server:11434

# Verbose logs
export LLM_CHECKER_LOG_LEVEL=debug

# Custom cache directory
export LLM_CHECKER_CACHE_DIR=/custom/cache/path

# Disable coloured output (for scripts/CI)
export NO_COLOR=1
```

---

## 🔧 Advanced Workflows

### 1 — Automated analysis for CI/CD

```bash
#!/usr/bin/env bash
# ci-llm-check.sh – Continuous Integration helper

# Silent JSON output
llm-checker check --format json --quiet > hardware-analysis.json

# Fail the job if no compatible models
COMPATIBLE_MODELS=$(jq '.compatible | length' < hardware-analysis.json)

if [ "$COMPATIBLE_MODELS" -gt 0 ]; then
  echo "✅  Hardware supports $COMPATIBLE_MODELS model(s)"
  exit 0
else
  echo "❌  Hardware not powerful enough for local LLMs"
  exit 1
fi
```

### 2 — Automated developer setup

```bash
#!/usr/bin/env bash
# setup-dev-environment.sh

echo "🔍  Analysing hardware…"
llm-checker check --use-case code --filter medium --ollama-only > analysis.txt

# Extract recommended installation commands
INSTALL_COMMANDS=$(grep "ollama pull" analysis.txt)

echo "📦  Installing recommended models…"
echo "$INSTALL_COMMANDS" | head -3 | while read cmd; do
  echo "Running: $cmd"
  $cmd
done

echo "✅  Development environment ready"
```

### 3 — Continuous performance monitoring

```bash
#!/usr/bin/env bash
# monitor-performance.sh

while true; do
  echo "$(date): System health check…"

  # Benchmark
  llm-checker check --performance-test --quiet | grep "tokens/sec"

  # Running Ollama models
  llm-checker ollama --running

  sleep 300   # every 5 min
done
```

---

## 📊 Comparative Analysis

### Compare multiple RAM configs

```bash
echo "RAM sensitivity test:"

for ram in 8 16 32 64; do
  echo "=== ${ram} GB RAM ==="
  LLM_CHECKER_RAM_GB=$ram llm-checker check --quiet | grep "Compatible:"
done
```

### Benchmark every installed model

```bash
echo "# Performance Report – $(date)" > performance-report.md

ollama list | grep -v NAME | awk '{print $1}' | while read model; do
  echo "## $model" >> performance-report.md
  llm-checker ollama --test "$model" >> performance-report.md
  echo "" >> performance-report.md
done
```

---

## 🛠️ IDE & Editor Integration

### VS Code tasks

```jsonc
// .vscode/tasks.json
{
  "version": "2.0.1",
  "tasks": [
    {
      "label": "Check LLM Compatibility",
      "type": "shell",
      "command": "llm-checker",
      "args": ["check", "--use-case", "code", "--detailed"],
      "group": "build",
      "presentation": {
        "echo": true,
        "reveal": "always",
        "focus": false,
        "panel": "shared"
      }
    },
    {
      "label": "Install Best Code Model",
      "type": "shell",
      "command": "bash",
      "args": [
        "-c",
        "llm-checker check --use-case code --ollama-only | grep 'ollama pull' | head -1 | bash"
      ],
      "group": "build"
    }
  ]
}
```

### Vim / Neovim Lua helper

```lua
-- lua/llm-checker.lua
local M = {}

function M.check_compatibility()
  local output = vim.fn.system('llm-checker check --use-case code --quiet')
  vim.api.nvim_echo({{output, 'Normal'}}, false, {})
end

function M.install_best_model()
  local cmd = vim.fn.system("llm-checker check --use-case code --ollama-only | grep 'ollama pull' | head -1")
  if cmd ~= '' then
    vim.fn.system(cmd)
    print('Installed model: ' .. cmd)
  end
end

return M
```

---

## 🔍 Advanced Troubleshooting

### Full debug mode

```bash
export DEBUG=1
export LLM_CHECKER_LOG_LEVEL=debug
llm-checker check --detailed 2>&1 | tee debug.log
```

### Common issues & fixes

#### 1 — Wrong hardware detection

```bash
llm-checker check --detailed | grep -A10 "Hardware"

# Override manually
export LLM_CHECKER_RAM_GB=16
export LLM_CHECKER_VRAM_GB=8
export LLM_CHECKER_CPU_CORES=8
```

#### 2 — Ollama not detected

```bash
# Check service
systemctl status ollama          # Linux
brew services list | grep ollama # macOS

# Test API
curl http://localhost:11434/api/version

# Custom URL
export OLLAMA_BASE_URL=http://192.168.1.100:11434
```

#### 3 — Models not marked compatible

```bash
# Remove score filter
llm-checker check --min-score 0 --include-all

# Model‑level diagnostics
llm-checker analyze-model "TinyLlama 1.1B"
```

---

## 📈 Performance Optimisation

### Architecture‑specific flags

#### Apple Silicon (M1/M2/M3)

```bash
export LLAMA_METAL=1   # Use Metal backend

llm-checker check --filter small,medium --detailed | grep -A5 "Apple Silicon"
```

#### NVIDIA GPUs

```bash
nvidia-smi                     # Verify CUDA
llm-checker check --gpu-acceleration cuda
```

#### AMD GPUs

```bash
rocm-smi                       # Verify ROCm
export LLAMA_OPENCL=1          # OpenCL fallback
```

### Quantisation tuning

```bash
for quant in Q2_K Q4_0 Q4_K_M Q5_0 Q8_0; do
  echo "=== $quant ==="
  llm-checker analyze --quantization $quant
done
```

---

## 🚀 Specific Use Cases

### 1 — Building AI apps

```bash
llm-checker check --use-case chat --filter small,medium
ollama pull $(llm-checker check --use-case chat | grep "ollama pull" | head -1 | cut -d' ' -f3)

curl -X POST http://localhost:11434/api/generate   -H "Content-Type: application/json"   -d '{"model":"llama3.2:3b","prompt":"Hello!","stream":false}'
```

### 2 — Large‑scale code analysis

```bash
ollama pull codellama:7b
echo 'def fibonacci(n): pass' | ollama run codellama:7b "Complete this function:"
```

### 3 — Semantic search

```bash
llm-checker check --filter embeddings
ollama pull all-minilm
echo "machine learning" | ollama run all-minilm "Generate embedding:"
```

---

## 📊 Reporting & Metrics

### Automated reports

```bash
llm-checker check --detailed --export json > report.json
llm-checker check --detailed --export html > report.html
llm-checker check --detailed --export csv  > report.csv

# Trend tracking
echo "$(date),$(llm-checker check --quiet | grep 'Compatible:' | grep -o '[0-9]*')" >> compatibility-trends.csv
```

### Adoption metrics

```bash
llm-checker ollama --list --format json | jq '.[] | {name, sizeGB: .fileSizeGB, lastUsed: .modified}'
find ~/.llm-checker/benchmarks -name "*.json" | xargs jq '.tokensPerSecond' | sort -n
```

---

## 🔐 Security & Privacy

### Fully offline mode

```bash
export LLM_CHECKER_OFFLINE=1
export LLM_CHECKER_NO_UPDATE_CHECK=1
llm-checker check --offline --no-cloud
```

### Sanitise logs

```bash
llm-checker check --anonymize-hardware > safe-report.txt
```

---

## 🤝 Contribution & Extensibility

### Adding custom models

```javascript
// custom-models.js
module.exports = [
  {
    name: "MyCustom Model 7B",
    size: "7B",
    type: "local",
    category: "medium",
    requirements: { ram: 8, vram: 4, cpu_cores: 4, storage: 7 },
    frameworks: ["ollama"],
    installation: { ollama: "ollama pull mycustom:7b" }
  }
];
```

### Plugin system

```bash
export LLM_CHECKER_PLUGINS_DIR=~/.llm-checker/plugins
llm-checker check --load-plugins
```

---

Made with ❤️ by **Pavelevich**.
