'use strict';
// Deterministic OFFLINE test model. Never authorizes real capture or imports data.
function step(previous, event) {
  const s = { playback:false, leaseValid:true, ...previous };
  switch (event.event) {
    case 'background': case 'lock': case 'transport-restored': return s;
    case 'network-loss':
      return s.session === 'ended' ? s : {...s,session:'paused',capture:false,playback:false};
    case 'lease-expired': case 'lease-revoked':
      return {...s,session:'ended',capture:false,playback:false,leaseValid:false};
    case 'user-resume': {
      const admitted = s.session === 'paused' && s.leaseValid && ['permission','lease','entitlement','audioFocus','nativeStartEligible'].every(k=>event.checks?.[k]===true);
      return admitted ? {...s,session:'active',capture:true} : s;
    }
    case 'spoken-interruption':
      return {...s,turnGeneration:s.turnGeneration+1,playback:false};
    case 'output': {
      const accepted = s.session==='active' && s.leaseValid && event.leaseGeneration===s.leaseGeneration && event.turnGeneration===s.turnGeneration;
      return {...s,accepted,playback:accepted ? true : s.playback};
    }
    case 'migration-binding':
      return {...s,accepted:event.envelopeAccountId===s.accountId && event.envelopeAccountId===event.authorityAccountId};
    default: throw new Error(`unknown-scenario-event:${event.event}`);
  }
}
module.exports = { step };
