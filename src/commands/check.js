const EnhancedOllamaClient = require('../ollama/enhanced-client');

async function checkOllamaIntegration() {
    const ollama = new EnhancedOllamaClient();

    try {
        // Verificar si Ollama está corriendo
        const status = await ollama.getStatus();

        if (!status.running) {
            console.log('Ollama Status: Not running');
            console.log('   Start with: ollama serve');
            return;
        }

        console.log(`Ollama Status: Running (v${status.version})`);

        // 🆕 Nueva funcionalidad mejorada
        console.log('Analyzing compatibility with enhanced model database...');
        const enhanced = await ollama.getEnhancedCompatibleModels();

        console.log(`Installed: ${enhanced.installed} total, ${enhanced.compatible} compatible`);
        console.log(`Available: ${enhanced.total_available} models in Ollama library`);

        // Mostrar modelos compatibles encontrados
        if (enhanced.compatible > 0) {
            console.log('\nCompatible Models Found:');
            enhanced.compatible_models.forEach(model => {
                const matchType = model.match_type === 'exact' ? 'EXACT' : 'PARTIAL';
                console.log(`   ${matchType} ${model.name} (Score: ${model.score}/100)`);
                console.log(`      Local: ${model.local_name}`);
                console.log(`      Pulls: ${model.pulls?.toLocaleString() || 'Unknown'}`);
                console.log(`      Install: ${model.installation.ollama}`);
            });
        } else {
            console.log('\nNo compatible models found in current database');
        }

        // Mostrar recomendaciones
        if (enhanced.recommendations.length > 0) {
            console.log('\nRecommended popular models:');
            enhanced.recommendations.slice(0, 5).forEach(model => {
                console.log(`   ${model.name} (${model.pulls?.toLocaleString() || 'Unknown'} pulls)`);
                console.log(`      ${model.description}`);
                console.log(`      Install: ${model.installation.ollama}`);
            });
        }

        // Info del cache
        if (enhanced.cache_info) {
            const cached = new Date(enhanced.cache_info.cached_at).toLocaleString();
            console.log(`\nModel data cached at: ${cached}`);
        }

    } catch (error) {
        console.error('Error checking Ollama integration:', error.message);
    }
}