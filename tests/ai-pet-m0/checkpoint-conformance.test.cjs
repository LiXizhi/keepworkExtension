'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const h=require('../../contracts/ai-pet/history.cjs');
const c=require('../../contracts/ai-pet/checkpoint.cjs');
const binding={accountId:'qa-account',homeRegion:'qa-region',characterId:'qa-character',characterVersion:'1',conversationId:'qa-chat'};
const initial='qa-old';
const text='QA erased synthetic payload';
const act=(state,type,rest={})=>({binding,epoch:state.epoch,type,...rest});
const apply=(s,type,rest={})=>h.reduce(s,act(s,type,rest)).state;
const event=(s,e)=>apply(s,'server',{event:e});
function journal(){
 let j=h.createJournal(binding,initial);
 for(const a of [{type:'draft',text},{type:'queue',requestId:'qa-r',turnId:'qa-t'},{type:'dispatch',requestId:'qa-r'}]) j=h.appendJournal(j,{binding,epoch:initial,...a}).journal;
 return j;
}
const restore=(state,freshEpoch='qa-new')=>c.restoreCheckpoint(JSON.stringify(c.compactCheckpoint(state)),{expectedBinding:binding,freshEpoch});
const message={messageId:'qa-m',requestId:'qa-r',turnId:'qa-t',role:'user',text,sourceKey:'qa-source'};

test('QA checkpoint: compact deletion removes payload but cannot erase existing log copies',()=>{
 let j=journal();
 for(const e of [{sequence:1,kind:'message',message},{sequence:2,kind:'delete-message',messageId:'alias',sourceKey:'qa-source'}]) j=h.appendJournal(j,{binding,epoch:initial,type:'server',event:e}).journal;
 const original=JSON.stringify(j);
 const state=h.restoreJournal(original).state;
 const cp=c.compactCheckpoint(state), encoded=JSON.stringify(cp);
 assert.ok(original.includes(text),'original append-only journal still requires independent disposal');
 assert.equal(encoded.includes(text),false);
 assert.equal(Object.hasOwn(cp,'actions'),false);
 let r=c.restoreCheckpoint(encoded,{expectedBinding:binding,freshEpoch:'qa-new'});
 assert.deepEqual(r.effects,[]);
 // Both source aliases and the previously removed canonical ID must stay deleted.
 r.state=event(r.state,{sequence:3,kind:'import-snapshot',messages:[{...message,messageId:'later-alias'}]});
 const ordinary={...message};delete ordinary.sourceKey;
 r.state=event(r.state,{sequence:4,kind:'message',message:ordinary});
 assert.deepEqual(r.state.messages,[]);
 assert.equal(JSON.stringify(c.compactCheckpoint(r.state)).includes(text),false);
 assert.equal(JSON.stringify(j),original);
});

test('QA checkpoint: repeated restore fences retired callbacks and queries uncertain attempt',()=>{
 const saved=h.restoreJournal(JSON.stringify(journal())).state;
 const a=restore(saved), b=restore(a.state,'qa-third');
 assert.deepEqual(a.effects,[]);assert.deepEqual(b.effects,[]);
 for(const epoch of [initial,'qa-new']){
  assert.throws(()=>h.reduce(b.state,{binding,epoch,type:'outcome',requestId:'qa-r',attempt:1,outcome:'definitively-absent'}),/context/);
  assert.throws(()=>restore(b.state,epoch),/activation-reuse/);
 }
 assert.deepEqual(h.reduce(b.state,act(b.state,'dispatch',{requestId:'qa-r'})).effects,[{type:'query-outcome',requestId:'qa-r',attempt:1}]);
 assert.equal(b.state.commands[0].status,'unknown');
});

test('QA checkpoint: host binding is required in every dimension without mutating saved state',()=>{
 const state=h.restoreJournal(JSON.stringify(journal())).state;
 const encoded=JSON.stringify(c.compactCheckpoint(state));
 assert.throws(()=>c.restoreCheckpoint(encoded));
 for(const key of Object.keys(binding)){
  assert.throws(()=>c.restoreCheckpoint(encoded,{expectedBinding:{...binding,[key]:'qa-other'},freshEpoch:'qa-new'}),/host-binding/);
 }
 assert.equal(JSON.stringify(c.compactCheckpoint(state)),encoded);
});

test('QA checkpoint: cursor gap and cancelled generation remain fenced after restart',()=>{
 let s=h.create(binding,initial);
 s=event(s,{sequence:1,kind:'message',message});
 s=apply(s,'cancel',{requestId:'qa-r'});
 s=event(s,{sequence:4,kind:'cancelled',requestId:'qa-r'});
 s=restore(s).state;
 assert.equal(s.cursor,1);assert.equal(s.recoveryTarget,4);assert.equal(s.gap,true);
 assert.throws(()=>event(s,{sequence:1,kind:'message',message:{...message,text:'conflicting'}}),/conflicting/);
 s=event(s,{sequence:2,kind:'message',message:{...message,messageId:'reply',sourceKey:'reply-source',role:'assistant'}});
 assert.deepEqual(s.messages,[message]);assert.equal(s.gap,true);
 s=event(s,{sequence:3,kind:'cancelled',requestId:'other'});
 s=event(s,{sequence:4,kind:'cancelled',requestId:'qa-r'});
 assert.equal(s.gap,false);
});

test('QA checkpoint: corrupt or structurally inconsistent payload cannot restore even with a fresh digest',()=>{
 const {createHash}=require('node:crypto');
 const canonical=x=>Array.isArray(x)?x.map(canonical):x && typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
 const state=h.restoreJournal(JSON.stringify(journal())).state;
 const original=JSON.stringify(c.compactCheckpoint(state));
 const host={expectedBinding:binding,freshEpoch:'qa-new'};
 const corrupt=JSON.parse(original);corrupt.state.draft='changed';
 assert.throws(()=>c.restoreCheckpoint(JSON.stringify(corrupt),host),/integrity/);
 for(const change of [v=>{v.format='unknown-version';},v=>{v.state.commands[0].attempt=0;},v=>{v.state.deleted=true;},v=>{v.state.cursor=1;},v=>{v.state.actions=[];}]){
  const v=JSON.parse(original);change(v);delete v.integritySha256;
  v.integritySha256=createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
  assert.throws(()=>c.restoreCheckpoint(JSON.stringify(v),host));
 }
 assert.equal(JSON.stringify(c.compactCheckpoint(state)),original);
});
