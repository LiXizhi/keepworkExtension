#!/usr/bin/env node
// Download on the operator's device. Never fall back to a direct GitHub download.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PROXY = 'http://127.0.0.1:7890';
const ARTIFACTS = {
  desktop: ['aichat-rust-release-packages'],
  mcp: ['mcp-rust-validation-windows-x64', 'mcp-rust-validation-windows-arm64', 'mcp-rust-validation-macos-universal'],
  'win7-win8': ['aichat-rust-win7-win8-x64'],
};
const WORKFLOWS = { desktop: '.github/workflows/aichat-rust-windows-release.yml', mcp: '.github/workflows/mcp-rust.yml',
  'win7-win8': '.github/workflows/aichat-rust-windows-release.yml' };
const RECEIPT = 'download-receipt.json';

function directEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:(?:https?|all|no)_proxy|node_use_env_proxy|global_agent_(?:https?_proxy|no_proxy))$/i.test(key)));
}

function githubEnvironment(env = process.env) {
  const result = directEnvironment(env);
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) result[key] = PROXY;
  result.NO_PROXY = result.no_proxy = '';
  // Credentials for Qiniu have no role in the GitHub subprocess.
  delete result.KP_QINIU_ACCESS_KEY;
  delete result.KP_QINIU_SECRET_KEY;
  return result;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let size;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

function inventory(root, relative = '') {
  const entries = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    if (!relative && name === RECEIPT) continue;
    const rel = relative ? `${relative}/${name}` : name;
    const file = path.join(root, rel);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Error('Artifact contains a symbolic link: ' + rel);
    if (stat.isDirectory()) entries.push(...inventory(root, rel));
    else if (stat.isFile()) entries.push({ path: rel, size: stat.size, sha256: sha256(file) });
    else throw Error('Unsupported artifact member: ' + rel);
  }
  return entries;
}

function validateIdentity({ product, commit, repository }) {
  if (!Object.hasOwn(ARTIFACTS, product)) throw Error('Use --product desktop, mcp or win7-win8');
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Require a full source commit SHA');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw Error('Invalid GitHub repository');
}

function downloadArtifacts({ product, runId, commit, output, repository = 'LiXizhi/keepworkExtension' }, { exec = execFileSync, env = process.env } = {}) {
  validateIdentity({ product, commit, repository });
  if (!/^[1-9]\d*$/.test(String(runId || ''))) throw Error('Require a workflow run ID');
  if (!output) throw Error('Require --output pointing to a new directory');
  const directory = path.resolve(output);
  if (fs.existsSync(directory)) throw Error('Download output must be a new directory; do not mix runs or partial downloads');
  const options = { encoding: 'utf8', env: githubEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] };
  const api = endpoint => JSON.parse(exec('gh', ['api', endpoint], options));
  const run = api(`repos/${repository}/actions/runs/${runId}`);
  if (String(run.id) !== String(runId) || run.head_sha !== commit || run.path !== WORKFLOWS[product]
    || run.status !== 'completed' || run.conclusion !== 'success' || !['workflow_dispatch', 'push'].includes(run.event)) {
    throw Error('Workflow run identity/status mismatch; require the successful build at the expected commit');
  }
  const pages = JSON.parse(exec('gh', ['api', '--paginate', '--slurp', `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`], options));
  const artifacts = pages.flatMap(page => page.artifacts);
  for (const name of ARTIFACTS[product]) {
    const matches = artifacts.filter(artifact => artifact.name === name);
    if (matches.length !== 1 || matches[0].expired) throw Error('Missing, duplicate or expired artifact: ' + name);
  }
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory); // Atomic: another invocation must not reuse this output.
  for (const name of ARTIFACTS[product]) {
    exec('gh', ['run', 'download', String(runId), '--repo', repository, '--name', name, '--dir', path.join(directory, name)],
      { ...options, stdio: 'inherit' });
    if (!fs.existsSync(path.join(directory, name)) || !inventory(path.join(directory, name)).length) throw Error('Empty artifact: ' + name);
  }
  const receipt = { schemaVersion: 1, product, repository, runId: String(runId), commit,
    workflow: run.path, proxy: PROXY, artifacts: ARTIFACTS[product], files: inventory(directory) };
  // Absence of this file means the download never completed.
  fs.writeFileSync(path.join(directory, RECEIPT), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

function verifyReceipt(directory, { product, commit }) {
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, RECEIPT), 'utf8'));
  validateIdentity({ product, commit, repository: receipt.repository });
  if (receipt.schemaVersion !== 1 || receipt.product !== product || receipt.commit !== commit
    || receipt.workflow !== WORKFLOWS[product] || receipt.proxy !== PROXY || !/^[1-9]\d*$/.test(receipt.runId || '')
    || JSON.stringify(receipt.artifacts) !== JSON.stringify(ARTIFACTS[product])
    || !Array.isArray(receipt.files) || !receipt.files.length) throw Error('Download receipt identity mismatch');
  if (JSON.stringify(inventory(directory)) !== JSON.stringify(receipt.files)) throw Error('Downloaded artifact size/SHA-256 mismatch or files changed');
  return receipt;
}

function readArgs(argv, allowed) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !allowed.includes(key) || args[key] !== undefined
      || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Expected supported --name value arguments');
    args[key] = argv[i + 1];
  }
  return args;
}

if (require.main === module) {
  try {
    const args = readArgs(process.argv.slice(2), ['product', 'run-id', 'commit', 'output', 'repo']);
    const receipt = downloadArtifacts({ product: args.product, runId: args['run-id'], commit: args.commit, output: args.output, repository: args.repo });
    console.log(`Downloaded ${receipt.product} run ${receipt.runId} @ ${receipt.commit} through ${PROXY}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { PROXY, ARTIFACTS, downloadArtifacts, verifyReceipt, githubEnvironment, directEnvironment, readArgs, sha256 };
