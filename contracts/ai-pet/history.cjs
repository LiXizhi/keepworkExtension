'use strict';
// Synthetic reference only: caller-supplied events are NOT authenticated here.
const { createHash } = require('node:crypto');
const FIELDS=['accountId','homeRegion','characterId','characterVersion','conversationId'];
const copy=x=>structuredClone(x);
const fail=(ok,reason)=>{if(!ok) throw new Error(reason);};
const id=x=>typeof x==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):x && typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const fingerprint=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
function context(binding,epoch){
  fail(binding && FIELDS.every(k=>id(binding[k])) && id(epoch),'invalid-history-context');
  return {binding:Object.fromEntries(FIELDS.map(k=>[k,binding[k]])),epoch};
}
function create(binding,epoch){
  return {...context(binding,epoch),format:'ai-pet.dev.history.v1',draft:'',commands:[],messages:[],cursor:0,gap:false,recoveryTarget:0,events:[],cancelled:[],deletedMessageIds:[],deletedSourceKeys:[],deleted:false};
}
function message(m){
  fail(m && ['messageId','requestId','turnId'].every(k=>id(m[k])) && ['user','assistant'].includes(m.role) && typeof m.text==='string' && m.text.length>0 && m.text.length<=32000 && (m.sourceKey===undefined || id(m.sourceKey)),'invalid-history-message');
  fail(Object.keys(m).every(k=>['messageId','requestId','turnId','role','text','sourceKey'].includes(k)),'unexpected-message-field');
}
function insert(s,m){
  message(m);
  const command=s.commands.find(c=>c.requestId===m.requestId);
  const tombstoned=s.deleted || s.deletedMessageIds.includes(m.messageId) || (m.sourceKey && s.deletedSourceKeys.includes(m.sourceKey));
  if(tombstoned){
    if(!s.deletedMessageIds.includes(m.messageId)) s.deletedMessageIds.push(m.messageId);
    if(m.sourceKey && !s.deletedSourceKeys.includes(m.sourceKey)) s.deletedSourceKeys.push(m.sourceKey);
    if(command && m.role==='user'){fail(command.turnId===m.turnId,'request-turn-conflict');delete command.text;command.status='deleted';}
    return;
  }
  if(m.role==='assistant' && s.cancelled.includes(m.requestId)) return;
  if(command) {
    fail(command.turnId===m.turnId,'request-turn-conflict');
    if(m.role==='user'){fail(command.text===m.text,'accepted-command-content-conflict');command.status='accepted';}
  }
  const old=s.messages.find(x=>x.messageId===m.messageId || (m.sourceKey && x.sourceKey===m.sourceKey));
  if(old) {fail(fingerprint(old)===fingerprint(m),'message-identity-conflict');return;}
  s.messages.push(copy(m));
}
function reduce(previous,action){
  fail(previous?.format==='ai-pet.dev.history.v1','invalid-history-state');
  fail(action && typeof action.type==='string','invalid-history-action');
  // Epoch is minted by the host for each activation, including switching back.
  fail(action.epoch===previous.epoch && action.binding && FIELDS.every(k=>action.binding[k]===previous.binding[k]),'stale-history-context');
  const s=copy(previous),effects=[];
  const find=()=>{fail(id(action.requestId),'invalid-request-id');const c=s.commands.find(x=>x.requestId===action.requestId);fail(c,'unknown-request');return c;};
  switch(action.type){
    case 'draft':
      fail(!s.deleted && typeof action.text==='string' && action.text.length<=32000,'invalid-draft');s.draft=action.text;break;
    case 'queue': {
      fail(!s.deleted && id(action.requestId) && id(action.turnId) && s.draft.length>0,'invalid-append');
      fail(!s.commands.some(c=>c.requestId===action.requestId),'duplicate-command');
      s.commands.push({requestId:action.requestId,turnId:action.turnId,text:s.draft,status:'queued',attempt:0});s.draft='';break;
    }
    case 'dispatch': {
      const c=find();fail(!s.deleted && !s.cancelled.includes(c.requestId),'cancelled-or-deleted-command');
      if(c.status==='unknown') {effects.push({type:'query-outcome',requestId:c.requestId,attempt:c.attempt});break;}
      fail(c.status==='queued' || c.status==='retry-ready','command-not-dispatchable');
      // Persist this state BEFORE executing the returned effect. Crash => query, not replay.
      c.attempt+=1;c.status='unknown';effects.push({type:'append',...copy(c),binding:copy(s.binding)});break;
    }
    case 'outcome': {
      const c=find();fail(['unknown','accepted','definitively-absent'].includes(action.outcome),'invalid-outcome');
      fail(c.status==='unknown','unexpected-outcome');
      fail(action.attempt===c.attempt,'stale-outcome-attempt');
      c.status=action.outcome==='definitively-absent'?'retry-ready':action.outcome;
      break;
    }
    case 'cancel': {
      fail(id(action.requestId),'invalid-request-id');
      if(!s.cancelled.includes(action.requestId)) s.cancelled.push(action.requestId);
      // Cancel generation is distinct from deleting accepted transcript/history.
      const c=s.commands.find(x=>x.requestId===action.requestId);
      if(c && c.status==='queued') c.status='cancelled';
      effects.push({type:'cancel-generation',requestId:action.requestId});break;
    }
    case 'server': {
      const e=action.event;
      fail(e && Number.isSafeInteger(e.sequence) && e.sequence>0 && ['message','import-snapshot','delete-message','delete-conversation','cancelled'].includes(e.kind),'invalid-server-event');
      const digest=fingerprint(e);
      if(e.sequence<=s.cursor){fail(s.events[e.sequence-1]===digest,'conflicting-server-sequence');break;}
      if(e.sequence!==s.cursor+1){s.gap=true;s.recoveryTarget=Math.max(s.recoveryTarget,e.sequence);effects.push({type:'recover-after',cursor:s.cursor});break;}
      switch(e.kind){
        case 'message': insert(s,e.message);break;
        case 'import-snapshot':
          fail(Array.isArray(e.messages) && e.messages.length<=200,'invalid-import-snapshot');
          // Pre-authorized immutable historical rows only; no inference effects.
          for(const m of e.messages){fail(id(m.sourceKey),'missing-source-key');insert(s,m);}break;
        case 'delete-message': {
          fail(id(e.messageId) && (e.sourceKey===undefined || id(e.sourceKey)),'invalid-deletion-binding');
          const sources=new Set(s.messages.filter(m=>m.messageId===e.messageId && m.sourceKey).map(m=>m.sourceKey));
          if(e.sourceKey) sources.add(e.sourceKey);
          const deletedRequests=s.messages.filter(m=>(m.messageId===e.messageId || sources.has(m.sourceKey)) && m.role==='user').map(m=>m.requestId);
          s.commands=s.commands.map(command=>{if(!deletedRequests.includes(command.requestId)) return command;const {text,...identity}=command;return {...identity,status:'deleted'};});
          if(!s.deletedMessageIds.includes(e.messageId)) s.deletedMessageIds.push(e.messageId);
          for(const key of sources) if(!s.deletedSourceKeys.includes(key)) s.deletedSourceKeys.push(key);
          for(const m of s.messages) if((m.messageId===e.messageId || sources.has(m.sourceKey)) && !s.deletedMessageIds.includes(m.messageId)) s.deletedMessageIds.push(m.messageId);
          s.messages=s.messages.filter(m=>m.messageId!==e.messageId && !sources.has(m.sourceKey));break;
        }
        case 'delete-conversation':
          s.deleted=true;s.messages=[];s.draft='';
          s.commands=s.commands.map(({text,...command})=>({...command,status:'deleted'}));break;
        case 'cancelled':
          fail(id(e.requestId),'invalid-cancellation');
          if(!s.cancelled.includes(e.requestId)) s.cancelled.push(e.requestId);break;
      }
      s.cursor=e.sequence;s.events.push(digest);s.gap=s.cursor<s.recoveryTarget;break;
    }
    default: throw new Error('unknown-history-action');
  }
  return {state:s,effects};
}
function createJournal(binding,epoch){return {format:'ai-pet.dev.journal.v1',...context(binding,epoch),actions:[]};}
function restoreJournal(serialized){
  const j=JSON.parse(serialized);
  fail(j?.format==='ai-pet.dev.journal.v1' && Array.isArray(j.actions) && j.actions.length<=10000,'invalid-journal');
  let state=create(j.binding,j.epoch);
  for(const action of j.actions) state=reduce(state,action).state;
  // Effects are intentionally discarded. Host must reconcile unknown commands.
  return {journal:copy(j),state,effects:[]};
}
function appendJournal(journal,action){
  const {state}=restoreJournal(JSON.stringify(journal));
  const next=reduce(state,action);
  fail(journal.actions.length<10000,'journal-capacity');
  return {journal:{...copy(journal),actions:[...copy(journal.actions),copy(action)]},...next};
}
module.exports={create,reduce,createJournal,appendJournal,restoreJournal};
