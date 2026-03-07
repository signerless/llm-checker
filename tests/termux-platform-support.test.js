const assert = require('assert');
const HardwareDetector = require('../src/hardware/detector');
const { getRuntimeInstallCommand } = require('../src/runtime/runtime-support');
const { normalizePlatform, isTermuxEnvironment } = require('../src/utils/platform');

function withPlatformAndEnv(platform, envOverrides, fn) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalValues = {};
    const keys = Object.keys(envOverrides || {});

    Object.defineProperty(process, 'platform', { value: platform });

    for (const key of keys) {
        originalValues[key] = process.env[key];
        const nextValue = envOverrides[key];
        if (nextValue == null) {
            delete process.env[key];
        } else {
            process.env[key] = nextValue;
        }
    }

    try {
        return fn();
    } finally {
        Object.defineProperty(process, 'platform', originalDescriptor);
        for (const key of keys) {
            if (originalValues[key] == null) {
                delete process.env[key];
            } else {
                process.env[key] = originalValues[key];
            }
        }
    }
}

function testNormalizePlatformMapsAndroidToLinux() {
    assert.strictEqual(normalizePlatform('android'), 'linux', 'Android should normalize to Linux');
}

function testTermuxEnvironmentDetection() {
    assert.strictEqual(isTermuxEnvironment('android', {}), true, 'Android platform should be treated as Termux-compatible');
    assert.strictEqual(
        isTermuxEnvironment('linux', { PREFIX: '/data/data/com.termux/files/usr' }),
        true,
        'Termux PREFIX should mark the environment as Termux'
    );
}

function testHardwareDetectorPreservesRawPlatform() {
    const detector = new HardwareDetector();
    const osInfo = detector.processOSInfo({
        platform: 'android',
        distro: 'Android 15',
        release: '6.1.99'
    });

    assert.strictEqual(osInfo.platform, 'linux', 'Normalized OS platform should use linux-compatible path');
    assert.strictEqual(osInfo.platformRaw, 'android', 'Raw platform should be preserved for diagnostics');
    assert.strictEqual(osInfo.distro, 'Android 15');
}

function testRuntimeInstallCommandUsesTermuxPackage() {
    const command = withPlatformAndEnv(
        'android',
        {
            PREFIX: '/data/data/com.termux/files/usr',
            TERMUX_VERSION: '0.119.0'
        },
        () => getRuntimeInstallCommand('ollama')
    );

    assert.strictEqual(command, 'pkg install ollama', 'Termux should prefer pkg-based Ollama installation');
}

function run() {
    testNormalizePlatformMapsAndroidToLinux();
    testTermuxEnvironmentDetection();
    testHardwareDetectorPreservesRawPlatform();
    testRuntimeInstallCommandUsesTermuxPackage();
    console.log('termux-platform-support: ok');
}

run();
