'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const h=require('../history.cjs');
const b={accountId:'dev-a',homeRegion:'dev-region',characterId:'dev-character',characterVersion:'1',conversationId:'dev-conversation'};
const action=(type,rest={})=>({binding:b,epoch:'activation-1',type,...rest});
const msg=(rest={})=>({messageId:'m1',requestId:'r1',turnId:'t1',role:'user',text:'Synthetic draft',sourceKey:'source-1',...rest});
const event=(sequence,kind,rest={})=>action('server',{event:{sequence,kind,...rest}});
function queued(){let s=h.create(b,'activation-1');s=h.reduce(s,action('draft',{text:'Synthetic draft'})).state;return h.reduce(s,action('queue',{requestId:'r1',turnId:'t1'})).state;}
test('draft is not history; uncertain append queries before an explicit identity-preserving retry',()=>{
  let s=queued();assert.equal(s.messages.length,0);assert.equal(s.commands[0].status,'queued');
  let r=h.reduce(s,action('dispatch',{requestId:'r1'}));assert.equal(r.effects[0].type,'append');s=r.state;
  r=h.reduce(s,action('dispatch',{requestId:'r1'}));assert.equal(r.effects[0].type,'query-outcome');
  s=h.reduce(r.state,action('outcome',{requestId:'r1',attempt:1,outcome:'unknown'})).state;
  assert.equal(h.reduce(s,action('dispatch',{requestId:'r1'})).effects[0].type,'query-outcome');
  r=h.reduce(s,action('outcome',{requestId:'r1',attempt:1,outcome:'definitively-absent'}));assert.deepEqual(r.effects,[]);
  r=h.reduce(r.state,action('dispatch',{requestId:'r1'}));assert.equal(r.effects[0].requestId,'r1');assert.equal(r.effects[0].turnId,'t1');assert.equal(r.effects[0].text,'Synthetic draft');
});
test('accepted events bind pending identity, never replace the submitted content',()=>{
  let s=h.reduce(queued(),action('dispatch',{requestId:'r1'})).state;
  assert.throws(()=>h.reduce(s,event(1,'message',{message:msg({text:'injected'})})),/content-conflict/);
  assert.throws(()=>h.reduce(s,event(1,'message',{message:msg({turnId:'other'})})),/turn-conflict/);
  s=h.reduce(s,event(1,'message',{message:msg()})).state;
  assert.equal(s.commands[0].status,'accepted');assert.equal(s.messages.length,1);
  assert.throws(()=>h.reduce(s,action('dispatch',{requestId:'r1'})),/not-dispatchable/);
});
test('cursor gaps require replay; duplicates do not mutate; conflicting duplicate sequences fail',()=>{
  let s=h.create(b,'activation-1');
  let r=h.reduce(s,event(3,'message',{message:msg({messageId:'m3',sourceKey:'source-3'})}));
  assert.deepEqual(r.effects,[{type:'recover-after',cursor:0}]);assert.equal(r.state.messages.length,0);assert.equal(r.state.cursor,0);
  s=h.reduce(r.state,event(1,'message',{message:msg()})).state;assert.equal(s.gap,true);
  assert.deepEqual(h.reduce(s,event(1,'message',{message:msg()})).state,s);
  assert.throws(()=>h.reduce(s,event(1,'message',{message:msg({text:'conflict'})})),/conflicting-server/);
  s=h.reduce(s,event(2,'message',{message:msg({messageId:'m2',sourceKey:'source-2'})})).state;
  s=h.reduce(s,event(3,'message',{message:msg({messageId:'m3',sourceKey:'source-3'})})).state;
  assert.equal(s.cursor,3);assert.equal(s.gap,false);assert.deepEqual(s.messages.map(m=>m.messageId),['m1','m2','m3']);
});
test('account/persona switches use a fresh journal and reject callbacks including switch-back epochs',()=>{
  const s=h.create({...b,accountId:'dev-b'},'activation-2');
  assert.throws(()=>h.reduce(s,event(1,'message',{message:msg()})),/stale-history/);
  assert.throws(()=>h.reduce(h.create({...b,characterId:'other',conversationId:'other'},'activation-1'),event(1,'message',{message:msg()})),/stale-history/);
  assert.throws(()=>h.reduce(h.create(b,'activation-3'),event(1,'message',{message:msg()})),/stale-history/);
  assert.equal(s.messages.length,0);assert.equal(s.commands.length,0);
});
test('cancel stops late generated output without deleting accepted user history',()=>{
  let s=h.reduce(queued(),event(1,'message',{message:msg()})).state;
  s=h.reduce(s,action('cancel',{requestId:'r1'})).state;
  s=h.reduce(s,event(2,'message',{message:msg({messageId:'reply',sourceKey:'reply-source',role:'assistant'})})).state;
  assert.equal(s.cursor,2);assert.equal(s.messages.length,1);assert.equal(s.messages[0].role,'user');
  assert.throws(()=>h.reduce(s,action('dispatch',{requestId:'r1'})),/cancelled/);
});
test('delete before import and during snapshot batches suppresses source aliases and all later retries',()=>{
  let s=h.create(b,'activation-1');
  s=h.reduce(s,event(1,'delete-message',{messageId:'m1',sourceKey:'source-1'})).state;
  s=h.reduce(s,event(2,'import-snapshot',{messages:[msg({messageId:'alias'})]})).state;assert.equal(s.messages.length,0);
  s=h.reduce(s,event(3,'import-snapshot',{messages:[msg({messageId:'m2',sourceKey:'source-2'})]})).state;
  s=h.reduce(s,event(4,'delete-message',{messageId:'m2',sourceKey:'source-2'})).state;
  s=h.reduce(s,event(5,'import-snapshot',{messages:[msg({messageId:'new-alias',sourceKey:'source-2'})]})).state;assert.equal(s.messages.length,0);
  s=h.reduce(s,event(6,'delete-conversation')).state;
  s=h.reduce(s,event(7,'message',{message:msg({messageId:'m3',sourceKey:'source-3'})})).state;assert.equal(s.messages.length,0);
  assert.throws(()=>h.reduce(s,action('draft',{text:'new'})),/invalid-draft/);
});
test('bad snapshot is atomic and cannot partially insert rows',()=>{
  const s=h.create(b,'activation-1');
  assert.throws(()=>h.reduce(s,event(1,'import-snapshot',{messages:[msg(),msg({messageId:'other',text:'changed'})]})),/identity-conflict/);
  assert.equal(s.messages.length,0);assert.equal(s.cursor,0);
});
test('journal restart restores unknown commands and tombstones, never replays effects',()=>{
  let j=h.createJournal(b,'activation-1');
  for(const a of [action('draft',{text:'Synthetic draft'}),action('queue',{requestId:'r1',turnId:'t1'}),action('dispatch',{requestId:'r1'}),event(1,'delete-message',{messageId:'m1',sourceKey:'source-1'})]) j=h.appendJournal(j,a).journal;
  const restored=h.restoreJournal(JSON.stringify(j));assert.deepEqual(restored.effects,[]);assert.equal(restored.state.commands[0].status,'unknown');
  assert.equal(h.reduce(restored.state,action('dispatch',{requestId:'r1'})).effects[0].type,'query-outcome');
  const next=h.appendJournal(restored.journal,event(2,'import-snapshot',{messages:[msg()]}));assert.equal(next.state.messages.length,0);
  assert.throws(()=>h.restoreJournal(JSON.stringify({...j,epoch:'other'})),/stale-history/);
});
test('a delayed absence result from an earlier dispatch cannot authorize another retry',()=>{
  let s=h.reduce(queued(),action('dispatch',{requestId:'r1'})).state;
  s=h.reduce(s,action('outcome',{requestId:'r1',attempt:1,outcome:'definitively-absent'})).state;
  s=h.reduce(s,action('dispatch',{requestId:'r1'})).state;
  assert.equal(s.commands[0].attempt,2);
  assert.throws(()=>h.reduce(s,action('outcome',{requestId:'r1',attempt:1,outcome:'definitively-absent'})),/stale-outcome/);
  assert.equal(h.reduce(s,action('dispatch',{requestId:'r1'})).effects[0].type,'query-outcome');
});
test('ordinary deletion needs only canonical message identity and preserves unrelated ordinary rows',()=>{
  let s=h.create(b,'activation-1');
  const first=msg();delete first.sourceKey;
  s=h.reduce(s,event(1,'message',{message:first})).state;
  s=h.reduce(s,event(2,'message',{message:{...first,messageId:'m2'}})).state;
  s=h.reduce(s,event(3,'delete-message',{messageId:'m1'})).state;
  assert.deepEqual(s.deletedSourceKeys,[]);assert.deepEqual(s.messages.map(m=>m.messageId),['m2']);
  s=h.reduce(s,event(4,'message',{message:first})).state;
  assert.deepEqual(s.messages.map(m=>m.messageId),['m2']);
});
test('deletion retains an already established source binding without inventing one',()=>{
  let s=h.reduce(h.create(b,'activation-1'),event(1,'import-snapshot',{messages:[msg()]})).state;
  s=h.reduce(s,event(2,'delete-message',{messageId:'m1'})).state;
  s=h.reduce(s,event(3,'import-snapshot',{messages:[msg({messageId:'alias'})]})).state;
  assert.deepEqual(s.messages,[]);assert.deepEqual(s.deletedSourceKeys,['source-1']);
});
test('unsupported journal format and invalid recovery event fail without advancing original state',()=>{
  const j=h.createJournal(b,'activation-1');
  assert.throws(()=>h.restoreJournal(JSON.stringify({...j,format:'future-journal'})),/invalid-journal/);
  let s=h.reduce(h.create(b,'activation-1'),event(2,'message',{message:msg()})).state;
  const original=structuredClone(s);
  assert.throws(()=>h.reduce(s,event(1,'import-snapshot',{messages:[msg(),msg({role:'system'})]})),/invalid-history-message/);
  assert.deepEqual(s,original);assert.equal(s.cursor,0);assert.equal(s.gap,true);
});
test('conversation deletion scrubs command plaintext and leaves only non-dispatchable identity',()=>{
  let s=h.reduce(queued(),action('dispatch',{requestId:'r1'})).state;
  s=h.reduce(s,event(1,'delete-conversation')).state;
  assert.equal(JSON.stringify(s).includes('Synthetic draft'),false);
  assert.equal(s.commands[0].requestId,'r1');assert.equal(s.commands[0].status,'deleted');
  assert.throws(()=>h.reduce(s,action('dispatch',{requestId:'r1'})),/deleted/);
});
test('deleting accepted user history scrubs its command copy too',()=>{
  let s=h.reduce(queued(),event(1,'message',{message:msg()})).state;
  s=h.reduce(s,event(2,'delete-message',{messageId:'m1'})).state;
  assert.equal(JSON.stringify(s).includes('Synthetic draft'),false);
  assert.equal(s.commands[0].status,'deleted');
});
