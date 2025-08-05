# AI Model Selector

This module implements an AI-powered model selector using a lightweight TabTransformer model that learns from performance benchmarks to recommend the optimal Ollama model for any given hardware configuration.

## 🧠 How It Works

The AI selector uses a small (<150KB) quantized ONNX model trained on hardware specifications and model performance data to predict which model will perform best on your system.

### Features

- **Hardware-Aware Selection**: Considers CPU cores, RAM, GPU VRAM, and model architecture
- **Lightweight Model**: Quantized ONNX model under 150KB
- **Fallback Heuristics**: Works even without trained model using smart heuristics
- **Continuous Learning**: Can be retrained with new benchmark data
- **Fast Inference**: Sub-second model selection

## 🚀 Quick Start

### 1. Check AI Model Status
```bash
npm run ai-check -- --status
```

### 2. Collect Benchmark Data (Optional)
```bash
npm run benchmark
```

### 3. Train AI Model (Optional)
```bash
npm run train-ai
```

### 4. Use AI Selection
```bash
npm run ai-check
npm run ai-check -- --models llama2:7b mistral:7b phi3:mini
npm run ai-check -- --prompt "Explain machine learning"
```

## 📊 Architecture

### TabTransformer Model
- **Input Features**: Hardware specs (categorical + numerical)
- **Architecture**: 2-layer transformer with 32-dim embeddings
- **Output**: Binary classification (best model probability)
- **Size**: <150KB quantized ONNX

### Feature Engineering
**Categorical Features:**
- `model_id`: Model identifier
- `gpu_model_normalized`: GPU category
- `hw_platform`: Operating system
- `ram_tier`, `cpu_tier`, `vram_tier`: Hardware capability tiers

**Numerical Features:**
- `model_size_numeric`: Model parameters in billions
- `hw_cpu_cores`: CPU core count
- `hw_cpu_freq_max`: Maximum CPU frequency
- `hw_total_ram_gb`: System RAM in GB
- `hw_gpu_vram_gb`: GPU VRAM in GB

## 🔧 Development

### Python Requirements
```bash
cd ml-model
pip install -r requirements.txt
```

### Training Pipeline
1. **Data Collection**: `benchmark_collector.py`
   - Runs performance tests on available models
   - Collects hardware specifications
   - Saves data as Parquet files

2. **Data Aggregation**: `dataset_aggregator.py`
   - Combines benchmark data from multiple machines
   - Creates training labels (best model per hardware config)
   - Preprocesses features

3. **Model Training**: `train_model.py`
   - Trains TabTransformer on processed data
   - Exports to ONNX and quantizes to INT8
   - Validates performance (target: >90% AUC)

### JavaScript Runtime
- **index.js**: ONNX runtime for model inference
- **cli.js**: Standalone CLI tool
- **test.js**: Testing utilities

## 📈 Performance Metrics

The model is trained to achieve:
- **>90% AUC** on validation set
- **<150KB** model size after quantization
- **<100ms** inference time
- **>80% accuracy** on hardware compatibility

## 🔄 Continuous Improvement

The model can be continuously improved by:
1. Running benchmarks on new hardware configurations
2. Adding new models to the training set
3. Retraining periodically with updated data
4. Fine-tuning hyperparameters based on performance

## 🛠️ API Reference

### AIModelSelector Class

```javascript
const selector = new AIModelSelector();

// Initialize (loads ONNX model)
await selector.initialize();

// Select best model
const result = await selector.selectBestModel(
  ['llama2:7b', 'mistral:7b'], 
  systemSpecs
);

// Fallback selection
const fallback = selector.selectModelHeuristic(models, specs);
```

### CLI Commands

```bash
# AI-powered selection
llm-checker ai-check

# With specific models
llm-checker ai-check -m llama2:7b mistral:7b

# With prompt
llm-checker ai-check --prompt "Hello world"

# Check training status
llm-checker ai-check --status

# Collect benchmarks
llm-checker ai-check --benchmark

# Train model
llm-checker ai-check --train
```

## 🔍 Troubleshooting

### Common Issues

1. **"ONNX model not found"**
   - Run `npm run train-ai` to train the model first
   - Or collect benchmarks with `npm run benchmark`

2. **"Python not found"**
   - Install Python ≥3.10
   - Install required packages: `pip install -r requirements.txt`

3. **"No models found"**
   - Install Ollama models: `ollama pull llama2:7b`

4. **Training fails with low AUC**
   - Collect more diverse benchmark data
   - Run benchmarks on different hardware configurations

### Debug Mode
```bash
llm-checker ai-check --debug
```

## 📝 File Structure

```
ml-model/
├── README.md                 # This file
├── requirements.txt          # Python dependencies
├── python/                   # Training pipeline
│   ├── benchmark_collector.py
│   ├── dataset_aggregator.py
│   └── train_model.py
├── js/                       # JavaScript runtime
│   ├── package.json
│   ├── index.js
│   ├── cli.js
│   └── test.js
├── data/                     # Training data
│   ├── raw/                  # Benchmark parquet files
│   └── processed/            # Processed training data
└── trained/                  # Trained model artifacts
    ├── model_quantized.onnx
    ├── metadata.json
    ├── scaler.joblib
    └── label_encoders.joblib
```

This AI-powered approach ensures optimal model selection tailored to your specific hardware, maximizing performance while minimizing resource usage.