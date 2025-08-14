/**
 * Test Runner - Executes all automated tests
 * Validates multi-GPU detection and cross-platform functionality
 */

const MultiGPUTests = require('./gpu-detection/multi-gpu.test');
const CrossPlatformTests = require('./platform-tests/cross-platform.test');
const InterfaceTests = require('./ui-tests/interface.test');

class TestRunner {
    constructor() {
        this.allResults = [];
        this.startTime = Date.now();
    }

    async runAllTests() {
        console.log('🚀 LLM-Checker Automated Test Suite\n');
        console.log('Testing multi-GPU detection and cross-platform functionality...\n');

        try {
            // Run Multi-GPU Detection Tests
            console.log('=' .repeat(70));
            console.log('🔧 MULTI-GPU DETECTION TESTS');
            console.log('=' .repeat(70));
            
            const multiGPUTester = new MultiGPUTests();
            const multiGPUResults = await multiGPUTester.runAll();
            this.allResults.push(...multiGPUResults);

            console.log('\n');

            // Run Cross-Platform Tests
            console.log('=' .repeat(70));
            console.log('🌍 CROSS-PLATFORM TESTS');
            console.log('=' .repeat(70));
            
            const crossPlatformTester = new CrossPlatformTests();
            const crossPlatformResults = await crossPlatformTester.runAll();
            this.allResults.push(...crossPlatformResults);

            console.log('\n');

            // Run UI/Interface Tests  
            console.log('=' .repeat(70));
            console.log('🖥️  UI/INTERFACE TESTS');
            console.log('=' .repeat(70));
            
            const interfaceTester = new InterfaceTests();
            const interfaceResults = await interfaceTester.runAll();
            this.allResults.push(...interfaceResults);

            // Overall Summary
            this.printOverallSummary();

        } catch (error) {
            console.error('❌ Test runner failed:', error.message);
            console.error(error.stack);
            process.exit(1);
        }
    }

    printOverallSummary() {
        const endTime = Date.now();
        const duration = endTime - this.startTime;
        
        const total = this.allResults.length;
        const passed = this.allResults.filter(r => r.success).length;
        const failed = total - passed;

        console.log('\n');
        console.log('=' .repeat(70));
        console.log('🏆 OVERALL TEST RESULTS');
        console.log('=' .repeat(70));
        
        console.log(`📊 Total Tests: ${total}`);
        console.log(`✅ Passed: ${passed}`);
        console.log(`❌ Failed: ${failed}`);
        console.log(`🎯 Success Rate: ${Math.round((passed / total) * 100)}%`);
        console.log(`⏱️  Total Duration: ${this.formatDuration(duration)}`);
        console.log();

        // Test Categories Summary
        const categories = this.groupResultsByCategory();
        console.log('📋 Results by Category:');
        for (const [category, results] of Object.entries(categories)) {
            const categoryPassed = results.filter(r => r.success).length;
            const categoryTotal = results.length;
            const rate = Math.round((categoryPassed / categoryTotal) * 100);
            console.log(`   ${category}: ${categoryPassed}/${categoryTotal} (${rate}%)`);
        }

        console.log();

        if (failed === 0) {
            console.log('🎉 ALL TESTS PASSED! 🎉');
            console.log('Multi-GPU detection and cross-platform functionality verified!');
            console.log();
            console.log('✅ Ready for production deployment');
        } else {
            console.log('⚠️  SOME TESTS FAILED');
            console.log('Review the detailed results above for failure analysis.');
            console.log();
            
            // List failed tests
            const failedTests = this.allResults.filter(r => !r.success);
            console.log('Failed Tests:');
            failedTests.forEach(test => {
                console.log(`  ❌ ${test.name}`);
                if (test.error) {
                    console.log(`     Error: ${test.error}`);
                }
            });
            
            console.log();
            console.log('🔧 Fix these issues before deployment');
        }

        // Exit with appropriate code
        process.exit(failed === 0 ? 0 : 1);
    }

    groupResultsByCategory() {
        const categories = {};
        
        this.allResults.forEach(result => {
            let category = 'Other';
            
            if (result.name.includes('Proxmox') || result.name.includes('Multi-GPU') || 
                result.name.includes('VRAM') || result.name.includes('Tier')) {
                category = 'Multi-GPU Detection';
            } else if (result.name.includes('macOS') || result.name.includes('Windows') || 
                       result.name.includes('Linux') || result.name.includes('Platform')) {
                category = 'Cross-Platform';
            } else if (result.name.includes('Spinner') || result.name.includes('Emoji') || 
                       result.name.includes('Progress') || result.name.includes('UI')) {
                category = 'UI/Interface';
            }
            
            if (!categories[category]) {
                categories[category] = [];
            }
            categories[category].push(result);
        });
        
        return categories;
    }

    formatDuration(ms) {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}m ${seconds}s`;
    }
}

// Export for use in other files or run directly
module.exports = TestRunner;

if (require.main === module) {
    const runner = new TestRunner();
    runner.runAllTests().catch(console.error);
}