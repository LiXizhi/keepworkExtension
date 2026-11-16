// Shared build-time identity checks. No application imports another application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sourceFingerprint(root) {
  const crate = path.join(root, 'crates/keepwork-mcp');
  const entries = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.rs')) entries.push(['crate/' + path.relative(crate, file).split(path.sep).join('/'), file]);
    }
  };
  walk(path.join(crate, 'src'));
  for (const name of ['Cargo.toml', 'build.rs']) entries.push(['crate/' + name, path.join(crate, name)]);
  for (const name of ['Cargo.toml', 'Cargo.lock']) entries.push(['workspace/' + name, path.join(root, name)]);
  const hash = crypto.createHash('sha256');
  for (const [name, file] of entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    const content = fs.readFileSync(file);
    hash.update(name); hash.update(Buffer.from([0]));
    hash.update(String(content.length)); hash.update(Buffer.from([0])); hash.update(content);
  }
  return hash.digest('hex');
}

function buildTimestamp(info) {
  // Old binaries never embedded a timestamp. Missing is unknown, not the
  // packaging clock, file mtime, Git commit time or process startup time.
  if (info.builtAtUnix === undefined) return undefined;
  if (!Number.isSafeInteger(info.builtAtUnix) || info.builtAtUnix < 0 || info.builtAtUnix > 253402300799) {
    throw new Error('Invalid compiled Rust build timestamp');
  }
  if (!['compile-clock', 'source-date-epoch'].includes(info.builtAtSource)) {
    throw new Error('Invalid compiled Rust build timestamp source');
  }
  return new Date(info.builtAtUnix * 1000).toISOString().replace('.000Z', 'Z');
}

function readBuildInfo(binary) {
  const content = fs.readFileSync(binary);
  const start = content.indexOf(Buffer.from('{"marker":"keepwork-mcp-build-v1",'));
  const ending = Buffer.from('"endMarker":"keepwork-mcp-build-end"}');
  const end = start < 0 ? -1 : content.indexOf(ending, start);
  if (start < 0 || end < 0 || end - start > 16384) throw new Error('Rust binary has no valid embedded build identity');
  const info = JSON.parse(content.subarray(start, end + ending.length).toString('utf8'));
  const builtAt = buildTimestamp(info);
  if (builtAt !== undefined) info.builtAt = builtAt;
  else delete info.builtAt;
  return info;
}

function validateBinary(binary, target, expected) {
  try {
    const info = readBuildInfo(binary);
    if (info.product !== 'keepwork-mcp-runtime' || info.engine !== 'rust' || info.target !== target.triple) throw new Error('Rust binary product or target mismatch');
    for (const key of ['version', 'commit', 'sourceHash']) {
      if (info[key] !== expected[key]) throw new Error('Rust binary ' + key + ' is stale or mismatched');
    }
    for (const capability of ['agentSessionApi', 'agentInventoryApi', 'agentContextApi', 'agentModeApi']) {
      if (info.capabilities?.[capability] !== 'v1') throw new Error('Rust binary is missing capability ' + capability);
    }
    return info;
  } catch (error) {
    throw new Error(error.message + '. Rebuild with: cargo build --release --manifest-path apps/mcp-rust/Cargo.toml --target ' + target.triple);
  }
}

module.exports = { sourceFingerprint, readBuildInfo, validateBinary, buildTimestamp };
