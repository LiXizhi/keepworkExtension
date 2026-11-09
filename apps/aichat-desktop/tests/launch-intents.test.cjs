const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLaunchUrl, LaunchIntents } = require('../src/launchIntents.cjs');
test('protocol accepts two fixed navigation intents without arbitrary input', () => {
  assert.equal(parseLaunchUrl('keepwork-secondbrain://open'), 'open');
  assert.equal(parseLaunchUrl('keepwork-secondbrain://onboarding/'), 'onboarding');
  for (const url of [null, '', 'https://keepwork.com', 'keepwork-secondbrain://open?path=/tmp', 'keepwork-secondbrain://onboarding#token=x',
    'keepwork-secondbrain://open/../onboarding', 'keepwork-secondbrain://user@open', 'keepwork-secondbrain://open:123',
    'keepwork-secondbrain://open\n', 'keepwork-secondbrain://OPEN', ' keepwork-secondbrain://open', 'keepwork-secondbrain://%6fpen', 'keepwork-secondbrain://run_terminal']) assert.equal(parseLaunchUrl(url), null, String(url));
});
test('cold-launch intent survives repeated reads and duplicate clicks until matching acknowledgement', () => {
  const queue = new LaunchIntents();
  queue.offer('first-launch');
  const explicit = queue.offer('onboarding');
  assert.equal(queue.offer('onboarding').id, explicit.id);
  assert.deepEqual(queue.peek(), explicit);
  assert.equal(queue.acknowledge('1'), false);
  assert.deepEqual(queue.peek(), explicit);
  assert.equal(queue.acknowledge(explicit.id), true);
  assert.equal(queue.peek(), null);
  assert.notEqual(queue.offer('onboarding').id, explicit.id);
});
test('legacy ZIP remains available while website installer and protocol configuration are added', () => {
  const config = require('../electron-builder.config.cjs');
  assert.equal(config.nsis.oneClick, true); assert.equal(config.nsis.runAfterFinish, true);
  assert.equal(config.nsis.perMachine, false); assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.deepEqual(config.mac.target, ['dmg', 'zip']);
  assert.equal(config.dmg.writeUpdateInfo, false);
  assert.deepEqual(config.protocols[0].schemes, ['keepwork-secondbrain']);
});
