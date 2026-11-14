'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const h=require('../history.cjs');
const c=require('../checkpoint.cjs');
const binding={accountId:'dev-a',homeRegion:'dev-region',characterId:'dev-character',characterVersion:'1',conversationId:'dev-conversation'};
const action=(s,type,rest={})=>({binding,epoch:s.epoch,type,...rest});
const apply=(s,type,rest={})=>h.reduce(s,action(s,type,rest)).state;
const server=(s,sequence,kind,rest={})=>apply(s,'server',{event:{sequence,kind,...rest}});
const message={messageId:'m1',requestId:'r1',turnId:'t1',role:'user',text:'PRIVATE SYNTHETIC DELETED TEXT',sourceKey:'source1'};
const host={expectedBinding:binding,freshEpoch:'activation-2'};
function pending(){let s=h.create(binding,'activation-1');s=apply(s,'draft',{text:message.text});s=apply(s,'queue',{requestId:'r1',turnId:'t1'});return apply(s,'dispatch',{requestId:'r1'});}
function load(s,context=host){return c.restoreCheckpoint(JSON.stringify(c.compactCheckpoint(s)),context);}
function resign(v){const canonical=x=>Array.isArray(x)?x.map(canonical):x && typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;delete v.integritySha256;v.integritySha256=createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');return JSON.stringify(v);}
test('checkpoint removes obsolete actions/deleted text, retains tombstones through reload and stale import',()=>{
  let s=server(pending(),1,'message',{message});s=server(s,2,'delete-message',{messageId:'m1'});
  const checkpoint=c.compactCheckpoint(s), encoded=JSON.stringify(checkpoint);
  assert.equal(encoded.includes(message.text),false);assert.equal(Object.hasOwn(checkpoint,'actions'),false);
  let restored=c.restoreCheckpoint(encoded,host);assert.deepEqual(restored.effects,[]);
  s=server(restored.state,3,'import-snapshot',{messages:[{...message,messageId:'alias'}]});
  assert.deepEqual(s.messages,[]);assert.equal(JSON.stringify(c.compactCheckpoint(s)).includes(message.text),false);
  assert.equal(s.commands[0].status,'deleted');
});
test('host supplies exact binding and new activation, including after switch-back and multiple checkpoints',()=>{
  const s=pending(),encoded=JSON.stringify(c.compactCheckpoint(s));
  assert.throws(()=>c.restoreCheckpoint(encoded),/host-context/);
  for(const field of Object.keys(binding))assert.throws(()=>c.restoreCheckpoint(encoded,{...host,expectedBinding:{...binding,[field]:'other'}}),/host-binding/);
  assert.throws(()=>c.restoreCheckpoint(encoded,{...host,freshEpoch:'activation-1'}),/activation-reuse/);
  const r=c.restoreCheckpoint(encoded,host).state;
  assert.throws(()=>h.reduce(r,action(s,'dispatch',{requestId:'r1'})),/stale-history/);
  const next=load(r,{...host,freshEpoch:'activation-3'}).state;
  for(const freshEpoch of ['activation-1','activation-2','activation-3'])assert.throws(()=>load(next,{...host,freshEpoch}),/activation-reuse/);
});
test('unknown outcome resumes query-only with stable request/turn/attempt; load never emits effects',()=>{
  const r=load(pending());assert.deepEqual(r.effects,[]);
  assert.deepEqual(r.state.commands,[{requestId:'r1',turnId:'t1',text:message.text,status:'unknown',attempt:1}]);
  assert.deepEqual(h.reduce(r.state,action(r.state,'dispatch',{requestId:'r1'})).effects,[{type:'query-outcome',requestId:'r1',attempt:1}]);
});
test('all old sequence digests and outstanding gap target survive checkpointing',()=>{
  let s=server(h.create(binding,'activation-1'),1,'message',{message});s=server(s,3,'cancelled',{requestId:'r1'});
  const r=load(s).state;assert.equal(r.cursor,1);assert.equal(r.gap,true);assert.equal(r.recoveryTarget,3);
  assert.deepEqual(server(r,1,'message',{message}),r);
  assert.throws(()=>server(r,1,'message',{message:{...message,text:'conflict'}}),/conflicting-server/);
  s=server(r,2,'cancelled',{requestId:'r2'});assert.equal(s.gap,true);
  s=server(s,3,'cancelled',{requestId:'r1'});assert.equal(s.gap,false);
});
test('corrupt, unsupported, unknown-property, oversized and internally inconsistent checkpoints fail atomically',()=>{
  const original=pending(),cp=c.compactCheckpoint(original),saved=structuredClone(original);
  const mutations=[
    v=>{v.format='future';}, v=>{v.extra=true;}, v=>{v.state.cursor=1;},
    v=>{v.state.gap=true;},v=>{v.state.commands[0].attempt=0;},
    v=>{v.state.commands.push({...v.state.commands[0]});},v=>{v.state.commands[0].status='deleted';},
    v=>{v.state.deleted=true;},v=>{v.previousActivations.push(v.previousActivations[0]);},
    v=>{v.state.draft='x'.repeat(32001);}
  ];
  for(const mutate of mutations){const value=structuredClone(cp);mutate(value);assert.throws(()=>c.restoreCheckpoint(resign(value),host));}
  const bad=structuredClone(cp);bad.state.draft='corrupted';assert.throws(()=>c.restoreCheckpoint(JSON.stringify(bad),host),/integrity/);
  assert.throws(()=>c.restoreCheckpoint('{',host));
  assert.throws(()=>c.restoreCheckpoint(' '.repeat(8*1024*1024+1),host),/capacity/);
  assert.deepEqual(original,saved);
});
test('strict state validation rejects message tombstones, conflicting bindings and dropped replay fences',()=>{
  const s=server(pending(),1,'message',{message});
  for(const mutate of [v=>v.deletedMessageIds.push('m1'),v=>v.deletedSourceKeys.push('source1'),v=>{v.commands[0].text='other';},v=>{v.commands[0].turnId='other';},v=>{v.events=[];}]){const changed=structuredClone(s);mutate(changed);assert.throws(()=>c.compactCheckpoint(changed),/checkpoint/);}
});
test('source-alias deletion scrubs command plaintext and fences the removed canonical ID too',()=>{
  let s=server(pending(),1,'message',{message});s=server(s,2,'delete-message',{messageId:'other-id',sourceKey:'source1'});
  assert.equal(JSON.stringify(c.compactCheckpoint(s)).includes(message.text),false);
  const ordinary={...message};delete ordinary.sourceKey;
  s=server(load(s).state,3,'message',{message:ordinary});assert.deepEqual(s.messages,[]);
});
test('delete before pending acknowledgement scrubs pending payload when late user mapping arrives',()=>{
  let s=server(pending(),1,'delete-message',{messageId:'m1'});
  s=server(s,2,'message',{message});
  assert.equal(s.commands[0].status,'deleted');assert.equal(JSON.stringify(c.compactCheckpoint(s)).includes(message.text),false);
});
test('cancellation survives reload and still suppresses late generation without erasing existing history',()=>{
  let s=server(pending(),1,'message',{message});s=apply(s,'cancel',{requestId:'r1'});
  s=server(load(s).state,2,'message',{message:{...message,messageId:'reply',sourceKey:'reply-source',role:'assistant'}});
  assert.equal(s.messages.length,1);assert.deepEqual(s.cancelled,['r1']);
});
test('late tombstoned row learns an independently supplied source alias for future imports',()=>{
  let s=server(h.create(binding,'activation-1'),1,'delete-message',{messageId:'m1'});
  s=server(s,2,'message',{message});
  s=server(load(s).state,3,'import-snapshot',{messages:[{...message,messageId:'alias'}]});
  assert.deepEqual(s.messages,[]);assert.deepEqual(s.deletedSourceKeys,['source1']);
});
