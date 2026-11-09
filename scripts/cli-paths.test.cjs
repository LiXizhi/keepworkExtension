const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function load(name) {
    const file = path.resolve(__dirname, '../src/core', name + '.ts');
    const m = new Module(file, module);
    m.filename = file; m.paths = module.paths;
    m.require = id => {
        if (id.startsWith('./')) {
            const base = path.basename(id).replace(/\.ts$/, '');
            const target = path.resolve(__dirname, '../src/core', base + '.ts');
            if (fs.existsSync(target)) return load(base);
        }
        return require(id);
    };
    m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, file);
    return m.exports;
}

function withHome(t, setup) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-cli-'));
    const saved = { HOME: process.env.HOME, PATH: process.env.PATH, KEEPWORK_DWS_PATH: process.env.KEEPWORK_DWS_PATH, KEEPWORK_LARK_PATH: process.env.KEEPWORK_LARK_PATH };
    process.env.HOME = home;
    process.env.PATH = '/usr/bin:/bin';
    delete process.env.KEEPWORK_DWS_PATH;
    delete process.env.KEEPWORK_LARK_PATH;
    t.after(() => {
        for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
        fs.rmSync(home, { recursive: true, force: true });
    });
    setup(home);
    return home;
}

function touchExecutable(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, 0o755);
}

test('resolveDws finds a version-manager global bin when the daemon PATH is minimal', t => {
    withHome(t, home => touchExecutable(path.join(home, '.nvm/versions/node/v22.23.2/bin/dws')));
    assert.match(load('messagingDingtalk').resolveDws(), /\.nvm\/versions\/node\/v22\.23\.2\/bin\/dws$/);
});

test('resolveDws falls back to an npm global package vendor binary', t => {
    withHome(t, home => touchExecutable(path.join(home, '.npm-global/lib/node_modules/dingtalk-workspace-cli/vendor/dws')));
    assert.match(load('messagingDingtalk').resolveDws(), /dingtalk-workspace-cli\/vendor\/dws$/);
});

test('resolveLark finds a version-manager global bin when the daemon PATH is minimal', t => {
    withHome(t, home => touchExecutable(path.join(home, '.nvm/versions/node/v22.23.2/bin/lark-cli')));
    assert.match(load('messagingFeishu').resolveLark(), /\.nvm\/versions\/node\/v22\.23\.2\/bin\/lark-cli$/);
});

test('resolveLark falls back to a global node_modules package bin', t => {
    withHome(t, home => touchExecutable(path.join(home, '.npm-global/lib/node_modules/@larksuite/cli/bin/lark-cli')));
    assert.match(load('messagingFeishu').resolveLark(), /@larksuite\/cli\/bin\/lark-cli$/);
});

test('explains how to fix a missing CLI when no install exists', t => {
    withHome(t, () => {});
    assert.throws(() => load('messagingDingtalk').resolveDws(), /KEEPWORK_DWS_PATH/);
    assert.throws(() => load('messagingFeishu').resolveLark(), /@larksuite\/cli/);
});

test('child processes get the runtime node dir and global bins on PATH', t => {
    withHome(t, home => touchExecutable(path.join(home, '.nvm/versions/node/v22.23.2/bin/dws')));
    const env = load('cliPaths').cliChildEnv();
    const key = process.platform === 'win32' ? 'Path' : 'PATH';
    const dirs = env[key].split(path.delimiter);
    assert.equal(dirs[0], path.dirname(process.execPath), 'npm CLI shims need a node on PATH');
    assert.ok(dirs.includes(path.join(os.homedir(), '.nvm/versions/node/v22.23.2/bin')));
});
