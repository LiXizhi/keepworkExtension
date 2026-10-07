const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file);
const { AGENT_CLI, AGENT_BACKENDS } = require('../src/core/agentCliBackends.ts');
const { resolveAgentCli, cliCommand } = require('../src/core/agentCliProcess.ts');

test('Windows official Cursor PowerShell wrapper resolves the newest complete bundled Node package without a shell', t => {
    const { home, options, put } = fixture(t, 'win32');
    options.env.LOCALAPPDATA = path.join(home, 'Local');
    const wrapper = put('Local/cursor-agent/cursor-agent.ps1', '# official wrapper; never execute during discovery');
    const cmd = put('Local/cursor-agent/agent.cmd', 'powershell -File cursor-agent.ps1 %*');
    put('Local/cursor-agent/versions/2026.9.30-abc/node.exe');
    put('Local/cursor-agent/versions/2026.9.30-abc/index.js');
    const node = put('Local/cursor-agent/versions/2026.10.1-10-12-30-def/node.exe');
    const entry = put('Local/cursor-agent/versions/2026.10.1-10-12-30-def/index.js');
    put('Local/cursor-agent/versions/2026.10.2-aaa/index.js');
    put('Local/cursor-agent/versions/untrusted/index.js');
    const args = ['acp', 'text $() & spaces'];
    assert.deepEqual(resolveAgentCli('cursor', args, undefined, options), { executable: node, args: [entry, ...args], path: entry, source: 'common' });
    for (const configured of [wrapper, cmd]) assert.deepEqual(resolveAgentCli('cursor', args, configured, options), { executable: node, args: [entry, ...args], path: entry, source: 'configured' });
    options.pathDirs = [path.dirname(cmd)];
    assert.equal(resolveAgentCli('cursor', args, undefined, options).source, 'PATH');
    fs.unlinkSync(entry);
    assert.match(resolveAgentCli('cursor', args, undefined, options).path, /2026\.9\.30-abc/);
});
function fixture(t, platform) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli discovery '));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const options = { home, platform, env: {}, systemDirs: [], applicationDirs: [path.join(home, 'Applications')] };
    const put = (rel, content = '') => { const target = path.join(home, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, { mode: 0o755 }); return target; };
    return { home, options, put };
}
for (const platform of ['win32', 'darwin']) {
    for (const backend of AGENT_BACKENDS) test(`${platform}: ${backend} discovery preserves PATH priority and explicit configuration`, t => {
        const { home, options, put } = fixture(t, platform);
        const name = AGENT_CLI[backend].commands[0], suffix = platform === 'win32' ? '.exe' : '';
        const common = put(`.local/bin/${name}${suffix}`), first = put(`first/${name}${suffix}`), second = put(`second/${name}${suffix}`);
        const args = ['--acp', 'text $() & spaces'];
        assert.equal(resolveAgentCli(backend, args, undefined, options).path, common);
        options.pathDirs = [path.join(home, 'first'), path.join(home, 'second')];
        assert.deepEqual(resolveAgentCli(backend, args, undefined, options), { executable: first, args, path: first, source: 'PATH' });
        options.env[`KEEPWORK_${backend.toUpperCase()}_PATH`] = second;
        assert.equal(resolveAgentCli(backend, args, undefined, options).path, second);
        assert.equal(resolveAgentCli(backend, args, first, options).path, first);
        assert.throws(() => resolveAgentCli(backend, args, path.join(home, 'absent'), options), /Configured.*not found/);
    });
}
test('Windows discovers extensionless npm CodeBuddy shim with shell-free Node arguments', t => {
    const { home, options, put } = fixture(t, 'win32');
    const prefix = path.join(home, 'Roaming', 'npm'); options.env.APPDATA = path.join(home, 'Roaming');
    const script = put('Roaming/npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy', '#!/usr/bin/env node\n');
    put('Roaming/npm/node.exe');
    put('Roaming/npm/codebuddy.cmd', 'IF EXIST "%dp0%\\node.exe" (\nSET "_prog=%dp0%\\node.exe"\n)\n"%_prog%" "%dp0%\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*');
    const args = ['--acp', '& never execute'];
    const command = resolveAgentCli('workbuddy', args, undefined, options);
    assert.equal(command.source, 'common'); assert.equal(command.path, script);
    assert.deepEqual(command.args, [script, ...args]); assert.equal(command.executable, process.execPath);
    put('Roaming/npm/workbuddy.cmd', 'node "%~dp0workbuddy-cli.cjs" %*');
    const wrapper = put('Roaming/npm/workbuddy-cli.cjs', '// wrapper');
    assert.deepEqual(cliCommand(path.join(prefix, 'workbuddy.cmd'), args, 'win32'), { executable: process.execPath, args: [wrapper, ...args] });
    put('Roaming/npm/copilot.cmd', '"%dp0%\\..\\outside.js" %*'); put('Roaming/outside.js');
    assert.throws(() => cliCommand(path.join(prefix, 'copilot.cmd'), args, 'win32'), /not a shell launcher/);
});
test('npm packages without PATH shims and extensionless desktop WorkBuddy entries use Node', t => {
    const { options, put } = fixture(t, 'darwin');
    const script = put('.npm-global/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy', '#!/usr/bin/env node\n');
    assert.equal(resolveAgentCli('workbuddy', ['--acp'], undefined, options).path, script);
    fs.unlinkSync(script);
    const desktop = put('Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy', '#!/usr/bin/env node\n');
    const launch = resolveAgentCli('workbuddy', ['--acp'], undefined, options);
    assert.equal(launch.source, 'desktop'); assert.equal(launch.executable, process.execPath); assert.deepEqual(launch.args, [desktop, '--acp']);
});
test('npm package declared Copilot entry works without a shim and stays inside its package', t => {
    const { options, put } = fixture(t, 'darwin');
    put('.npm-global/lib/node_modules/@github/copilot/package.json', JSON.stringify({ bin: { copilot: './index.js' } }));
    const entry = put('.npm-global/lib/node_modules/@github/copilot/index.js');
    assert.equal(resolveAgentCli('copilot', [], undefined, options).path, entry);
    put('.npm-global/lib/node_modules/@github/copilot/package.json', JSON.stringify({ bin: { copilot: '../outside.js' } }));
    put('.npm-global/lib/node_modules/@github/outside.js');
    assert.throws(() => resolveAgentCli('copilot', [], undefined, options), /CLI not found/);
});
test('Windows desktop Codex selects newest installed version; WorkBuddy desktop is a fallback', t => {
    const { home, options, put } = fixture(t, 'win32');
    options.env.LOCALAPPDATA = path.join(home, 'Local');
    const old = put('Local/OpenAI/Codex/bin/old/codex.exe'), recent = put('Local/OpenAI/Codex/bin/new/codex.exe');
    fs.utimesSync(old, new Date(1000), new Date(1000));
    assert.equal(resolveAgentCli('codex', [], undefined, options).path, recent);
    const desktop = put('Applications/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy', '#!/usr/bin/env node\n');
    assert.equal(resolveAgentCli('workbuddy', [], undefined, options).path, desktop);
    const official = put('.local/bin/codebuddy.exe');
    assert.equal(resolveAgentCli('workbuddy', [], undefined, options).path, official);
});
test('macOS discovers Homebrew, NVM and desktop Codex despite a GUI app PATH', t => {
    const { home, options, put } = fixture(t, 'darwin');
    const brew = put('homebrew/bin/copilot'); options.systemDirs = [path.join(home, 'homebrew/bin')];
    assert.equal(resolveAgentCli('copilot', [], undefined, options).path, brew);
    const nvm = put('.nvm/versions/node/v24.1.0/bin/codebuddy', '#!/usr/bin/env node\n');
    assert.equal(resolveAgentCli('workbuddy', [], undefined, options).path, nvm);
    const desktop = put('Applications/Codex.app/Contents/Resources/codex');
    assert.equal(resolveAgentCli('codex', [], undefined, options).path, desktop);
});
test('missing CLIs produce actionable errors and directories are not treated as executables', t => {
    const { home, options } = fixture(t, 'darwin');
    fs.mkdirSync(path.join(home, '.local/bin/copilot'), { recursive: true });
    assert.throws(() => resolveAgentCli('copilot', [], undefined, options), /CLI not found.*KEEPWORK_COPILOT_PATH/);
});

test('Windows official Cursor and Trae installation directories work without PATH', t => {
    const { home, options, put } = fixture(t, 'win32');
    options.env.LOCALAPPDATA = path.join(home, 'Local');
    const cursor = put('Local/cursor-agent/cursor-agent.exe');
    assert.equal(resolveAgentCli('cursor', ['acp'], undefined, options).path, cursor);
    const trae = put('Local/Programs/TraeCLI/bin/traex.exe');
    const shim = put('Local/Programs/TraeCLI/bin/traecli.cmd', '@echo off\r\n"%~dp0traex.exe" %*\r\n');
    assert.deepEqual(resolveAgentCli('trae', ['acp', 'serve'], undefined, options), { executable: trae, args: ['acp', 'serve'], path: trae, source: 'common' });
    assert.equal(resolveAgentCli('trae', [], shim, options).path, trae);
    put('Local/Programs/TraeCLI/bin/unsafe.cmd', '@echo off\r\n"%~dp0traex.exe" %*\r\necho extra');
    assert.throws(() => cliCommand(path.join(path.dirname(shim), 'unsafe.cmd'), [], 'win32'), /not a shell launcher/);
    fs.unlinkSync(trae);
    options.env.TRAECLI_INSTALL_DIR = path.join(home, 'custom');
    const custom = put('custom/traex.exe');
    assert.equal(resolveAgentCli('trae', [], undefined, options).path, custom);
});
test('a missing CLI can be discovered on a later connection without caching failure or replaying prompts', async t => {
    const { home, put } = fixture(t, process.platform);
    const { AcpHarness } = require('../src/core/acpHarness.ts');
    const target = path.join(home, 'installed-later.cjs');
    const adapter = new AcpHarness('workbuddy', path.join(home, 'cache'), target); t.after(() => adapter.close());
    await assert.rejects(adapter.call('account/read'), /Configured.*not found/);
    put('installed-later.cjs', `require(${JSON.stringify(path.join(__dirname, 'fixtures/fake-acp.cjs'))});`);
    const account = await adapter.call('account/read'); assert.equal(account.authUnknown, true);
    assert.deepEqual(adapter.cliInfo(), { path: target, source: 'configured' });
});
