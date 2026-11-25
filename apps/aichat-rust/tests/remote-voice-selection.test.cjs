const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const appRoot = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(appRoot, relative), 'utf8');
const deviceA = { id: '12345678-1234-5678-1234-567812345671', name: '小米遥控器 2 Pro', connected: true };
const deviceB = { id: '12345678-1234-5678-1234-567812345672', name: '小米遥控器 2 Pro', connected: false };
const remoteKeys = ['power', 'voice', 'up', 'down', 'left', 'right', 'ok', 'back', 'volume', 'home', 'menu', 'tv'];
const copy = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
function snapshot(overrides = {}) {
  return {
    supported: true, running: false, state: 'waiting-selection', error: '', device: '',
    config: { device: '', autoStart: true }, devices: [deviceA, deviceB], ...overrides,
  };
}

// Run the actual settings renderer with native-select semantics and a manually
// advanced status timer. No Bluetooth, input hooks, or Tauri application starts.
async function renderer(initial = snapshot(), responses = {}) {
  const elements = new Map();
  const eventListeners = new Map();
  const captureListeners = new Map();
  const windowListeners = new Map();
  const hotspots = [];
  const timers = [];
  const calls = [];
  let current = copy(initial);
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.listeners = new Map();
      this.dataset = {};
      this.classes = new Set();
      this.classList = {
        contains: name => this.classes.has(name),
        toggle: (name, force) => {
          const enabled = force === undefined ? !this.classes.has(name) : !!force;
          if (enabled) this.classes.add(name); else this.classes.delete(name);
          return enabled;
        },
      };
      this.disabled = false;
      this.hidden = false;
      this.checked = false;
      this._value = '';
      this._text = '';
    }
    get value() { return this._value; }
    set value(value) {
      const next = String(value);
      this._value = this.tagName === 'SELECT' && !this.children.some(child => child.value === next) ? '' : next;
    }
    get textContent() { return this._text || this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get innerHTML() { return this.textContent; }
    set innerHTML(value) {
      assert.equal(value, '', 'device labels must use text nodes rather than executable HTML');
      this.replaceChildren();
    }
    get options() { return this.children; }
    get selectedIndex() { return this.children.findIndex(child => child.value === this.value); }
    set selectedIndex(index) { this.value = this.children[index]?.value || ''; }
    appendChild(child) {
      const empty = this.children.length === 0;
      this.children.push(child);
      if (this.tagName === 'SELECT' && (empty || child.selected)) this._value = child.value;
      return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    add(child) { this.appendChild(child); }
    replaceChildren(...children) { this.children = []; this._text = ''; this._value = ''; this.append(...children); }
    addEventListener(type, callback) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), callback]);
    }
    setAttribute(name, value) { this[name] = String(value); }
    removeAttribute(name) { delete this[name]; }
    toggleAttribute(name, enabled) { if (enabled) this.setAttribute(name, ''); else this.removeAttribute(name); }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    focus() { document.activeElement = this; }
    setPointerCapture() {}
    fire(type, init = {}) {
      const event = { type, target: this, currentTarget: this, button: 0, pointerId: 1, repeat: false,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...init };
      for (const callback of captureListeners.get(type) || []) {
        callback(event);
        if (event.stopped) return event;
      }
      this['on' + type]?.(event);
      for (const callback of this.listeners.get(type) || []) callback(event);
      return event;
    }
    click() { if (!this.disabled) this.fire('click'); }
  }
  const html = read('remote-voice.html');
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attributes, id] = match;
    const element = new Element(tag);
    element.id = id;
    element.disabled = /\sdisabled(?:\s|$)/.test(attributes);
    element.hidden = /\shidden(?:\s|$)/.test(attributes);
    element.checked = /\schecked(?:\s|$)/.test(attributes);
    elements.set(id, element);
  }
  for (const match of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const select = elements.get(match[1]);
    for (const optionMatch of match[2].matchAll(/<option\b[^>]*\bvalue="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
      const option = new Element('option');
      option.value = optionMatch[1];
      option.textContent = optionMatch[2];
      select.appendChild(option);
    }
  }
  for (const match of html.matchAll(/<button\b([^>]*class="[^"]*remote-hotspot[^"]*"[^>]*)>/g)) {
    const element = new Element('button');
    element.dataset.key = /\bdata-key="([^"]+)"/.exec(match[1])?.[1] || '';
    for (const name of (/\bclass="([^"]+)"/.exec(match[1])?.[1] || '').split(/\s+/)) {
      if (name) element.classes.add(name);
    }
    hotspots.push(element);
  }
  const document = {
    activeElement: null,
    addEventListener(type, callback) {
      captureListeners.set(type, [...(captureListeners.get(type) || []), callback]);
    },
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag),
    querySelectorAll(selector) {
      assert.equal(selector, '.remote-hotspot');
      return hotspots;
    },
  };
  const invoke = async (command, args) => {
    calls.push({ command, ...(args === undefined || args.feedback ? {} : { args: copy(args) }) });
    if (responses[command]) return responses[command](args);
    if (command === 'remote_voice_enter_demo') return true;
    if (command === 'remote_voice_status' || command === 'remote_voice_refresh_devices') return copy(current);
    if (command === 'remote_voice_set_demo_mode') return args.enabled;
    if (command === 'remote_voice_start') {
      current = { ...current, running: true, state: 'connecting', config: copy(args.config) };
      return copy(current);
    }
    if (command === 'remote_voice_stop') {
      current = { ...current, running: false, state: 'stopped', autoPaused: true };
      return copy(current);
    }
    if (command === 'remote_voice_set_auto_start') {
      current = { ...current, config: { ...current.config, autoStart: args.enabled } };
      return copy(current);
    }
    throw new Error('Unexpected settings command: ' + command);
  };
  const javascript = ts.transpileModule(read('src/remote-voice.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(javascript, {
    exports: {}, document,
    window: {
      addEventListener(type, callback) { windowListeners.set(type, callback); },
      setTimeout(callback) { timers.push(callback); return timers.length; },
    },
    Option: class extends Element {
      constructor(text = '', value = '', defaultSelected = false, selected = false) {
        super('option'); this.textContent = text; this.value = value; this.selected = selected;
      }
    },
    require(name) {
      if (name === '@tauri-apps/api/core') return { invoke, Channel: class {} };
      if (name === '@tauri-apps/api/event') return {
        listen: async (event, callback) => {
          eventListeners.set(event, callback);
          return () => eventListeners.delete(event);
        },
      };
      throw new Error('Unexpected renderer module: ' + name);
    },
  }, { filename: 'remote-voice.js' });
  await settle();
  return {
    calls, document,
    get(id) { const element = elements.get(id); assert.ok(element, 'missing settings element #' + id); return element; },
    async choose(id) { const picker = this.get('device-picker'); picker.value = id; picker.fire('change'); await settle(); },
    async click(id) { this.get(id).click(); await settle(); },
    async blur() { windowListeners.get('blur')?.(); await settle(); },
    async poll(next) {
      current = copy(next);
      const callback = timers.shift();
      assert.ok(callback, 'the status renderer must retain its refresh timer');
      callback();
      await settle();
    },
    setSnapshot(next) { current = copy(next); },
    hotspot(key) {
      const element = hotspots.find(spot => spot.dataset.key === key);
      assert.ok(element, 'missing remote hotspot ' + key);
      return element;
    },
    async emitKeys(payload) {
      const listener = eventListeners.get('aichat-desktop:remote-voice-keys');
      assert.ok(listener, 'the native key activity listener must be registered');
      listener({ payload });
      await settle();
    },
  };
}

test('native key activity highlights exactly the pressed diagram keys and releases them in order', async () => {
  const view = await renderer();
  let revision = 0;
  for (const key of remoteKeys) {
    await view.emitKeys({ revision: ++revision, pressedKeys: [key] });
    for (const other of remoteKeys) {
      assert.equal(view.hotspot(other).classList.contains('is-pressed'), other === key,
        key + ' must not change the ' + other + ' hotspot');
    }
    assert.equal(view.hotspot(key)['aria-pressed'], 'true');
    await view.emitKeys({ revision: ++revision, pressedKeys: [] });
    assert.equal(view.hotspot(key).classList.contains('is-pressed'), false);
    assert.equal(view.hotspot(key)['aria-pressed'], 'false');
  }

  await view.emitKeys({ revision: ++revision, pressedKeys: ['home', 'menu'] });
  assert.equal(view.hotspot('home').classList.contains('is-pressed'), true);
  assert.equal(view.hotspot('menu').classList.contains('is-pressed'), true);
  await view.emitKeys({ revision: ++revision, pressedKeys: ['home'] });
  assert.equal(view.hotspot('home').classList.contains('is-pressed'), true);
  assert.equal(view.hotspot('menu').classList.contains('is-pressed'), false);
  await view.emitKeys({ revision: 1, pressedKeys: ['tv'] });
  assert.equal(view.hotspot('home').classList.contains('is-pressed'), true, 'stale snapshots cannot undo a newer release');
  assert.equal(view.hotspot('tv').classList.contains('is-pressed'), false);
  await view.emitKeys({ revision: ++revision, pressedKeys: [] });
});

test('legacy direction-pad activity uses a group highlight and honors current releases', async () => {
  const view = await renderer();
  const group = view.get('remote-dpad');
  const directionKeys = ['up', 'down', 'left', 'right', 'ok'];
  const pressed = () => directionKeys.filter(key => view.hotspot(key).classList.contains('is-pressed'));

  await view.emitKeys({ revision: 1, pressedKeys: ['dpad'] });
  assert.equal(group.classList.contains('legacy-pressed'), true);
  assert.deepEqual(pressed(), []);
  await view.emitKeys({ revision: 2, pressedKeys: ['dpad', 'up'] });
  assert.equal(group.classList.contains('legacy-pressed'), false);
  assert.deepEqual(pressed(), ['up']);
  await view.emitKeys({ revision: 3, pressedKeys: [] });
  await view.emitKeys({ revision: 2, pressedKeys: ['dpad', 'up'] });
  assert.equal(group.classList.contains('legacy-pressed'), false);
  assert.deepEqual(pressed(), []);
});

test('pointer and keyboard holds are momentary and independent of the pinned key guide', async () => {
  const view = await renderer();
  for (const key of [...remoteKeys, 'pairing']) {
    const spot = view.hotspot(key);
    spot.fire('pointerdown');
    assert.equal(spot.classList.contains('is-pressed'), true, key + ' pointerdown');
    spot.fire('pointerup');
    assert.equal(spot.classList.contains('is-pressed'), false, key + ' pointerup');
  }
  const voice = view.hotspot('voice');
  voice.fire('keydown', { key: ' ' });
  assert.equal(voice.classList.contains('is-pressed'), true);
  voice.fire('keydown', { key: ' ', repeat: true });
  voice.fire('keyup', { key: ' ' });
  assert.equal(voice.classList.contains('is-pressed'), false);
  voice.fire('pointerdown');
  voice.fire('pointercancel');
  assert.equal(voice.classList.contains('is-pressed'), false);

  voice.click();
  assert.equal(voice.classList.contains('is-active'), true);
  await view.emitKeys({ revision: 1, pressedKeys: ['voice'] });
  await view.emitKeys({ revision: 2, pressedKeys: [] });
  assert.equal(voice.classList.contains('is-active'), true, 'physical feedback does not unpin the usage guide');
  assert.equal(voice.classList.contains('is-pressed'), false);
});

test('demo arrows and OK track simultaneous presses and release independently', async () => {
  const view = await renderer();
  await view.click('remote-demo-toggle');
  const guide = view.get('remote-guide');
  const keys = ['up', 'down', 'left', 'right', 'ok'];
  const press = (type, key) => assert.equal(guide.fire(type, { key, code: key }).defaultPrevented, true);
  const pressed = () => keys.filter(key => view.hotspot(key).classList.contains('is-pressed'));
  for (const [arrow, key] of [['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right']]) {
    press('keydown', arrow);
    assert.deepEqual(pressed(), [key]);
    press('keydown', 'Enter');
    assert.deepEqual(pressed(), [key, 'ok']);
    press('keyup', arrow);
    assert.deepEqual(pressed(), ['ok']);
    press('keyup', 'Enter');
    assert.deepEqual(pressed(), []);
  }
});

test('demo is active only after native capture succeeds and ignores events from expired captures', async () => {
  const channels = [];
  let finish;
  const view = await renderer(snapshot(), { remote_voice_enter_demo: ({ feedback }) => {
    channels.push(feedback);
    return new Promise((resolve, reject) => { finish = { resolve, reject }; });
  } });
  const toggle = view.get('remote-demo-toggle');
  const guide = view.get('remote-guide');
  const settings = view.get('voice-controls');
  await view.click(toggle.id);
  assert.equal(guide['data-demo'], undefined);
  finish.reject(new Error('需要辅助功能权限'));
  await settle();
  assert.match(view.get('error').textContent, /辅助功能/);
  assert.equal(settings.inert, false);
  assert.equal(toggle.textContent, '进入演示');

  await view.click(toggle.id);
  await view.blur();
  finish.resolve(true);
  await settle();
  assert.equal(guide['data-demo'], undefined);
  assert.equal(view.calls.at(-1).args.enabled, false, 'blur releases capture even when activation was pending');

  await view.click(toggle.id);
  finish.resolve(true);
  await settle();
  assert.equal(guide['data-demo'], '');
  channels[1].onmessage({ key: 'volume', pressed: true });
  assert.equal(view.hotspot('volume')['aria-pressed'], 'false');
  channels[2].onmessage({ key: 'volume', pressed: true });
  assert.equal(view.hotspot('volume')['aria-pressed'], 'true');
  channels[2].onmessage({ key: 'unavailable', pressed: false });
  assert.equal(view.hotspot('volume')['aria-pressed'], 'false');
  assert.equal(guide['data-demo'], undefined);
  assert.equal(settings.inert, false);
  await view.click(toggle.id);
  finish.resolve(true);
  await settle();
  channels[3].onmessage({ key: 'ended', pressed: false });
  assert.equal(toggle.textContent, '进入演示', 'native focus loss ends demo without a DOM blur');
  assert.equal(view.get('error').textContent, '');
  assert.equal(settings.inert, false);
});

test('losing window focus exits the demo and clears input held during it', async () => {
  const view = await renderer();
  const settings = view.get('voice-controls');
  const spot = view.hotspot('voice');
  await view.click('remote-demo-toggle');
  assert.equal(settings.inert, true);
  assert.equal(spot.fire('keydown', { key: 'Enter', code: 'Enter' }).defaultPrevented, true);
  assert.equal(spot.classList.contains('is-pressed'), true);
  assert.equal(view.get('refresh-devices').fire('click').defaultPrevented, true);
  await view.blur();
  assert.equal(settings.inert, false);
  assert.equal(spot.classList.contains('is-pressed'), false);
  await view.click('refresh-devices');
  assert.deepEqual(view.calls.filter(call => call.command !== 'remote_voice_status'), [
    { command: 'remote_voice_enter_demo' },
    { command: 'remote_voice_set_demo_mode', args: { enabled: false } },
    { command: 'remote_voice_refresh_devices', args: {} },
  ]);
});

test('multiple remotes are distinguishable and require an explicit choice before connecting', async () => {
  const view = await renderer();
  assert.equal(view.get('device-selection').hidden, false);
  assert.equal(view.get('device-picker').value, '', 'the first remote cannot be silently selected');
  assert.equal(view.get('device-picker').options[0].value, '', 'the list starts with a neutral placeholder');
  for (const device of [deviceA, deviceB]) {
    const option = view.get('device-picker').options.find(option => option.value === device.id);
    assert.ok(option, 'a discovered remote is available for selection');
    assert.ok(option.textContent.includes(device.name));
    assert.ok(option.textContent.includes(device.id), 'same-name remotes display their identities');
  }
  assert.equal(view.get('connect-device').disabled, true);
  assert.equal(view.calls.some(call => call.command === 'remote_voice_start'), false);
  await view.choose(deviceB.id);
  assert.equal(view.get('device').value, deviceB.id);
  assert.equal(view.get('connect-device').disabled, false);
  assert.equal(view.calls.some(call => call.command === 'remote_voice_start'), false, 'selecting alone does not start input');
  await view.click('connect-device');
  const starts = view.calls.filter(call => call.command === 'remote_voice_start');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].args, { config: { device: deviceB.id, autoStart: true } });
  assert.equal(view.get('device-picker').disabled, true, 'an active connection cannot be retargeted by the picker');
});

test('status and explicit discovery refresh preserve a pending choice without writing or starting it', async () => {
  const view = await renderer();
  await view.choose(deviceB.id);
  view.get('device-picker').focus();
  await view.poll(snapshot({ devices: [deviceB, deviceA] }));
  assert.equal(view.get('device-picker').value, deviceB.id);
  assert.equal(view.get('device').value, deviceB.id, 'saved blank config cannot overwrite a user selection');
  assert.equal(view.document.activeElement, view.get('device-picker'));
  view.setSnapshot(snapshot({ devices: [{ ...deviceB, connected: true }, deviceA] }));
  await view.click('refresh-devices');
  const refresh = view.calls.filter(call => call.command === 'remote_voice_refresh_devices');
  assert.equal(refresh.length, 1);
  assert.ok(refresh[0].args === undefined || Object.keys(refresh[0].args).length === 0,
    'discovery refresh receives no device or authorization payload');
  assert.equal(view.get('device-picker').value, deviceB.id);
  assert.equal(view.get('device').value, deviceB.id);
  assert.equal(view.calls.some(call => call.command === 'remote_voice_start'), false);
});

test('a vanished selection is cleared and never turns into an automatic start of another remote', async () => {
  const view = await renderer();
  await view.choose(deviceB.id);
  await view.poll(snapshot({ devices: [deviceA] }));
  assert.equal(view.get('device-picker').value, '');
  assert.equal(view.get('connect-device').disabled, true);
  await view.click('connect-device');
  await view.click('start');
  assert.equal(view.calls.some(call => call.command === 'remote_voice_start'), false,
    'losing a chosen remote must not submit the blank automatic-discovery target');
  await view.poll(snapshot());
  assert.equal(view.get('device-picker').value, '', 'a reappearing candidate still requires a new choice');
  await view.choose(deviceA.id);
  await view.click('connect-device');
  assert.equal(view.calls.find(call => call.command === 'remote_voice_start').args.config.device, deviceA.id);
});

test('legacy snapshots without device candidates preserve manual device selection', async () => {
  const legacy = snapshot({ state: 'stopped', config: { device: deviceA.id, autoStart: false } });
  delete legacy.devices;
  const view = await renderer(legacy);
  assert.equal(view.get('device').value, deviceA.id);
  assert.equal(view.get('start').disabled, false);
  view.get('device').value = deviceB.id;
  view.get('device').fire('input');
  await view.poll(legacy);
  assert.equal(view.get('device').value, deviceB.id);
  await view.click('start');
  assert.deepEqual(view.calls.find(call => call.command === 'remote_voice_start').args,
    { config: { device: deviceB.id, autoStart: false } });
});

test('input permission preflight preserves the explicitly selected remote until it can be saved', async () => {
  const permission = snapshot({ state: 'needs-permission', error: '请先授权输入监控。' });
  const view = await renderer(snapshot(), {
    remote_voice_start: async () => copy(permission),
  });
  await view.choose(deviceB.id);
  await view.click('connect-device');
  assert.equal(view.calls.filter(call => call.command === 'remote_voice_start').length, 1);
  assert.equal(view.get('device-picker').value, deviceB.id,
    'a permission response with the old saved config cannot discard the chosen remote');
  assert.equal(view.get('device').value, deviceB.id);
  await view.poll(permission);
  assert.equal(view.get('device-picker').value, deviceB.id);
  assert.equal(view.get('device').value, deviceB.id);
  await view.click('connect-device');
  const starts = view.calls.filter(call => call.command === 'remote_voice_start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].args.config.device, deviceB.id,
    'retrying after permission setup still targets the same remote');
});

test('changing automatic-start preference does not overwrite an unsaved manually entered device ID', async () => {
  const view = await renderer(snapshot({ state: 'stopped', config: { device: deviceA.id, autoStart: false } }));
  view.get('device').value = deviceB.id;
  view.get('device').fire('input');
  view.get('auto-start').checked = true;
  view.get('auto-start').fire('change');
  await settle();
  assert.deepEqual(view.calls.find(call => call.command === 'remote_voice_set_auto_start').args, { enabled: true });
  assert.equal(view.get('device').value, deviceB.id,
    'preference writes return saved config but must preserve unsaved input');
  await view.poll(snapshot({ state: 'stopped', config: { device: deviceA.id, autoStart: true } }));
  assert.equal(view.get('device').value, deviceB.id);
  await view.click('start');
  assert.deepEqual(view.calls.find(call => call.command === 'remote_voice_start').args,
    { config: { device: deviceB.id, autoStart: true } });
});

test('discovered names are rendered as text and refresh failures retain the user choice', async () => {
  const hostileName = '<img src=x onerror="globalThis.compromised=true">';
  const view = await renderer(snapshot({ devices: [{ ...deviceA, name: hostileName }, deviceB] }), {
    remote_voice_refresh_devices: async () => { throw new Error('蓝牙暂不可用'); },
  });
  assert.ok(view.get('device-picker').options.some(option => option.textContent.includes(hostileName)));
  await view.choose(deviceB.id);
  await view.click('refresh-devices');
  assert.ok(view.get('error').textContent.includes('蓝牙暂不可用'));
  assert.equal(view.get('device-picker').value, deviceB.id);
  assert.equal(view.get('device').value, deviceB.id);
  assert.equal(view.calls.some(call => call.command === 'remote_voice_start'), false);
});

test('legacy snapshots without diagnostics keep the diagnostic panel hidden and device controls usable', async () => {
  const legacy = snapshot();
  assert.equal(Object.hasOwn(legacy, 'diagnostic'), false);
  const view = await renderer(legacy);
  assert.equal(view.get('voice-diagnostic').hidden, true);
  assert.equal(view.get('diagnostic').value, '');
  await view.choose(deviceB.id);
  await view.click('connect-device');
  assert.equal(view.calls.find(call => call.command === 'remote_voice_start').args.config.device, deviceB.id);
});

test('native GATT diagnostics are selectable readonly text and never interpreted as HTML', async () => {
  const diagnostic = 'Device: </textarea><img src=x onerror="globalThis.compromised=true">\n'
    + 'Service: ab5e0001-5a21-4f05-bc7d-af01f617b664\nMissing: audio';
  const view = await renderer(snapshot({ state: 'error', device: deviceA.id, diagnostic }));
  assert.equal(view.get('voice-diagnostic').hidden, false);
  assert.equal(view.get('diagnostic').tagName, 'TEXTAREA');
  assert.equal(view.get('diagnostic').value, diagnostic);
  assert.equal(view.get('diagnostic').children.length, 0);
  assert.match(read('remote-voice.html'), /<textarea\b(?=[^>]*\bid="diagnostic")(?=[^>]*\breadonly(?:\s|>|=))[^>]*>/);
  assert.equal(view.calls.some(call => call.command === 'remote_voice_start'), false,
    'showing a diagnostic cannot start or retarget a native session');
});

test('cleared diagnostics and snapshots for another device remove the previous diagnostic text', async () => {
  const diagnostic = 'Device: ' + deviceA.id + '\nMissing: audio';
  const failed = snapshot({ state: 'error', device: deviceA.id, diagnostic });
  const view = await renderer(failed);
  for (const next of [
    snapshot({ state: 'stopped', device: deviceA.id, diagnostic: '' }),
    snapshot({ state: 'connecting', device: deviceB.id, config: { device: deviceB.id, autoStart: true } }),
  ]) {
    await view.poll(failed);
    assert.equal(view.get('voice-diagnostic').hidden, false);
    assert.equal(view.get('diagnostic').value, diagnostic);
    await view.poll(next);
    assert.equal(view.get('voice-diagnostic').hidden, true);
    assert.equal(view.get('diagnostic').value, '', 'a hidden panel cannot retain another session\'s report');
  }
});

test('only the local settings document can refresh discovered remotes', () => {
  const permissions = read('src-tauri/permissions/desktop-commands.toml').split('[[permission]]');
  const local = permissions.find(part => part.includes('identifier = "allow-remote-voice-settings"'));
  const main = permissions.find(part => part.includes('identifier = "allow-desktop-commands"'));
  assert.ok(local.includes('"remote_voice_refresh_devices"'));
  assert.equal(main.includes('remote_voice_refresh_devices'), false);
  const host = read('src-tauri/src/app/remote_voice_host.rs');
  const body = host.slice(host.indexOf('fn remote_voice_refresh_devices(')).split('#[tauri::command]')[0];
  assert.match(body, /verify\(&window\)\?/);
  assert.ok(read('src-tauri/src/app/startup.rs').includes('remote_voice_host::remote_voice_refresh_devices'));
  assert.equal((read('src/bridge.ts') + read('src-tauri/src/bridge.rs')).includes('remote_voice_refresh_devices'), false);
});
