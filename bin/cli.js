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

// `ai-check --models <list>` is now a real commander option handled in
// enhanced_cli.js (and the AICheckSelector applies it as a candidate filter), so
// the previous argv-rewriting shim — which stripped the flag and stashed it in an
// env var that nothing read — is gone. LLM_CHECKER_AI_CHECK_MODELS still works as
// an explicit fallback for the same filter.

require('./enhanced_cli');
