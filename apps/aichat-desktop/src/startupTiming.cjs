const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { atomicJson } = require('./files.cjs');
// Numeric stages only: never persist account details, URLs or error payloads.
function createStartupTiming(home, version) {
  const report = { schemaVersion: 1, version, platform: process.platform, arch: process.arch, startedAt: new Date(performance.timeOrigin).toISOString(), stagesMs: {} };
  return {
    begin() { report.stagesMs = { electronReady: report.stagesMs.electronReady }; },
    mark(stage) { report.stagesMs[stage] = Math.round(performance.now()); },
    finish(outcome) {
      report.outcome = outcome;
      report.finishedMs = Math.round(performance.now());
      try { atomicJson(path.join(home, 'startup-timing.json'), report); }
      catch { /* Diagnostics must never block startup. */ }
      console.info('[startup]', JSON.stringify(report));
    },
  };
}
module.exports = { createStartupTiming };
