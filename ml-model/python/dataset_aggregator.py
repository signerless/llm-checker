#!/usr/bin/env python3
"""
Dataset aggregator for ML model training.
Combines benchmark data from multiple hosts and creates training labels.
"""

import pandas as pd
import numpy as np
from pathlib import Path
import sys
from typing import List, Dict, Tuple
import warnings
warnings.filterwarnings('ignore')

class DatasetAggregator:
    """Aggregates benchmark data and creates training labels."""
    
    def __init__(self, raw_data_dir: str = "data/raw", output_dir: str = "data/processed"):
        self.raw_data_dir = Path(raw_data_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
    
    def load_all_benchmarks(self) -> pd.DataFrame:
        """Load and concatenate all benchmark parquet files."""
        parquet_files = list(self.raw_data_dir.glob("benchmark_*.parquet"))
        
        if not parquet_files:
            raise FileNotFoundError(f"No benchmark files found in {self.raw_data_dir}")
        
        print(f"📁 Found {len(parquet_files)} benchmark files")
        
        dfs = []
        for file in parquet_files:
            try:
                df = pd.read_parquet(file)
                print(f"  ✅ Loaded {file.name}: {len(df)} records")
                dfs.append(df)
            except Exception as e:
                print(f"  ❌ Error loading {file.name}: {e}")
        
        if not dfs:
            raise ValueError("No valid benchmark files could be loaded")
        
        combined_df = pd.concat(dfs, ignore_index=True)
        print(f"📊 Combined dataset: {len(combined_df)} total records")
        
        return combined_df
    
    def clean_and_preprocess(self, df: pd.DataFrame) -> pd.DataFrame:
        """Clean and preprocess the dataset."""
        print("🧹 Cleaning and preprocessing data...")
        
        # Remove failed benchmarks
        initial_count = len(df)
        df = df[df['success'] == True].copy()
        print(f"  Removed {initial_count - len(df)} failed benchmarks")
        
        # Remove benchmarks with zero or negative performance
        df = df[df['tokens_per_second'] > 0].copy()
        
        # Extract numeric model size
        df['model_size_numeric'] = df['model_size'].apply(self._parse_model_size)
        
        # Normalize GPU model names
        df['gpu_model_normalized'] = df['hw_gpu_model'].apply(self._normalize_gpu_name)
        
        # Create categorical bins for hardware specs
        df['ram_tier'] = pd.cut(df['hw_total_ram_gb'], 
                               bins=[0, 8, 16, 32, 64, float('inf')], 
                               labels=['low', 'medium', 'high', 'very_high', 'extreme'])
        
        df['cpu_tier'] = pd.cut(df['hw_cpu_cores'], 
                               bins=[0, 4, 8, 16, 32, float('inf')], 
                               labels=['low', 'medium', 'high', 'very_high', 'extreme'])
        
        df['vram_tier'] = pd.cut(df['hw_gpu_vram_gb'], 
                                bins=[-1, 0, 4, 8, 16, 24, float('inf')], 
                                labels=['none', 'low', 'medium', 'high', 'very_high', 'extreme'])
        
        print(f"  Final dataset: {len(df)} records")
        return df
    
    def _parse_model_size(self, size_str: str) -> float:
        """Parse model size string to numeric value in billions of parameters."""
        if pd.isna(size_str) or size_str == 'unknown':
            return 1.0  # Default small size
        
        size_str = str(size_str).lower().strip()
        
        # Extract number and unit
        import re
        match = re.match(r'(\d+\.?\d*)([kmb]?)', size_str)
        
        if not match:
            return 1.0
        
        num = float(match.group(1))
        unit = match.group(2)
        
        if unit == 'k':
            return num / 1000  # Convert to billions
        elif unit == 'm':
            return num / 1000  # Convert to billions
        elif unit == 'b' or unit == '':
            return num
        else:
            return num
    
    def _normalize_gpu_name(self, gpu_name: str) -> str:
        """Normalize GPU names to common categories."""
        if pd.isna(gpu_name):
            return 'cpu_only'
        
        gpu_name = str(gpu_name).lower()
        
        # NVIDIA GPUs
        if 'rtx 4090' in gpu_name:
            return 'rtx_4090'
        elif 'rtx 4080' in gpu_name:
            return 'rtx_4080'
        elif 'rtx 4070' in gpu_name:
            return 'rtx_4070'
        elif 'rtx 4060' in gpu_name:
            return 'rtx_4060'
        elif 'rtx 3090' in gpu_name:
            return 'rtx_3090'
        elif 'rtx 3080' in gpu_name:
            return 'rtx_3080'
        elif 'rtx 3070' in gpu_name:
            return 'rtx_3070'
        elif 'rtx 3060' in gpu_name:
            return 'rtx_3060'
        elif 'gtx 1080' in gpu_name:
            return 'gtx_1080'
        elif 'gtx 1070' in gpu_name:
            return 'gtx_1070'
        elif 'gtx 1060' in gpu_name:
            return 'gtx_1060'
        elif 'apple silicon' in gpu_name:
            return 'apple_silicon'
        elif 'cpu only' in gpu_name:
            return 'cpu_only'
        elif 'amd' in gpu_name or 'radeon' in gpu_name:
            return 'amd_gpu'
        elif 'intel' in gpu_name:
            return 'intel_gpu'
        elif 'nvidia' in gpu_name or 'geforce' in gpu_name:
            return 'nvidia_gpu_other'
        else:
            return 'unknown_gpu'
    
    def create_training_labels(self, df: pd.DataFrame) -> pd.DataFrame:
        """Create binary labels for which model is best for each hardware configuration."""
        print("🏷️ Creating training labels...")
        
        # Initialize label column
        df['label_best'] = 0
        
        labeled_count = 0
        
        # Group by unique hardware configurations
        hardware_cols = ['host_id', 'hw_cpu_cores', 'hw_cpu_freq_max', 
                        'hw_total_ram_gb', 'gpu_model_normalized', 'hw_gpu_vram_gb']
        
        for hardware_config, group in df.groupby(hardware_cols):
            if len(group) < 2:  # Need at least 2 models to compare
                continue
            
            # Find models that can actually run (reasonable performance thresholds)
            viable_models = group[
                (group['tokens_per_second'] > 1.0) &  # At least 1 token/s
                (group['response_time'] < 60.0) &     # Response within 60 seconds
                (group['peak_ram_mb'] < group['hw_total_ram_gb'] * 1024 * 0.8)  # Uses <80% RAM
            ].copy()
            
            if len(viable_models) == 0:
                continue
            
            # Calculate performance score (tokens/s weighted by efficiency)
            viable_models['efficiency_score'] = (
                viable_models['tokens_per_second'] / 
                (viable_models['model_size_numeric'] + 1)  # Avoid division by zero
            )
            
            # Find the best model (highest tokens/s among viable ones)
            best_idx = viable_models['tokens_per_second'].idxmax()
            df.loc[best_idx, 'label_best'] = 1
            labeled_count += 1
        
        positive_labels = (df['label_best'] == 1).sum()
        print(f"  Created {positive_labels} positive labels from {labeled_count} hardware configs")
        print(f"  Label distribution: {positive_labels} positive, {len(df) - positive_labels} negative")
        
        return df
    
    def prepare_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Prepare features for ML training."""
        print("🔧 Preparing features...")
        
        # Select and create final feature set
        feature_df = df[[
            'host_id',
            'model_id',
            'model_size_numeric',
            'hw_cpu_cores',
            'hw_cpu_freq_max',
            'hw_total_ram_gb',
            'gpu_model_normalized',
            'hw_gpu_vram_gb',
            'hw_platform',
            'ram_tier',
            'cpu_tier', 
            'vram_tier',
            'tokens_per_second',
            'peak_ram_mb',
            'response_time',
            'label_best'
        ]].copy()
        
        # Handle missing values
        feature_df['hw_cpu_freq_max'].fillna(3.0, inplace=True)  # Default CPU frequency
        feature_df['hw_gpu_vram_gb'].fillna(0.0, inplace=True)   # CPU-only systems
        
        print(f"  Final feature set: {len(feature_df.columns)} columns, {len(feature_df)} rows")
        
        return feature_df
    
    def analyze_dataset(self, df: pd.DataFrame) -> Dict:
        """Analyze the dataset and provide statistics."""
        print("\n📊 Dataset Analysis:")
        print("=" * 40)
        
        analysis = {}
        
        # Basic stats
        analysis['total_records'] = len(df)
        analysis['unique_hosts'] = df['host_id'].nunique()
        analysis['unique_models'] = df['model_id'].nunique()
        analysis['positive_labels'] = (df['label_best'] == 1).sum()
        analysis['label_ratio'] = analysis['positive_labels'] / len(df)
        
        print(f"Total records: {analysis['total_records']}")
        print(f"Unique hosts: {analysis['unique_hosts']}")
        print(f"Unique models: {analysis['unique_models']}")
        print(f"Positive labels: {analysis['positive_labels']} ({analysis['label_ratio']:.2%})")
        
        # Hardware distribution
        print(f"\nHardware Distribution:")
        print(f"CPU cores: {df['hw_cpu_cores'].min()}-{df['hw_cpu_cores'].max()} (avg: {df['hw_cpu_cores'].mean():.1f})")
        print(f"RAM: {df['hw_total_ram_gb'].min():.1f}-{df['hw_total_ram_gb'].max():.1f} GB (avg: {df['hw_total_ram_gb'].mean():.1f})")
        print(f"GPU VRAM: {df['hw_gpu_vram_gb'].min():.1f}-{df['hw_gpu_vram_gb'].max():.1f} GB (avg: {df['hw_gpu_vram_gb'].mean():.1f})")
        
        # Model distribution
        print(f"\nModel Distribution:")
        model_counts = df['model_id'].value_counts().head(10)
        for model, count in model_counts.items():
            print(f"  {model}: {count} benchmarks")
        
        # Performance stats for labeled models
        best_models = df[df['label_best'] == 1]
        if len(best_models) > 0:
            print(f"\nBest Model Performance:")
            print(f"Tokens/sec: {best_models['tokens_per_second'].min():.1f}-{best_models['tokens_per_second'].max():.1f} (avg: {best_models['tokens_per_second'].mean():.1f})")
            print(f"Response time: {best_models['response_time'].min():.1f}-{best_models['response_time'].max():.1f}s (avg: {best_models['response_time'].mean():.1f})")
        
        return analysis
    
    def save_processed_dataset(self, df: pd.DataFrame, filename: str = "benchmarks.parquet") -> str:
        """Save the processed dataset."""
        output_path = self.output_dir / filename
        df.to_parquet(output_path, index=False)
        print(f"\n💾 Processed dataset saved to: {output_path}")
        return str(output_path)
    
    def process_all(self) -> Tuple[str, Dict]:
        """Run the complete aggregation pipeline."""
        print("🏗️ Starting dataset aggregation pipeline...")
        
        # Load raw data
        df = self.load_all_benchmarks()
        
        # Clean and preprocess
        df = self.clean_and_preprocess(df)
        
        # Create labels
        df = self.create_training_labels(df)
        
        # Prepare features
        df = self.prepare_features(df)
        
        # Analyze
        analysis = self.analyze_dataset(df)
        
        # Save
        output_path = self.save_processed_dataset(df)
        
        return output_path, analysis

def main():
    """Main entry point."""
    if len(sys.argv) > 1 and sys.argv[1] == "--help":
        print("Dataset Aggregator for ML Model Training")
        print("")
        print("Combines benchmark data from multiple hosts and creates training labels.")
        print("")
        print("Usage:")
        print("  python dataset_aggregator.py")
        print("")
        print("Input: data/raw/benchmark_*.parquet files")
        print("Output: data/processed/benchmarks.parquet")
        print("")
        return
    
    try:
        aggregator = DatasetAggregator()
        output_path, analysis = aggregator.process_all()
        
        print("\n🎉 Dataset aggregation complete!")
        print(f"Output: {output_path}")
        
        # Check if dataset is suitable for training
        if analysis['positive_labels'] < 10:
            print("\n⚠️  Warning: Very few positive labels. Collect more benchmark data.")
        elif analysis['unique_hosts'] < 3:
            print("\n⚠️  Warning: Data from very few hosts. Collect from more diverse hardware.")
        else:
            print("\n✅ Dataset looks good for training!")
            print("Next step: python train_model.py")
        
    except Exception as e:
        print(f"\n❌ Error during aggregation: {e}")
        if "--debug" in sys.argv:
            import traceback
            traceback.print_exc()

if __name__ == "__main__":
    main()