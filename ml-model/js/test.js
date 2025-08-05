const AIModelSelector = require('./index');

async function testSelector() {
    console.log('🧪 Testing AI Model Selector...');
    
    const selector = new AIModelSelector();
    
    try {
        // Test system specs detection
        console.log('\n1. Testing system specs detection...');
        const specs = await selector.getSystemSpecs();
        console.log('System specs:', {
            cpu_cores: specs.cpu_cores,
            ram_gb: specs.total_ram_gb.toFixed(1),
            gpu: specs.gpu_model_normalized,
            vram_gb: specs.gpu_vram_gb.toFixed(1)
        });
        
        // Test heuristic selection (always works)
        console.log('\n2. Testing heuristic selection...');
        const testModels = ['llama2:7b', 'mistral:7b', 'phi3:mini', 'llama2:13b'];
        const heuristicResult = selector.selectModelHeuristic(testModels, specs);
        console.log('Heuristic result:', {
            bestModel: heuristicResult.bestModel,
            method: heuristicResult.method,
            reason: heuristicResult.reason
        });
        
        // Test AI selection (might fail if model not trained)
        console.log('\n3. Testing AI selection...');
        try {
            const aiResult = await selector.predictBestModel(testModels, specs);
            console.log('AI result:', {
                bestModel: aiResult.bestModel,
                topScores: aiResult.allPredictions.slice(0, 3).map(p => ({
                    model: p.model,
                    score: (p.score * 100).toFixed(1) + '%'
                }))
            });
            console.log('✅ AI selection working!');
        } catch (error) {
            console.log('⚠️  AI selection not available:', error.message);
            console.log('   This is expected if the model hasn\'t been trained yet.');
        }
        
        console.log('\n🎉 Test completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

if (require.main === module) {
    testSelector();
}

module.exports = testSelector;