const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const app = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(app, '../../.github/workflows/aichat-rust-win7.yml'), 'utf8');
const signingScript = workflow.match(/@'\r?\n([\s\S]*?)\r?\n\s*'@ \| node/)[1].replace(/^ {10}/gm, '');
const production = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = key => key.export({ type: 'pkcs8', format: 'pem' });
const publicDer = key => key.export({ type: 'spki', format: 'der' });

function run(t, { mode = 'production', secret = privatePem(production.privateKey), pinned = production.publicKey } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwork-legacy-signing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'isolated-key');
  fs.mkdirSync(directory);
  if (pinned) {
    const file = path.join(root, 'apps/aichat-rust/keys/win7-release-public.pem');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pinned.export({ type: 'spki', format: 'pem' }));
  }
  const env = { ...process.env, LEGACY_SIGNING_MODE: mode, WIN7_SIGNING_KEY_DIR: directory };
  delete env.WIN7_RELEASE_PRIVATE_KEY_PEM;
  if (secret) env.WIN7_RELEASE_PRIVATE_KEY_PEM = secret;
  const result = spawnSync(process.execPath, ['-e', signingScript], { cwd: root, env, encoding: 'utf8' });
  return { ...result, file: path.join(directory, 'private.pem') };
}

test('production signing accepts only the pinned RSA-2048 key and writes no key output', t => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const written = crypto.createPrivateKey(fs.readFileSync(result.file));
  assert.deepEqual(publicDer(crypto.createPublicKey(written)), publicDer(production.publicKey));
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
});

test('production signing rejects a different RSA key before writing private material', t => {
  const result = run(t, { secret: privatePem(other.privateKey) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the pinned Win7\/Win8 trust root/);
  assert.equal(fs.existsSync(result.file), false);
  assert.equal(result.stderr.includes(privatePem(other.privateKey)), false);
});

test('production signing never falls back when its secret is missing', t => {
  const result = run(t, { secret: null });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preview fallback is forbidden/);
  assert.equal(fs.existsSync(result.file), false);
});

test('production signing rejects invalid private-key input without exposing it', t => {
  const secret = 'invalid-sensitive-release-key-input';
  const result = run(t, { secret });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a usable RSA-2048 private key/);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(fs.existsSync(result.file), false);
});

test('production signing rejects a missing pinned public key', t => {
  const result = run(t, { pinned: null });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(result.file), false);
});

test('production signing rejects a non-RSA private key', t => {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const result = run(t, { secret: privatePem(pair.privateKey) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Use an RSA-2048 release key/);
  assert.equal(fs.existsSync(result.file), false);
});

test('preview signing remains isolated from production secrets and trust roots', t => {
  const result = run(t, { mode: 'preview', secret: 'must-not-use-this-secret', pinned: null });
  assert.equal(result.status, 0, result.stderr);
  const written = crypto.createPrivateKey(fs.readFileSync(result.file));
  assert.equal(written.asymmetricKeyType, 'rsa');
  assert.equal(written.asymmetricKeyDetails.modulusLength, 2048);
  assert.notDeepEqual(publicDer(crypto.createPublicKey(written)), publicDer(production.publicKey));
});

test('the committed legacy trust root is a public RSA-2048 key with its documented fingerprint', () => {
  const pem = fs.readFileSync(path.join(app, 'keys/win7-release-public.pem'), 'utf8');
  assert.doesNotMatch(pem, /PRIVATE KEY/);
  const key = crypto.createPublicKey(pem);
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.equal(key.asymmetricKeyDetails.modulusLength, 2048);
  const fingerprint = crypto.createHash('sha256').update(publicDer(key)).digest('hex');
  const docs = fs.readFileSync(path.join(app, 'docs/windows-cef.md'), 'utf8');
  assert.ok(docs.includes(fingerprint));
});
