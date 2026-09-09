require('./computer.test.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeMac, createMacExecutor, macActionScript, macConsentScript, macGuardScript, macClickScript } = require('../src/core/computerMac.ts');
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
    assert.match(result.permission, /session consent/);
});

test('unsupported Mac input fails before any command or approval', async () => {
    for (const args of [{ action: 'scroll', delta: 120 }, { action: 'click', x: 1, y: 2, button: 'right' }]) {
        await assert.rejects(executeMac(args, 'owner', () => { throw Error('must not run'); }), /does not support/);
    }
});

test('Mac bounds checked before approval and user text remains an argument', async () => {
    const executeMac = createMacExecutor();
    await assert.rejects(executeMac({ action: 'click', x: 1440, y: 1, button: 'left' }, 'owner', async () => '{"width":1440,"height":900}'), /outside/);
    const text = '" & do shell script "bad"';
    let calls = 0;
    await assert.rejects(executeMac({ action: 'type', text }, 'owner', async (file, args) => {
        calls++;
        if (args.some(arg => arg.includes('NSScreen'))) return '{"width":1440,"height":900}';
        if (args.includes(macGuardScript) || args.includes(macConsentScript)) return '';
        assert.equal(args[1], macActionScript);
        assert.deepEqual(args.slice(2), ['--', 'type', text]);
        throw Error('consent denied');
    }), /consent denied/);
    assert.equal(calls, 5);
    assert.match(macConsentScript, /default button "Cancel"/);
    assert.match(macConsentScript, /giving up after 20/);
});

function mockDesktop() {
    const calls = [];
    return { calls, run: async (file, args) => {
        calls.push({ file, args });
        if (args.some(arg => arg.includes('NSScreen'))) return '{"width":1440,"height":900}';
        if (file === '/usr/sbin/screencapture') await fs.writeFile(args.at(-1), 'mock jpeg');
        return '';
    } };
}

test('Mac continuous actions approve once; expiry and owner changes renew consent', async () => {
    let clock = 0;
    const execute = createMacExecutor(() => clock);
    const { calls, run } = mockDesktop();
    const approvals = () => calls.filter(call => call.args.includes(macConsentScript)).length;
    await execute({ action: 'screenshot' }, 'one', run);
    await execute({ action: 'click', x: 400, y: 500, button: 'left' }, 'one', run);
    await execute({ action: 'type', text: 'hello' }, 'one', run);
    assert.equal(approvals(), 1);
    assert.equal(calls.filter(call => call.args.includes(macClickScript)).length, 1);
    clock = 24 * 60 * 60 * 1000 - 1;
    await execute({ action: 'screenshot' }, 'one', run);
    assert.equal(approvals(), 1, 'idle time does not shorten the 24-hour grant');
    clock++;
    await execute({ action: 'screenshot' }, 'one', run);
    assert.equal(approvals(), 2, 'grant expires exactly 24 hours after approval');
    await execute({ action: 'screenshot' }, 'two', run);
    assert.equal(approvals(), 3);
    for (let i = 0; i < 24; i++) {
        clock += 60 * 60 * 1000;
        await execute({ action: 'screenshot' }, 'two', run);
    }
    assert.equal(approvals(), 4, 'activity does not extend the 24-hour absolute expiry');
});

test('Mac local stop and capture failure revoke consent without retrying input', async () => {
    const execute = createMacExecutor();
    const { calls, run } = mockDesktop();
    await execute({ action: 'screenshot' }, 'one', run);
    await assert.rejects(execute({ action: 'click', x: 400, y: 500, button: 'left' }, 'one', async (file, args) => {
        if (args.includes(macGuardScript)) throw Error('KEEPWORK_STOP');
        return run(file, args);
    }), /KEEPWORK_STOP/);
    assert.equal(calls.filter(call => call.args.includes(macClickScript)).length, 0);
    await execute({ action: 'screenshot' }, 'one', run);
    await assert.rejects(execute({ action: 'click', x: 400, y: 500, button: 'left' }, 'one', async (file, args) => {
        if (file === '/usr/sbin/screencapture') throw Error('capture failed');
        return run(file, args);
    }), /capture failed/);
    assert.equal(calls.filter(call => call.args.includes(macClickScript)).length, 1);
    await execute({ action: 'screenshot' }, 'one', run);
    assert.equal(calls.filter(call => call.args.includes(macConsentScript)).length, 3);
});

test('Mac denial sends no input and requires fresh approval', async () => {
    const execute = createMacExecutor();
    const { calls, run } = mockDesktop();
    await assert.rejects(execute({ action: 'key', key: 'Tab' }, 'one', async (file, args) => {
        if (args.includes(macConsentScript)) throw Error('denied');
        return run(file, args);
    }), /denied/);
    assert.equal(calls.filter(call => call.args.includes(macActionScript)).length, 0);
    await execute({ action: 'screenshot' }, 'one', run);
    assert.equal(calls.filter(call => call.args.includes(macConsentScript)).length, 1);
});

test('native Mac bridge allocates Quartz events without posting input', { skip: process.platform !== 'darwin' }, () => {
    const { spawnSync } = require('node:child_process');
    // JXA owns bridged CF objects: manually releasing them crashes at teardown.
    const probe = macClickScript.replace(/    \$\.CGEventPost[^\n]+\n/g, '').replace('function run(', 'function probe(') + '\nprobe(["10", "10"]); "ok";';
    const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', probe], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ok');
});
