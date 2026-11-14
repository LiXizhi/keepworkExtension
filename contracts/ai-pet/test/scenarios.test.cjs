'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {step}=require('../dev-lifecycle.cjs');
const fixture=require('../fixtures/voice-lifecycle-scenarios.json');
for(const scenario of fixture.scenarios) test(`portable scenario: ${scenario.id}`,()=>{
  let state=structuredClone(scenario.initial);
  for(const event of scenario.steps){
    state=step(state,event);
    for(const [key,value] of Object.entries(event.expect)) assert.deepEqual(state[key],value,`${scenario.id}/${event.event}/${key}`);
  }
});
test('portable model refuses an unrecognized event',()=>assert.throws(()=>step({}, {event:'unknown'}),/unknown-scenario/));
test('missing resume checks and revoked lease never reactivate capture',()=>{
  const state={session:'paused',capture:false,leaseValid:false};
  assert.equal(step(state,{event:'user-resume'}).capture,false);
  assert.equal(step(state,{event:'user-resume',checks:{permission:true,lease:true,entitlement:true,audioFocus:true,nativeStartEligible:true}}).capture,false);
});
test('expiry and revocation are terminal even after reconnect, interruption and valid resume checks',()=>{
  const checks={permission:true,lease:true,entitlement:true,audioFocus:true,nativeStartEligible:true};
  for(const event of ['lease-expired','lease-revoked']) {
    let state=step({session:'active',capture:true,playback:true,leaseGeneration:2,turnGeneration:3},{event});
    for(const next of [{event:'transport-restored'},{event:'network-loss'},{event:'user-resume',checks},{event:'output',leaseGeneration:2,turnGeneration:3}]) {
      state=step(state,next);
      assert.equal(state.session,'ended');
      assert.equal(state.capture,false);
      assert.equal(state.playback,false);
    }
    assert.equal(state.accepted,false);
  }
});
