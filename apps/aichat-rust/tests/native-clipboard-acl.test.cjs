const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const capabilityDir = path.resolve(__dirname, '../src-tauri/capabilities');
const read = name => JSON.parse(fs.readFileSync(path.join(capabilityDir, name), 'utf8'));

test('webview capabilities grant no native clipboard plugin commands', () => {
  for (const name of fs.readdirSync(capabilityDir).filter(name => name.endsWith('.json'))) {
    const capability = read(name);
    const permissions = capability.permissions.map(permission =>
      typeof permission === 'string' ? permission : permission.identifier);
    assert.deepEqual(permissions.filter(permission =>
      permission.startsWith('clipboard-manager:') && !permission.startsWith('clipboard-manager:deny-')),
    [], `${name} must route clipboard work through existing browser/native consent, not direct plugin IPC`);
  }
});

test('clipboard removal preserves default window, origin and unrelated command boundaries', () => {
  const capability = read('default.json');
  assert.deepEqual(capability.windows, ['main', 'pet', 'updates']);
  assert.deepEqual(capability.remote.urls, [
    'https://keepwork.com/chat',
    'https://keepwork.com/chat/*',
    'https://keepwork.com/chat*',
    'https://keepwork.com/*',
    'https://cdn.keepwork.com',
    'https://cdn.keepwork.com/*',
    'http://127.0.0.1:*',
    'http://127.0.0.1:*/*',
    'http://localhost:*',
    'http://localhost:*/*',
  ]);
  assert.deepEqual(capability.permissions, [
    'core:default',
    'core:window:allow-start-dragging',
    'core:event:default',
    'allow-desktop-commands',
    'dialog:default',
    'dialog:allow-open',
    'dialog:allow-save',
    'dialog:allow-ask',
    'dialog:allow-confirm',
    'dialog:allow-message',
    'notification:default',
  ]);
});

test('registered desktop bridge commands have matching explicit IPC permissions', () => {
  const app = path.resolve(__dirname, '..');
  const startup = fs.readFileSync(path.join(app, 'src-tauri/src/app/startup.rs'), 'utf8');
  const handler = startup.match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/);
  assert.ok(handler, 'desktop commands must have an explicit Tauri handler');
  const registered = [...handler[1].matchAll(/(?:[A-Za-z_]\w*::)+([A-Za-z_]\w*)/g)]
    .map(match => match[1]);
  const permissions = fs.readFileSync(path.join(app, 'src-tauri/permissions/desktop-commands.toml'), 'utf8');
  const allowed = [...permissions.matchAll(/commands\.allow\s*=\s*\[([\s\S]*?)\]/g)]
    .flatMap(match => [...match[1].matchAll(/"([^"]+)"/g)].map(command => command[1]));
  assert.ok(registered.includes('desktop_set_menu_language'), 'native menu language updates stay registered');
  assert.deepEqual([...registered].sort(), [...allowed].sort(),
    'every registered bridge command needs an explicit permission, with no stale permissions');
});
