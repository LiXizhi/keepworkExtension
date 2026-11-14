'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const h=require('../history.cjs');const c=require('../checkpoint.cjs');
const fixture=require('../fixtures/checkpoint-scenarios.json');
assert.equal(fixture.format,'ai-pet.dev.checkpoint-scenarios.v1');
function partial(actual,expected){if(Array.isArray(expected)){assert.equal(actual.length,expected.length);expected.forEach((e,i)=>partial(actual[i],e));}else if(expected && typeof expected==='object'){for(const [k,v] of Object.entries(expected))partial(actual[k],v);}else assert.deepEqual(actual,expected);}
for(const scenario of fixture.scenarios)test(`portable checkpoint: ${scenario.id}`,()=>{
  const load=()=>c.restoreCheckpoint(JSON.stringify(scenario.checkpoint),scenario.host);
  if(scenario.expectError){assert.throws(load,{message:scenario.expectError});return;}
  const restored=load();assert.deepEqual(restored.effects,[]);
  if(scenario.expectState)partial(restored.state,scenario.expectState);
  if(scenario.nextAction){
    const next=()=>h.reduce(restored.state,scenario.nextAction);
    if(scenario.expectNextError){assert.throws(next,{message:scenario.expectNextError});return;}
    const r=next();if(scenario.expectNextState)partial(r.state,scenario.expectNextState);if(scenario.expectNextEffects)partial(r.effects,scenario.expectNextEffects);
  }
});
