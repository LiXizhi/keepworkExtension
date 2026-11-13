// Publication-time validation. Readers keep accepting additive optional fields.
const { normalizeVersion } = require('./qiniu-release.cjs');

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`Invalid ${name}`);
}
function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw Error(`Invalid ${name}: expected a UTC ISO-8601 timestamp`);
  const normalized = value.includes('.') ? value.replace(/\.(\d+)Z$/, (_, digits) => '.' + digits.padEnd(3, '0').slice(0, 3) + 'Z') : value.replace('Z', '.000Z');
  if (new Date(value).toISOString() !== normalized) throw Error(`Invalid ${name}: invalid calendar date`);
}
function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('Invalid update URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('Update URL must be credential-free HTTPS without query or fragment');
}
function packageFields(value, { version, dateRequired = false } = {}) {
  object(value, 'update package');
  normalizeVersion(value.version ?? version);
  httpsUrl(value.url);
  if (typeof value.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.fileName)
    || value.fileName.includes('..')) throw Error('Invalid update fileName');
  if (!Number.isSafeInteger(value.size) || value.size <= 0) throw Error('Invalid update size');
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw Error('Invalid update SHA-256');
  if (dateRequired || value.publishedAt !== undefined) timestamp(value.publishedAt, 'publishedAt');
  if (value.builtAt !== undefined) timestamp(value.builtAt, 'builtAt');
}

function validateDesktopManifest(value, { target, legacy = false } = {}) {
  object(value, 'desktop update manifest');
  if ((!legacy || value.schemaVersion !== undefined) && value.schemaVersion !== 1
    || (!legacy || value.product !== undefined) && value.product !== 'aichat-desktop') throw Error('Invalid desktop update schema/product');
  const platform = value.platform ?? (legacy && target?.startsWith('darwin-') ? 'macos' : legacy && target?.startsWith('win32-') ? 'windows' : undefined);
  const arch = value.arch ?? (legacy && target ? target.split('-')[1] : undefined);
  const supportedArch = ['arm64', 'x64'].includes(arch) || platform === 'macos' && arch === 'universal';
  if (!['macos', 'windows'].includes(platform) || !supportedArch) throw Error('Invalid desktop update target');
  const expected = `${platform === 'macos' ? 'darwin' : 'win32'}-${arch}`;
  if (target && target !== expected) throw Error('Desktop update target mismatch');
  packageFields(value);
  const nativeFormat = platform === 'macos' ? 'dmg' : 'exe';
  if (!['zip', nativeFormat].includes(value.format) || !value.fileName.endsWith('.' + value.format)) throw Error('Invalid desktop update format');
  if (value.installer !== undefined) {
    object(value.installer, 'desktop installer');
    packageFields(value.installer, { version: legacy ? value.version : undefined, dateRequired: !legacy });
    if (value.installer.format !== nativeFormat || !value.installer.fileName.endsWith('.' + nativeFormat)) throw Error('Desktop installer format/target mismatch');
  } else if (!legacy) {
    if (value.format === 'zip') throw Error('Native desktop installer is required');
    timestamp(value.publishedAt, 'publishedAt');
  }
  return value;
}

function validateRustManifest(value) {
  object(value, 'Rust runtime update manifest');
  if (value.schemaVersion !== 2 || value.product !== 'keepwork-mcp-runtime' || value.engine !== 'rust') throw Error('Invalid Rust update schema/product/engine');
  if (!['macos', 'windows', 'linux'].includes(value.platform) || !['arm64', 'x64'].includes(value.arch)) throw Error('Invalid Rust update target');
  packageFields(value);
  if (!/^[a-f0-9]{40}$/.test(value.commit || '') || !/^[a-f0-9]{64}$/.test(value.sourceHash || '')) throw Error('Invalid Rust update provenance');
  if (value.fileName !== `${value.platform}-${value.arch}.zip`) throw Error('Rust update fileName/target mismatch');
  return value;
}

module.exports = { validateDesktopManifest, validateRustManifest, timestamp };
