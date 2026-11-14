'use strict';
// Independent behavioral probes against the actual development contract implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../../contracts/ai-pet/index.cjs');
const fixtures = require('../../contracts/ai-pet/fixtures/positive.json');
const scenarios = require('../../contracts/ai-pet/fixtures/voice-lifecycle-scenarios.json');
const { createHash } = require('node:crypto');
const copy = value => structuredClone(value);
const digest = m => createHash('sha256').update(JSON.stringify([m.role, m.text, m.order, m.createdAtMs])).digest('hex');
const evidence = copy(fixtures.migration);
const adapters = { migration: async () => ({ ...copy(evidence), completedConsumerHistory: true }) };

test('QA: trusted export revision cannot authorize changed text with a retained claimed digest', async () => {
  const envelope = copy(evidence);
  envelope.messages[0].text = 'Injected text not present in the independently trusted export';
  await assert.rejects(api.evaluateMigration(envelope, { adapters }));
});
test('QA: trusted export revision cannot authorize an injected source message', async () => {
  const envelope = copy(evidence);
  const injected = { ...copy(envelope.messages[0]), sourceMessageId: 'injected-message', order: 1 };
  injected.contentSha256 = digest(injected);
  envelope.messages.push(injected);
  await assert.rejects(api.evaluateMigration(envelope, { adapters }));
});
test('QA: unsupported destructive commands fail closed rather than replay', () => {
  for (const operation of ['clear', 'delete']) {
    const command = { ...fixtures.conversation, operation };
    assert.throws(() => api.checkConversation(command, command, command), /shape:conversation/, operation);
  }
});
test('QA: portable wrong-account scenario executes against independently bound exporter evidence', async () => {
  assert.equal(scenarios.format, 'ai-pet.dev.scenarios.v1');
  const scenario = scenarios.scenarios.find(s => s.id === 'wrong-account-migration');
  assert.ok(scenario);
  for (const step of scenario.steps) {
    assert.equal(step.event, 'migration-binding', 'unknown migration event');
    assert.deepEqual(Object.keys(step.expect), ['accepted'], 'unknown checkpoint');
    assert.equal(step.expect.accepted, false);
    const envelope = { ...copy(evidence), accountId: step.envelopeAccountId };
    const authority = { ...copy(evidence), accountId: step.authorityAccountId, completedConsumerHistory: true };
    await assert.rejects(api.evaluateMigration(envelope, { adapters: { migration: async () => authority } }));
  }
});
test('QA: resume denies each missing independent admission check', () => {
  const lease = { ...fixtures.voiceLease, state: 'paused' };
  const checks = { nowMs: 1000, pauseRevision: 1, usedIntentIds: new Set(), permission: true,
    lease: true, entitlement: true, audioFocus: true, nativeStartEligible: true };
  for (const key of ['permission', 'lease', 'entitlement', 'audioFocus', 'nativeStartEligible']) {
    assert.throws(() => api.canResume(fixtures.resumeIntent, lease, { ...checks, [key]: false }));
  }
});
test('QA: old lease output is refused after otherwise valid same-turn takeover', () => {
  assert.throws(() => api.acceptOutput(fixtures.voiceOutput,
    { ...fixtures.voiceLease, leaseGeneration: fixtures.voiceLease.leaseGeneration + 1 }, { nowMs: 1000 }));
});

test('QA: recomputing a valid digest cannot authorize altered trusted text', async () => {
  const envelope = copy(evidence);
  envelope.messages[0].text = 'Changed with self-consistent digest';
  envelope.messages[0].contentSha256 = digest(envelope.messages[0]);
  await assert.rejects(api.evaluateMigration(envelope, { adapters }), /export-payload-binding/);
});
