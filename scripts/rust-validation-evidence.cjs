/** Durable validation receipts. Never probes a user's daemon, account or devices. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const Ajv = require('ajv/dist/2020');
const { readRuntimeArchive } = require('./lib/runtime-archive.cjs');
const { validateBinary } = require('./lib/rust-runtime-identity.cjs');

const repoRoot = path.resolve(__dirname, '..');
const defaultOutput = path.join(repoRoot, '.test-runtime', 'rust-validation');
const gates = {
  'aichat-rust': ['source-checks', 'fixture-contracts', 'package-integrity', 'clean-install', 'launch-protocol', 'first-paint', 'desktop-health', 'persona-live', 'files-terminal', 'runtime-update-rollback', 'compatibility-matrix', 'native-interaction', 'clean-uninstall'],
  'mcp-rust': ['source-checks', 'fixture-contracts', 'package-integrity', 'runtime-live-identity', 'runtime-update-rollback', 'compatibility-matrix', 'cli-live', 'messaging-live'],
};
const schema = require('../docs/acceptance/rust-release-evidence.schema.json');
// File existence and artifact bytes are checked below. Optional URL/date formats
// do not require a second validation dependency or any network requests.
const validateSchema = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
const gateLevels = {
  'source-checks': ['source'], 'fixture-contracts': ['fixture'],
  'persona-live': ['live'], 'cli-live': ['live'], 'messaging-live': ['live'],
  'first-paint': ['native', 'packaged'], 'native-interaction': ['native', 'live'],
};

function overallStatus(checks) {
  if (checks.some(check => check.status === 'failed')) return 'failed';
  if (checks.some(check => check.status === 'blocked')) return 'blocked';
  if (checks.some(check => check.status !== 'passed')) return 'pending';
  return 'passed';
}

function git(...args) {
  try { return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
}

function productVersion(product) {
  if (product === 'aichat-rust') return JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/aichat-rust/package.json'), 'utf8')).version;
  return /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(repoRoot, 'apps/mcp-rust/crates/keepwork-mcp/Cargo.toml'), 'utf8'))?.[1] || null;
}

function sourceFingerprint(product, root = repoRoot) {
  const inputs = ['package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', '.github/workflows', 'src', 'scripts', 'skills', 'apps/mcp-runtime', 'apps/mcp-rust', 'apps/pet-companion', 'docs/acceptance/rust-release-evidence.schema.json'];
  if (product === 'aichat-rust') inputs.push('apps/aichat-rust');
  const generated = new Set(['node_modules', 'target', 'dist', 'gen', 'resources', 'staging', 'runtime-staging', 'release', 'reports']);
  // Historical desktop packages are generated outputs, independent of the
  // source snapshot. Keep source modules named "releases" in other locations.
  const desktopReleases = path.join(root, 'apps', 'aichat-rust', 'releases');
  const files = [];
  const walk = file => {
    if (file === desktopReleases || !fs.existsSync(file)) return;
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) {
      files.push([path.relative(root, file), Buffer.from('symlink:' + fs.readlinkSync(file))]);
    } else if (info.isDirectory()) {
      for (const entry of fs.readdirSync(file)) {
        if (generated.has(entry) || (entry.startsWith('.') && entry !== '.cargo')) continue;
        walk(path.join(file, entry));
      }
    } else if (info.isFile()) files.push([path.relative(root, file), fs.readFileSync(file)]);
  };
  for (const input of inputs) walk(path.join(root, input));
  const hash = crypto.createHash('sha256');
  for (const [name, content] of files.sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
    hash.update(name.split(path.sep).join('/')); hash.update('\0');
    hash.update(String(content.length)); hash.update('\0'); hash.update(content);
  }
  return hash.digest('hex');
}

function sourceContext(product, fingerprint = sourceFingerprint) {
  return {
    product, version: productVersion(product), commit: git('rev-parse', 'HEAD'), sourceDirty: !!git('status', '--porcelain'),
    sourceHash: fingerprint(product),
    platform: ({ darwin: 'macos', win32: 'windows' })[process.platform] || process.platform, arch: process.arch,
  };
}

async function artifactInfo(file) {
  const absolute = path.resolve(file);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk);
  return { path: absolute, sha256: hash.digest('hex'), size: fs.statSync(absolute).size, signing: { status: 'unknown' } };
}

function validateReport(report, { directory = process.cwd(), metadataOnly = false, requireComplete = false } = {}) {
  if (!validateSchema(report)) throw Error('Invalid evidence schema: ' + JSON.stringify(validateSchema.errors));
  if (!Number.isFinite(Date.parse(report.recordedAt))) throw Error('Invalid evidence recordedAt');
  if (report.overallStatus !== overallStatus(report.checks)) throw Error('Overall status does not match the recorded checks');
  const seen = new Set();
  for (const check of report.checks) {
    if (seen.has(check.id)) throw Error('Duplicate check ID: ' + check.id);
    seen.add(check.id);
    if (check.sourceHash && check.sourceHash !== report.sourceHash) throw Error('Check source fingerprint differs from report: ' + check.id);
    if (check.status === 'passed' && gates[report.product].includes(check.id)) {
      const levels = gateLevels[check.id] || ['packaged'];
      if (!levels.includes(check.level)) throw Error('Check ' + check.id + ' requires ' + levels.join('/') + ' evidence; changing a source result cannot satisfy release acceptance');
      const requirements = pendingGate(check.id).requirements || [];
      for (const requirement of requirements) if (!check.requirements?.includes(requirement)) throw Error('Check ' + check.id + ' requires an explicit ' + requirement + ' receipt');
      if (check.id === 'package-integrity' && !report.artifact) throw Error('Package integrity requires installer artifact identity');
    }
    if (!metadataOnly) for (const evidence of check.evidence) {
      const file = path.resolve(directory, evidence);
      if (!fs.statSync(file).isFile()) throw Error('Evidence is not a file: ' + evidence);
      const expectedHash = check.evidenceSha256?.[evidence];
      if (check.sourceHash && !expectedHash) throw Error('Missing log checksum: ' + evidence);
      if (expectedHash) {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (actual !== expectedHash) throw Error('Evidence SHA-256 mismatch: ' + evidence);
      }
    }
  }
  for (const gate of gates[report.product]) if (!seen.has(gate)) throw Error('Required release check is missing: ' + gate);
  if (requireComplete && (report.overallStatus !== 'passed' || !report.artifact || !report.runtime || !report.commit || !report.version || !report.sourceHash || report.sourceDirty !== false)) throw Error('Release acceptance is incomplete: ' + report.overallStatus + '; final artifact/runtime/clean source identity is required');
  return report;
}

function parseArgs(argv) {
  const action = argv.shift();
  if (!['run', 'collect', 'verify'].includes(action)) throw Error('Usage: rust-validation-evidence.cjs run|collect|verify [options] [-- command args]');
  const options = { action, output: defaultOutput, product: 'aichat-rust' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') { options.command = argv.slice(index + 1); break; }
    if (['--metadata-only', '--require-complete'].includes(argument)) options[argument.slice(2)] = true;
    else if (['--output', '--product', '--id', '--level', '--artifact', '--report-name'].includes(argument)) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw Error('Missing value for ' + argument);
      const key = argument === '--report-name' ? 'reportName' : argument.slice(2);
      options[key] = argv[++index];
    } else if (action === 'verify' && !argument.startsWith('--') && !options.report) options.report = argument;
    else throw Error('Unknown evidence option: ' + argument);
  }
  if (!gates[options.product]) throw Error('Unknown Rust product: ' + options.product);
  if (options.reportName !== undefined) {
    if (action !== 'collect') throw Error('--report-name is only supported by collect');
    reportFilename(options.reportName);
  }
  options.output = path.resolve(options.output);
  return options;
}

async function runCheck({ output, product = 'aichat-rust', id, level = 'fixture', command, fingerprint = sourceFingerprint }) {
  if (!gates[product]) throw Error('Unknown Rust product: ' + product);
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(id || '')) throw Error('--id must be a bounded lowercase check name');
  if (!['source', 'fixture', 'native', 'packaged', 'live'].includes(level)) throw Error('Unknown check level');
  if (!command?.length || /\.(?:cmd|bat)$/i.test(command[0])) throw Error('A direct executable is required after --; use node with a script path for package managers');
  const logs = path.join(output, 'logs'), checks = path.join(output, 'checks');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(checks, { recursive: true });
  const context = sourceContext(product, fingerprint);
  const contextPath = path.join(output, 'context.json');
  if (fs.existsSync(contextPath)) {
    const previous = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    for (const key of ['product', 'version', 'commit', 'platform', 'arch', 'sourceHash']) if (previous[key] !== context[key]) throw Error('Evidence source identity changed (' + key + '); use a new output directory');
    // A later dirty tree can never upgrade an originally clean execution.
    if (context.sourceDirty && !previous.sourceDirty) fs.writeFileSync(contextPath, JSON.stringify({ ...previous, sourceDirty: true }, null, 2) + '\n');
  } else fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n', { flag: 'wx' });
  const logPath = path.join(logs, id + '.log');
  const checkPath = path.join(checks, id + '.json');
  if (fs.existsSync(checkPath) || fs.existsSync(logPath)) throw Error('Evidence already exists for ' + id + '; keep the first result and use a new output directory for a rerun');
  const fd = fs.openSync(logPath, 'wx');
  const started = Date.now();
  let errorMessage;
  let exitCode = 1;
  try {
    exitCode = await new Promise(resolve => {
      const child = spawn(command[0], command.slice(1), { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
      for (const [stream, mirror] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', chunk => {
        fs.writeSync(fd, chunk);
        mirror.write(chunk);
      });
      const signal = name => { child.kill(name); };
      const terminate = () => signal('SIGTERM');
      const interrupt = () => signal('SIGINT');
      process.once('SIGTERM', terminate);
      process.once('SIGINT', interrupt);
      child.once('error', error => { errorMessage = error.message; fs.writeSync(fd, error.message + '\n'); });
      child.once('close', (code, signalName) => {
        process.removeListener('SIGTERM', terminate);
        process.removeListener('SIGINT', interrupt);
        if (signalName) errorMessage = 'Command ended by ' + signalName;
        resolve(Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1);
      });
    });
    try {
      if (fingerprint(product) !== context.sourceHash) errorMessage = 'Source inputs changed while this command ran; the result cannot validate one source snapshot';
    } catch (error) { errorMessage = 'Source fingerprint failed after the command: ' + error.message; }
    if (errorMessage?.startsWith('Source ')) {
      fs.writeSync(fd, '\n' + errorMessage + '\n');
      if (exitCode === 0) exitCode = 1;
    }
  } finally { fs.closeSync(fd); }
  const check = {
    id, level, status: exitCode === 0 ? 'passed' : 'failed',
    command: JSON.stringify(command), evidence: ['logs/' + id + '.log'], durationMs: Date.now() - started,
    sourceHash: context.sourceHash, evidenceSha256: { ['logs/' + id + '.log']: (await artifactInfo(logPath)).sha256 },
    summary: 'Executed with shell disabled; exit code ' + exitCode + '. Platform skips, if any, remain visible in the command log.',
  };
  if (exitCode !== 0) check.reason = errorMessage || 'Command exited with code ' + exitCode;
  fs.writeFileSync(checkPath, JSON.stringify(check, null, 2) + '\n', { flag: 'wx' });
  return exitCode;
}

function pendingGate(id) {
  const requirements = [];
  if (['clean-install', 'clean-uninstall'].includes(id)) requirements.push('clean-machine');
  if (['persona-live', 'cli-live', 'messaging-live'].includes(id)) requirements.push('real-account', 'network');
  if (id === 'native-interaction') requirements.push('real-hardware', 'interactive-desktop');
  return { id, level: (gateLevels[id] || ['packaged'])[0], status: 'pending', evidence: [], reason: 'Not executed for this report; source and fixture checks do not establish this acceptance result.', ...(requirements.length ? { requirements } : {}) };
}

function reportFilename(name = 'report.json') {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw Error('--report-name requires a safe JSON filename in the output directory');
  }
  return name;
}

// Read the absolute archive before its path becomes portable. An archive target
// may differ from the validation host, but must agree with its embedded binary.
function runtimeIdentity(artifact, context) {
  if (!artifact?.path || !/\.zip$/i.test(artifact.path)) return null;
  const members = readRuntimeArchive(fs.readFileSync(artifact.path));
  const runtime = JSON.parse(members.get('runtime.json')?.toString() || 'null');
  const triples = {
    'macos-arm64': 'aarch64-apple-darwin', 'macos-x64': 'x86_64-apple-darwin',
    'windows-arm64': 'aarch64-pc-windows-msvc', 'windows-x64': 'x86_64-pc-windows-msvc',
    'linux-arm64': 'aarch64-unknown-linux-gnu', 'linux-x64': 'x86_64-unknown-linux-gnu',
  };
  const target = runtime && `${runtime.platform}-${runtime.arch}`;
  const triple = triples[target];
  if (!runtime || runtime.schemaVersion !== 2 || runtime.product !== 'keepwork-mcp-runtime'
    || runtime.engine !== 'rust' || !triple
    || runtime.version !== context.version || runtime.commit !== context.commit
    || !/^[a-f0-9]{40}$/.test(runtime.commit || '') || !/^[a-f0-9]{64}$/.test(runtime.sourceHash || '')) {
    throw Error('Packaged Rust runtime identity/target does not match the captured source context');
  }
  const binaryName = `bin/keepwork-mcp${runtime.platform === 'windows' ? '.exe' : ''}`;
  if (runtime.entry !== binaryName || !members.get(binaryName)?.length || !members.get('LICENSE')?.length) {
    throw Error('Packaged Rust runtime archive is missing required members');
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-evidence-identity-'));
  let info;
  try {
    const binary = path.join(temporary, 'binary');
    fs.writeFileSync(binary, members.get(binaryName));
    info = validateBinary(binary, { triple }, runtime);
    if (info.builtAt !== undefined && (runtime.builtAt !== info.builtAt || runtime.builtAtSource !== info.builtAtSource)) {
      throw Error('Packaged Rust compiled build timestamp does not match runtime.json');
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return { platform: runtime.platform, arch: runtime.arch,
    identity: { engine: runtime.engine, version: runtime.version, commit: runtime.commit,
      owner: 'standalone', capabilities: info.capabilities, source: 'build-info' } };
}

async function collect({ output, product, artifact, reportName = 'report.json' }) {
  if (!gates[product]) throw Error('Unknown Rust product: ' + product);
  const name = reportFilename(reportName);
  const directory = path.join(output, 'checks');
  const checks = fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => file.endsWith('.json')).sort().map(file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))) : [];
  for (const gate of gates[product]) {
    if (checks.some(check => check.id === gate)) continue;
    const members = checks.filter(check => check.id.startsWith(gate + '-'));
    if (!members.length) { checks.push(pendingGate(gate)); continue; }
    const status = overallStatus(members);
    checks.push({
      id: gate, level: members[0].level, status,
      evidence: [...new Set(members.flatMap(check => check.evidence))],
      evidenceSha256: Object.assign({}, ...members.map(check => check.evidenceSha256 || {})),
      ...(members.every(check => check.sourceHash && check.sourceHash === members[0].sourceHash) ? { sourceHash: members[0].sourceHash } : {}),
      summary: 'Aggregates ' + members.map(check => check.id).join(', '),
      ...(status === 'passed' ? {} : { reason: 'One or more recorded commands are incomplete or failed' }),
    });
  }
  const contextPath = path.join(output, 'context.json');
  const context = fs.existsSync(contextPath) ? JSON.parse(fs.readFileSync(contextPath, 'utf8')) : sourceContext(product);
  if (context.product !== product) throw Error('Evidence product does not match the captured command context');
  const installer = artifact ? await artifactInfo(artifact) : null;
  const packaged = product === 'mcp-rust' ? runtimeIdentity(installer, context) : null;
  if (packaged && (packaged.platform !== context.platform || packaged.arch !== context.arch)) {
    for (const check of checks) {
      if (check.status === 'passed' && ['native', 'packaged', 'live'].includes(check.level)) {
        throw Error('Cross-target archive cannot reuse passed host native/packaged/live acceptance: ' + check.id);
      }
      if (['source', 'fixture'].includes(check.level)) {
        const note = `Executed on ${context.platform}-${context.arch}; archive target ${packaged.platform}-${packaged.arch}. This is not native target acceptance.`;
        check.summary = check.summary ? `${check.summary} ${note}` : note;
      }
    }
  }
  if (installer) {
    const relative = path.relative(output, installer.path);
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) installer.path = relative.split(path.sep).join('/');
  }
  const report = {
    schemaVersion: 1, recordedAt: new Date().toISOString(), ...context,
    ...(packaged ? { platform: packaged.platform, arch: packaged.arch } : {}),
    artifact: installer, runtime: packaged?.identity || null, web: null, checks, overallStatus: overallStatus(checks),
  };
  validateReport(report, { directory: output });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, name), JSON.stringify(report, null, 2) + '\n');
  return report;
}

async function verify(file, options = {}) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateReport(report, { directory: path.dirname(path.resolve(file)), ...options });
  if (!options.metadataOnly && report.artifact?.path) {
    const actual = await artifactInfo(path.resolve(path.dirname(path.resolve(file)), report.artifact.path));
    if (actual.size !== report.artifact.size || actual.sha256 !== report.artifact.sha256) throw Error('Installer artifact does not match its recorded size/SHA-256');
  }
  return report;
}

module.exports = { gates, parseArgs, runCheck, collect, verify, validateReport, overallStatus, sourceFingerprint };
if (require.main === module) (async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === 'run') process.exitCode = await runCheck(options);
  else if (options.action === 'collect') {
    const report = await collect(options);
    console.log('Saved ' + path.join(options.output, reportFilename(options.reportName)) + ' (' + report.overallStatus + ')');
  } else {
    if (!options.report) throw Error('verify requires a report JSON path');
    const report = await verify(options.report, { metadataOnly: !!options['metadata-only'], requireComplete: !!options['require-complete'] });
    console.log('Evidence verified (' + (options['metadata-only'] ? 'metadata only; local bytes not checked' : 'local evidence files checked') + '): ' + report.overallStatus);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
