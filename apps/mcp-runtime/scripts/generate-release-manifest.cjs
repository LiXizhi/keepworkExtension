#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key || '(end)'}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function required(args, name) {
  const value = String(args[name] || '').trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('--base-url must use HTTPS');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function manifestForFile(filePath, args) {
  const fileName = path.basename(filePath);
  const platform = required(args, 'platform');
  const arch = required(args, 'arch');
  const baseUrl = normalizeBaseUrl(required(args, 'base-url'));
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`release file is empty or missing: ${filePath}`);
  return {
    schemaVersion: 1,
    id: 'keepwork-mcp',
    name: 'Keepwork MCP',
    product: 'keepwork-mcp-node-runtime',
    version: required(args, 'version'),
    platform,
    arch,
    archiveName: fileName,
    fileName,
    url: `${baseUrl}/${encodeURIComponent(fileName)}`,
    size: stat.size,
    sha256: sha256(filePath),
    entry: 'app/cli.cjs',
    args: ['--port', '8089'],
    health: {
      url: 'http://127.0.0.1:8089/health',
      match: { name: 'keepwork-mcp' },
      timeoutMs: 10000,
    },
    logFile: 'keepwork-mcp.log',
    publishedAt: new Date().toISOString(),
  };
}

function main() {
  const args = readArgs(process.argv.slice(2));
  const file = path.resolve(required(args, 'file'));
  const output = path.resolve(args.output || 'latest.json');
  const manifest = manifestForFile(file, args);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { manifestForFile };
