const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function load(name, runtime) {
    const file = path.resolve(__dirname, '../src/core', name + '.ts');
    const m = new Module(file, module);
    m.filename = file; m.paths = module.paths;
    m.require = id => {
        if (id === 'node:os') return { ...os, homedir: () => runtime.home };
        if (id === 'node:fs') return runtime.fs;
        if (id.startsWith('./')) {
            const base = path.basename(id).replace(/\.ts$/, '');
            const target = path.resolve(__dirname, '../src/core', base + '.ts');
            if (fs.existsSync(target)) return load(base, runtime);
        }
        return require(id);
    };
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('exports', 'require', 'module', '__filename', '__dirname', 'process', output)(
        m.exports, m.require, m, file, path.dirname(file), runtime.process,
    );
    return m.exports;
}

// Real isolated install trees, with the target platform injected. Filesystem
// paths use the host API so both Windows and POSIX branches run on every host.
function fixture(t, platform = 'darwin') {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-cli-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const inside = file => typeof file === 'string' && (file === home || file.startsWith(home + path.sep));
    const checked = file => { if (!inside(file)) throw Object.assign(Error('Outside fixture'), { code: 'ENOENT' }); };
    const env = { PATH: '' };
    const runtime = {
        home,
        process: { platform, env, execPath: path.join(home, 'runtime', platform === 'win32' ? 'node.exe' : 'node') },
        fs: { ...fs,
            existsSync: file => inside(file) && fs.existsSync(file),
            statSync: file => { checked(file); return fs.statSync(file); },
            readdirSync: file => { checked(file); return fs.readdirSync(file); },
        },
    };
    return {
        home, env,
        binary: platform === 'win32' ? 'dws.exe' : 'dws',
        load: name => load(name, runtime),
        install(relative) { const file = path.join(home, relative); touchExecutable(file); return file; },
        mkdir(relative) { const dir = path.join(home, relative); fs.mkdirSync(dir, { recursive: true }); return dir; },
    };
}

function touchExecutable(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, 0o755);
}

test('resolveDws finds a version-manager global bin when the daemon PATH is minimal', t => {
    const f = fixture(t), expected = f.install('.nvm/versions/node/v22.23.2/bin/dws');
    assert.equal(f.load('messagingDingtalk').resolveDws(), expected);
});

test('resolveDws falls back to an npm global package vendor binary', t => {
    const f = fixture(t), expected = f.install('.npm-global/lib/node_modules/dingtalk-workspace-cli/vendor/dws');
    assert.equal(f.load('messagingDingtalk').resolveDws(), expected);
});

test('resolveLark finds a version-manager global bin when the daemon PATH is minimal', t => {
    const f = fixture(t), expected = f.install('.nvm/versions/node/v22.23.2/bin/lark-cli');
    assert.equal(f.load('messagingFeishu').resolveLark(), expected);
});

test('resolveLark falls back to a global node_modules package bin', t => {
    const f = fixture(t), expected = f.install('.npm-global/lib/node_modules/@larksuite/cli/bin/lark-cli');
    assert.equal(f.load('messagingFeishu').resolveLark(), expected);
});

test('explains how to fix a missing CLI when no install exists', t => {
    const f = fixture(t);
    assert.throws(() => f.load('messagingDingtalk').resolveDws(), /KEEPWORK_DWS_PATH/);
    assert.throws(() => f.load('messagingFeishu').resolveLark(), /@larksuite\/cli/);
});

test('child processes get the runtime node dir and global bins on PATH', t => {
    const f = fixture(t);
    f.install('.nvm/versions/node/v22.23.2/bin/dws');
    const dirs = f.load('cliPaths').cliChildEnv().PATH.split(path.delimiter);
    assert.equal(dirs[0], path.join(f.home, 'runtime'), 'npm CLI shims need a node on PATH');
    assert.ok(dirs.includes(path.join(f.home, '.nvm/versions/node/v22.23.2/bin')));
});

for (const key of ['PATH', 'Path']) {
    test(`resolveDws finds the native Windows vendor beside an npm shim on ${key}`, t => {
        const f = fixture(t, 'win32'), prefix = f.mkdir('custom npm prefix');
        f.env[key] = prefix;
        f.install('custom npm prefix/dws.cmd');
        const expected = f.install('custom npm prefix/node_modules/dingtalk-workspace-cli/vendor/dws.exe');
        assert.equal(f.load('messagingDingtalk').resolveDws(), expected);
    });
}

test('resolveDws finds the POSIX vendor under a custom PATH prefix lib directory', t => {
    const f = fixture(t);
    f.env.PATH = f.mkdir('custom-prefix/bin');
    f.install('custom-prefix/bin/dws.cmd');
    const expected = f.install('custom-prefix/lib/node_modules/dingtalk-workspace-cli/vendor/dws');
    assert.equal(f.load('messagingDingtalk').resolveDws(), expected);
});

for (const platform of ['win32', 'darwin']) {
    for (const key of ['npm_config_prefix', 'NPM_CONFIG_PREFIX']) {
        test(`resolveDws finds ${platform} ${key} installs absent from PATH`, t => {
            const f = fixture(t, platform);
            f.env[key] = f.mkdir('configured npm prefix');
            f.mkdir(platform === 'win32' ? 'configured npm prefix' : 'configured npm prefix/bin');
            const expected = f.install(`configured npm prefix/${platform === 'win32' ? '' : 'lib/'}node_modules/dingtalk-workspace-cli/vendor/${f.binary}`);
            assert.equal(f.load('messagingDingtalk').resolveDws(), expected);
            const child = f.load('cliPaths').cliChildEnv();
            const dirs = child[platform === 'win32' ? 'Path' : 'PATH'].split(path.delimiter);
            assert.ok(dirs.includes(path.join(f.env[key], platform === 'win32' ? '' : 'bin')));
        });
    }

    test(`resolveDws preserves override and direct PATH precedence on ${platform}`, t => {
        const f = fixture(t, platform), prefix = f.mkdir('npm-prefix');
        f.env.PATH = [f.mkdir('first'), f.mkdir('second'), prefix].join(path.delimiter);
        f.env.KEEPWORK_DWS_PATH = f.install(`override/${f.binary}`);
        const direct = f.install(`first/${f.binary}`);
        f.install(`second/${f.binary}`);
        f.install(`npm-prefix/node_modules/dingtalk-workspace-cli/vendor/${f.binary}`);
        const { resolveDws } = f.load('messagingDingtalk');
        assert.equal(resolveDws(), f.env.KEEPWORK_DWS_PATH);
        delete f.env.KEEPWORK_DWS_PATH;
        assert.equal(resolveDws(), direct);
        fs.unlinkSync(direct);
        assert.equal(resolveDws(), path.join(f.home, 'second', f.binary));
    });

    test(`resolveDws discovers a newly installed ${platform} vendor on immediate retry`, t => {
        const f = fixture(t, platform);
        f.env.PATH = f.mkdir('install-later');
        const { resolveDws } = f.load('messagingDingtalk');
        assert.throws(() => resolveDws(), /DWS CLI unavailable/);
        f.install('install-later/dws.cmd');
        const expected = f.install(`install-later/node_modules/dingtalk-workspace-cli/vendor/${f.binary}`);
        assert.equal(resolveDws(), expected);
    });
}

test('resolveDws does not treat a Windows command shim as a native executable', t => {
    const f = fixture(t, 'win32');
    f.env.PATH = f.mkdir('shim-only');
    f.install('shim-only/dws.cmd');
    f.install('shim-only/dws.ps1');
    assert.throws(() => f.load('messagingDingtalk').resolveDws(), /DWS CLI unavailable/);
});

test('resolveLark keeps finding a native Windows global npm package binary', t => {
    const f = fixture(t, 'win32');
    f.env.APPDATA = f.mkdir('AppData/Roaming');
    const expected = f.install('AppData/Roaming/npm/node_modules/@larksuite/cli/bin/lark-cli.exe');
    assert.equal(f.load('messagingFeishu').resolveLark(), expected);
});
