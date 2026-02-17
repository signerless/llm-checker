# 📚 LLM Checker - Complete Usage Guide

This guide provides detailed examples and use cases for the LLM Checker intelligent model selector.

---

## 🎯 **Common Use Cases**

### **1. First-Time User - "What model should I use?"**

**Scenario**: You're new to LLMs and want to know what works best on your system.

```bash
# Get intelligent recommendation for your hardware
llm-checker ai-check

# See what models are available locally
llm-checker list-models

# Get broader system analysis
llm-checker check
```

**Expected Output**:
```
🧠 INTELLIGENT MODEL SELECTION 
│ 🏆 Selected Model: llama2:7b
│ 📊 Confidence: 100%
│ 🔢 Intelligence Score: 99/100
│ 💡 AI Analysis: Excellent fit for your high hardware configuration...
```

**What to do next**: Run `ollama pull llama2:7b` to install the recommended model.

---

### **2. Developer - "I need a coding assistant"**

**Scenario**: You want to find the best model for programming tasks.

```bash
# Compare coding-specific models
llm-checker ai-check --models codellama:7b deepseek-coder:6.7b starcoder:7b

# Browse all coding models
llm-checker list-models --category coding

# Quick coding session
llm-checker ai-run --prompt "Help me write a Python function to parse JSON"

# Quick coding session with calibrated routing policy (auto-discovery)
llm-checker ai-run --calibrated --category coding --prompt "Help me write a Python function to parse JSON"
```

**Why it works**: The intelligent selector considers:
- Model specialization in coding tasks
- Context length for large code files
- Performance on programming benchmarks

---

### **2.5. Calibration Workflow - "Route by measured policy"**

**Scenario**: You want deterministic routing based on your own calibration artifacts.

```bash
# Use repository fixture (or your own JSONL suite)
cp ./docs/fixtures/calibration/sample-suite.jsonl ./sample-suite.jsonl

# Generate calibration contract + routing policy
llm-checker calibrate \
  --suite ./sample-suite.jsonl \
  --models qwen2.5-coder:7b llama3.2:3b \
  --runtime ollama \
  --objective balanced \
  --dry-run \
  --output ./artifacts/calibration-result.json \
  --policy-out ./artifacts/calibration-policy.yaml

# Route recommend/ai-run through calibrated policy
llm-checker recommend --calibrated ./artifacts/calibration-policy.yaml --category coding
llm-checker ai-run --calibrated ./artifacts/calibration-policy.yaml --category coding --prompt "Refactor this function"
```

**Flag precedence**:
- `--policy <file>` overrides `--calibrated [file]`
- `--calibrated` (without path) loads `~/.llm-checker/calibration-policy.{yaml,yml,json}`

---

### **3. Researcher - "I need reasoning capabilities"**

**Scenario**: You're doing research and need models good at complex reasoning.

```bash
# Compare reasoning models
llm-checker ai-check --models llama2:13b qwen2:7b mistral:7b

# Get category-specific recommendations
llm-checker recommend --category reasoning

# Check what large models you can run
llm-checker ai-check --models llama2:70b claude:20b gpt4:175b
```

**Intelligence in action**: Prioritizes models with:
- Higher parameter counts for complex reasoning
- Strong performance on reasoning benchmarks
- Sufficient context length for multi-step problems

---

### **4. Hardware Upgrader - "What can I run with better hardware?"**

**Scenario**: You're considering a hardware upgrade and want to see potential.

```bash
# Check current capabilities
llm-checker check --detailed

# See what models require more resources
llm-checker list-models --full | grep "16.*GB\|32.*GB"

# Compare small vs large models
llm-checker ai-check --models phi3:mini llama2:7b llama2:13b llama2:70b
```

**Insight**: The hardware tier analysis shows exactly what upgrade would unlock new model tiers.

---

### **5. Performance Optimizer - "What's the fastest model for my needs?"**

**Scenario**: You need the best performance/speed ratio.

```bash
# Find efficient models
llm-checker list-models --popular --limit 20

# Compare performance profiles
llm-checker ai-check --models phi3:mini mistral:7b gemma:7b

# Test multiple sizes of same family
llm-checker ai-check --models llama2:7b llama2:13b
```

**Intelligence factors**: Considers inference speed, memory efficiency, and quality balance.

---

## 🛠️ **Advanced Usage Patterns**

### **Command Chaining for Workflows**

```bash
# Complete discovery workflow
llm-checker check && \
llm-checker list-models --category coding && \
llm-checker ai-check --models codellama:7b deepseek-coder:6.7b

# Automated model testing
for model in llama2:7b mistral:7b phi3:mini; do
  echo "Testing $model:"
  llm-checker ai-check --models $model
done
```

### **JSON Output for Integration**

```bash
# Export model database
llm-checker list-models --json > my-models.json

# Integrate with scripts
MODEL=$(llm-checker ai-check --models llama2:7b mistral:7b --json | jq -r '.bestModel')
echo "Best model: $MODEL"
```

### **Custom Model Comparison**

```bash
# Compare your installed models
MODELS=$(ollama list | tail -n +2 | awk '{print $1}' | tr '\n' ' ')
llm-checker ai-check --models $MODELS
```

---

## 🎨 **Understanding the Output**

### **Intelligence Score Breakdown**

| Score Range | Meaning | Action |
|-------------|---------|---------|
| **90-100** | Perfect match | Use immediately |
| **70-89** | Great fit | Recommended choice |
| **50-69** | Good option | Consider if you like the model |
| **30-49** | Suboptimal | Better alternatives exist |
| **0-29** | Poor fit | Likely won't work well |

### **Confidence Levels**

| Confidence | Interpretation |
|------------|----------------|
| **95-100%** | Algorithm is certain about hardware compatibility |
| **80-94%** | High confidence, good match expected |
| **60-79%** | Moderate confidence, should work well |
| **40-59%** | Lower confidence, may have limitations |
| **<40%** | Uncertain, proceed with caution |

### **Hardware Tier Impact**

```
Your Hardware Tier: HIGH
├── Can run: 7B-13B models optimally
├── Possible: 30B models with limitations  
├── Recommended: llama2:7b, mistral:7b, codellama:7b
└── Avoid: 70B+ models (insufficient memory)
```

---

## 🚨 **Troubleshooting**

### **"No models found"**

```bash
# Check if Ollama is running
ollama list

# Install some models first
ollama pull llama2:7b
ollama pull phi3:mini

# Then rerun
llm-checker ai-check
```

### **"Low confidence scores"**

This usually means:
- **Limited hardware** - Consider smaller models
- **Unusual configuration** - Algorithm less certain
- **Memory constraints** - Most models too large

**Solution**: Try with smaller models:
```bash
llm-checker ai-check --models phi3:mini gemma:2b qwen2:1.5b
```

### **"Model doesn't perform as expected"**

The algorithm optimizes for compatibility, not task-specific performance. For specialized needs:

```bash
# Check task-specific models
llm-checker list-models --category coding  # For programming
llm-checker list-models --category creative  # For writing
```

---

## 🎓 **Tips & Best Practices**

### **1. Start Small, Scale Up**
```bash
# Begin with efficient models
llm-checker ai-check --models phi3:mini gemma:2b

# Then try larger ones
llm-checker ai-check --models llama2:7b mistral:7b
```

### **2. Use Specific Comparisons**
```bash
# Instead of checking everything
llm-checker list-models --limit 50

# Compare specific candidates  
llm-checker ai-check --models model1 model2 model3
```

### **3. Monitor Resource Usage**
```bash
# Check system impact
llm-checker check --detailed

# Monitor during model execution
htop  # or Activity Monitor on macOS
```

### **4. Keep Database Updated**
```bash
# Regular updates for new models
llm-checker update-db

# Force refresh if needed
llm-checker update-db --force
```

### **5. Leverage Categories**
```bash
llm-checker list-models --category coding    # Programming
llm-checker list-models --category reasoning # Research  
llm-checker list-models --category creative  # Writing
```

---

## 🔬 **Advanced Configuration**

### **For Power Users**

The intelligent selector can be customized by editing `src/ai/intelligent-selector.js`:

```javascript
// Adjust scoring weights
this.performanceWeights = {
    memory_efficiency: 0.40,    // Increase memory priority
    performance_match: 0.30,    // Boost performance importance
    task_optimization: 0.15,    // Reduce task specificity  
    popularity_quality: 0.10,   // Less weight on popularity
    resource_efficiency: 0.05   // Keep efficiency low
};
```

### **Custom Model Profiles**

Add your own models to the database:

```javascript
'custom-model:7b': {
    name: 'Custom Model 7B',
    size_gb: 4.2,
    parameters: 7,
    memory_requirement: 8,
    cpu_cores_min: 4,
    cpu_intensive: 0.8,
    specialization: ['custom', 'specialized'],
    quality_score: 9.0,
    popularity_score: 5.0,
    context_length: 8192,
    quantization: 'Q4_0',
    inference_speed: 'medium'
}
```

---

## 📊 **Performance Benchmarking**

### **Optional ML Training Pipeline**

For users who want to contribute benchmarking data:

```bash
# Collect performance data
npm run benchmark

# Process and label data  
cd ml-model && python python/dataset_aggregator.py

# Train TabTransformer model
npm run train-ai

# Use trained model for predictions
llm-checker ai-check --status
```

This creates an ONNX model that learns from real performance data across different hardware configurations.

---

**💡 Pro Tip**: Use `llm-checker ai-check --help` and `llm-checker ai-run --help` to see all available options for any command!
