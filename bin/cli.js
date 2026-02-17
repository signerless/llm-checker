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

require('./enhanced_cli');
