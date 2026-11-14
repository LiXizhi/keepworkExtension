'use strict';
// Offline reference semantics only. No sockets, credentials, storage or microphone.
const Ajv = require('ajv/dist/2020');
const { createHash } = require('node:crypto');
const schema = require('./schema/ai-pet.schema.json');
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validators = new Map();
function shape(kind, value) {
  if (!Object.hasOwn(schema.$defs, kind)) throw new Error('unknown-contract');
  if (!validators.has(kind)) validators.set(kind, ajv.compile({ $ref: `${schema.$id}#/$defs/${kind}` }));
  const validate = validators.get(kind);
  if (!validate(value)) throw new Error(`shape:${kind}:${ajv.errorsText(validate.errors)}`);
  return value;
}
function requireThat(condition, reason) { if (!condition) throw new Error(reason); }
function equalFields(a, b, fields, reason) {
  requireThat(a && b && fields.every(k => a[k] !== undefined && a[k] === b[k]), reason);
}
const binding = ['accountId', 'homeRegion', 'characterId', 'characterVersion'];
const fence = [...binding, 'conversationId', 'requestId', 'turnId', 'sessionId', 'leaseGeneration', 'turnGeneration'];
const denyAdapters = Object.freeze({
  account: async () => { throw new Error('external-account-adapter-required'); },
  catalog: async () => { throw new Error('external-catalog-adapter-required'); },
  migration: async () => { throw new Error('external-exporter-adapter-required'); },
  entitlement: async () => { throw new Error('external-billing-adapter-required'); }
});
async function authorizeSelection(selection, adapters = denyAdapters) {
  shape('selection', selection);
  // Adapters must resolve authenticated context independently, never echo wire assertions.
  const account = await adapters.account();
  equalFields(selection, account, ['accountId', 'homeRegion'], 'account-binding');
  const entry = await adapters.catalog(selection.characterId, selection.characterVersion);
  equalFields(selection, entry, ['characterId','characterVersion','appearanceId','appearanceVersion'], 'catalog-binding');
  requireThat(entry.eligible === true && entry.withdrawn === false, 'catalog-ineligible');
  return true;
}
function negotiate(peer, supported) {
  shape('capabilities', peer);
  const result = Object.create(null);
  for (const [name, versions] of Object.entries(supported)) {
    const offered = Object.hasOwn(peer.capabilities || {}, name) ? peer.capabilities[name] : [];
    const common = versions.filter(v => offered.includes(v));
    if (common.length) result[name] = Math.max(...common);
  }
  return result;
}
function checkConversation(command, current, knownRequest) {
  shape('conversation', command);
  equalFields(command, current, [...binding, 'conversationId'], 'conversation-binding');
  requireThat(command.operation !== 'append' || typeof command.text === 'string', 'append-text-required');
  if (knownRequest) {
    equalFields(command, knownRequest, [...binding,'conversationId','requestId','turnId'], 'request-identity-changed');
    if (command.operation === 'append') {
      requireThat(command.text === knownRequest.text, 'request-content-changed');
      return 'inspect-existing-outcome';
    }
  }
  return command.operation === 'append' ? 'submit-once' : command.operation;
}
function acceptOutput(output, lease, { nowMs, lastSequence = -1, cancelled = false } = {}) {
  shape('voiceOutput', output); shape('voiceLease', lease);
  requireThat(Number.isSafeInteger(nowMs) && nowMs >= 0, 'trusted-time-required');
  requireThat(Number.isSafeInteger(lastSequence) && lastSequence >= -1, 'invalid-sequence-state');
  equalFields(output, lease, fence, 'stale-output');
  requireThat(!cancelled && lease.state === 'active' && lease.expiresAtMs > nowMs, 'inactive-lease');
  requireThat(output.sequence > lastSequence, 'replayed-output');
  return true;
}
function canResume(intent, lease, context) {
  shape('resumeIntent', intent); shape('voiceLease', lease);
  equalFields(intent, lease, [...fence,'deviceId'], 'stale-resume');
  requireThat(lease.state === 'paused', 'not-paused');
  requireThat(context && Number.isSafeInteger(context.nowMs) && context.nowMs >= 0 && lease.expiresAtMs > context.nowMs, 'expired-lease');
  requireThat(intent.pauseRevision === context.pauseRevision && !context.usedIntentIds?.has(intent.intentId), 'replayed-resume');
  requireThat(['permission','lease','entitlement','audioFocus','nativeStartEligible'].every(k => context[k] === true), 'resume-admission-required');
  return true; // Caller atomically consumes intentId and transitions; never starts hardware here.
}
const sourceFields = ['format','formatVersion','installationId','sourceConversationId'];
function migrationKey(envelope, messageId) {
  return JSON.stringify([envelope.accountId,envelope.homeRegion,...sourceFields.map(k => envelope.source[k]),messageId]);
}
async function evaluateMigration(envelope, { adapters = denyAdapters, deleted = new Set(), imported = new Map() } = {}) {
  shape('migration', envelope);
  const authority = await adapters.migration(envelope.evidenceRef);
  equalFields(envelope, authority, binding, 'migration-account-character-binding');
  equalFields(envelope.source, authority.source, [...sourceFields,'snapshotRevision'], 'migration-source-binding');
  requireThat(authority.completedConsumerHistory === true, 'unqualified-history');
  requireThat(Array.isArray(authority.messages), 'immutable-export-evidence-required');
  const evidence = new Map();
  for (const message of authority.messages) {
    shape('migrationMessage', message);
    requireThat(!evidence.has(message.sourceMessageId), 'ambiguous-export-evidence');
    evidence.set(message.sourceMessageId, message);
  }
  const seen = new Set(); let order = -1;
  return envelope.messages.map(message => {
    requireThat(!seen.has(message.sourceMessageId) && message.order > order, 'duplicate-or-unordered-source');
    seen.add(message.sourceMessageId); order = message.order;
    const key = migrationKey(envelope, message.sourceMessageId);
    // Tombstones outrank retries, new snapshots and content changes.
    if (deleted.has(migrationKey(envelope, '*')) || deleted.has(key)) return { key, status: 'suppressed-deletion' };
    const digest = createHash('sha256').update(JSON.stringify([message.role,message.text,message.order,message.createdAtMs])).digest('hex');
    requireThat(digest === message.contentSha256, 'source-mutated');
    equalFields(message, evidence.get(message.sourceMessageId), ['sourceMessageId','role','text','order','createdAtMs','contentSha256'], 'export-payload-binding');
    const previous = imported.get(key);
    if (previous !== undefined) {
      requireThat(previous === message.contentSha256, 'source-mutated');
      return { key, status: 'already-imported' };
    }
    return { key, status: 'eligible-for-historical-import' };
  });
}
async function authorizeUsage(usage, entitlement, lease, adapters = denyAdapters) {
  shape('usage', usage); shape('entitlement', entitlement); shape('voiceLease', lease);
  const authority = await adapters.entitlement();
  equalFields(entitlement, authority, ['accountId','homeRegion','entitlementId','allowanceVersion','periodId','grantId','grantKind','purchaseChannel','status'], 'entitlement-authority');
  requireThat(authority.status === 'active', 'inactive-entitlement');
  equalFields(usage, entitlement, ['accountId','homeRegion','entitlementId','allowanceVersion','periodId'], 'usage-entitlement-binding');
  equalFields(usage, lease, ['accountId','homeRegion','sessionId','leaseGeneration'], 'usage-lease-binding');
  requireThat(usage.consumedUnits <= usage.reservedUnits, 'usage-over-reservation');
  return JSON.stringify([usage.accountId, usage.homeRegion, usage.reservationId, usage.settlementId]);
}
module.exports = { shape, denyAdapters, authorizeSelection, negotiate, checkConversation, acceptOutput, canResume, migrationKey, evaluateMigration, authorizeUsage };
