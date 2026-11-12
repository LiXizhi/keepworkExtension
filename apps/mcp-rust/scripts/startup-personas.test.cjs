const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { isolatedHome, rustBinary } = require('../../../scripts/contract/harness.cjs');

function run(home, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(rustBinary(), ['--port', String(port)], {
      env: { ...process.env, HOME: home, USERPROFILE: home, KEEPWORK_MCP_HOST_KIND: 'standalone' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
for (const mode of ['occupied port', 'maintenance lock']) {
  test(`startup with ${mode} never loads or normalizes persona files`, async t => {
    const home = isolatedHome();
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const listener = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const port = listener.address().port;
    if (mode === 'occupied port') t.after(() => new Promise(resolve => listener.close(resolve)));
    else await new Promise(resolve => listener.close(resolve));
    const dir = path.join(home, '.keepwork-mcp', 'personas-v1');
    fs.mkdirSync(dir, { recursive: true });
    const owner = 'ab'.repeat(32), id = 'default-persona';
    const key = createHash('sha256').update(owner + '\0' + id).digest('hex');
    const file = path.join(dir, key + '.json');
    const bytes = Buffer.from(JSON.stringify({ owner, id, messages: [], requests: {}, schedules: [], job: { state: 'running' } }));
    fs.writeFileSync(file, bytes);
    if (mode === 'maintenance lock') fs.writeFileSync(path.join(home, '.keepwork-mcp', 'persona-maintenance.lock'), JSON.stringify({ pid: process.pid }));
    const before = fs.statSync(file);
    const result = await run(home, port);
    assert.equal(result.code, mode === 'occupied port' ? 0 : 1, result.output);
    assert.match(result.output, mode === 'occupied port' ? /already running/ : /maintenance is in progress/);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  });
}
