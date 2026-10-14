// Artifact provenance for the local Go publisher. Never contains credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeBuildInfo(dir, { runId, commit, target, version }) {
  if (!/^[a-zA-Z0-9-]*$/.test(runId) || !/^[a-f0-9]{40}$/.test(commit) || !['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(target)) throw new Error('Invalid build provenance');
  const files = {};
  for (const name of fs.readdirSync(dir).sort()) {
    if (/\.(exe|dmg|zip|blockmap|yml)$/.test(name)) files[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
  }
  fs.writeFileSync(path.join(dir, 'publisher-build.json'), JSON.stringify({ runId, commit, target, version, files }, null, 2) + '\n');
}
if (require.main === module) writeBuildInfo(path.resolve('apps/aichat-desktop/release'), {
  runId: process.env.KP_PUBLISHER_ID || '', commit: process.env.GITHUB_SHA,
  target: process.env.KP_DESKTOP_TARGET, version: require('../apps/aichat-desktop/package.json').version,
});
module.exports = { writeBuildInfo };
