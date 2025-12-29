#!/usr/bin/env node

/**
 * Test script for the new deterministic model selector
 */

const DeterministicModelSelector = require('../src/models/deterministic-selector');

async function main() {
    const selector = new DeterministicModelSelector();
    
    const category = process.argv[2] || 'general';
    const enableProbe = process.argv.includes('--probe');
    const topN = process.argv.includes('--limit') ? 
        parseInt(process.argv[process.argv.indexOf('--limit') + 1]) : 5;

    console.log('LLM-Checker: Deterministic Model Selector (v1.0)');
    console.log(`Category: ${category}`);
    console.log(`🔬 Quick probe: ${enableProbe ? 'enabled' : 'disabled'}`);
    console.log('─'.repeat(80));

    try {
        const result = await selector.recommend(category, {
            topN,
            enableProbe
        });
        
        console.log('\n✅ Selection complete!');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (process.argv.includes('--verbose')) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}