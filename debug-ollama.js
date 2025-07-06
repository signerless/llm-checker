const OllamaClient = require('./src/ollama/client');

async function diagnoseOllama() {
    console.log('🔍 Diagnosing Ollama connection...\n');
    
    const client = new OllamaClient();
    
    try {
        // Test completo de conexión
        const testResult = await client.testConnection();
        
        if (testResult.success) {
            console.log('✅ Ollama connection successful!');
            console.log(`   Version: ${testResult.version}`);
            console.log(`   Models found: ${testResult.modelsFound}`);
            
            if (testResult.modelsFound === 0) {
                console.log('\n💡 No models installed. Try installing one:');
                console.log('   ollama pull tinyllama');
                console.log('   ollama pull llama3.2:3b');
            } else {
                console.log('\n📦 Installed models:');
                testResult.models.forEach(model => {
                    console.log(`   • ${model.name}`);
                });
            }
        } else {
            console.log('❌ Ollama connection failed');
            console.log(`   Error: ${testResult.error}`);
            console.log(`   Details: ${testResult.details}`);
            
            console.log('\n🔧 Possible solutions:');
            console.log('1. Install Ollama: curl -fsSL https://ollama.ai/install.sh | sh');
            console.log('2. Start Ollama: ollama serve');
            console.log('3. Check if running: curl http://localhost:11434/api/version');
        }
    } catch (error) {
        console.log('❌ Diagnosis failed:', error.message);
    }
}

diagnoseOllama();
