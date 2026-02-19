const assert = require('assert');
const os = require('os');
const CPUDetector = require('../src/hardware/backends/cpu-detector');

class MockWindowsCPUDetector extends CPUDetector {
    constructor(handler) {
        super();
        this.handler = handler;
        this.commands = [];
    }

    runCommand(command) {
        this.commands.push(command);
        return this.handler(command);
    }
}

function withPlatform(platform, fn) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    try {
        return fn();
    } finally {
        Object.defineProperty(process, 'platform', originalDescriptor);
    }
}

function testPhysicalCoresFallbackToCim() {
    const detector = new MockWindowsCPUDetector((command) => {
        if (command.startsWith('wmic')) {
            throw new Error('wmic not found');
        }
        if (command.includes('Get-CimInstance Win32_Processor') && command.includes('NumberOfCores')) {
            return '12\r\n';
        }
        throw new Error(`Unexpected command: ${command}`);
    });

    const physical = withPlatform('win32', () => detector.getPhysicalCores());
    assert.strictEqual(physical, 12, `Expected PowerShell CIM fallback for physical cores, got ${physical}`);
    assert(
        detector.commands.some((cmd) => cmd.startsWith('wmic cpu get NumberOfCores')),
        'Expected WMIC to be attempted first for physical cores'
    );
    assert(
        detector.commands.some((cmd) => cmd.includes('Get-CimInstance Win32_Processor') && cmd.includes('NumberOfCores')),
        'Expected Get-CimInstance fallback to be attempted for physical cores'
    );
}

function testMaxClockFallbackToCim() {
    const detector = new MockWindowsCPUDetector((command) => {
        if (command.startsWith('wmic')) {
            throw new Error('wmic not found');
        }
        if (command.includes('Get-CimInstance Win32_Processor') && command.includes('MaxClockSpeed')) {
            return '5200\r\n';
        }
        throw new Error(`Unexpected command: ${command}`);
    });

    const maxClock = withPlatform('win32', () => detector.getMaxFrequency());
    assert.strictEqual(maxClock, 5200, `Expected PowerShell CIM fallback for max clock speed, got ${maxClock}`);
    assert(
        detector.commands.some((cmd) => cmd.startsWith('wmic cpu get MaxClockSpeed')),
        'Expected WMIC to be attempted first for max clock speed'
    );
    assert(
        detector.commands.some((cmd) => cmd.includes('Get-CimInstance Win32_Processor') && cmd.includes('MaxClockSpeed')),
        'Expected Get-CimInstance fallback to be attempted for max clock speed'
    );
}

function testFallbackToNodeWhenWindowsCommandsUnavailable() {
    const detector = new MockWindowsCPUDetector(() => {
        throw new Error('command unavailable');
    });

    const expectedCores = os.cpus().length;
    const expectedSpeed = os.cpus()[0]?.speed || 0;

    const result = withPlatform('win32', () => ({
        physical: detector.getPhysicalCores(),
        maxClock: detector.getMaxFrequency()
    }));

    assert.strictEqual(
        result.physical,
        expectedCores,
        `Expected Node.js fallback core count (${expectedCores}), got ${result.physical}`
    );
    assert.strictEqual(
        result.maxClock,
        expectedSpeed,
        `Expected Node.js fallback clock speed (${expectedSpeed}), got ${result.maxClock}`
    );
}

function run() {
    testPhysicalCoresFallbackToCim();
    testMaxClockFallbackToCim();
    testFallbackToNodeWhenWindowsCommandsUnavailable();
    console.log('cpu-detector-windows-fallback.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('cpu-detector-windows-fallback.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };
