const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync, symlinkSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./harness.cjs');

test('named Codex accounts isolate login, discovery and persisted session execution', async (t) => {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'kp-codex-accounts-')));
  const root = path.join(directory, 'workspace');
  const defaultHome = path.join(directory, 'default-codex-home');
  mkdirSync(root);
  mkdirSync(defaultHome);
  const log = path.join(directory, 'rpc.log');
  const appData = path.join(directory, process.platform === 'darwin' ? 'Library/Application Support' : 'app-data');
  const env = {
    APPDATA: appData,
    XDG_DATA_HOME: appData,
    CODEX_HOME: defaultHome,
    OPENAI_API_KEY: 'fixture-inherited-key',
    KEEPWORK_CODEX_ACCOUNT_FIXTURE: '1',
    KEEPWORK_CODEX_PATH: path.join(__dirname, 'fixtures', 'codex-agent-cli.cjs'),
    KEEPWORK_AGENT_FIXTURE_LOG: log,
    KEEPWORK_MCP_ROOT: root,
  };
  let daemon, token;
  const owner = 'fixture-owner-'.padEnd(40, 'a');
  const start = async () => {
    daemon = await h.startRust({ env, home: directory, port: daemon?.port, requireAuth: true });
    token = readFileSync(path.join(directory, '.keepwork-mcp', 'token'), 'utf8').trim();
  };
  t.after(async () => {
    await daemon?.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = async (route, data, extra = {}) => {
    const response = await fetch(daemon.base + '/agents/' + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        origin: daemon.base, 'x-agent-owner': owner,
        authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (...args) => {
    const response = await request(...args);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const session = (conversationId, accountId) => ({ backend: 'codex', conversationId, roots: [root], accountId });

  await start();
  assert.equal(daemon.health.agentAccountApi, 'codex-profiles-v1');
  const empty = await ok('codex/accounts');
  assert.deepEqual(empty, { accounts: [{ id: 'default', name: '默认' }] });
  assert.equal((await request('codex/accounts', undefined, { authorization: '' })).status, 401);
  assert.equal((await request('codex/accounts', undefined, { origin: 'https://untrusted.invalid' })).status, 403);
  const business = await ok('codex/accounts', { name: ' Business ' });
  const personal = await ok('codex/accounts', { name: 'Personal' });
  assert.equal(business.name, 'Business');
  assert.notEqual(business.id, personal.id);
  assert.deepEqual(Object.keys(business).sort(), ['id', 'name']);
  assert.deepEqual(await ok('codex/accounts'), { accounts: [...empty.accounts, business, personal] });
  assert.equal((await request('codex/accounts', { name: 'Business' })).status, 400);
  assert.equal((await request('codex/accounts', { name: 'Invalid', path: defaultHome })).status, 400);
  assert.equal((await request('codex/accounts', { name: 'A\u0000B' })).status, 400);
  const foreign = { 'x-agent-owner': 'fixture-owner-'.padEnd(40, 'b') };
  assert.deepEqual(await ok('codex/accounts', undefined, foreign), empty);
  const probe = (id) => 'backends?backend=codex&accountId=' + encodeURIComponent(id);
  assert.equal((await request(probe(business.id), undefined, foreign)).status, 400);
  assert.equal((await request(probe('../default-codex-home'))).status, 400);
  assert.equal((await request('backends?backend=claude&accountId=' + business.id)).status, 422);
  assert.equal((await request('codex/accounts/' + business.id + '/login', {}, foreign)).status, 400);
  assert.equal((await request('account-sessions', session('missing-account'))).status, 400);
  assert.equal((await request('account-sessions', session('foreign-account', business.id), foreign)).status, 400);
  assert.deepEqual(await ok('codex/accounts/' + business.id + '/login', {}), { url: 'https://auth.openai.com/fixture' });
  const businessProbe = (await ok(probe(business.id))).codex;
  const personalProbe = (await ok(probe(personal.id))).codex;
  assert.equal(businessProbe.accountId, business.id);
  assert.equal(personalProbe.accountId, personal.id);
  assert.equal(businessProbe.authenticated, true);
  assert.ok(businessProbe.models.length);
  const businessHome = calls().find(row => row.method === 'account/login/start').codexHome;
  const personalHome = calls().filter(row => row.method === 'account/read').at(-1).codexHome;
  const ownerDirectory = createHash('sha256').update(`${daemon.base}\0${owner}`).digest('hex');
  for (const [id, home] of [[business.id, businessHome], [personal.id, personalHome]]) {
    const relativeHome = path.relative(directory, realpathSync.native(home));
    assert.equal(relativeHome, path.join('.keepwork-mcp', 'codex-accounts-v1', ownerDirectory, id, 'home'));
    const scoped = calls().filter(row => row.codexHome === home);
    assert.ok(scoped.every(row => !row.inheritedKey && row.args.includes('cli_auth_credentials_store="file"')));
  }

  const ordinary = await ok('sessions', session('legacy-default'));
  assert.equal(ordinary.accountId, undefined);
  assert.equal(calls().filter(row => row.method === 'thread/start').at(-1).codexHome, defaultHome);
  assert.equal((await request('account-sessions/' + ordinary.id)).status, 400);
  const work = await ok('account-approval-sessions', { ...session('work-context', business.id), approvalMode: 'on-request' });
  const other = await ok('account-sessions', session('other-context', personal.id));
  assert.equal(work.accountId, business.id);
  assert.equal(other.accountId, personal.id);
  assert.equal((await request('account-sessions', session('other-context', business.id))).status, 400);
  assert.equal((await request(probe(business.id) + '&sessionId=' + other.id)).status, 400);
  assert.equal((await request('native-codex/' + work.threadId)).status, 400);
  assert.equal((await ok('account-sessions/' + other.id)).accountId, personal.id);
  assert.equal((await request('account-sessions/' + work.id + '/turns', { requestId: 'foreign-turn', text: 'foreign' }, foreign)).status, 400);
  assert.deepEqual(calls().filter(row => row.method === 'thread/start').slice(-2).map(row => row.codexHome), [businessHome, personalHome]);

  await daemon.stop();
  await start();
  assert.deepEqual(await ok('codex/accounts'), { accounts: [...empty.accounts, business, personal] });
  const turn = await ok('account-sessions/' + work.id + '/approval-turns', { requestId: 'resume-work', text: 'Continue', approvalMode: 'on-request' });
  assert.equal(turn.session.accountId, business.id);
  assert.equal(calls().findLast(row => row.method === 'thread/resume' && row.params.threadId === work.threadId).codexHome, businessHome);
  assert.equal(calls().findLast(row => row.method === 'turn/start' && row.params.threadId === work.threadId).codexHome, businessHome);
  assert.equal((await ok('account-sessions/' + other.id)).accountId, personal.id);

  // Retargeting the stored profile must never cause default credentials to be used.
  if (process.platform !== 'win32') {
    rmSync(personalHome, { recursive: true });
    symlinkSync(defaultHome, personalHome, 'dir');
    const count = calls().length;
    assert.equal((await request(probe(personal.id))).status, 400);
    assert.equal((await request('codex/accounts/' + personal.id + '/login', {})).status, 400);
    assert.equal((await request('account-sessions', session('retargeted-account', personal.id))).status, 400);
    assert.equal(calls().slice(count).some(row => ['account/read', 'account/login/start', 'thread/start'].includes(row.method)), false);
  }

  // Match the legacy GrokX roster on disk. The Rust tests cover current SQLite/WAL discovery.
  const grokx = path.join(appData, 'com.chenliao.grokx');
  const grokxHome = path.join(grokx, 'cli-accounts', 'codex', 'a123');
  mkdirSync(grokxHome, { recursive: true });
  const roster = path.join(grokx, 'state.json');
  const writeRoster = (accounts) => writeFileSync(roster, JSON.stringify({ settings: { agentAccounts: { codex: accounts } } }));
  writeRoster([{ id: 'a123', label: 'Boss' }]);

  const shared = (await ok('codex/accounts')).accounts.find(row => row.name === 'Boss (GrokX)');
  assert.match(shared.id, /^grokx-[0-9a-f]{32}$/);
  assert.equal((await request(probe('a123'))).status, 400);
  assert.equal((await request(probe(shared.id), undefined, foreign)).status, 400);
  assert.notEqual((await ok('codex/accounts', undefined, foreign)).accounts[1].id, shared.id);
  const status = (await ok(probe(shared.id))).codex;
  assert.equal(status.accountId, shared.id);
  assert.equal(status.account.email, 'fixture@example.invalid');
  assert.deepEqual(await ok('codex/accounts/' + shared.id + '/login', {}), { url: 'https://auth.openai.com/fixture' });
  const sharedSession = await ok('account-sessions', session('grokx-context', shared.id));
  assert.equal(sharedSession.accountId, shared.id);
  const expectedGrokxHome = realpathSync.native(grokxHome);
  const assertGrokxHome = (call) => assert.equal(path.relative(expectedGrokxHome, realpathSync.native(call.codexHome)), '');
  for (const method of ['account/read', 'account/login/start', 'thread/start']) {
    assertGrokxHome(calls().findLast(row => row.method === method));
  }
  await daemon.stop();
  await start();
  await ok('account-sessions/' + sharedSession.id + '/turns', { requestId: 'resume-grokx', text: 'Continue' });
  assertGrokxHome(calls().findLast(row => row.method === 'thread/resume' && row.params.threadId === sharedSession.threadId));
  assertGrokxHome(calls().findLast(row => row.method === 'turn/start' && row.params.threadId === sharedSession.threadId));

  writeRoster([]);
  assert.ok(!(await ok('codex/accounts')).accounts.some(row => row.id === shared.id));
  const count = calls().length;
  assert.equal((await request(probe(shared.id))).status, 400);
  assert.equal((await request('codex/accounts/' + shared.id + '/login', {})).status, 400);
  assert.equal((await request('account-sessions', session('deleted-grokx', shared.id))).status, 400);
  assert.equal(calls().length, count);
});
