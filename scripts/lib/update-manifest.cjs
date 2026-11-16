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
function buildTime(value, allowRecordedDate = false) {
  const markers = ['builtAtPrecision', 'builtAtSource', 'builtAtTimezone'];
  // Modern binaries record the origin of an exact build timestamp. This is
  // separate from the explicitly lower-precision historical recovery below.
  if (['compile-clock', 'source-date-epoch'].includes(value.builtAtSource)
    && !Object.hasOwn(value, 'builtAtPrecision') && !Object.hasOwn(value, 'builtAtTimezone')) {
    timestamp(value.builtAt, 'builtAt');
    return;
  }
  if (markers.some(key => Object.hasOwn(value, key))) {
    if (!allowRecordedDate || value.builtAtPrecision !== 'day'
      || value.builtAtSource !== 'recorded-build-session' || value.builtAtTimezone !== 'Asia/Shanghai') {
      throw Error('Invalid recorded build-date provenance');
    }
    if (typeof value.builtAt !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value.builtAt)) {
      throw Error('Recorded build date requires YYYY-MM-DD without an invented time');
    }
    const midnight = `${value.builtAt}T00:00:00.000Z`;
    if (!Number.isFinite(Date.parse(midnight)) || new Date(midnight).toISOString() !== midnight) {
      throw Error('Invalid recorded build calendar date');
    }
    return;
  }
  if (value.builtAt !== undefined) timestamp(value.builtAt, 'builtAt');
}

function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('Invalid update URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('Update URL must be credential-free HTTPS without query or fragment');
}
function packageFields(value, { version, dateRequired = false, allowRecordedBuildDate = false } = {}) {
  object(value, 'update package');
  normalizeVersion(value.version ?? version);
  httpsUrl(value.url);
  if (typeof value.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.fileName)
    || value.fileName.includes('..')) throw Error('Invalid update fileName');
  if (!Number.isSafeInteger(value.size) || value.size <= 0) throw Error('Invalid update size');
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw Error('Invalid update SHA-256');
  if (dateRequired || value.publishedAt !== undefined) timestamp(value.publishedAt, 'publishedAt');
  buildTime(value, allowRecordedBuildDate);
}

// This explicit discovery-only record contains no downloadable package. It is
// accepted only as a predecessor to a real release, never as an installer.
function validateDesktopVersionStatus(value, { target } = {}) {
  object(value, 'desktop version status');
  const allowed = ['schemaVersion', 'kind', 'product', 'channel', 'platform', 'arch',
    'version', 'commit', 'publishedAt', 'releaseStatus', 'installable', 'description'];
  if (Object.keys(value).some(key => !allowed.includes(key))
    || value.schemaVersion !== 1 || value.kind !== 'version-status'
    || value.product !== 'aichat-desktop' || value.channel !== 'stable'
    || value.releaseStatus !== 'version-only' || value.installable !== false) {
    throw Error('Invalid desktop version-status record');
  }
  const expected = value.platform === 'macos' && value.arch === 'universal' ? 'darwin-universal'
    : value.platform === 'windows' && ['x64', 'arm64'].includes(value.arch) ? `win32-${value.arch}` : undefined;
  if (!expected || target && target !== expected) throw Error('Desktop version-status target mismatch');
  normalizeVersion(value.version);
  if (typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)) throw Error('Invalid desktop version-status commit');
  timestamp(value.publishedAt, 'publishedAt');
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 4096)) {
    throw Error('Invalid desktop version-status description');
  }
  return value;
}

function validateDesktopManifest(value, { target, legacy = false } = {}) {
  object(value, 'desktop update manifest');
  if (value.kind === 'version-status' || value.releaseStatus === 'version-only' || value.installable === false) {
    throw Error('A version-status record is not an installable desktop manifest');
  }
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
  packageFields(value, { allowRecordedBuildDate: true });
  if (!/^[a-f0-9]{40}$/.test(value.commit || '') || !/^[a-f0-9]{64}$/.test(value.sourceHash || '')) throw Error('Invalid Rust update provenance');
  if (value.fileName !== `${value.platform}-${value.arch}.zip`) throw Error('Rust update fileName/target mismatch');
  return value;
}

module.exports = { validateDesktopManifest, validateDesktopVersionStatus, validateRustManifest, timestamp };
