const assert = require('assert');
const {
    __private: {
        tokenizeArgString,
        buildCommandCatalog,
        buildPrimaryCommands,
        getVisibleCommands,
        truncateText
    }
} = require('../src/ui/interactive-panel');

function createMockCommand(name, description) {
    return {
        name: () => name,
        description: () => description
    };
}

function run() {
    const parsed = tokenizeArgString('--json --limit 5 --name "llama 3.2" --path \'./my file.txt\'');
    assert.deepStrictEqual(parsed, [
        '--json',
        '--limit',
        '5',
        '--name',
        'llama 3.2',
        '--path',
        './my file.txt'
    ]);

    assert.strictEqual(truncateText('short', 10), 'short');
    assert.strictEqual(truncateText('abcdefghij', 6), 'abc...');

    const mockProgram = {
        commands: [
            createMockCommand('recommend', 'Recommend models'),
            createMockCommand('check', 'Check compatibility'),
            createMockCommand('search', 'Search models'),
            createMockCommand('sync', 'Sync database')
        ]
    };

    const catalog = buildCommandCatalog(mockProgram);
    assert.strictEqual(catalog[0].name, 'check', 'catalog should be sorted alphabetically');

    const primary = buildPrimaryCommands(catalog);
    assert.strictEqual(primary[0].name, 'check', 'primary ordering should prioritize check');
    assert.strictEqual(primary[1].name, 'recommend', 'primary ordering should prioritize recommend');

    const stateClosed = { paletteOpen: false, query: '', selected: 0 };
    const visibleClosed = getVisibleCommands(stateClosed, catalog, primary);
    assert.deepStrictEqual(
        visibleClosed.map((item) => item.name),
        primary.map((item) => item.name),
        'closed palette should show primary commands'
    );

    const stateOpen = { paletteOpen: true, query: 'sea', selected: 0 };
    const visibleOpen = getVisibleCommands(stateOpen, catalog, primary);
    assert.deepStrictEqual(
        visibleOpen.map((item) => item.name),
        ['search'],
        'open palette should filter commands by query'
    );

    console.log('cli-interactive-panel.test.js: OK');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('cli-interactive-panel.test.js: FAILED');
        console.error(error);
        process.exit(1);
    }
}

module.exports = { run };

