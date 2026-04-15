#!/usr/bin/env node
'use strict';

const majorNodeVersion = Number.parseInt(process.versions.node.split('.')[0], 10);

if (!Number.isFinite(majorNodeVersion) || majorNodeVersion < 16) {
    console.error(
        `[llm-checker] Unsupported Node.js version: ${process.versions.node}. ` +
        'Please use Node.js 16 or newer.'
    );
    process.exit(1);
}

function preprocessAiCheckModelsArg(argv) {
    const normalizedArgs = [];
    let modelsFilter = null;
    let sawAiCheck = false;

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];

        if (token === 'ai-check') {
            sawAiCheck = true;
        }

        if (sawAiCheck && token === '--models') {
            const nextToken = argv[index + 1];
            if (nextToken && !nextToken.startsWith('-')) {
                modelsFilter = nextToken;
                index += 1;
            }
            continue;
        }

        if (sawAiCheck && token.startsWith('--models=')) {
            modelsFilter = token.slice('--models='.length);
            continue;
        }

        normalizedArgs.push(token);
    }

    return { args: normalizedArgs, modelsFilter };
}

const preprocessedArgs = preprocessAiCheckModelsArg(process.argv.slice(2));

if (typeof preprocessedArgs.modelsFilter === 'string' && preprocessedArgs.modelsFilter.trim()) {
    process.env.LLM_CHECKER_AI_CHECK_MODELS = preprocessedArgs.modelsFilter.trim();
}

process.argv = [process.argv[0], process.argv[1], ...preprocessedArgs.args];

require('./enhanced_cli');
