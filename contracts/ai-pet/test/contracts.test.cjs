'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../index.cjs');
const fixtures = require('../fixtures/positive.json');
const invalid = require('../fixtures/negative.json');
const clone = v => structuredClone(v);
for (const [kind,value] of Object.entries(fixtures)) test(`shape: ${kind}`, () => api.shape(kind,value));
for (const c of invalid) test(`reject: ${c.reason}`, () => {
  const value = clone(fixtures[c.kind]); const path = c.path.slice(1).split('/');
  const key = path.pop(); const parent = path.reduce((v,k) => v[k], value);
  if (c.value === null) delete parent[key]; else parent[key] = c.value;
  assert.throws(() => api.shape(c.kind,value), /shape:/);
});
const selectionAdapters = {
  account: async () => fixtures.account,
  catalog: async () => ({ ...fixtures.selection, eligible:true, withdrawn:false })
};
test('selection requires independent authority, exact region and catalog mapping', async () => {
  await assert.rejects(api.authorizeSelection(fixtures.selection), /external-account/);
  assert.equal(await api.authorizeSelection(fixtures.selection, selectionAdapters), true);
  for (const field of ['accountId','homeRegion','characterId','characterVersion','appearanceId','appearanceVersion']) {
    await assert.rejects(api.authorizeSelection({...fixtures.selection,[field]:'other'}, selectionAdapters), /binding/);
  }
  await assert.rejects(api.authorizeSelection(fixtures.selection,{...selectionAdapters,catalog:async()=>({...fixtures.selection,eligible:true,withdrawn:true})}), /ineligible/);
});
test('new/old, old/new, new/new and unknown additive capabilities', () => {
  const supported = { text:[1], 'voice.lease':[1] };
  assert.deepEqual({...api.negotiate({contractVersion:'ai-pet.dev.v1'}, supported)}, {});
  assert.deepEqual({...api.negotiate(fixtures.capabilities, {text:[1]})}, {text:1});
  assert.deepEqual({...api.negotiate({...fixtures.capabilities,futureField:true}, supported)}, {'text':1,'voice.lease':1});
  assert.deepEqual({...api.negotiate({contractVersion:'ai-pet.dev.v1',capabilities:{text:[1],'voice.lease':[2]}}, supported)}, {text:1});
});
test('conversation identity survives retries; uncertain outcome is inspected, not resubmitted', () => {
  const c = fixtures.conversation;
  assert.equal(api.checkConversation(c,c), 'submit-once');
  assert.equal(api.checkConversation(c,c,c), 'inspect-existing-outcome');
  assert.throws(()=>api.checkConversation({...c,text:'changed'},c,c), /content-changed/);
  for (const field of ['accountId','homeRegion','characterId','conversationId']) assert.throws(()=>api.checkConversation({...c,[field]:'other'},c), /binding/);
  assert.equal(api.checkConversation({...c,operation:'cancel'},c,c), 'cancel');
});
test('voice rejects wrong owner, session, superseded turn, replay, expiry and cancellation', () => {
  const o = fixtures.voiceOutput, l = fixtures.voiceLease;
  assert.equal(api.acceptOutput({...o,unknownOptional:true},l,{nowMs:1000}),true);
  for(const field of ['accountId','homeRegion','characterId','characterVersion','conversationId','requestId','turnId','sessionId']) assert.throws(()=>api.acceptOutput({...o,[field]:'old'},l,{nowMs:1000}), /stale/);
  for(const field of ['leaseGeneration','turnGeneration']) assert.throws(()=>api.acceptOutput({...o,[field]:1},l,{nowMs:1000}), /stale/);
  assert.throws(()=>api.acceptOutput(o,l,{nowMs:2000}), /inactive/);
  assert.throws(()=>api.acceptOutput(o,l,{nowMs:1000,lastSequence:1}), /replayed/);
  assert.throws(()=>api.acceptOutput(o,l,{nowMs:1000,cancelled:true}), /inactive/);
  assert.throws(()=>api.acceptOutput(o,{...l,state:'paused'},{nowMs:1000}), /inactive/);
  assert.throws(()=>api.acceptOutput(o,l), /trusted-time/);
});
test('resume needs new deliberate intent and every independently rechecked admission', () => {
  const l={...fixtures.voiceLease,state:'paused'}, i=fixtures.resumeIntent;
  const context={nowMs:1000,pauseRevision:1,usedIntentIds:new Set(),permission:true,lease:true,entitlement:true,audioFocus:true,nativeStartEligible:true};
  assert.equal(api.canResume(i,l,context),true);
  for(const k of ['permission','lease','entitlement','audioFocus','nativeStartEligible']) assert.throws(()=>api.canResume(i,l,{...context,[k]:false}), /admission/);
  assert.throws(()=>api.canResume(i,l,{...context,pauseRevision:2}), /replayed/);
  assert.throws(()=>api.canResume(i,l,{...context,usedIntentIds:new Set([i.intentId])}), /replayed/);
  assert.throws(()=>api.canResume(i,l,{...context,nowMs:2000}), /expired/);
});
const migrationAdapters = {migration:async()=>({...fixtures.migration,completedConsumerHistory:true})};
test('migration fails closed and binds account, region, official character and complete source snapshot', async () => {
  const e=fixtures.migration;
  await assert.rejects(api.evaluateMigration(e), /external-exporter/);
  assert.equal((await api.evaluateMigration(e,{adapters:migrationAdapters}))[0].status,'eligible-for-historical-import');
  for(const field of ['accountId','homeRegion','characterId','characterVersion']) await assert.rejects(api.evaluateMigration({...e,[field]:'other'},{adapters:migrationAdapters}), /binding/);
  for(const field of Object.keys(e.source)) await assert.rejects(api.evaluateMigration({...e,source:{...e.source,[field]:'other'}},{adapters:migrationAdapters}), /binding/);
});
test('migration retries deduplicate, reject changed content and suppress cleared history across snapshots', async () => {
  const e=clone(fixtures.migration), key=api.migrationKey(e,e.messages[0].sourceMessageId);
  const imported=new Map([[key,e.messages[0].contentSha256]]);
  assert.equal((await api.evaluateMigration(e,{adapters:migrationAdapters,imported}))[0].status,'already-imported');
  e.messages[0].contentSha256='c'.repeat(64);
  await assert.rejects(api.evaluateMigration(e,{adapters:migrationAdapters,imported}), /source-mutated/);
  assert.equal((await api.evaluateMigration(e,{adapters:migrationAdapters,imported,deleted:new Set([key])}))[0].status,'suppressed-deletion');
  e.source.snapshotRevision='revision-2'; e.batchId='new-batch';
  const adapters={migration:async()=>({...e,completedConsumerHistory:true})};
  assert.equal((await api.evaluateMigration(e,{adapters,deleted:new Set([api.migrationKey(e,'*')])}))[0].status,'suppressed-deletion');
  e.messages[0].contentSha256=fixtures.migration.messages[0].contentSha256;
  const immutableEvidence=clone(e);
  e.messages.push({...e.messages[0]});
  await assert.rejects(api.evaluateMigration(e,{adapters:{migration:async()=>({...immutableEvidence,completedConsumerHistory:true})}}), /duplicate-or-unordered/);
});
test('usage identities bind independent entitlement; local success cannot grant quota', async () => {
  const u=fixtures.usage,e=fixtures.entitlement,l=fixtures.voiceLease;
  await assert.rejects(api.authorizeUsage(u,e,l), /external-billing/);
  const adapters={entitlement:async()=>e};
  assert.equal(await api.authorizeUsage(u,e,l,adapters),await api.authorizeUsage(clone(u),e,l,adapters));
  for(const field of ['accountId','homeRegion','entitlementId','allowanceVersion','periodId','sessionId']) await assert.rejects(api.authorizeUsage({...u,[field]:'other'},e,l,adapters), /binding/);
  await assert.rejects(api.authorizeUsage({...u,consumedUnits:11},e,l,adapters), /over-reservation/);
  await assert.rejects(api.authorizeUsage(u,{...e,status:'revoked'},l,{entitlement:async()=>({...e,status:'revoked'})}), /inactive/);
});
test('export evidence binds payload, not merely a caller-selected revision or digest', async () => {
  const e=clone(fixtures.migration);
  e.messages[0].text='Injected content with original digest';
  await assert.rejects(api.evaluateMigration(e,{adapters:migrationAdapters}), /source-mutated/);
  const {createHash}=require('node:crypto');
  const m=e.messages[0];
  m.contentSha256=createHash('sha256').update(JSON.stringify([m.role,m.text,m.order,m.createdAtMs])).digest('hex');
  await assert.rejects(api.evaluateMigration(e,{adapters:migrationAdapters}), /export-payload-binding/);
  const injected=clone(fixtures.migration);
  injected.messages[0].sourceMessageId='injected-message';
  await assert.rejects(api.evaluateMigration(injected,{adapters:migrationAdapters}), /export-payload-binding/);
  const missingEvidence={migration:async()=>({...fixtures.migration,messages:undefined,completedConsumerHistory:true})};
  await assert.rejects(api.evaluateMigration(fixtures.migration,{adapters:missingEvidence}), /immutable-export/);
});
