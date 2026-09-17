#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

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

function runtimeArchiveName(version, platform, arch) {
  const extension = platform === 'windows' ? 'zip' : 'tar.gz';
  return `Keepwork-MCP-NodeRuntime-${version}-${platform}-${arch}.${extension}`;
}

function collectReleaseFiles(releaseDir, version, platform, arch, prefix, domain) {
  const normalizedPrefix = normalizePrefix(prefix);
  const baseUrl = `${normalizeHttpsUrl(domain, 'domain')}/${normalizedPrefix.replace(/\/$/, '')}`;
  const archiveName = runtimeArchiveName(normalizeVersion(version), platform, arch);
  const names = [archiveName, `latest-${platform}-${arch}.json`];

  for (const name of names) {
    const filePath = path.join(releaseDir, name);
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Required release file is missing: ${filePath}`);
    }
  }

  const manifestPath = path.join(releaseDir, `latest-${platform}-${arch}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const archivePath = path.join(releaseDir, archiveName);
  if (manifest.version !== version || manifest.fileName !== archiveName || manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error('latest manifest does not match the requested runtime archive');
  }
  if (manifest.url !== `${baseUrl}/${encodeURIComponent(archiveName)}`) {
    throw new Error(`latest manifest URL must use ${baseUrl}`);
  }
  if (manifest.size !== fs.statSync(archivePath).size || manifest.sha256 !== sha256(archivePath)) {
    throw new Error('latest manifest size or SHA-256 does not match the archive');
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

function createMultipartParts(token, remoteKey, fileName) {
  const boundary = `----kp-mcp-runtime-${crypto.randomBytes(12).toString('hex')}`;
  const safeFileName = fileName.replace(/["\r\n]/g, '_');
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${token}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\n${remoteKey}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, header, footer };
}

function uploadFile(uploadHost, token, entry) {
  const { boundary, header, footer } = createMultipartParts(token, entry.remoteKey, entry.name);
  const contentLength = header.length + entry.size + footer.length;
  return new Promise((resolve, reject) => {
    const request = https.request(uploadHost, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': contentLength,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) reject(new Error(`upload ${entry.name}: HTTP ${response.statusCode} ${text}`));
        else resolve(text);
      });
    });
    request.on('error', reject);
    request.write(header);
    const stream = fs.createReadStream(entry.filePath);
    stream.on('error', reject);
    stream.on('end', () => request.end(footer));
    stream.pipe(request, { end: false });
  });
}

async function verifyEntry(entry) {
  const response = await fetch(`${entry.url}?kp_runtime_verify=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`verify ${entry.name}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  if (data.length !== entry.size || digest !== entry.sha256) {
    throw new Error(`verify ${entry.name}: size or SHA-256 mismatch`);
  }
}

function readArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key || '(end)'}`);
    result[key.slice(2)] = value;
  }
  return result;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const releaseDir = path.resolve(required(args['release-dir'], 'release-dir'));
  const version = normalizeVersion(args.version);
  const platform = required(args.platform, 'platform');
  const arch = required(args.arch, 'arch');
  const bucket = required(args.bucket, 'bucket');
  const uploadHost = normalizeHttpsUrl(required(args['upload-host'], 'upload-host'), 'upload-host');
  const entries = collectReleaseFiles(releaseDir, version, platform, arch, args.prefix, args.domain);
  const accessKey = required(process.env.KP_QINIU_ACCESS_KEY || args['access-key'], 'KP_QINIU_ACCESS_KEY');
  const secretKey = required(process.env.KP_QINIU_SECRET_KEY || args['secret-key'], 'KP_QINIU_SECRET_KEY');

  for (const entry of entries) {
    const token = createUploadToken(accessKey, secretKey, bucket, entry.remoteKey);
    await uploadFile(uploadHost, token, entry);
    await verifyEntry(entry);
    process.stdout.write(`published ${entry.url}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  collectReleaseFiles,
  createMultipartParts,
  createUploadToken,
  normalizePrefix,
  normalizeVersion,
  runtimeArchiveName,
};
