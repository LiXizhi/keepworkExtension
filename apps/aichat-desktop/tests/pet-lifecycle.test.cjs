const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { transformSync } = require('esbuild');

test('tray can show a hidden pet even while the main window is visible', () => {
  const source = fs.readFileSync(require.resolve('../src/main.ts'), 'utf8');
  const start = source.indexOf("settings.petVisible = item.checked; atomicJson(settingsFile, settings);");
  const end = source.indexOf('menu();', start) + 'menu();'.length;
  assert.ok(start >= 0 && end > start);
  for (const mainVisible of [true, false]) {
    let shown = false, saved, refreshed = 0;
    const context = vm.createContext({
      item: { checked: false }, settings: { petVisible: true }, settingsFile: 'fixture',
      atomicJson: (_file, settings) => { saved = settings.petVisible; },
      floatingPet: { show: () => { shown = true; }, hide: () => { shown = false; } },
      liveWindow: () => ({ isVisible: () => mainVisible }),
      menu: () => { refreshed++; },
    });
    const callback = source.slice(start, end);
    vm.runInContext(callback, context);
    assert.equal(shown, false); assert.equal(saved, false);
    context.item.checked = true;
    vm.runInContext(callback, context);
    assert.equal(shown, true, `pet must reappear with mainVisible=${mainVisible}`);
    assert.equal(saved, true); assert.equal(refreshed, 2);
  }
});
test('closing AIChat keeps its renderer and terminals; reopening restores the same window and mode', async () => {
  const windows = [], calls = [];
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.visible = false; }
    isDestroyed() { return false; } isVisible() { return this.visible; } isMinimized() { return false; } setMenu() {} show() { this.visible = true; } focus() {} hide() { this.visible = false; }
    loadURL() { calls.push('load'); return Promise.resolve(); }
  }
  const source = transformSync(fs.readFileSync(require.resolve('../src/main.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const context = vm.createContext({ console, process: { env: {}, platform: 'darwin' }, __dirname: path.resolve(__dirname, '../src'),
    petFixture: { show: () => calls.push('pet-show'), hide: stop => calls.push(stop ? 'pet-hide-stop-voice' : 'pet-hide') },
    require: name => {
      if (name === 'electron') return { BrowserWindow: Window, app: { isPackaged: false, setName() {}, setAppUserModelId() {}, commandLine: { hasSwitch: () => true }, requestSingleInstanceLock: () => false, quit() {} } };
      if (name === 'electron-updater') return { autoUpdater: {} };
      if (name.includes('terminalSessions')) return { TerminalSessionManager: class { closeAll() { calls.push('terminal-close'); } } };
      if (name === './permissions.cjs') return { installPermissions() {} };
      if (name.startsWith('./')) return require('../src/' + name.slice(2));
      return require(name);
    },
  });
  vm.runInContext(source + '\nfloatingPet = petFixture;', context);
  await vm.runInContext('openWindow()', context); const window = windows[0]; window.marker = { draft: 'draft', mode: 'professional', voice: true };
  let prevented = false; window.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(window.visible, false); assert.equal(calls.at(-1), 'pet-show');
  await vm.runInContext('ensureShown()', context);
  assert.equal(window.visible, true); assert.equal(windows.length, 1); assert.equal(calls.filter(c => c === 'load').length, 1);
  assert.deepEqual(window.marker, { draft: 'draft', mode: 'professional', voice: true }); assert.ok(!calls.includes('terminal-close'));
  vm.runInContext('settings.petVisible = false', context); window.emit('close', { preventDefault() {} });
  assert.equal(calls.at(-1), 'pet-hide-stop-voice');
  vm.runInContext('quitting = true', context); prevented = false;
  window.emit('close', { preventDefault() { prevented = true; } }); assert.equal(prevented, false);
});
