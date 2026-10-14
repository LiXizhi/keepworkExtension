const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { transformSync } = require('esbuild');

function host(platform = 'win32') {
  const calls = [];
  let template;
  const contents = { getURL: () => 'http://127.0.0.1:3002/AIChat.html?dev=true', send: (...args) => calls.push(args), reloadIgnoringCache: () => calls.push('reloadIgnoringCache') };
  const window = { webContents: contents, setMenu() {}, loadURL: async url => calls.push(url) };
  const electron = {
    app: { isPackaged: false, setAppUserModelId() {}, setName(name) { this.name = name; }, commandLine: { hasSwitch: () => true }, requestSingleInstanceLock: () => false, quit() {}, getVersion: () => '0.1.0' },
    Menu: { buildFromTemplate: items => { template = items; return { items }; }, setApplicationMenu() {} },
    dialog: { showErrorBox: (_title, message) => calls.push(message) },
    shell: { openExternal: async url => calls.push(url) },
  };
  const source = transformSync(fs.readFileSync(require.resolve('../src/main.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const context = vm.createContext({ process: { env: { AICHAT_DESKTOP_DEV_URL: 'http://127.0.0.1:3002/AIChat.html' }, platform }, console,
    require: name => {
      if (name === 'electron') return electron;
      if (name === 'electron-updater') return { autoUpdater: {} };
      if (name.includes('terminalSessions')) return { TerminalSessionManager: class {} };
      if (name.startsWith('./')) return require('../src/' + name.slice(2));
      return require(name);
    }, windowFixture: window });
  vm.runInContext(source + '\nwin = windowFixture; runtime = { state: { state: "running", owner: "desktop" } };', context);
  return { context, calls, app: electron.app, menu: () => { vm.runInContext('menu()', context); return template; } };
}

test('desktop menus are File Edit View Help and expose a serializable page payload', async () => {
  const h = host();
  const bar = h.menu().filter(item => ['File', 'Edit', 'View', 'Help'].includes(item.label));
  assert.equal(JSON.stringify(bar.map(item => item.label)), JSON.stringify(['File', 'Edit', 'View', 'Help']));
  assert.equal(JSON.stringify(bar[0].submenu.map(item => item.label).filter(Boolean)), JSON.stringify(['新对话', '打开文件夹…', '重新加载', '检查更新', '登录后自动启动', '退出']));
  const help = bar[3].submenu;
  help.find(item => item.label === '打开 Dashboard').click();
  assert.deepEqual(h.calls, ['http://127.0.0.1:8089/dashboard']);
  bar[0].submenu.find(item => item.label === '重新加载').click();
  assert.equal(h.calls.at(-1), 'reloadIgnoringCache');
  help.find(item => item.label === '使用线上服务器').click();
  assert.equal(h.calls.at(-1), 'https://keepwork.com/chat');
  const payload = vm.runInContext('menuPayload("view")', h.context);
  assert.equal(payload.label, 'View');
  assert.equal(JSON.stringify(payload.items.filter(item => item.id).map(item => item.id)), JSON.stringify(['experience-simple', 'experience-professional', 'theme-light', 'theme-dark', 'toggle-sidebar', 'toggle-files', 'zoom-in', 'zoom-out', 'zoom-reset', 'fullscreen', 'open-settings']));
  for (const item of payload.items) assert.equal(typeof item.click, 'undefined');
  assert.throws(() => vm.runInContext('menuPayload("nope")', h.context), /Invalid menu/);
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

test('macOS native menus dispatch page commands and preserve native editing roles', () => {
  const h = host('darwin');
  const bar = h.menu();
  assert.equal(h.app.name, 'Keepwork');
  assert.equal(bar[0].label, 'Keepwork');
  const config = require('../electron-builder.config.cjs');
  assert.equal(config.mac.extendInfo.CFBundleName, 'Keepwork');
  assert.equal(config.mac.extendInfo.CFBundleDisplayName, 'Keepwork');
  bar.find(item => item.label === 'File').submenu.find(item => item.label === '新对话').click();
  assert.deepEqual(h.calls, [['aichat-desktop:page-command', 'new-chat']]);
  assert.ok(bar.find(item => item.label === 'Edit').submenu.some(item => item.role === 'copy'));
});

async function titlebar(platform) {
  const nodes = [], events = {}, ipc = {}, posts = [], calls = [];
  function element(tag) {
    const node = { tag, children: [], attributes: {}, handlers: {}, style: { setProperty() {} },
      append(...children) { this.children.push(...children); },
      attachShadow() { return element('shadow'); },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(key, handler) { this.handlers[key] = handler; },
      getBoundingClientRect() { return { left: 10, bottom: 34 }; },
      getContext() { return { clearRect() {}, fillRect() {}, getImageData() { return { data: [0, 0, 0, 255] }; } }; },
    };
    nodes.push(node); return node;
  }
  const document = { createElement: element, head: element('head'), documentElement: element('html'),
    body: { classList: { contains: () => false }, dataset: {} }, addEventListener() {} };
  const window = { location: { origin: 'https://keepwork.com' },
    addEventListener: (key, handler) => { events[key] = handler; }, postMessage: (...args) => posts.push(args) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/preload.cjs'), 'utf8'), {
    process: { isMainFrame: true }, document, window,
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '', color: '#000000', backgroundColor: '#ffffff' }),
    require: () => ({ contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {
      on: (key, handler) => { ipc[key] = handler; },
      invoke: async (_channel, method, args) => { calls.push(method); return method === 'titlebar' ? { platform, address: 'keepwork.com/chat' } : { id: args?.id, items: [] }; },
    } }),
  });
  await events.DOMContentLoaded();
  return { nodes, ipc, posts, calls };
}

for (const platform of ['darwin', 'win32']) test(`${platform} titlebar has only platform-appropriate menus and working controls`, async () => {
  const h = await titlebar(platform);
  const menus = h.nodes.filter(node => node.attributes['aria-haspopup'] === 'menu');
  assert.deepEqual(menus.map(node => node.textContent), platform === 'darwin' ? [] : ['File', 'Edit', 'View', 'Help']);
  assert.ok(h.nodes.find(node => node.tag === 'html').children.some(node => node.id === 'keepwork-desktop-titlebar'));
  h.nodes.find(node => node.className === 'refresh').handlers.click();
  assert.ok(h.calls.includes('reloadPage'));
  h.ipc['aichat-desktop:page-command']({}, 'new-chat');
  assert.equal(h.posts.at(-1)[0].id, 'new-chat');
  if (menus.length) {
    await menus[0].handlers.click();
    assert.equal(h.posts.at(-1)[0].type, 'show');
    assert.equal(h.posts.at(-1)[0].menu.id, 'file');
  }
});
