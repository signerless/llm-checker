#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

// Add src to path for imports
process.env.NODE_PATH = path.join(__dirname, '..', 'src');
require('module').Module._initPaths();

const LLMChecker = require('../src/index');
const OllamaClient = require('../src/ollama/client');
const PerformanceAnalyzer = require('../src/analyzer/performance');
const { getLogger } = require('../src/utils/logger');

class BenchmarkRunner {
    constructor() {
        this.checker = new LLMChecker();
        this.ollama = new OllamaClient();
        this.performance = new PerformanceAnalyzer();
        this.logger = getLogger({ level: 'info' });
        this.results = [];
    }

    async runFullBenchmark() {
        console.log('🚀 Starting LLM Checker Benchmark Suite\n');

        try {
            // Hardware benchmark
            await this.runHardwareBenchmark();

            // Model analysis benchmark
            await this.runModelAnalysisBenchmark();

            // Ollama integration benchmark
            await this.runOllamaBenchmark();

            // Performance estimation benchmark
            await this.runPerformanceBenchmark();

            // Generate report
            await this.generateBenchmarkReport();

        } catch (error) {
            console.error('❌ Benchmark failed:', error.message);
            process.exit(1);
        }
    }

    async runHardwareBenchmark() {
        console.log('🔍 Running Hardware Detection Benchmark...');

        const times = [];
        const iterations = 5;

        for (let i = 0; i < iterations; i++) {
            const start = Date.now();
            const hardware = await this.checker.getSystemInfo();
            const duration = Date.now() - start;
            times.push(duration);

            if (i === 0) {
                console.log(`   CPU: ${hardware.cpu.brand} (${hardware.cpu.cores} cores)`);
                console.log(`   RAM: ${hardware.memory.total}GB`);
                console.log(`   GPU: ${hardware.gpu.model}`);
            }
        }

        const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
        console.log(`   Average detection time: ${avgTime.toFixed(2)}ms\n`);

        this.results.push({
            test: 'Hardware Detection',
            averageTime: avgTime,
            iterations,
            status: 'success'
        });
    }

    async runModelAnalysisBenchmark() {
        console.log('🧠 Running Model Analysis Benchmark...');

        const start = Date.now();
        const analysis = await this.checker.analyze();
        const duration = Date.now() - start;

        console.log(`   Models analyzed: ${analysis.compatible.length + analysis.marginal.length + analysis.incompatible.length}`);
        console.log(`   Compatible: ${analysis.compatible.length}`);
        console.log(`   Analysis time: ${duration}ms\n`);

        this.results.push({
            test: 'Model Analysis',
            duration,
            modelsAnalyzed: analysis.compatible.length + analysis.marginal.length + analysis.incompatible.length,
            status: 'success'
        });
    }

    async runOllamaBenchmark() {
        console.log('🦙 Running Ollama Integration Benchmark...');

        try {
            const start = Date.now();
            const status = await this.ollama.checkOllamaAvailability();
            const checkDuration = Date.now() - start;

            if (!status.available) {
                console.log(`   Ollama not available: ${status.error}\n`);
                this.results.push({
                    test: 'Ollama Integration',
                    status: 'skipped',
                    reason: status.error
                });
                return;
            }

            console.log(`   Ollama detection: ${checkDuration}ms`);

            // Test model listing
            const listStart = Date.now();
            const models = await this.ollama.getLocalModels();
            const listDuration = Date.now() - listStart;

            console.log(`   Local models: ${models.length} (${listDuration}ms)`);

            // Test running models
            const runningStart = Date.now();
            const running = await this.ollama.getRunningModels();
            const runningDuration = Date.now() - runningStart;

            console.log(`   Running models: ${running.length} (${runningDuration}ms)\n`);

            this.results.push({
                test: 'Ollama Integration',
                checkTime: checkDuration,
                listTime: listDuration,
                runningTime: runningDuration,
                localModels: models.length,
                runningModels: running.length,
                status: 'success'
            });

        } catch (error) {
            console.log(`   Error: ${error.message}\n`);
            this.results.push({
                test: 'Ollama Integration',
                status: 'error',
                error: error.message
            });
        }
    }

    async runPerformanceBenchmark() {
        console.log('⚡ Running Performance Analysis Benchmark...');

        try {
            const start = Date.now();
            const hardware = await this.checker.getSystemInfo();
            const systemPerf = await this.performance.analyzeSystemPerformance(hardware);
            const duration = Date.now() - start;

            console.log(`   CPU Score: ${systemPerf.cpu.score}/100`);
            console.log(`   Memory Score: ${systemPerf.memory.score}/100`);
            console.log(`   GPU Score: ${systemPerf.gpu.score}/100`);
            console.log(`   Overall Score: ${systemPerf.overall}/100`);
            console.log(`   Analysis time: ${duration}ms\n`);

            this.results.push({
                test: 'Performance Analysis',
                duration,
                scores: {
                    cpu: systemPerf.cpu.score,
                    memory: systemPerf.memory.score,
                    gpu: systemPerf.gpu.score,
                    overall: systemPerf.overall
                },
                status: 'success'
            });

        } catch (error) {
            console.log(`   Error: ${error.message}\n`);
            this.results.push({
                test: 'Performance Analysis',
                status: 'error',
                error: error.message
            });
        }
    }

    async generateBenchmarkReport() {
        console.log('📊 Generating Benchmark Report...\n');

        const report = {
            timestamp: new Date().toISOString(),
            system: await this.getSystemSummary(),
            results: this.results,
            summary: this.generateSummary()
        };

        // Save to file
        const reportPath = path.join(process.cwd(), `benchmark-${Date.now()}.json`);
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

        // Display summary
        console.log('📋 Benchmark Summary:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        this.results.forEach(result => {
            const status = result.status === 'success' ? '✅' :
                result.status === 'error' ? '❌' : '⏭️';
            console.log(`${status} ${result.test}`);

            if (result.duration) {
                console.log(`   Duration: ${result.duration}ms`);
            }
            if (result.averageTime) {
                console.log(`   Average Time: ${result.averageTime.toFixed(2)}ms`);
            }
            if (result.scores) {
                console.log(`   Overall Score: ${result.scores.overall}/100`);
            }
        });

        console.log(`\n📄 Full report saved to: ${reportPath}`);
    }

    async getSystemSummary() {
        try {
            const hardware = await this.checker.getSystemInfo();
            return {
                cpu: hardware.cpu.brand,
                architecture: hardware.cpu.architecture,
                cores: hardware.cpu.cores,
                ram: `${hardware.memory.total}GB`,
                gpu: hardware.gpu.model,
                vram: `${hardware.gpu.vram}GB`,
                os: `${hardware.os.distro} ${hardware.os.release}`
            };
        } catch (error) {
            return { error: error.message };
        }
    }

    generateSummary() {
        const successful = this.results.filter(r => r.status === 'success').length;
        const failed = this.results.filter(r => r.status === 'error').length;
        const skipped = this.results.filter(r => r.status === 'skipped').length;

        const totalTime = this.results.reduce((sum, r) => {
            return sum + (r.duration || r.averageTime || 0);
        }, 0);

        return {
            totalTests: this.results.length,
            successful,
            failed,
            skipped,
            totalTime: Math.round(totalTime),
            grade: this.calculateGrade(successful, failed, skipped)
        };
    }

    calculateGrade(successful, failed, skipped) {
        const total = successful + failed + skipped;
        const successRate = (successful / total) * 100;

        if (successRate >= 90) return 'A';
        if (successRate >= 80) return 'B';
        if (successRate >= 70) return 'C';
        if (successRate >= 60) return 'D';
        return 'F';
    }
}

// CLI interface
if (require.main === module) {
    const benchmark = new BenchmarkRunner();

    const args = process.argv.slice(2);
    const command = args[0] || 'full';

    switch (command) {
        case 'full':
        case 'all':
            benchmark.runFullBenchmark();
            break;

        case 'hardware':
            benchmark.runHardwareBenchmark();
            break;

        case 'models':
            benchmark.runModelAnalysisBenchmark();
            break;

        case 'ollama':
            benchmark.runOllamaBenchmark();
            break;

        case 'performance':
            benchmark.runPerformanceBenchmark();
            break;

        default:
            console.log('Usage: node benchmark.js [full|hardware|models|ollama|performance]');
            process.exit(1);
    }
}

module.exports = BenchmarkRunner;