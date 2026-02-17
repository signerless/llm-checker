#!/usr/bin/env python3
"""
TabTransformer model trainer for Ollama model selection.
Trains a lightweight transformer model to predict the best model for given hardware.
"""

import pandas as pd
import numpy as np
import tensorflow as tf
from tensorflow import keras
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.metrics import classification_report, roc_auc_score
import joblib
import json
import sys
from pathlib import Path
from typing import Dict, Tuple, List
import warnings
warnings.filterwarnings('ignore')

# Set random seeds for reproducibility
tf.random.set_seed(42)
np.random.seed(42)

class TabTransformer(keras.Model):
    """Lightweight TabTransformer implementation for tabular data."""
    
    def __init__(self, 
                 categorical_features: List[str],
                 numerical_features: List[str],
                 categorical_vocab_sizes: Dict[str, int],
                 embed_dim: int = 32,
                 num_heads: int = 2,
                 num_layers: int = 2,
                 dropout_rate: float = 0.1,
                 **kwargs):
        super().__init__(**kwargs)
        
        self.categorical_features = categorical_features
        self.numerical_features = numerical_features
        self.embed_dim = embed_dim
        
        # Embedding layers for categorical features
        self.embeddings = {}
        for feature in categorical_features:
            vocab_size = categorical_vocab_sizes[feature]
            self.embeddings[feature] = keras.layers.Embedding(
                input_dim=vocab_size,
                output_dim=embed_dim,
                name=f"embed_{feature}"
            )
        
        # Transformer layers
        self.transformer_blocks = []
        for i in range(num_layers):
            transformer_block = self._create_transformer_block(
                embed_dim, num_heads, dropout_rate, name=f"transformer_{i}"
            )
            self.transformer_blocks.append(transformer_block)
        
        # Dense layers for numerical features
        self.numerical_dense = keras.layers.Dense(
            embed_dim, activation='relu', name='numerical_dense'
        )
        self.numerical_dropout = keras.layers.Dropout(dropout_rate)
        
        # Final classification layers
        self.global_pool = keras.layers.GlobalAveragePooling1D()
        self.concat = keras.layers.Concatenate()
        self.final_dense1 = keras.layers.Dense(64, activation='relu', name='final_dense1')
        self.final_dropout = keras.layers.Dropout(dropout_rate)
        self.final_dense2 = keras.layers.Dense(32, activation='relu', name='final_dense2')
        self.output_layer = keras.layers.Dense(1, activation='sigmoid', name='output')
    
    def _create_transformer_block(self, embed_dim, num_heads, dropout_rate, name):
        """Create a transformer block."""
        inputs = keras.layers.Input(shape=(None, embed_dim))
        
        # Multi-head attention
        attention = keras.layers.MultiHeadAttention(
            num_heads=num_heads, key_dim=embed_dim // num_heads, dropout=dropout_rate
        )(inputs, inputs)
        
        # Add & Norm
        attention = keras.layers.Dropout(dropout_rate)(attention)
        attention_output = keras.layers.Add()([inputs, attention])
        attention_output = keras.layers.LayerNormalization()(attention_output)
        
        # Feed Forward
        ff = keras.layers.Dense(embed_dim * 2, activation='relu')(attention_output)
        ff = keras.layers.Dropout(dropout_rate)(ff)
        ff = keras.layers.Dense(embed_dim)(ff)
        
        # Add & Norm
        ff = keras.layers.Dropout(dropout_rate)(ff)
        output = keras.layers.Add()([attention_output, ff])
        output = keras.layers.LayerNormalization()(output)
        
        return keras.Model(inputs=inputs, outputs=output, name=name)
    
    def call(self, inputs, training=None):
        # Process categorical features
        categorical_embeddings = []
        for feature in self.categorical_features:
            embedded = self.embeddings[feature](inputs[feature])
            categorical_embeddings.append(embedded)
        
        # Stack categorical embeddings
        if categorical_embeddings:
            categorical_tensor = tf.stack(categorical_embeddings, axis=1)
            
            # Apply transformer blocks
            transformer_output = categorical_tensor
            for transformer_block in self.transformer_blocks:
                transformer_output = transformer_block(transformer_output, training=training)
            
            # Global pooling
            categorical_features = self.global_pool(transformer_output)
        else:
            categorical_features = tf.zeros((tf.shape(inputs[self.numerical_features[0]])[0], self.embed_dim))
        
        # Process numerical features
        numerical_tensor = tf.concat([inputs[feature] for feature in self.numerical_features], axis=-1)
        numerical_features = self.numerical_dense(numerical_tensor)
        numerical_features = self.numerical_dropout(numerical_features, training=training)
        
        # Combine features
        combined = self.concat([categorical_features, numerical_features])
        
        # Final layers
        x = self.final_dense1(combined)
        x = self.final_dropout(x, training=training)
        x = self.final_dense2(x)
        output = self.output_layer(x)
        
        return output

class ModelTrainer:
    """Trains the TabTransformer model."""
    
    def __init__(self, data_path: str = "data/processed/benchmarks.parquet"):
        self.data_path = Path(data_path)
        # Keep artifacts in ml-model/trained regardless of invocation from repo root or ml-model cwd.
        self.model_dir = Path(__file__).resolve().parents[1] / "trained"
        self.model_dir.mkdir(parents=True, exist_ok=True)
        
        # Feature definitions
        self.categorical_features = [
            'model_id', 'gpu_model_normalized', 'hw_platform', 
            'ram_tier', 'cpu_tier', 'vram_tier'
        ]
        
        self.numerical_features = [
            'model_size_numeric', 'hw_cpu_cores', 'hw_cpu_freq_max',
            'hw_total_ram_gb', 'hw_gpu_vram_gb'
        ]
        
        # Preprocessing objects
        self.label_encoders = {}
        self.scaler = StandardScaler()
        self.categorical_vocab_sizes = {}
    
    def load_and_prepare_data(self) -> Tuple[Dict, np.ndarray, Dict, np.ndarray]:
        """Load data and prepare for training."""
        print("📊 Loading training data...")
        
        if not self.data_path.exists():
            raise FileNotFoundError(f"Training data not found: {self.data_path}")
        
        df = pd.read_parquet(self.data_path)
        print(f"Loaded {len(df)} training samples")
        
        # Check for minimum data requirements
        positive_samples = (df['label_best'] == 1).sum()
        if positive_samples < 10:
            raise ValueError(f"Not enough positive samples: {positive_samples} (need at least 10)")
        
        if df['host_id'].nunique() < 2:
            raise ValueError("Need data from at least 2 different hardware configurations")
        
        print(f"Positive samples: {positive_samples} ({positive_samples/len(df):.2%})")
        print(f"Unique hardware configs: {df['host_id'].nunique()}")
        print(f"Unique models: {df['model_id'].nunique()}")
        
        # Prepare features and target
        X = {}
        y = df['label_best'].values.astype(np.float32)
        
        # Process categorical features
        for feature in self.categorical_features:
            if feature not in df.columns:
                print(f"Warning: {feature} not in data, using default")
                X[feature] = np.zeros(len(df), dtype=np.int32)
                self.categorical_vocab_sizes[feature] = 1
                continue
            
            # Encode categorical feature
            encoder = LabelEncoder()
            encoded = encoder.fit_transform(df[feature].astype(str))
            
            self.label_encoders[feature] = encoder
            self.categorical_vocab_sizes[feature] = len(encoder.classes_)
            X[feature] = encoded.astype(np.int32)
            
            print(f"  {feature}: {len(encoder.classes_)} categories")
        
        # Process numerical features
        numerical_data = []
        for feature in self.numerical_features:
            if feature not in df.columns:
                print(f"Warning: {feature} not in data, using zeros")
                numerical_data.append(np.zeros(len(df)))
            else:
                numerical_data.append(df[feature].values)
        
        # Scale numerical features
        numerical_array = np.column_stack(numerical_data)
        numerical_scaled = self.scaler.fit_transform(numerical_array)
        
        # Add numerical features to X
        for i, feature in enumerate(self.numerical_features):
            X[feature] = numerical_scaled[:, i:i+1].astype(np.float32)
        
        return X, y, self.categorical_vocab_sizes, numerical_scaled
    
    def create_model(self, categorical_vocab_sizes: Dict[str, int]) -> TabTransformer:
        """Create the TabTransformer model."""
        print("🏗️ Creating TabTransformer model...")
        
        model = TabTransformer(
            categorical_features=self.categorical_features,
            numerical_features=self.numerical_features,
            categorical_vocab_sizes=categorical_vocab_sizes,
            embed_dim=32,
            num_heads=2,
            num_layers=2,
            dropout_rate=0.1
        )
        
        # Compile model
        model.compile(
            optimizer=keras.optimizers.Adam(learning_rate=0.001),
            loss='binary_crossentropy',
            metrics=['accuracy', 'precision', 'recall']
        )
        
        return model
    
    def train_model(self, model: TabTransformer, X: Dict, y: np.ndarray) -> keras.callbacks.History:
        """Train the model."""
        print("🚀 Training model...")
        
        # Split data
        X_train, X_val, y_train, y_val = {}, {}, None, None
        
        # Get indices for split
        indices = np.arange(len(y))
        train_indices, val_indices = train_test_split(
            indices, test_size=0.2, random_state=42, stratify=y
        )
        
        # Split each feature
        for feature in X.keys():
            X_train[feature] = X[feature][train_indices]
            X_val[feature] = X[feature][val_indices]
        
        y_train = y[train_indices]
        y_val = y[val_indices]
        
        print(f"Training samples: {len(y_train)}, Validation samples: {len(y_val)}")
        
        # Callbacks
        callbacks = [
            keras.callbacks.EarlyStopping(
                monitor='val_loss', patience=10, restore_best_weights=True
            ),
            keras.callbacks.ReduceLROnPlateau(
                monitor='val_loss', factor=0.5, patience=5, min_lr=1e-6
            )
        ]
        
        # Train model
        history = model.fit(
            X_train, y_train,
            validation_data=(X_val, y_val),
            epochs=100,
            batch_size=32,
            callbacks=callbacks,
            verbose=1
        )
        
        # Evaluate
        train_pred = model.predict(X_train)
        val_pred = model.predict(X_val)
        
        train_auc = roc_auc_score(y_train, train_pred)
        val_auc = roc_auc_score(y_val, val_pred)
        
        print(f"\n📊 Training Results:")
        print(f"Training AUC: {train_auc:.4f}")
        print(f"Validation AUC: {val_auc:.4f}")
        
        if val_auc < 0.80:
            print("⚠️  Warning: Low validation AUC. Consider collecting more data.")
        elif val_auc >= 0.90:
            print("🎉 Excellent model performance!")
        else:
            print("✅ Good model performance.")
        
        return history
    
    def save_model_and_preprocessors(self, model: TabTransformer):
        """Save the model and preprocessing objects."""
        print("💾 Saving model and preprocessors...")
        
        # Save Keras model
        model_path = self.model_dir / "model.keras"
        model.save(model_path)
        print(f"  Model saved: {model_path}")
        
        # Save preprocessing objects
        scaler_path = self.model_dir / "scaler.joblib"
        joblib.dump(self.scaler, scaler_path)
        print(f"  Scaler saved: {scaler_path}")
        
        encoders_path = self.model_dir / "label_encoders.joblib"
        joblib.dump(self.label_encoders, encoders_path)
        print(f"  Encoders saved: {encoders_path}")
        
        # Save model metadata
        metadata = {
            'categorical_features': self.categorical_features,
            'numerical_features': self.numerical_features,
            'categorical_vocab_sizes': self.categorical_vocab_sizes,
            'feature_count': len(self.categorical_features) + len(self.numerical_features),
            'model_version': '1.0'
        }
        
        metadata_path = self.model_dir / "metadata.json"
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f, indent=2)
        print(f"  Metadata saved: {metadata_path}")
    
    def convert_to_onnx(self):
        """Convert the model to ONNX format."""
        print("🔄 Converting to ONNX...")
        
        try:
            import tf2onnx
            import onnx
            from onnxconverter_common import float16
            
            # Load the saved model
            model_path = self.model_dir / "model.keras"
            model = keras.models.load_model(model_path, custom_objects={'TabTransformer': TabTransformer})
            
            # Create dummy input for conversion
            dummy_inputs = {}
            for feature in self.categorical_features:
                dummy_inputs[feature] = tf.TensorSpec(shape=[None], dtype=tf.int32, name=feature)
            for feature in self.numerical_features:
                dummy_inputs[feature] = tf.TensorSpec(shape=[None, 1], dtype=tf.float32, name=feature)
            
            # Convert to ONNX
            onnx_path = self.model_dir / "model.onnx"
            
            model_proto, _ = tf2onnx.convert.from_keras(
                model,
                input_signature=dummy_inputs,
                output_path=str(onnx_path)
            )
            
            print(f"  ONNX model saved: {onnx_path}")
            
            # Quantize to INT8
            self._quantize_onnx_model(onnx_path)
            
        except ImportError as e:
            print(f"  ⚠️  ONNX conversion skipped (missing dependencies): {e}")
        except Exception as e:
            print(f"  ❌ ONNX conversion failed: {e}")
    
    def _quantize_onnx_model(self, onnx_path: Path):
        """Quantize ONNX model to INT8."""
        try:
            from onnxruntime.quantization import quantize_dynamic, QuantType
            
            quantized_path = self.model_dir / "model_quantized.onnx"
            
            quantize_dynamic(
                str(onnx_path),
                str(quantized_path),
                weight_type=QuantType.QInt8
            )
            
            # Check file sizes
            original_size = onnx_path.stat().st_size / 1024  # KB
            quantized_size = quantized_path.stat().st_size / 1024  # KB
            
            print(f"  Original model: {original_size:.1f} KB")
            print(f"  Quantized model: {quantized_size:.1f} KB ({quantized_size/original_size:.1%} of original)")
            
            if quantized_size < 150:
                print("  ✅ Model size target achieved (<150 KB)")
            else:
                print("  ⚠️  Model larger than target (150 KB)")
            
        except ImportError as e:
            print(f"  ⚠️  Quantization skipped (missing dependencies): {e}")
        except Exception as e:
            print(f"  ❌ Quantization failed: {e}")
    
    def train_complete_pipeline(self):
        """Run the complete training pipeline."""
        print("🧠 Starting ML Model Training Pipeline")
        print("=" * 50)
        
        try:
            # Load and prepare data
            X, y, vocab_sizes, _ = self.load_and_prepare_data()
            
            # Create model
            model = self.create_model(vocab_sizes)
            
            # Train model
            history = self.train_model(model, X, y)
            
            # Save everything
            self.save_model_and_preprocessors(model)
            
            # Convert to ONNX
            self.convert_to_onnx()
            
            print("\n🎉 Training pipeline completed successfully!")
            print(f"Model saved in: {self.model_dir}")
            
            return model, history
            
        except Exception as e:
            print(f"\n❌ Training failed: {e}")
            if "--debug" in sys.argv:
                import traceback
                traceback.print_exc()
            raise

def main():
    """Main entry point."""
    if len(sys.argv) > 1 and sys.argv[1] == "--help":
        print("TabTransformer Model Trainer")
        print("")
        print("Trains a lightweight transformer model to predict the best")
        print("Ollama model for given hardware specifications.")
        print("")
        print("Requirements:")
        print("  - data/processed/benchmarks.parquet (from dataset_aggregator.py)")
        print("  - TensorFlow 2.16+")
        print("  - scikit-learn, pandas, numpy")
        print("")
        print("Usage:")
        print("  python train_model.py")
        print("  python train_model.py --debug")
        print("")
        return
    
    trainer = ModelTrainer()
    model, history = trainer.train_complete_pipeline()

if __name__ == "__main__":
    main()
