const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function run() {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-checker-main-registry-'));
    const cliPath = path.join(__dirname, '..', 'bin', 'enhanced_cli.js');

    try {
        const result = spawnSync(
            process.execPath,
            [
                cliPath,
                'recommend',
                '--no-verbose',
                '--runtime',
                'vllm',
                '--category',
                'coding'
            ],
            {
                encoding: 'utf8',
                timeout: 30000,
                env: {
                    ...process.env,
                    HOME: tempHome
                }
            }
        );

        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        assert.strictEqual(result.status, 0, output);
        assert.ok(output.includes('Source: Multi-source registry'), 'recommend should use the registry main flow');
        assert.ok(output.includes('Runtime: VLLM'), 'recommend should honor non-Ollama runtime selection');
        assert.ok(output.includes('hf download '), 'recommend should emit Hugging Face download commands');
        assert.ok(output.includes('Source: huggingface'), 'recommend should surface Hugging Face picks');

        console.log('[OK] model-registry-main-flow.test.js passed');
    } finally {
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('[FAIL] model-registry-main-flow.test.js failed');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
