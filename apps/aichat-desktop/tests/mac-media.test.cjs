const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('../electron-builder.config.cjs');

test('hardened macOS packages declare microphone access for the app and helpers', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(config.mac.hardenedRuntime, true);
  assert.ok(config.mac.extendInfo.NSMicrophoneUsageDescription?.trim());
  for (const file of new Set([config.mac.entitlements, config.mac.entitlementsInherit])) {
    const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.resolve(__dirname, '..', file)], { encoding: 'utf8' }));
    assert.equal(plist['com.apple.security.device.audio-input'], true,
      `${file}: a usage description alone cannot authorize Hardened Runtime audio capture`);
  }
});
