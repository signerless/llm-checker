#!/usr/bin/env python3
"""
Performance benchmark collector for Ollama models.
Collects hardware specs and model performance data for ML training.
"""

import json
import time
import subprocess
import platform
import hashlib
import os
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional, Tuple
import pandas as pd
import psutil
import sys

@dataclass
class HardwareSpec:
    """Hardware specification for a given system."""
    host_id: str
    cpu_cores: int
    cpu_freq_max: float  # GHz
    total_ram_gb: float
    gpu_model: str
    gpu_vram_gb: float
    platform: str
    architecture: str

@dataclass
class ModelBenchmark:
    """Benchmark result for a specific model on specific hardware."""
    host_id: str
    model_id: str
    model_size: str
    tokens_per_second: float
    peak_ram_mb: float
    peak_vram_mb: float
    response_time: float
    success: bool
    error_message: Optional[str] = None
    timestamp: str = ""

class HardwareDetector:
    """Detects hardware specifications of the current system."""
    
    def __init__(self):
        self.host_id = self._generate_host_id()
    
    def _generate_host_id(self) -> str:
        """Generate a unique but anonymous host identifier."""
        system_info = f"{platform.node()}-{platform.system()}-{platform.machine()}"
        return hashlib.md5(system_info.encode()).hexdigest()[:12]
    
    def get_hardware_spec(self) -> HardwareSpec:
        """Collect comprehensive hardware specifications."""
        # CPU information
        cpu_cores = psutil.cpu_count(logical=False)
        cpu_freq = psutil.cpu_freq()
        cpu_freq_max = cpu_freq.max / 1000 if cpu_freq else 3.0  # Default to 3GHz
        
        # Memory information
        memory = psutil.virtual_memory()
        total_ram_gb = memory.total / (1024**3)
        
        # GPU information
        gpu_model, gpu_vram_gb = self._detect_gpu()
        
        return HardwareSpec(
            host_id=self.host_id,
            cpu_cores=cpu_cores,
            cpu_freq_max=cpu_freq_max,
            total_ram_gb=total_ram_gb,
            gpu_model=gpu_model,
            gpu_vram_gb=gpu_vram_gb,
            platform=platform.system(),
            architecture=platform.machine()
        )
    
    def _detect_gpu(self) -> Tuple[str, float]:
        """Detect GPU model and VRAM."""
        try:
            # Try nvidia-smi first
            result = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total', 
                                   '--format=csv,noheader,nounits'], 
                                  capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                lines = result.stdout.strip().split('\n')
                if lines and lines[0]:
                    parts = lines[0].split(', ')
                    if len(parts) >= 2:
                        gpu_name = parts[0].strip()
                        vram_mb = float(parts[1].strip())
                        return gpu_name, vram_mb / 1024  # Convert to GB
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError):
            pass
        
        # Try other methods or return CPU-only
        try:
            # Check for Apple Silicon
            if platform.system() == "Darwin" and platform.machine() == "arm64":
                # Apple Silicon - use unified memory
                memory = psutil.virtual_memory()
                return "Apple Silicon GPU", memory.total / (1024**3) * 0.75  # Assume 75% available for GPU
        except:
            pass
        
        # Default to CPU-only
        return "CPU Only", 0.0

class OllamaBenchmarker:
    """Benchmarks Ollama model performance."""
    
    def __init__(self):
        self.test_prompt = "Explain in one sentence what machine learning is."
        
    def get_available_models(self) -> List[str]:
        """Get list of locally available Ollama models."""
        try:
            result = subprocess.run(['ollama', 'list'], capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                print(f"Error getting models: {result.stderr}")
                return []
                
            lines = result.stdout.strip().split('\n')[1:]  # Skip header
            models = []
            
            for line in lines:
                if line.strip():
                    parts = line.split()
                    if parts:
                        model_name = parts[0]
                        models.append(model_name)
            
            return models
            
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as e:
            print(f"Error: {e}")
            return []
    
    def benchmark_model(self, model_id: str, hardware_spec: HardwareSpec) -> ModelBenchmark:
        """Benchmark a specific model."""
        print(f"Benchmarking {model_id}...")
        
        # Initialize benchmark result
        benchmark = ModelBenchmark(
            host_id=hardware_spec.host_id,
            model_id=model_id,
            model_size=self._extract_size_from_model_id(model_id),
            tokens_per_second=0.0,
            peak_ram_mb=0.0,
            peak_vram_mb=0.0,
            response_time=0.0,
            success=False,
            timestamp=time.strftime("%Y-%m-%d %H:%M:%S")
        )
        
        try:
            # Record initial memory
            process = psutil.Process()
            initial_memory = process.memory_info().rss / (1024**2)  # MB
            
            # Run the benchmark
            start_time = time.time()
            
            result = subprocess.run([
                'ollama', 'run', model_id, self.test_prompt
            ], capture_output=True, text=True, timeout=120)
            
            end_time = time.time()
            response_time = end_time - start_time
            
            if result.returncode == 0:
                # Parse output for tokens/second if available
                output = result.stderr if result.stderr else result.stdout
                tokens_per_second = self._extract_tokens_per_second(output)
                
                # Estimate peak memory usage (simplified)
                final_memory = process.memory_info().rss / (1024**2)  # MB
                peak_ram_mb = max(final_memory - initial_memory, 0)
                
                benchmark.tokens_per_second = tokens_per_second
                benchmark.peak_ram_mb = peak_ram_mb
                benchmark.peak_vram_mb = 0.0  # TODO: Implement GPU memory tracking
                benchmark.response_time = response_time
                benchmark.success = True
                
                print(f"  ✅ {model_id}: {tokens_per_second:.2f} tokens/s, {response_time:.2f}s")
                
            else:
                benchmark.error_message = result.stderr
                print(f"  ❌ {model_id}: {result.stderr}")
                
        except subprocess.TimeoutExpired:
            benchmark.error_message = "Timeout"
            print(f"  ⏰ {model_id}: Timeout")
        except Exception as e:
            benchmark.error_message = str(e)
            print(f"  ❌ {model_id}: {e}")
        
        return benchmark
    
    def _extract_size_from_model_id(self, model_id: str) -> str:
        """Extract model size from model identifier."""
        # Extract patterns like 7b, 13b, 70b, etc.
        import re
        size_match = re.search(r'(\d+\.?\d*[kmb])', model_id.lower())
        return size_match.group(1) if size_match else "unknown"
    
    def _extract_tokens_per_second(self, output: str) -> float:
        """Extract tokens per second from Ollama output."""
        import re
        
        # Look for patterns like "45.67 tokens/s" or similar
        patterns = [
            r'(\d+\.?\d*)\s*tokens?/s',
            r'(\d+\.?\d*)\s*tok/s',
            r'speed:\s*(\d+\.?\d*)',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, output, re.IGNORECASE)
            if match:
                try:
                    return float(match.group(1))
                except ValueError:
                    continue
        
        # If no explicit rate found, estimate from response time and output length
        # This is a rough approximation
        word_count = len(output.split())
        if word_count > 10:  # Reasonable response
            return word_count * 1.3  # Rough tokens per word estimate
        
        return 0.0
    
    def benchmark_all_models(self, hardware_spec: HardwareSpec) -> List[ModelBenchmark]:
        """Benchmark all available models."""
        models = self.get_available_models()
        
        if not models:
            print("No models found. Please install some models first:")
            print("  ollama pull llama2:7b")
            print("  ollama pull mistral:7b")
            print("  ollama pull phi3:mini")
            return []
        
        print(f"Found {len(models)} models to benchmark")
        benchmarks = []
        
        for model_id in models:
            benchmark = self.benchmark_model(model_id, hardware_spec)
            benchmarks.append(benchmark)
            
            # Small delay between benchmarks
            time.sleep(2)
        
        return benchmarks

class BenchmarkCollector:
    """Main collector that coordinates hardware detection and model benchmarking."""
    
    def __init__(self, output_dir: str = "data/raw"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        self.hardware_detector = HardwareDetector()
        self.benchmarker = OllamaBenchmarker()
    
    def collect_benchmark_data(self) -> str:
        """Collect complete benchmark data for this system."""
        print("🔍 Detecting hardware specifications...")
        hardware_spec = self.hardware_detector.get_hardware_spec()
        
        print(f"Hardware detected:")
        print(f"  Host ID: {hardware_spec.host_id}")
        print(f"  CPU: {hardware_spec.cpu_cores} cores @ {hardware_spec.cpu_freq_max:.1f} GHz")
        print(f"  RAM: {hardware_spec.total_ram_gb:.1f} GB")
        print(f"  GPU: {hardware_spec.gpu_model} ({hardware_spec.gpu_vram_gb:.1f} GB VRAM)")
        
        print("\n🚀 Starting model benchmarks...")
        benchmarks = self.benchmarker.benchmark_all_models(hardware_spec)
        
        if not benchmarks:
            print("No benchmarks collected.")
            return ""
        
        # Convert to DataFrame
        benchmark_data = [asdict(b) for b in benchmarks]
        df = pd.DataFrame(benchmark_data)
        
        # Add hardware info to each row
        hardware_dict = asdict(hardware_spec)
        for key, value in hardware_dict.items():
            if key != 'host_id':  # host_id already in benchmark data
                df[f'hw_{key}'] = value
        
        # Save to parquet
        output_file = self.output_dir / f"benchmark_{hardware_spec.host_id}_{int(time.time())}.parquet"
        df.to_parquet(output_file, index=False)
        
        print(f"\n✅ Benchmark data saved to: {output_file}")
        print(f"Collected {len(benchmarks)} model benchmarks")
        
        return str(output_file)

def main():
    """Main entry point."""
    if len(sys.argv) > 1 and sys.argv[1] == "--help":
        print("Ollama Model Performance Benchmark Collector")
        print("")
        print("This script benchmarks all locally installed Ollama models")
        print("and collects hardware specifications for ML training.")
        print("")
        print("Prerequisites:")
        print("  - Ollama installed and running")
        print("  - At least one model installed (ollama pull <model>)")
        print("  - Python packages: pandas, psutil, pyarrow")
        print("")
        print("Usage:")
        print("  python benchmark_collector.py")
        print("")
        return
    
    print("🧠 Ollama Model Performance Benchmark Collector")
    print("=" * 50)
    
    try:
        collector = BenchmarkCollector()
        output_file = collector.collect_benchmark_data()
        
        if output_file:
            print(f"\n🎉 Collection complete! Data saved to: {output_file}")
            print("\nNext steps:")
            print("  1. Run this on multiple machines with different hardware")
            print("  2. Aggregate all parquet files for training")
            print("  3. Train the ML model selector")
        else:
            print("\n❌ No data collected. Please install Ollama models first.")
            
    except KeyboardInterrupt:
        print("\n⏹️  Collection cancelled by user")
    except Exception as e:
        print(f"\n❌ Error during collection: {e}")
        if "--debug" in sys.argv:
            import traceback
            traceback.print_exc()

if __name__ == "__main__":
    main()