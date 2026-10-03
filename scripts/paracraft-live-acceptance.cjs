// Opt-in live MCP acceptance. Never creates/reopens a world or guesses its identity.
// node scripts/paracraft-live-acceptance.cjs <exact-disposable-world-path> <output-dir> [--build]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function main() {
  const [worldPath, output] = process.argv.slice(2);
  assert.ok(worldPath && output, 'Supply exact disposable world path and output directory');
  const build = process.argv.includes('--build');
  const home = path.join(os.homedir(), '.keepwork-mcp');
  const { port } = JSON.parse(fs.readFileSync(path.join(home, 'instance.json'), 'utf8'));
  const token = fs.existsSync(path.join(home, 'token')) ? fs.readFileSync(path.join(home, 'token'), 'utf8').trim() : '';
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const client = new Client({ name: 'codex-paracraft-live-review', version: '1' });
  const out = path.resolve(output);
  fs.mkdirSync(out, { recursive: true });
  const id = 'codex_' + crypto.randomBytes(4).toString('hex');
  const report = { id, worldPath, jobs: [], builds: [], captures: [] };
  const reportFile = path.join(out, `${id}-report.json`);
  const saveReport = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const parsed = result => {
    assert.ok(!result.isError, result.content?.[0]?.text);
    const body = JSON.parse(result.content[0].text);
    assert.notEqual(body.ok, false, JSON.stringify(body));
    assert.notEqual(body.result?.ok, false, JSON.stringify(body));
    return body.result || body;
  };
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
  try {
    const tools = (await client.listTools()).tools.map(t => t.name);
    assert.deepEqual(tools.filter(t => t.startsWith('paracraft_')), ['paracraft_cli']);
    const guide = parsed(await client.callTool({ name: 'paracraft_cli', arguments: { action: 'skill' } }));
    const resource = await client.readResource({ uri: 'keepwork://skills/paracraft-create/SKILL.md' });
    assert.equal(resource.contents[0].text, guide.content);
    const discovered = parsed(await client.callTool({ name: 'paracraft_cli', arguments: { action: 'clients' } }));
    const clients = Array.isArray(discovered) ? discovered : discovered.clients;
    assert.ok(Array.isArray(clients), 'Invalid client discovery response');
    const matches = clients.filter(c => c.worldPath === worldPath);
    assert.equal(matches.length, 1, 'Expected exactly one client in the requested world');
    const clientId = matches[0].clientId;
    const call = (name, args = {}) => client.callTool({ name: 'paracraft_cli', arguments: { action: name, clientId, params: args } });
    const identity = parsed(await call('get_creation_capabilities')).identity;
    assert.equal(identity.worldPath, worldPath);
    report.identity = identity;
    const doc = parsed(await call('read_official_wiki', { path: 'creation.md' }));
    assert.match(JSON.stringify(doc), /createScene/);
    const before = parsed(await call('get_scene_info'));
    const run = async (code, suffix) => {
      const submitted = parsed(await call('run_code', { expectedIdentity: identity, requestId: `${id}-${suffix}`, code }));
      assert.ok(submitted.jobId);
      const entry = { requestId: `${id}-${suffix}`, jobId: submitted.jobId, source: code, state: submitted.state };
      report.jobs.push(entry);saveReport();
      console.log(`Submitted ${entry.requestId}: ${entry.jobId}`);
      const deadline = Date.now() + 125000;
      while (Date.now() < deadline) {
        const status = parsed(await call('code_job', { expectedIdentity: identity, jobId: submitted.jobId }));
        if (status.state !== 'running') {
          entry.state = status.state;entry.error = status.error;saveReport();
          assert.equal(status.state, 'completed', status.error);
          return status;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      throw new Error(`Timed out waiting; recover existing job ${submitted.jobId}`);
    };
    const capture = async (name, args) => {
      const result = await call('camera_capture', { expectedIdentity: identity, ...args });
      assert.ok(!result.isError, result.content[0]?.text);
      const image = result.content.find(c => c.type === 'image');
      assert.ok(image, 'MCP image missing');
      const metadata = JSON.parse(result.content[0].text);
      assert.equal(metadata.sessionId, identity.sessionId);
      const filename = path.join(out, `${id}-${name}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(filename, Buffer.from(image.data, 'base64'), { flag: 'wx' });
      report.captures.push({ filename, metadata });
      console.log(`Captured ${filename}`);
    };
    if (build) {
      for (const [example, original] of [['pavilion.lua', 'pavilion'], ['idle-wave.lua', 'character']]) {
        const source = parsed(await client.callTool({ name: 'paracraft_cli', arguments: { action: 'skill', params: { path: `examples/${example}` } } })).content;
        const name = `${id}_${original}`;
        // Isolate sample names and output files; retain the exact bundled procedural design.
        const code = source.replaceAll(original, name);
        const status = await run(code, original);
        report.builds.push({ name, jobId: status.jobId, site: status.site, created: status.created });
        console.log(`Built ${name} with autonomous site selection`);
        const frame = (await run(`local s=createScene({name="${name}",resume=true}); return {eye=s:toWorld({${original === 'pavilion' ? '22,14,22' : '14,9,14'}}),lookat=s:toWorld({${original === 'pavilion' ? '7,4,7' : '9,2,9'}}),movie=s:position({1,0,10})}`, original + '-frame')).result;
        if (original === 'pavilion') await capture(original, { eye: frame.eye, lookat: frame.lookat });
        else for (const timeSeconds of [0, 1.5]) await capture(`character-${timeSeconds}`, { eye: frame.eye, lookat: frame.lookat, moviePosition: frame.movie, timeSeconds });
      }
    } else {
      assert.equal((await run('wait(0.01); return 42', 'execution-check')).result, 42);
      await capture('player-view', { nearPlayer: true });
    }
    const after = parsed(await call('get_scene_info'));
    assert.deepEqual(after.player, before.player, 'Player changed');
    assert.deepEqual(after.camera, before.camera, 'Main camera changed');
    report.playerAndCameraUnchanged = true;
    // Real stdio CLI, forwarding through the same live singleton daemon.
    const stdio = new Client({ name: 'codex-stdio-review', version: '1' });
    try {
      await stdio.connect(new StdioClientTransport({ command: process.execPath,
        args: [path.resolve(__dirname, '../apps/vscode-extension/dist/cli.js'), '--stdio'], stderr: 'pipe' }));
      const caps = parsed(await stdio.callTool({ name: 'paracraft_cli', arguments: { action: 'get_creation_capabilities', clientId } }));
      assert.deepEqual(caps.identity, identity);
      const image = await stdio.callTool({ name: 'paracraft_cli', arguments: { action: 'screenshot', clientId, params: { expectedIdentity: identity } } });
      assert.ok(!image.isError && image.content.some(c => c.type === 'image'));
      report.stdioNativeImage = true;
    } finally { await stdio.close(); }
    saveReport();
    console.log('PASS live installed MCP: tools, skill, resources, native images, HTTP/stdio, player/camera invariance');
  } finally { saveReport();await client.close(); }
}
main().catch(error => { console.error(error.message);process.exitCode = 1; });
