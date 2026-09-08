#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REFRESH_URL = 'https://fusion.qiniuapi.com/v2/tune/refresh';

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeHttpsUrl(value, name) {
  const url = new URL(required(value, name));
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizePrefix(value) {
  const input = required(value, 'prefix');
  if (input.startsWith('/') || /[\\\x00-\x1f]/.test(input)) throw new Error(`Invalid CDN prefix: ${value}`);
  const normalized = input.replace(/\/+$/, '');
  const parts = normalized.split('/');
  if (parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..')) {
    throw new Error(`Invalid CDN prefix: ${value}`);
  }
  return `${parts.join('/')}/`;
}

function normalizeVersion(value) {
  const version = required(value, 'version');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`version must be a stable X.Y.Z version, got: ${version}`);
  }
  return version;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function collectReleaseFiles(releaseDir, version, prefix, domain) {
  const installerName = `KP-Local-Helper-Setup-${version}-x64.exe`;
  const names = [installerName, `${installerName}.blockmap`, 'latest.yml', 'latest.json'];
  const normalizedPrefix = normalizePrefix(prefix);
  const baseUrl = `${normalizeHttpsUrl(domain, 'domain')}/${normalizedPrefix.replace(/\/$/, '')}`;

  for (const name of names) {
    const filePath = path.join(releaseDir, name);
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Required release file is missing: ${filePath}`);
    }
  }

  const manifestPath = path.join(releaseDir, 'latest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const installerPath = path.join(releaseDir, installerName);
  if (manifest.version !== version || manifest.fileName !== installerName) {
    throw new Error('latest.json does not match the requested version and installer');
  }
  if (manifest.url !== `${baseUrl}/${encodeURIComponent(installerName)}`) {
    throw new Error(`latest.json URL must use ${baseUrl}`);
  }
  if (manifest.size !== fs.statSync(installerPath).size || manifest.sha256 !== sha256(installerPath)) {
    throw new Error('latest.json size or SHA-256 does not match the installer');
  }

  const latestYml = fs.readFileSync(path.join(releaseDir, 'latest.yml'), 'utf8');
  if (!latestYml.includes(`version: ${version}`) || !latestYml.includes(installerName)) {
    throw new Error('latest.yml does not match the requested version and installer');
  }

  return names.map((name) => {
    const filePath = path.join(releaseDir, name);
    const size = fs.statSync(filePath).size;
    if (size <= 0) throw new Error(`Release file is empty: ${filePath}`);
    return {
      name,
      filePath,
      remoteKey: `${normalizedPrefix}${name}`,
      url: `${baseUrl}/${encodeURIComponent(name)}`,
      size,
      sha256: sha256(filePath),
    };
  });
}

function urlSafeBase64(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function createUploadToken(accessKey, secretKey, bucket, remoteKey, deadline = Math.floor(Date.now() / 1000) + 3600) {
  const policy = urlSafeBase64(JSON.stringify({ scope: `${bucket}:${remoteKey}`, deadline }));
  const signature = urlSafeBase64(crypto.createHmac('sha1', secretKey).update(policy).digest());
  return `${accessKey}:${signature}:${policy}`;
}

function createQBoxAuthorization(accessKey, secretKey, requestUrl) {
  const url = new URL(requestUrl);
  const signingText = `${url.pathname}${url.search}\n`;
  const signature = urlSafeBase64(crypto.createHmac('sha1', secretKey).update(signingText).digest());
  return `QBox ${accessKey}:${signature}`;
}

async function uploadEntry(config, entry) {
  const form = new FormData();
  form.append('token', createUploadToken(config.accessKey, config.secretKey, config.bucket, entry.remoteKey));
  form.append('key', entry.remoteKey);
  form.append('file', new Blob([fs.readFileSync(entry.filePath)]), entry.name);
  const response = await fetch(config.uploadHost, { method: 'POST', body: form });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Qiniu upload failed for ${entry.name}: HTTP ${response.status} ${responseText}`);
  const result = JSON.parse(responseText);
  if (result.key !== entry.remoteKey) throw new Error(`Qiniu returned an unexpected key for ${entry.name}`);
}

async function refreshUrls(config, urls) {
  const body = JSON.stringify({ urls });
  const response = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: {
      Authorization: createQBoxAuthorization(config.accessKey, config.secretKey, REFRESH_URL),
      'Content-Type': 'application/json',
    },
    body,
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Qiniu CDN refresh failed: HTTP ${response.status} ${responseText}`);
  const result = JSON.parse(responseText);
  if (result.code !== 200 || (Array.isArray(result.invalidUrls) && result.invalidUrls.length)) {
    throw new Error(`Qiniu CDN refresh was rejected: ${responseText}`);
  }
}

async function verifyEntry(entry) {
  const response = await fetch(`${entry.url}?kp_release_verify=${Date.now()}`, {
    headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
  });
  if (!response.ok) throw new Error(`CDN verification failed for ${entry.url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  if (data.length !== entry.size || digest !== entry.sha256) {
    throw new Error(`CDN verification mismatch for ${entry.url}`);
  }
}

async function verifyEntriesWithRetry(entries, attempts = 20, delayMs = 30_000) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      for (const entry of entries) {
        process.stdout.write(`Verifying ${entry.url} (attempt ${attempt}/${attempts})\n`);
        await verifyEntry(entry);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function readArgs(argv) {
  const result = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key || '(end)'}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const version = normalizeVersion(args.version);
  const releaseDir = path.resolve(required(args['release-dir'], 'release-dir'));
  const prefix = normalizePrefix(required(args.prefix, 'prefix'));
  const domain = normalizeHttpsUrl(required(args.domain, 'domain'), 'domain');
  const entries = collectReleaseFiles(releaseDir, version, prefix, domain);
  process.stdout.write(`${JSON.stringify({ version, prefix, files: entries.map(({ filePath, ...entry }) => entry) }, null, 2)}\n`);
  if (args.dryRun) return;

  const config = {
    accessKey: required(process.env.KP_QINIU_ACCESS_KEY, 'KP_QINIU_ACCESS_KEY'),
    secretKey: required(process.env.KP_QINIU_SECRET_KEY, 'KP_QINIU_SECRET_KEY'),
    bucket: required(args.bucket, 'bucket'),
    uploadHost: normalizeHttpsUrl(required(args['upload-host'], 'upload-host'), 'upload-host'),
  };

  for (const entry of entries) {
    process.stdout.write(`Uploading ${entry.name} -> ${entry.remoteKey}\n`);
    await uploadEntry(config, entry);
  }
  await refreshUrls(config, entries.map((entry) => entry.url));
  await verifyEntriesWithRetry(entries);
  process.stdout.write('Qiniu upload, refresh, and CDN verification completed.\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { collectReleaseFiles, createQBoxAuthorization, createUploadToken, normalizePrefix, normalizeVersion, verifyEntriesWithRetry };
