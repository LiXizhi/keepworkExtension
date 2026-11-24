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
// Representative points on the 217 × 840 source photo, outside the center button except OK.
const directionalButtons = [
  { key: 'up', keyboard: 'ArrowUp', x: 108, y: 124 },
  { key: 'down', keyboard: 'ArrowDown', x: 108, y: 257 },
  { key: 'left', keyboard: 'ArrowLeft', x: 39, y: 191 },
  { key: 'right', keyboard: 'ArrowRight', x: 177, y: 191 },
  { key: 'ok', keyboard: 'Enter', x: 108, y: 191 },
];
const browserOptions = { skip: process.env.KEEPWORK_CEF_BROWSER_TESTS !== '1', timeout: 60000 };

// Use the repository's opt-in browser runner and an isolated Tauri status fixture.
async function remoteVoicePage(t, readState, invokeAction = command => assert.fail('Unexpected command: ' + command)) {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: process.env.KEEPWORK_CEF_BROWSER_CHANNEL || 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const js = ts.transpileModule(read('src/remote-voice.ts').toString(), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  await page.exposeFunction('mockInvoke', (command, args) =>
    command === 'remote_voice_status' ? readState() : invokeAction(command, args));
  await page.addInitScript(() => {
    window.fixtureInvoke = (command, args) => {
      if (command === 'remote_voice_enter_demo') {
        window.emitDemoEdge = edge => args.feedback.onmessage(edge);
        return window.mockInvoke(command, {});
      }
      return window.mockInvoke(command, args);
    };
    window.mockListen = async (name, callback) => {
      window.emitRemoteKeys = payload => callback({ payload });
      return () => { delete window.emitRemoteKeys; };
    };
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
      const fixture = 'const exports = {}; const require = name => name === "@tauri-apps/api/event" ? {listen: window.mockListen} : {invoke: window.fixtureInvoke, Channel: class {}};';
      return route.fulfill({ contentType: 'application/javascript', body: fixture + '\n' + js });
    }
    if (!staticFiles[pathname]) return route.abort();
    const [file, contentType] = staticFiles[pathname];
    return route.fulfill({ contentType, body: read(file) });
  });
  return page;
}

test('remote voice actions fit the initial viewport at the native default and minimum size', browserOptions, async t => {
  let state = stopped;
  const page = await remoteVoicePage(t, () => state);
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
        const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        assert.ok(scrollHeight <= viewport.height,
          label + ' should display the default settings on one screen, got height ' + scrollHeight);
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
        const keys = ['power', 'voice', ...directionalButtons.map(button => button.key), 'back', 'volume', 'home', 'menu', 'tv'];
        for (const [index, key] of keys.entries()) {
          const spot = page.locator('.remote-hotspot[data-key="' + key + '"]');
          const before = await spot.evaluate(el => getComputedStyle(el).backgroundColor);
          await page.evaluate(({ key, revision }) => window.emitRemoteKeys({ revision, pressedKeys: [key] }),
            { key, revision: index * 2 + 1 });
          assert.equal(await spot.evaluate(el => el.classList.contains('is-pressed')), true);
          assert.notEqual(await spot.evaluate(el => getComputedStyle(el).backgroundColor), before);
          assert.equal(await page.locator('.remote-hotspot.is-pressed').count(), 1);
          await page.evaluate(revision => window.emitRemoteKeys({ revision, pressedKeys: [] }), index * 2 + 2);
          assert.equal(await spot.evaluate(el => el.classList.contains('is-pressed')), false);
          assert.equal(await spot.evaluate(el => getComputedStyle(el).backgroundColor), before);
        }
        await voiceKey.hover();
        await page.mouse.down();
        assert.equal(await voiceKey.evaluate(el => el.classList.contains('is-pressed')), true);
        await page.mouse.up();
        assert.equal(await voiceKey.evaluate(el => el.classList.contains('is-pressed')), false);
      }
    }
  }
});

test('diagram demo intercepts mouse and keyboard actions until exit', browserOptions, async t => {
  let state = stopped;
  const actions = [];
  const page = await remoteVoicePage(t, () => state, (command, args) => {
    actions.push({ command, args });
    if (command === 'remote_voice_enter_demo') return true;
    if (command === 'remote_voice_set_demo_mode') return args.enabled;
    if (command === 'remote_voice_refresh_devices') return state;
    if (command === 'remote_voice_set_auto_start') {
      state = { ...state, config: { ...state.config, autoStart: args.enabled } };
      return state;
    }
    assert.fail('Unexpected command: ' + command);
  });
  await page.setViewportSize({ width: 940, height: 740 });
  await page.goto('https://remote.test/remote-voice.html');
  await page.locator('#status[data-state="stopped"]').waitFor();

  const toggle = page.locator('#remote-demo-toggle');
  const refresh = page.locator('#refresh-devices');
  const autoStart = page.locator('#auto-start');
  const guide = page.locator('.remote-guide-pane');
  const voice = page.locator('.remote-hotspot[data-key="voice"]');
  const home = page.locator('.remote-hotspot[data-key="home"]');
  const pressed = guide.locator('.remote-hotspot.is-pressed');
  const pressedKeys = () => pressed.evaluateAll(elements => elements.map(element => element.dataset.key).sort());
  const background = spot => spot.evaluate(element => getComputedStyle(element).backgroundColor);
  const [refreshBox, checkboxBox] = await Promise.all([refresh.boundingBox(), autoStart.boundingBox()]);
  const mouseClick = box => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await page.evaluate(() => {
    window.voiceClicks = 0;
    document.querySelector('.hotspot-voice').addEventListener('click', () => window.voiceClicks++);
  });

  await toggle.click();
  await page.locator('.remote-guide-pane[data-demo]').waitFor();
  assert.equal(await toggle.innerText(), '退出演示');
  assert.equal(await page.locator('.voice-controls-pane').evaluate(element => element.inert), true);
  await mouseClick(refreshBox);
  await mouseClick(checkboxBox);
  await refresh.evaluate(element => element.focus());
  assert.equal(await refresh.evaluate(element => element === document.activeElement), false);
  assert.equal(await autoStart.isChecked(), false);
  assert.deepEqual(actions, [{ command: 'remote_voice_enter_demo', args: {} }]);
  await page.evaluate(() => window.emitDemoEdge({ key: 'volume', pressed: true }));
  assert.deepEqual(await pressedKeys(), ['volume']);
  await page.evaluate(() => window.emitDemoEdge({ key: 'volume', pressed: false }));
  assert.deepEqual(await pressedKeys(), []);

  const hotspotAt = point => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)
    ?.closest('.remote-hotspot')?.dataset.key, point);
  for (const viewport of [{ width: 940, height: 740 }, { width: 680, height: 520 }]) {
    await page.setViewportSize(viewport);
    const photo = await page.locator('.remote-photo').boundingBox();
    const pointOnPhoto = (x, y) => ({ x: photo.x + x * photo.width / 217, y: photo.y + y * photo.height / 840 });
    assert.equal(await hotspotAt(pointOnPhoto(29, 117)), undefined, 'the ring leaves its outer corners unmarked');
    for (const { key, x, y } of directionalButtons) {
      const pointer = pointOnPhoto(x, y);
      assert.equal(await hotspotAt(pointer), key, 'hit testing at ' + viewport.width + ' px');
      await page.mouse.move(pointer.x, pointer.y);
      await page.mouse.down();
      assert.deepEqual(await pressedKeys(), [key]);
      await page.mouse.up();
      assert.deepEqual(await pressedKeys(), []);
    }
  }
  await page.setViewportSize({ width: 940, height: 740 });

  await guide.focus();
  for (const { key, keyboard } of directionalButtons) {
    await page.keyboard.down(keyboard);
    assert.deepEqual(await pressedKeys(), [key]);
    await page.keyboard.up(keyboard);
    assert.deepEqual(await pressedKeys(), []);
  }
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('Enter');
  assert.deepEqual(await pressedKeys(), ['ok', 'up']);
  await page.keyboard.up('ArrowUp');
  assert.deepEqual(await pressedKeys(), ['ok']);
  await page.keyboard.up('Enter');
  assert.deepEqual(await pressedKeys(), []);

  await page.evaluate(() => window.emitRemoteKeys({ revision: 1, pressedKeys: ['down', 'ok'] }));
  await page.keyboard.down('ArrowDown');
  await page.evaluate(() => window.emitRemoteKeys({ revision: 2, pressedKeys: ['ok'] }));
  assert.deepEqual(await pressedKeys(), ['down', 'ok']);
  await page.keyboard.up('ArrowDown');
  assert.deepEqual(await pressedKeys(), ['ok']);
  await page.evaluate(() => window.emitRemoteKeys({ revision: 3, pressedKeys: [] }));
  assert.deepEqual(await pressedKeys(), []);

  await voice.hover();
  const releasedVoice = await background(voice);
  await page.mouse.down();
  assert.equal(await voice.getAttribute('aria-pressed'), 'true');
  assert.equal(await pressed.count(), 1);
  assert.notEqual(await background(voice), releasedVoice);
  await page.mouse.up();
  assert.equal(await voice.getAttribute('aria-pressed'), 'false');
  assert.equal(await background(voice), releasedVoice);

  await voice.focus();
  for (const key of ['Enter', 'Space']) {
    const before = await background(voice);
    await page.keyboard.down(key);
    assert.equal(await voice.getAttribute('aria-pressed'), 'true');
    assert.equal(await pressed.count(), 1);
    assert.notEqual(await background(voice), before);
    await page.keyboard.up(key);
    assert.equal(await voice.getAttribute('aria-pressed'), 'false');
    assert.equal(await background(voice), before);
  }
  assert.equal(await page.evaluate(() => window.voiceClicks), 0);

  await page.evaluate(() => window.emitRemoteKeys({ revision: 4, pressedKeys: ['home'] }));
  assert.equal(await home.getAttribute('aria-pressed'), 'true');
  assert.equal(await pressed.count(), 1);
  await page.evaluate(() => window.emitRemoteKeys({ revision: 5, pressedKeys: [] }));
  assert.equal(await pressed.count(), 0);

  await page.mouse.down();
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowDown');
  assert.deepEqual(await pressedKeys(), ['down', 'voice']);
  await page.keyboard.press('Escape');
  await page.locator('.remote-guide-pane[data-demo]').waitFor({ state: 'detached' });
  assert.equal(await toggle.innerText(), '进入演示');
  await page.keyboard.up('Space');
  await page.keyboard.up('ArrowDown');
  await page.mouse.up();
  assert.equal(await pressed.count(), 0);
  assert.equal(await page.evaluate(() => window.voiceClicks), 0);
  assert.equal(await page.locator('.voice-controls-pane').evaluate(element => element.inert), false);

  await mouseClick(refreshBox);
  await page.locator('#refresh-devices:enabled').waitFor();
  await autoStart.focus();
  await page.keyboard.press('Space');
  await page.locator('#auto-start:checked').waitFor();
  await voice.click();
  assert.equal(await page.evaluate(() => window.voiceClicks), 1);

  await toggle.click();
  await page.locator('.remote-guide-pane[data-demo]').waitFor();
  await toggle.click();
  await page.locator('.remote-guide-pane[data-demo]').waitFor({ state: 'detached' });
  assert.deepEqual(actions, [
    { command: 'remote_voice_enter_demo', args: {} },
    { command: 'remote_voice_set_demo_mode', args: { enabled: false } },
    { command: 'remote_voice_refresh_devices', args: {} },
    { command: 'remote_voice_set_auto_start', args: { enabled: true } },
    { command: 'remote_voice_enter_demo', args: {} },
    { command: 'remote_voice_set_demo_mode', args: { enabled: false } },
  ]);
});
