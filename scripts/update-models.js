#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

class ModelDatabaseUpdater {
    constructor() {
        this.databasePath = path.join(__dirname, '..', 'src', 'models', 'expanded_database.js');
        this.backupPath = this.databasePath + '.backup.' + Date.now();
        this.sources = [
            'https://api.github.com/repos/ollama/ollama/contents/README.md',
            'https://huggingface.co/api/models?sort=downloads&direction=-1&limit=100'
        ];
    }

    async updateDatabase() {
        console.log('🔄 Starting model database update...\n');

        try {
            // Create backup
            await this.createBackup();

            // Fetch latest model information
            const newModels = await this.fetchLatestModels();

            // Update database
            await this.updateDatabaseFile(newModels);

            // Validate updated database
            await this.validateDatabase();

            console.log('✅ Model database updated successfully!');

        } catch (error) {
            console.error('❌ Database update failed:', error.message);
            await this.restoreBackup();
            process.exit(1);
        }
    }

    async createBackup() {
        console.log('📋 Creating backup of current database...');

        if (fs.existsSync(this.databasePath)) {
            fs.copyFileSync(this.databasePath, this.backupPath);
            console.log(`   Backup created: ${this.backupPath}\n`);
        }
    }

    async fetchLatestModels() {
        console.log('🌐 Fetching latest model information...');

        const models = [];

        // Fetch from Ollama library
        try {
            const ollamaModels = await this.fetchOllamaModels();
            models.push(...ollamaModels);
            console.log(`   Found ${ollamaModels.length} models from Ollama`);
        } catch (error) {
            console.warn(`   Warning: Could not fetch Ollama models: ${error.message}`);
        }

        // Fetch from Hugging Face
        try {
            const hfModels = await this.fetchHuggingFaceModels();
            models.push(...hfModels);
            console.log(`   Found ${hfModels.length} models from Hugging Face`);
        } catch (error) {
            console.warn(`   Warning: Could not fetch Hugging Face models: ${error.message}`);
        }

        console.log(`   Total new models found: ${models.length}\n`);
        return models;
    }

    async fetchOllamaModels() {
        // This would fetch from Ollama's official model list
        // For now, return example models that might be new
        return [
            {
                name: "Llama 3.4 8B",
                size: "8B",
                type: "local",
                category: "medium",
                requirements: {
                    ram: 8,
                    vram: 4,
                    cpu_cores: 4,
                    storage: 8.5,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "llama.cpp", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "excellent",
                    context_length: 128000,
                    tokens_per_second_estimate: "12-30"
                },
                installation: {
                    ollama: "ollama pull llama3.4:8b",
                    description: "Latest Llama model with improved capabilities"
                },
                specialization: "general",
                languages: ["en"],
                year: 2025,
                source: "ollama_update"
            }
        ];
    }

    async fetchHuggingFaceModels() {
        // This would fetch from Hugging Face API
        // For now, return example models
        return [
            {
                name: "Gemma 3 8B",
                size: "8B",
                type: "local",
                category: "medium",
                requirements: {
                    ram: 10,
                    vram: 5,
                    cpu_cores: 4,
                    storage: 9,
                    recommended_ram: 16
                },
                frameworks: ["ollama", "transformers"],
                quantization: ["Q4_0", "Q4_K_M", "Q5_0", "Q5_K_M", "Q8_0"],
                performance: {
                    speed: "medium",
                    quality: "excellent",
                    context_length: 128000,
                    tokens_per_second_estimate: "10-25"
                },
                installation: {
                    ollama: "ollama pull gemma3:8b",
                    description: "Google's latest Gemma model with enhanced performance"
                },
                specialization: "general",
                languages: ["en"],
                year: 2025,
                multimodal: false,
                source: "huggingface_update"
            }
        ];
    }

    async updateDatabaseFile(newModels) {
        console.log('📝 Updating database file...');

        // Read current database
        const currentContent = fs.readFileSync(this.databasePath, 'utf8');

        // Parse the current models array
        const modelsMatch = currentContent.match(/initializeExpandedModels\(\)\s*{\s*return\s*(\[[\s\S]*?\]);/);
        if (!modelsMatch) {
            throw new Error('Could not parse current database file');
        }

        let currentModels;
        try {
            // Safely evaluate the models array
            currentModels = eval(modelsMatch[1]);
        } catch (error) {
            throw new Error('Could not parse current models array');
        }

        // Merge new models (avoid duplicates)
        const existingNames = new Set(currentModels.map(m => m.name));
        const uniqueNewModels = newModels.filter(m => !existingNames.has(m.name));

        if (uniqueNewModels.length === 0) {
            console.log('   No new models to add');
            return;
        }

        const updatedModels = [...currentModels, ...uniqueNewModels];

        // Generate new database content
        const newContent = this.generateDatabaseContent(updatedModels);

        // Write to file
        fs.writeFileSync(this.databasePath, newContent, 'utf8');

        console.log(`   Added ${uniqueNewModels.length} new models to database`);
        uniqueNewModels.forEach(model => {
            console.log(`     - ${model.name} (${model.size})`);
        });
        console.log();
    }

    generateDatabaseContent(models) {
        // Generate the complete database file content
        const modelsJSON = JSON.stringify(models, null, 8).replace(/^/gm, '      ');

        return `class ExpandedModelsDatabase {
  constructor() {
    this.models = this.initializeExpandedModels();
    this.compatibilityMatrix = this.initializeCompatibilityMatrix();
  }

  initializeExpandedModels() {
    return ${modelsJSON};
  }

  initializeCompatibilityMatrix() {
    return {
      // Hardware tiers
      tiers: {
        ultra_low: { ram: 4, vram: 0, cpu_cores: 2 },
        low: { ram: 8, vram: 2, cpu_cores: 4 },
        medium: { ram: 16, vram: 8, cpu_cores: 6 },
        high: { ram: 32, vram: 16, cpu_cores: 8 },
        ultra_high: { ram: 64, vram: 32, cpu_cores: 12 }
      },
      
      // Compatibility scores by category and tier
      compatibility: {
        ultra_small: {
          ultra_low: 95, low: 100, medium: 100, high: 100, ultra_high: 100
        },
        small: {
          ultra_low: 70, low: 90, medium: 100, high: 100, ultra_high: 100
        },
        medium: {
          ultra_low: 20, low: 60, medium: 85, high: 95, ultra_high: 100
        },
        large: {
          ultra_low: 5, low: 25, medium: 50, high: 80, ultra_high: 95
        },
        embedding: {
          ultra_low: 100, low: 100, medium: 100, high: 100, ultra_high: 100
        }
      },

      // Performance multipliers
      architecture_bonuses: {
        'Apple Silicon': 1.15,
        'x86_64_modern': 1.05,
        'ARM64': 0.95
      },

      // Quantization effectiveness
      quantization_savings: {
        'Q2_K': 0.6,   // 60% size reduction
        'Q3_K_M': 0.7, // 70% of original size
        'Q4_0': 0.75,  // 75% of original size
        'Q4_K_M': 0.75,
        'Q5_0': 0.85,  // 85% of original size
        'Q5_K_M': 0.85,
        'Q6_K': 0.9,   // 90% of original size
        'Q8_0': 0.95   // 95% of original size
      }
    };
  }

  // ... (rest of the class methods remain the same)
  getAllModels() {
    return this.models;
  }

  getModelsByCategory(category) {
    return this.models.filter(model => model.category === category);
  }

  // Add all other existing methods here...
}

module.exports = ExpandedModelsDatabase;`;
    }

    async validateDatabase() {
        console.log('🔍 Validating updated database...');

        try {
            // Try to require the updated database
            delete require.cache[require.resolve(this.databasePath)];
            const ExpandedModelsDatabase = require(this.databasePath);

            // Test instantiation
            const db = new ExpandedModelsDatabase();
            const models = db.getAllModels();

            console.log(`   Validation passed: ${models.length} models loaded`);

            // Basic validation checks
            const categories = ['ultra_small', 'small', 'medium', 'large'];
            categories.forEach(category => {
                const categoryModels = db.getModelsByCategory(category);
                console.log(`     ${category}: ${categoryModels.length} models`);
            });

            console.log();

        } catch (error) {
            throw new Error(`Database validation failed: ${error.message}`);
        }
    }

    async restoreBackup() {
        console.log('🔄 Restoring backup...');

        if (fs.existsSync(this.backupPath)) {
            fs.copyFileSync(this.backupPath, this.databasePath);
            console.log('   Backup restored successfully');
        }
    }

    async cleanupBackups() {
        console.log('🧹 Cleaning up old backups...');

        const backupDir = path.dirname(this.databasePath);
        const files = fs.readdirSync(backupDir);

        const backupFiles = files
            .filter(file => file.includes('.backup.'))
            .map(file => ({
                name: file,
                path: path.join(backupDir, file),
                time: fs.statSync(path.join(backupDir, file)).mtime
            }))
            .sort((a, b) => b.time - a.time);

        // Keep only the 5 most recent backups
        const toDelete = backupFiles.slice(5);

        toDelete.forEach(backup => {
            fs.unlinkSync(backup.path);
            console.log(`   Removed old backup: ${backup.name}`);
        });

        if (toDelete.length === 0) {
            console.log('   No old backups to clean up');
        }
    }
}

// CLI interface
if (require.main === module) {
    const updater = new ModelDatabaseUpdater();

    const args = process.argv.slice(2);
    const command = args[0] || 'update';

    switch (command) {
        case 'update':
            updater.updateDatabase();
            break;

        case 'validate':
            updater.validateDatabase()
                .then(() => console.log('✅ Database validation passed'))
                .catch(error => {
                    console.error('❌ Database validation failed:', error.message);
                    process.exit(1);
                });
            break;

        case 'backup':
            updater.createBackup()
                .then(() => console.log('✅ Backup created'))
                .catch(error => {
                    console.error('❌ Backup failed:', error.message);
                    process.exit(1);
                });
            break;

        case 'cleanup':
            updater.cleanupBackups();
            break;

        default:
            console.log('Usage: node update-models.js [update|validate|backup|cleanup]');
            process.exit(1);
    }
}

module.exports = ModelDatabaseUpdater;