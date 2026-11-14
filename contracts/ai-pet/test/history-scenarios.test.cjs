'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const h=require('../history.cjs');
const fixtures=require('../fixtures/history-scenarios.json');
function partial(actual,expected){
  if(Array.isArray(expected)){assert.equal(actual.length,expected.length);expected.forEach((e,i)=>partial(actual[i],e));}
  else if(expected && typeof expected==='object'){for(const [k,v] of Object.entries(expected)) partial(actual[k],v);}
  else assert.deepEqual(actual,expected);
}
for(const scenario of fixtures.scenarios) test(`portable history: ${scenario.id}`,()=>{
  let journal=h.createJournal(fixtures.initial.binding,fixtures.initial.epoch);
  for(const step of scenario.steps){
    if(step.expectError){assert.throws(()=>h.appendJournal(journal,step.action),{message:step.expectError});continue;}
    const result=step.reload ? h.restoreJournal(JSON.stringify(journal)) : h.appendJournal(journal,step.action);
    journal=result.journal;
    if(step.expectState) partial(result.state,step.expectState);
    if(step.expectEffects) partial(result.effects,step.expectEffects);
  }
});
