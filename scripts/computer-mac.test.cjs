require('./computer.test.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeMac, macActionScript } = require('../src/core/computerMac.ts');
const { ComputerController } = require('../src/core/computer.ts');
const fs = require('node:fs/promises');
const path = require('node:path');

test('Mac capture normalizes dimensions and cleans temporary files', async () => {
    let image;
    const output = JSON.parse(await executeMac({ action: 'screenshot' }, 'owner', async (file, args) => {
        if (args.includes('JavaScript')) return '{"width":1440,"height":900}';
        if (file === '/usr/sbin/screencapture') {
            image = args.at(-1);
            await fs.writeFile(image, Buffer.from('mock jpeg'));
        }
        if (file === '/usr/bin/sips') assert.deepEqual(args, ['-z', '900', '1440', image]);
        return '';
    }));
    assert.equal(output.width, 1440);
    assert.equal(output.height, 900);
    assert.equal(output.data, Buffer.from('mock jpeg').toString('base64'));
    await assert.rejects(fs.stat(path.dirname(image)), { code: 'ENOENT' });
});

test('Mac status exposes experimental limits without invoking commands', async () => {
    const controller = new ComputerController('darwin', () => { throw Error('must not execute'); });
    const result = JSON.parse((await controller.run({ action: 'status' })).content[0].text);
    assert.equal(result.supported, true);
    assert.equal(result.experimental, true);
    assert.match(result.permission, /EVERY action/);
});

test('unsupported Mac input fails before any command or approval', async () => {
    for (const args of [{ action: 'scroll', delta: 120 }, { action: 'click', x: 1, y: 2, button: 'right' }]) {
        await assert.rejects(executeMac(args, 'owner', () => { throw Error('must not run'); }), /does not support/);
    }
});

test('Mac bounds checked before approval and user text remains an argument', async () => {
    await assert.rejects(executeMac({ action: 'click', x: 1440, y: 1, button: 'left' }, 'owner', async () => '{"width":1440,"height":900}'), /outside/);
    const text = '" & do shell script "bad"';
    let calls = 0;
    await assert.rejects(executeMac({ action: 'type', text }, 'owner', async (file, args) => {
        if (++calls === 1) return '{"width":1440,"height":900}';
        assert.equal(args[1], macActionScript);
        assert.deepEqual(args.slice(2), ['--', 'type', text]);
        throw Error('consent denied');
    }), /consent denied/);
    assert.equal(calls, 2);
    assert.match(macActionScript, /default button "Cancel"/);
    assert.match(macActionScript, /giving up after 20/);
});