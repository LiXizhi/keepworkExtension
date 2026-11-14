import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const input = new URL('../../../contracts/ai-pet/fixtures/voice-lifecycle-scenarios.json', import.meta.url);
const data = JSON.parse(readFileSync(input, 'utf8'));
if (data.format !== 'ai-pet.dev.scenarios.v1') throw Error('Unknown fixture format');
const ids = new Set(['background-lock-continuation', 'interruption-deliberate-resume', 'stale-turn-output', 'lease-expiry', 'lease-revoked']);
const events = new Set(['background', 'lock', 'network-loss', 'transport-restored', 'user-resume', 'spoken-interruption', 'output', 'lease-expired', 'lease-revoked']);
const fields = new Set(['session', 'capture', 'playback', 'turnGeneration', 'accepted']);
const rows = [];
for (const scenario of data.scenarios) {
  if (scenario.id === 'wrong-account-migration') continue; // Explicitly outside Android voice owner scope.
  if (!ids.delete(scenario.id)) throw Error(`Unknown or duplicate scenario ${scenario.id}`);
  const initial = scenario.initial;
  if (initial.session !== 'active' || initial.capture !== true) throw Error('Unsupported initial state');
  rows.push(['initial', scenario.id, initial.leaseGeneration, initial.turnGeneration].join('\t'));
  for (const step of scenario.steps) {
    if (!events.has(step.event)) throw Error(`Unknown event ${step.event}`);
    for (const field of Object.keys(step.expect)) if (!fields.has(field)) throw Error(`Unknown checkpoint ${field}`);
    const checks = step.checks;
    if (checks && Object.keys(checks).sort().join() !== 'audioFocus,entitlement,lease,nativeStartEligible,permission') throw Error('Unknown admission checks');
    rows.push(['event', step.event, step.leaseGeneration ?? '', step.turnGeneration ?? '',
      checks ? ['permission','lease','entitlement','audioFocus','nativeStartEligible'].map(k => checks[k]).join(',') : '',
      Object.entries(step.expect).map(([k,v]) => `${k}=${v}`).join(',')].join('\t'));
  }
}
if (ids.size) throw Error(`Missing scenarios: ${[...ids]}`);
const output = new URL('../core/build/shared-scenarios.tsv', import.meta.url);
mkdirSync(new URL('../core/build/', import.meta.url), {recursive:true});
writeFileSync(output, rows.join('\n') + '\n');
console.log('Prepared 5 shared voice scenarios; migration explicitly unsupported by this harness.');
