'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const history = require('../../contracts/ai-pet/history.cjs');
const binding = { accountId:'qa-a', homeRegion:'qa-region', characterId:'qa-pet', characterVersion:'1', conversationId:'qa-chat' };
const epoch = 'qa-activation';
const action = (type, rest={}) => ({ type, binding, epoch, ...rest });
function queued() {
  let journal = history.createJournal(binding, epoch);
  for (const a of [action('draft',{text:'Synthetic pending message'}), action('queue',{requestId:'qa-request',turnId:'qa-turn'}), action('dispatch',{requestId:'qa-request'})]) {
    journal = history.appendJournal(journal,a).journal;
  }
  return journal;
}
test('QA history: crash recovery emits no append and retains uncertain request identity', () => {
  const journal=queued();
  const restored=history.restoreJournal(JSON.stringify(journal));
  assert.deepEqual(restored.effects,[]);
  assert.equal(restored.state.commands[0].status,'unknown');
  const retry=history.reduce(restored.state,action('dispatch',{requestId:'qa-request'}));
  assert.deepEqual(retry.effects,[{type:'query-outcome',requestId:'qa-request',attempt:1}]);
  assert.equal(retry.state.commands.length,1);
});
test('QA history: wrong account or stale activation cannot mutate restored state', () => {
  const state=history.restoreJournal(JSON.stringify(queued())).state;
  const original=structuredClone(state);
  for(const bad of [{binding:{...binding,accountId:'qa-b'}},{binding:{...binding,homeRegion:'other'}},{epoch:'stale'}]) {
    assert.throws(()=>history.reduce(state,action('draft',{text:'Wrong scope',...bad})),/context/);
    assert.deepEqual(state,original);
  }
});
test('QA history: rejected multirow import is atomic', () => {
  const state=history.create(binding,epoch), original=structuredClone(state);
  const m={messageId:'m1',requestId:'r1',turnId:'t1',role:'user',text:'Synthetic',sourceKey:'src1'};
  assert.throws(()=>history.reduce(state,action('server',{event:{sequence:1,kind:'import-snapshot',messages:[m,{...m,messageId:'m2',role:'system'}]}})));
  assert.deepEqual(state,original);
});
test('QA history: deletion fences stale imported identity across replay', () => {
  let journal=history.createJournal(binding,epoch);
  const m={messageId:'m1',requestId:'r1',turnId:'t1',role:'user',text:'Synthetic',sourceKey:'src1'};
  for(const event of [
    {sequence:1,kind:'import-snapshot',messages:[m]},
    {sequence:2,kind:'delete-message',messageId:'m1',sourceKey:'src1'},
    {sequence:3,kind:'import-snapshot',messages:[{...m,messageId:'m2'}]}
  ]) journal=history.appendJournal(journal,action('server',{event})).journal;
  const restored=history.restoreJournal(JSON.stringify(journal));
  assert.deepEqual(restored.state.messages,[]);
  assert.deepEqual(restored.effects,[]);
});
test('QA history: ordinary accepted message can be deleted without inventing a source identity', () => {
  let state=history.create(binding,epoch);
  state=history.reduce(state,action('server',{event:{sequence:1,kind:'message',message:{messageId:'m1',requestId:'r1',turnId:'t1',role:'user',text:'Synthetic'}}})).state;
  const deleted=history.reduce(state,action('server',{event:{sequence:2,kind:'delete-message',messageId:'m1'}}));
  assert.deepEqual(deleted.state.messages,[]);
});
test('QA history: equivalent duplicate JSON event ignores object property order', () => {
  const m={messageId:'m1',requestId:'r1',turnId:'t1',role:'user',text:'Synthetic'};
  const first={sequence:1,kind:'message',message:m};
  const state=history.reduce(history.create(binding,epoch),action('server',{event:first})).state;
  const reordered={message:{text:m.text,role:m.role,turnId:m.turnId,requestId:m.requestId,messageId:m.messageId},kind:'message',sequence:1};
  assert.deepEqual(history.reduce(state,action('server',{event:reordered})).state,state);
});
test('QA history: deleted conversation projection does not retain pending plaintext', () => {
  const state=history.restoreJournal(JSON.stringify(queued())).state;
  const deleted=history.reduce(state,action('server',{event:{sequence:1,kind:'delete-conversation'}})).state;
  assert.equal(deleted.deleted,true);
  assert.equal(JSON.stringify(deleted).includes('Synthetic pending message'),false);
});

test('QA history: source-key deletion alias scrubs the suppressed user command copy', () => {
  let state=history.restoreJournal(JSON.stringify(queued())).state;
  const text=state.commands[0].text;
  state=history.reduce(state,action('server',{event:{sequence:1,kind:'message',message:{messageId:'accepted-id',requestId:'qa-request',turnId:'qa-turn',role:'user',text,sourceKey:'shared-source'}}})).state;
  const deleted=history.reduce(state,action('server',{event:{sequence:2,kind:'delete-message',messageId:'other-alias',sourceKey:'shared-source'}})).state;
  assert.deepEqual(deleted.messages,[]);
  assert.equal(JSON.stringify(deleted).includes(text),false,'suppressed accepted user text remains in command copy');
  assert.equal(deleted.commands[0].status,'deleted');
  assert.ok(deleted.deletedSourceKeys.includes('shared-source'));
});

test('QA history: tombstone before late acceptance erases the matching uncertain command only', () => {
  let state=history.restoreJournal(JSON.stringify(queued())).state;
  const text=state.commands[0].text;
  state=history.reduce(state,action('draft',{text:'Unrelated pending text'})).state;
  state=history.reduce(state,action('queue',{requestId:'unrelated',turnId:'unrelated-turn'})).state;
  state=history.reduce(state,action('server',{event:{sequence:1,kind:'delete-message',messageId:'old-alias',sourceKey:'shared-source'}})).state;
  assert.equal(state.commands[0].text,text); // no request identity can be inferred from source tombstone alone
  state=history.reduce(state,action('server',{event:{sequence:2,kind:'message',message:{messageId:'new-alias',requestId:'qa-request',turnId:'qa-turn',role:'user',text,sourceKey:'shared-source'}}})).state;
  assert.equal(JSON.stringify(state).includes(text),false);
  assert.equal(state.commands[0].status,'deleted');
  assert.equal(state.commands[1].text,'Unrelated pending text');
  assert.deepEqual(state.messages,[]);
});
