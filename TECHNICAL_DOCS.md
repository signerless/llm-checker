# 🔧 LLM Checker - Technical Documentation

Detailed technical documentation for developers, contributors, and advanced users.

---

## 🏗️ **Architecture Overview**

### **System Design**

```
┌─────────────────────────────────────────────────┐
│                 CLI Interface                    │
│              (enhanced_cli.js)                   │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│              Main LLM Checker                    │
│                (src/index.js)                    │
└─────────┬───────────────────────────┬───────────┘
          │                           │
┌─────────▼─────────┐       ┌─────────▼─────────┐
│  Hardware         │       │  AI Model         │
│  Detection        │       │  Selector         │
│                   │       │                   │
│ • CPU/RAM/GPU     │       │ • Mathematical    │
│ • Tier Analysis   │       │   Algorithm       │
│ • Performance     │       │ • 5-Factor        │
│   Calculation     │       │   Scoring         │
└─────────┬─────────┘       └─────────┬─────────┘
          │                           │
          └─────────┬───────────────┬─┘
                    │               │
          ┌─────────▼─────────┐   ┌─▼─────────────┐
          │  Model Database   │   │ Ollama        │
          │                   │   │ Integration   │
          │ • 15+ Models      │   │               │
          │ • Characteristics │   │ • Client      │
          │ • Scoring Data    │   │ • Scraper     │
          └───────────────────┘   └───────────────┘
```

---

## 🧠 **Intelligent Selector Algorithm**

### **Core Algorithm Flow**

```javascript
function selectBestModel(hardware, availableModels, userPreference) {
    // 1. Hardware Analysis
    const analysis = analyzeHardware(hardware);
    
    // 2. Model Scoring
    const scores = availableModels.map(model => ({
        model,
        score: calculateModelScore(model, hardware, analysis, userPreference)
    }));
    
    // 3. Ranking & Selection
    const ranked = scores.sort((a, b) => b.score - a.score);
    
    // 4. Confidence Calculation
    const confidence = calculateConfidence(ranked[0].score, analysis);
    
    // 5. Reasoning Generation
    const reasoning = generateReasoning(ranked[0].model, hardware, analysis);
    
    return {
        bestModel: ranked[0].model,
        confidence,
        reasoning,
        allPredictions: ranked
    };
}
```

### **5-Factor Scoring System**

#### **1. Memory Efficiency Score (35% weight)**

```javascript
calculateMemoryEfficiencyScore(model, analysis) {
    const requiredMemory = model.memory_requirement;
    const availableMemory = analysis.available_memory.total;
    
    if (requiredMemory > availableMemory) {
        return 0.1; // Severe penalty for overflow
    }
    
    const utilizationRatio = requiredMemory / availableMemory;
    
    // Optimal utilization curve
    if (utilizationRatio <= 0.3) return 0.6; // Under-utilizing
    if (utilizationRatio <= 0.5) return 0.8; // Good utilization  
    if (utilizationRatio <= 0.7) return 1.0; // Optimal utilization
    if (utilizationRatio <= 0.9) return 0.9; // High utilization
    return 0.7; // Very tight fit
}
```

#### **2. Performance Match Score (25% weight)**

```javascript
calculatePerformanceMatchScore(model, analysis) {
    // CPU capability vs model requirements
    const cpuMatch = Math.min(1.0, 
        analysis.cpu_tier.multiplier * model.cpu_intensive
    );
    
    // Memory tier bonus
    const memoryMatch = analysis.memory_tier.multiplier / 2.0;
    
    // GPU acceleration bonus
    const gpuBoost = analysis.gpu_tier.multiplier > 1.0 ? 0.2 : 0;
    
    return Math.min(1.0, cpuMatch + memoryMatch + gpuBoost);
}
```

#### **3. Task Optimization Score (20% weight)**

```javascript
calculateTaskOptimizationScore(model, userPreference) {
    if (model.specialization.includes(userPreference)) {
        return 1.0; // Perfect match
    }
    
    // Check for compatible tasks
    const compatibleTasks = {
        'coding': ['programming', 'debugging'],
        'general': ['chat', 'reasoning'],
        'chat': ['general', 'reasoning']
    };
    
    const compatible = compatibleTasks[userPreference] || [];
    const hasCompatible = compatible.some(task => 
        model.specialization.includes(task)
    );
    
    return hasCompatible ? 0.7 : 0.5;
}
```

#### **4. Quality/Popularity Score (15% weight)**

```javascript
calculatePopularityQualityScore(model) {
    const qualityNormalized = model.quality_score / 10.0;
    const popularityNormalized = model.popularity_score / 10.0;
    
    // Quality is more important than popularity
    return (qualityNormalized * 0.6) + (popularityNormalized * 0.4);
}
```

#### **5. Resource Efficiency Score (5% weight)**

```javascript
calculateResourceEfficiencyScore(model, analysis) {
    const efficiencyFactors = {
        inference_speed: {
            'very_fast': 1.0,
            'fast': 0.9,
            'medium': 0.8,
            'slow': 0.6,
            'very_slow': 0.4
        }
    };
    
    const speedScore = efficiencyFactors.inference_speed[model.inference_speed];
    const thermalScore = analysis.thermal_constraint;
    
    return (speedScore * 0.7) + (thermalScore * 0.3);
}
```

---

## 💾 **Model Database Schema**

### **Model Entry Structure**

```javascript
{
    // Basic Information
    name: "Human-readable name",
    size_gb: 3.8,                    // Disk space requirement
    parameters: 7,                   // Model parameters in billions
    memory_requirement: 8,           // RAM needed in GB
    
    // Performance Requirements  
    cpu_cores_min: 4,               // Minimum CPU cores
    cpu_intensive: 0.7,             // CPU usage factor (0-1)
    
    // Specialization & Quality
    specialization: ['general', 'chat', 'reasoning'],
    quality_score: 9.2,             // Community quality rating (0-10)
    popularity_score: 9.8,          // Adoption/usage score (0-10)
    
    // Technical Specifications
    context_length: 4096,           // Maximum context tokens
    quantization: 'Q4_0',           // Quantization method
    inference_speed: 'medium'       // Speed category
}
```

### **Hardware Tier Definitions**

```javascript
const hardwareTiers = {
    memory: {
        ultra_low: { min: 0, max: 4, multiplier: 0.3 },
        low: { min: 4, max: 8, multiplier: 0.6 },
        medium: { min: 8, max: 16, multiplier: 1.0 },
        high: { min: 16, max: 32, multiplier: 1.4 },
        very_high: { min: 32, max: 64, multiplier: 1.8 },
        extreme: { min: 64, max: 128, multiplier: 2.2 }
    },
    cpu: {
        ultra_low: { min: 0, max: 2, multiplier: 0.4 },
        low: { min: 2, max: 4, multiplier: 0.7 },
        medium: { min: 4, max: 8, multiplier: 1.0 },
        high: { min: 8, max: 16, multiplier: 1.3 },
        very_high: { min: 16, max: 32, multiplier: 1.6 },
        extreme: { min: 32, max: 64, multiplier: 2.0 }
    }
};
```

---

## 🔍 **Hardware Detection System**

### **Multi-Platform Detection**

```javascript
async getSystemSpecs() {
    // Try systeminformation first (most detailed)
    if (si) {
        try {
            const [cpu, mem, graphics, osInfo] = await Promise.all([
                si.cpu(), si.mem(), si.graphics(), si.osInfo()
            ]);
            return this.processDetailedSpecs(cpu, mem, graphics, osInfo);
        } catch (error) {
            console.warn('Detailed detection failed, using fallback');
        }
    }
    
    // Fallback to Node.js built-ins
    const os = require('os');
    return {
        cpu_cores: os.cpus().length,
        cpu_freq_max: 3.0, // Estimated
        total_ram_gb: os.totalmem() / (1024 ** 3),
        gpu_model_normalized: os.platform() === 'darwin' ? 'apple_silicon' : 'cpu_only',
        gpu_vram_gb: os.platform() === 'darwin' ? os.totalmem() / (1024 ** 3) * 0.75 : 0,
        platform: os.platform()
    };
}
```

### **Apple Silicon Optimization**

```javascript
handleAppleSilicon(totalRAM) {
    // Apple Silicon uses unified memory architecture
    const unifiedMemory = totalRAM;
    
    // Estimate GPU-accessible memory (60% of total)
    const gpuMemory = unifiedMemory * 0.6;
    
    // System overhead (30% reserved for macOS)
    const availableMemory = unifiedMemory * 0.7;
    
    return {
        total_ram_gb: unifiedMemory,
        gpu_vram_gb: gpuMemory,
        available_memory: availableMemory,
        gpu_model_normalized: 'apple_silicon',
        architecture_boost: 1.15 // 15% performance bonus
    };
}
```

---

## 🚀 **Performance Optimizations**

### **Caching Strategy**

```javascript
class ModelSelector {
    constructor() {
        this.hardwareCache = null;
        this.hardwareCacheExpiry = 5 * 60 * 1000; // 5 minutes
        this.modelCache = new Map();
    }
    
    async getHardwareSpecs() {
        if (this.hardwareCache && 
            Date.now() - this.hardwareCache.timestamp < this.hardwareCacheExpiry) {
            return this.hardwareCache.data;
        }
        
        const specs = await this.detectHardware();
        this.hardwareCache = {
            data: specs,
            timestamp: Date.now()
        };
        
        return specs;
    }
}
```

### **Lazy Loading**

```javascript
class IntelligentSelector {
    constructor() {
        this._modelDatabase = null;
        this._hardwareTiers = null;
    }
    
    get modelDatabase() {
        if (!this._modelDatabase) {
            this._modelDatabase = this.initializeModelDatabase();
        }
        return this._modelDatabase;
    }
}
```

---

## 🔌 **API Integration Points**

### **Adding New Models**

```javascript
// 1. Add to model database
const newModel = {
    'new-model:7b': {
        name: 'New Model 7B',
        size_gb: 4.0,
        parameters: 7,
        memory_requirement: 8,
        cpu_cores_min: 4,
        cpu_intensive: 0.7,
        specialization: ['general', 'chat'],
        quality_score: 8.5,
        popularity_score: 7.0,
        context_length: 4096,
        quantization: 'Q4_0',
        inference_speed: 'medium'
    }
};

// 2. The system automatically includes it in selection
```

### **Custom Hardware Profiles**

```javascript
// Override hardware detection for testing
const customHardware = {
    cpu_cores: 16,
    cpu_freq_max: 3.8,
    total_ram_gb: 32,
    gpu_model_normalized: 'rtx_4090',
    gpu_vram_gb: 24
};

const result = await aiSelector.selectBestModel(
    candidateModels, 
    customHardware, 
    'coding'
);
```

---

## 🧪 **Testing Framework**

### **Unit Tests Structure**

```javascript
// Test hardware analysis
describe('Hardware Analysis', () => {
    test('should classify high-end system correctly', () => {
        const hardware = { cpu_cores: 12, total_ram_gb: 24 };
        const analysis = selector.analyzeHardware(hardware);
        expect(analysis.overall_tier).toBe('high');
    });
    
    test('should handle Apple Silicon correctly', () => {
        const hardware = { 
            gpu_model_normalized: 'apple_silicon',
            total_ram_gb: 16 
        };
        const analysis = selector.analyzeHardware(hardware);
        expect(analysis.gpu_tier.multiplier).toBeGreaterThan(1.0);
    });
});

// Test scoring algorithm
describe('Model Scoring', () => {
    test('should penalize oversized models', () => {
        const smallHardware = { total_ram_gb: 8 };
        const largeModel = { memory_requirement: 16 };
        const score = selector.calculateModelScore(largeModel, smallHardware);
        expect(score).toBeLessThan(50);
    });
});
```

### **Integration Tests**

```javascript
// Test full selection pipeline
describe('Model Selection Integration', () => {
    test('should select appropriate model for given hardware', async () => {
        const hardware = { cpu_cores: 8, total_ram_gb: 16 };
        const models = ['llama2:7b', 'llama2:13b', 'phi3:mini'];
        
        const result = await selector.selectBestModel(models, hardware);
        
        expect(result.bestModel).toBe('llama2:7b');
        expect(result.confidence).toBeGreaterThan(0.8);
        expect(result.method).toBe('intelligent_mathematical');
    });
});
```

---

## 📊 **Monitoring & Analytics**

### **Performance Metrics**

```javascript
class PerformanceMonitor {
    static trackSelection(hardware, selectedModel, confidence) {
        const metrics = {
            timestamp: Date.now(),
            hardware_tier: this.getHardwareTier(hardware),
            model_size: this.getModelSize(selectedModel),
            confidence: confidence,
            selection_time: process.hrtime.bigint() - startTime
        };
        
        // Log or send to analytics service
        console.log('Selection metrics:', metrics);
    }
}
```

### **Error Tracking**

```javascript
class ErrorTracker {
    static logSelectionError(error, context) {
        const errorReport = {
            error: error.message,
            stack: error.stack,
            context: {
                hardware: context.hardware,
                models: context.models,
                timestamp: new Date().toISOString()
            }
        };
        
        // Send to error tracking service
        console.error('Selection error:', errorReport);
    }
}
```

---

## 🔧 **Configuration Options**

### **Environment Variables**

```bash
# Enable debug mode
DEBUG=1 llm-checker ai-check

# Disable hardware caching
NO_CACHE=1 llm-checker ai-check

# Custom model database path
MODEL_DB_PATH=/path/to/custom/models.json llm-checker ai-check
```

### **Configuration File**

```javascript
// ~/.llm-checker/config.json
{
    "selector": {
        "weights": {
            "memory_efficiency": 0.35,
            "performance_match": 0.25,
            "task_optimization": 0.20,
            "popularity_quality": 0.15,
            "resource_efficiency": 0.05
        },
        "cache_ttl": 300000,
        "fallback_enabled": true
    },
    "hardware": {
        "force_detection": false,
        "custom_multipliers": {
            "apple_silicon": 1.15,
            "rtx_40_series": 1.3
        }
    }
}
```

---

## 🚀 **Deployment & Distribution**

### **Build Process**

```bash
# Development
npm run dev

# Testing
npm test

# Build for distribution
npm run build

# Package for npm
npm pack
```

### **CI/CD Pipeline**

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node-version: [16, 18, 20]
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: ${{ matrix.node-version }}
      - run: npm ci
      - run: npm test
```

---

## 🔍 **Debugging Guide**

### **Common Issues**

1. **Hardware Detection Fails**
   ```bash
   DEBUG=1 llm-checker ai-check
   # Check output for detection errors
   ```

2. **Low Confidence Scores**
   ```javascript
   // Check if models are too large for hardware
   const analysis = selector.analyzeHardware(hardware);
   console.log('Available memory:', analysis.available_memory.total);
   ```

3. **Unexpected Model Selection**
   ```javascript
   // Enable verbose scoring
   const result = selector.selectBestModel(models, hardware, 'general');
   console.log('All scores:', result.allPredictions);
   ```

### **Debug Mode Output**

```bash
DEBUG=1 llm-checker ai-check --models llama2:7b mistral:7b
# Outputs:
# [DEBUG] Hardware analysis: { cpu_cores: 12, total_ram_gb: 24 }
# [DEBUG] Model scores: [{ model: 'llama2:7b', score: 99 }, ...]
# [DEBUG] Selection reasoning: Optimal memory utilization...
```

---

**This technical documentation covers the core implementation details. For usage examples, see [USAGE_GUIDE.md](USAGE_GUIDE.md).**