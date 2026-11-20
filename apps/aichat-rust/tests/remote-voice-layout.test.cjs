const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');

const appRoot = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(appRoot, name));
const devices = ['1', '2'].map(suffix => ({
  id: '12345678-1234-5678-1234-56781234567' + suffix, name: '小米遥控器 2 Pro', connected: true,
}));
const stopped = {
  state: 'stopped', running: false, supported: true, config: { device: '', autoStart: false }, device: '', error: '',
};

// Use the repository's opt-in browser runner and an isolated Tauri status fixture.
test('remote voice actions fit the initial viewport at the native default and minimum size', {
  skip: process.env.KEEPWORK_CEF_BROWSER_TESTS !== '1', timeout: 60000,
}, async t => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: process.env.KEEPWORK_CEF_BROWSER_CHANNEL || 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const js = ts.transpileModule(read('src/remote-voice.ts').toString(), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let state = stopped;
  await page.exposeFunction('mockInvoke', command => {
    assert.equal(command, 'remote_voice_status');
    return state;
  });
  await page.route('https://remote.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const staticFiles = {
      '/remote-voice.html': ['remote-voice.html', 'text/html; charset=utf-8'],
      '/src/typography.css': ['src/typography.css', 'text/css'],
      '/src/remote-voice.css': ['src/remote-voice.css', 'text/css'],
      '/src/assets/remote-control.png': ['src/assets/remote-control.png', 'image/png'],
    };
    if (pathname === '/src/remote-voice.ts') {
      const fixture = 'const exports = {}; const require = () => ({invoke: window.mockInvoke});';
      return route.fulfill({ contentType: 'application/javascript', body: fixture + '\n' + js });
    }
    if (!staticFiles[pathname]) return route.abort();
    const [file, contentType] = staticFiles[pathname];
    return route.fulfill({ contentType, body: read(file) });
  });
  for (const viewport of [{ width: 940, height: 740 }, { width: 680, height: 520 }]) {
    await page.setViewportSize(viewport);
    for (state of [
      stopped,
      { ...stopped, running: true, state: 'ready', devices, device: devices[0].id,
        config: { device: devices[0].id, autoStart: true } },
      { ...stopped, state: 'waiting-selection', devices },
      { ...stopped, state: 'error', error: '请在系统设置中允许输入监控，再重新连接遥控器。', diagnostic: 'Missing: audio' },
    ]) {
      await page.goto('https://remote.test/remote-voice.html');
      await page.locator('#status[data-state="' + state.state + '"]').waitFor();
      const label = viewport.width + '×' + viewport.height + ' ' + state.state;
      const ids = [state.running ? 'begin' : 'start', 'stop', 'auto-start'];
      if (state.state === 'waiting-selection') ids.push('device-picker', 'refresh-devices', 'connect-device');
      for (const id of ids) {
        const box = await page.locator('#' + id).boundingBox();
        assert.ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0
          && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
        label + ' #' + id + ' must be fully visible, got ' + JSON.stringify(box));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        label + ' must not require horizontal scrolling');
      if (state.state !== 'error') {
        assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
          label + ' should display the default settings on one screen');
      }
      if (state === stopped) {
        const card = page.locator('#remote-key-card');
        assert.ok(await card.evaluate(el => el.scrollHeight <= el.clientHeight),
          label + ' should display the full pairing hint');
        const original = await card.innerText();
        const voiceKey = page.locator('.remote-hotspot[data-key="voice"]');
        await voiceKey.focus();
        assert.notEqual(await card.innerText(), original, 'focusing a key reveals its instructions');
        await voiceKey.blur();
        assert.equal(await card.innerText(), original, 'leaving the key restores pairing instructions');
      }
    }
  }
});
