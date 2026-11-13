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
