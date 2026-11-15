const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { verify } = require('../skills/agent-cli-verify/scripts/verify.cjs');
async function fixture(t, status, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-report-scope-'));
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(status)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, {recursive:true,force:true}); });
  const report = await verify(`http://127.0.0.1:${server.address().port}`, {probeOnly:true,reportFile:path.join(dir,'report.json'),...options});
  return { report, requests };
}
test('targeted verification never starts unselected backends', async t => {
  const { report, requests } = await fixture(t, { workbuddy:{available:true,probe:'protocol',protocol:'acp'} }, {backends:['workbuddy']});
  assert.deepEqual(requests, ['/agents/backends?backend=workbuddy']);
  assert.deepEqual(report.results.map(row => row.backend), ['workbuddy']);
  assert.equal(report.results[0].status, 'not_tested');
  assert.deepEqual(report.results[0].checks, ['handshake']);
});
test('native auth and model discovery cannot count as a protocol handshake', async t => {
  const { report } = await fixture(t, { claude:{available:true,probe:'native-auth',protocol:'claude'}, gemini:{available:true,probe:'protocol',protocol:'antigravity'}, codex:{available:true,probe:'protocol',protocol:'codex'} }, {backends:['claude','gemini','codex']});
  assert.deepEqual(report.results.map(row => row.checks), [['native-account-status'],['native-model-catalog'],['handshake']]);
  assert.equal(report.passed, false);
  assert.match(report.checkDefinitions['snapshot-reconnect'], /no network disconnect or process restart/);
  assert.match(report.checkDefinitions['history-resume'], /no new turn/);
});
test('legacy Gemini ACP uses advertised protocol and missing probe metadata stays unknown', async t => {
  const { report } = await fixture(t, { gemini:{available:true,probe:'protocol',protocol:'acp'}, claude:{available:true} }, {backends:['gemini','claude']});
  assert.deepEqual(report.results.map(row => row.checks), [['handshake'],['backend-availability']]);
});
test('open-source Trae discovery does not count as an ACP handshake; older Trae services retain their advertised contract', async t => {
  const native = await fixture(t, { trae:{available:true,probe:'executable',protocol:'trae',authenticated:null} }, {backends:['trae']});
  assert.deepEqual(native.report.results[0].checks, ['cli-executable']);
  assert.equal(native.report.results[0].status, 'not_tested');
  const legacy = await fixture(t, { trae:{available:true,probe:'protocol',protocol:'acp'} }, {backends:['trae']});
  assert.deepEqual(legacy.report.results[0].checks, ['handshake']);
  assert.equal(legacy.report.passed, false);
});
test('a selected provider absent from an older service remains unavailable', async t => {
  const { report } = await fixture(t, { codex:{available:true} }, {backends:['deepseek']});
  assert.equal(report.results[0].backend, 'deepseek');
  assert.equal(report.results[0].status, 'unavailable');
  assert.equal(report.passed, false);
});
