const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LocalModelSupervisor,
  LOCAL_MODEL_PORT,
} = require('../dist/localModelSupervisor.js');

function runtimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-model-supervisor-'));
  fs.mkdirSync(path.join(root, 'app/dist/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node.exe'), 'node');
  fs.writeFileSync(path.join(root, 'app/dist/src/cli.js'), 'cli');
  fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({
    schemaVersion: 1,
    product: 'keepwork-local-model-node-runtime',
    platform: 'windows',
    arch: 'x64',
    entry: 'app/dist/src/cli.js',
    args: ['serve', '--port', String(LOCAL_MODEL_PORT)],
    env: { LOCAL_MODEL_ROOT: 'app' },
  }));
  return root;
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  return child;
}

test('attaches to an existing compatible local-model service without spawning', async () => {
  const root = runtimeFixture();
  let spawned = false;
  const states = [];
  try {
    const supervisor = new LocalModelSupervisor({
      runtimeRoot: root,
      onState: state => states.push(state),
      fetchImpl: async () => response({ service: 'keepwork-local-model', status: 'ok', protocolVersion: '1.0.0' }),
      spawnImpl: () => { spawned = true; return fakeChild(); },
    });
    await supervisor.maintain();
    assert.equal(spawned, false);
    assert.equal(supervisor.currentState().status, 'attached');
    assert.equal(states.at(-1).status, 'attached');
    await supervisor.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports a conflict when another service occupies port 18089', async () => {
  const root = runtimeFixture();
  let spawned = false;
  try {
    const supervisor = new LocalModelSupervisor({
      runtimeRoot: root,
      onState() {},
      fetchImpl: async () => response({ service: 'not-local-model', status: 'ok', protocolVersion: '1.0.0' }),
      spawnImpl: () => { spawned = true; return fakeChild(); },
    });
    await supervisor.maintain();
    assert.equal(spawned, false);
    assert.equal(supervisor.currentState().status, 'conflict');
    await supervisor.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('starts the staged runtime and stops only its owned process', async () => {
  const root = runtimeFixture();
  const child = fakeChild();
  let spawnCall;
  let healthy = false;
  try {
    const supervisor = new LocalModelSupervisor({
      runtimeRoot: root,
      onState() {},
      fetchImpl: async () => {
        if (!healthy) throw new Error('connection refused');
        return response({ service: 'keepwork-local-model', status: 'ok', protocolVersion: '1.0.0' });
      },
      spawnImpl: (command, args, options) => {
        spawnCall = { command, args, options };
        return child;
      },
    });
    await supervisor.maintain();
    assert.equal(supervisor.currentState().status, 'starting');
    assert.equal(spawnCall.command, path.join(root, 'node.exe'));
    assert.deepEqual(spawnCall.args, [path.join(root, 'app/dist/src/cli.js'), 'serve', '--port', '18089']);
    assert.equal(spawnCall.options.env.LOCAL_MODEL_ROOT, path.join(root, 'app'));
    healthy = true;
    await supervisor.maintain();
    assert.equal(supervisor.currentState().status, 'running');
    await supervisor.stop();
    assert.equal(child.killed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when the packaged runtime is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-model-supervisor-missing-'));
  try {
    const supervisor = new LocalModelSupervisor({
      runtimeRoot: root,
      onState() {},
      fetchImpl: async () => { throw new Error('connection refused'); },
      spawnImpl: () => { throw new Error('must not spawn'); },
    });
    await supervisor.maintain();
    assert.equal(supervisor.currentState().status, 'error');
    assert.match(supervisor.currentState().detail, /缺少有效模型运行时/);
    await supervisor.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
