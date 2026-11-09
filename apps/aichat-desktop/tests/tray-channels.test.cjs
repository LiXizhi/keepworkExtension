const { test } = require('node:test');
const assert = require('node:assert/strict');
const { channelStates, describe } = require('../src/trayChannels.cjs');

test('legacy, missing and downgraded snapshots keep unsupported channels unknown', () => {
  const channels = [{ channel: 'dingtalk', bindings: [{ status: 'listening' }] }, { channel: 'feishu', bindings: [] }];
  assert.deepEqual(channelStates({ channels, wechat: 'qr' }), ['listening', 'unbound', 'qr']);
  assert.deepEqual(channelStates({ channels }), ['listening', 'unbound', 'unknown']);
  assert.deepEqual(channelStates(null), ['unknown', 'unknown', 'unknown']);
  assert.deepEqual(channelStates({channels: [{}], wechat: 'new-status'}), ['unknown', 'unknown', 'unknown']);
});

test('partial failure remains visible alongside a listening binding', () => {
  const states = channelStates({channels: [
    {channel:'dingtalk', bindings:[{status:'needs-authorization'}, {status:'listening'}]},
    {channel:'feishu', bindings:[{status:'reconnecting'}]},
  ], wechat:'verified'});
  assert.deepEqual(describe(states), ['⚠️ 钉钉：部分连接需检查', '⏳ 飞书：连接中', '✅ 微信：上次已连接 · 巡检关闭']);
});
