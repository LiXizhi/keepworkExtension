const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { transformSync } = require('esbuild');

function host() {
  const calls = [];
  let template;
  const contents = { getURL: () => 'http://127.0.0.1:3002/AIChat.html?dev=true', reloadIgnoringCache: () => calls.push('reloadIgnoringCache') };
  const window = { webContents: contents, setMenu() {}, loadURL: async url => calls.push(url) };
  const electron = {
    app: { isPackaged: false, setAppUserModelId() {}, commandLine: { hasSwitch: () => true }, requestSingleInstanceLock: () => false, quit() {}, getVersion: () => '0.1.0' },
    Menu: { buildFromTemplate: items => { template = items; return { items }; }, setApplicationMenu() {} },
    dialog: { showErrorBox: (_title, message) => calls.push(message) },
    shell: { openExternal: async url => calls.push(url) },
  };
  const source = transformSync(fs.readFileSync(require.resolve('../src/main.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const context = vm.createContext({ process: { env: { AICHAT_DESKTOP_DEV_URL: 'http://127.0.0.1:3002/AIChat.html' }, platform: 'win32' }, console,
    require: name => {
      if (name === 'electron') return electron;
      if (name === 'electron-updater') return { autoUpdater: {} };
      if (name.includes('terminalSessions')) return { TerminalSessionManager: class {} };
      if (name.startsWith('./')) return require('../src/' + name.slice(2));
      return require(name);
    }, windowFixture: window });
  vm.runInContext(source + '\nwin = windowFixture; runtime = { state: { state: "running", owner: "desktop" } };', context);
  return { context, calls, menu: () => { vm.runInContext('menu()', context); return template; } };
}

test('desktop file menu exposes MCP status, dashboard, restart and local source switch', async () => {
  const h = host();
  const items = h.menu()[0].submenu;
  const mcp = items.find(item => item.label === 'Keepwork MCP Server').submenu;
  assert.deepEqual(Array.from(mcp, item => item.label), ['查看状态…', '打开 Dashboard', '重启 Keepwork MCP Server']);
  mcp[1].click();
  assert.deepEqual(h.calls, ['http://127.0.0.1:8089/dashboard']);
  const server = items.find(item => item.label === 'AIChat 服务器').submenu;
  assert.ok(server.find(item => item.label === '使用本地源码服务器…'));
  server.find(item => item.accelerator === 'CmdOrCtrl+R').click();
  assert.equal(h.calls.at(-1), 'reloadIgnoringCache');
  server.find(item => item.label === '使用线上服务器').click();
  assert.equal(h.calls.at(-1), 'https://keepwork.com/chat');
});

test('MCP restart reloads local development page only after success and reports errors', async () => {
  const h = host();
  vm.runInContext('runtime.restart = async () => {};', h.context);
  await vm.runInContext('mcpAction("restart")', h.context);
  assert.deepEqual(h.calls, ['reloadIgnoringCache']);
  vm.runInContext('runtime.restart = async () => { throw new Error("owned by VS Code"); };', h.context);
  await vm.runInContext('mcpAction("restart")', h.context);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1], /owned by VS Code/);
  assert.equal(vm.runInContext('serviceBusy', h.context), false);
});
