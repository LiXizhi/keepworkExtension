'use strict';
// Development value codec, NOT a storage/authentication/secure-erasure adapter.
const {createHash}=require('node:crypto');
const Ajv=require('ajv/dist/2020');
const schema=require('./schema/history-checkpoint.schema.json');
const validate=new Ajv({strict:true,allErrors:true}).compile(schema);
const FIELDS=['accountId','homeRegion','characterId','characterVersion','conversationId'];
const STATE_FIELDS=['draft','commands','messages','cursor','gap','recoveryTarget','events','cancelled','deletedMessageIds','deletedSourceKeys','deleted'];
const MAX_BYTES=8*1024*1024;
const fail=(ok,reason)=>{if(!ok)throw new Error(reason);};
const canonical=x=>Array.isArray(x)?x.map(canonical):x && typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
function digest(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function unique(values,reason){fail(new Set(values).size===values.length,reason);}
function check(value){
  fail(validate(value),'invalid-checkpoint-shape');
  const {integritySha256,...payload}=value;
  fail(digest(payload)===integritySha256,'checkpoint-integrity');
  const s=value.state;
  fail(s.events.length===s.cursor,'checkpoint-cursor-fences');
  fail(s.gap===(s.recoveryTarget>s.cursor),'checkpoint-gap');
  unique(s.commands.map(c=>c.requestId),'checkpoint-duplicate-command');
  unique(s.messages.map(m=>m.messageId),'checkpoint-duplicate-message');
  unique(s.messages.filter(m=>m.sourceKey).map(m=>m.sourceKey),'checkpoint-duplicate-source');
  for(const c of s.commands){
    fail(c.status==='deleted' ? !Object.hasOwn(c,'text') : typeof c.text==='string' && c.text.length>0,'checkpoint-command-text');
    if(['queued','cancelled'].includes(c.status)) fail(c.attempt===0,'checkpoint-command-attempt');
    if(['unknown','retry-ready'].includes(c.status)) fail(c.attempt>0,'checkpoint-command-attempt');
    if(c.status==='cancelled') fail(s.cancelled.includes(c.requestId),'checkpoint-cancellation');
    if(c.status==='queued') fail(!s.cancelled.includes(c.requestId),'checkpoint-cancellation');
  }
  for(const m of s.messages){
    fail(!s.deletedMessageIds.includes(m.messageId) && !(m.sourceKey && s.deletedSourceKeys.includes(m.sourceKey)),'checkpoint-tombstoned-message');
    const c=s.commands.find(c=>c.requestId===m.requestId);
    if(c){
      fail(c.turnId===m.turnId,'checkpoint-request-turn');
      if(m.role==='user') fail(c.status==='accepted' && c.text===m.text,'checkpoint-command-message');
    }
  }
  if(s.deleted)fail(s.draft==='' && s.messages.length===0 && s.commands.every(c=>c.status==='deleted'),'checkpoint-deleted-content');
  return value;
}
function compactCheckpoint(state){
  fail(state?.format==='ai-pet.dev.history.v1','unsupported-checkpoint-state');
  fail(Object.keys(state).every(k=>['format','binding','epoch','retiredEpochs',...STATE_FIELDS].includes(k)),'unexpected-checkpoint-state-field');
  const value={format:'ai-pet.dev.checkpoint.v1',binding:structuredClone(state.binding),previousActivations:[...(state.retiredEpochs||[]),state.epoch],state:Object.fromEntries(STATE_FIELDS.map(k=>[k,structuredClone(state[k])]))};
  value.integritySha256=digest(value);
  check(value);
  fail(Buffer.byteLength(JSON.stringify(value),'utf8')<=MAX_BYTES,'checkpoint-capacity');
  return value;
}
function restoreCheckpoint(serialized,host){
  fail(typeof serialized==='string' && Buffer.byteLength(serialized,'utf8')<=MAX_BYTES,'checkpoint-capacity');
  // Host context is mandatory and independent of the saved value.
  fail(host && host.expectedBinding && typeof host.freshEpoch==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(host.freshEpoch),'checkpoint-host-context-required');
  const value=check(JSON.parse(serialized));
  fail(FIELDS.every(k=>host.expectedBinding[k]===value.binding[k]),'checkpoint-host-binding');
  fail(!value.previousActivations.includes(host.freshEpoch),'checkpoint-activation-reuse');
  // No saved epoch is activated. Unknown commands remain unknown; effects stay empty.
  const state={format:'ai-pet.dev.history.v1',binding:structuredClone(value.binding),epoch:host.freshEpoch,retiredEpochs:structuredClone(value.previousActivations),...structuredClone(value.state)};
  return {state,effects:[]};
}
module.exports={compactCheckpoint,restoreCheckpoint};
