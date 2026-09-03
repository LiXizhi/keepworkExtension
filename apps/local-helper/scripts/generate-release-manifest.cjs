#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readArgs(argv) {
    const result = {};
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
        result[key.slice(2)] = value;
        i += 1;
    }
    return result;
}

function required(args, name) {
    const value = String(args[name] || '').trim();
    if (!value) throw new Error(`--${name} is required`);
    return value;
}

function main() {
    const args = readArgs(process.argv.slice(2));
    const file = path.resolve(required(args, 'file'));
    const output = path.resolve(args.output || 'release-manifest.json');
    const version = required(args, 'version');
    const protocolVersion = required(args, 'protocol-version');
    const baseUrl = required(args, 'base-url').replace(/\/+$/, '');
    const data = fs.readFileSync(file);
    const manifest = {
        schemaVersion: 1,
        product: 'kp-local-helper',
        version,
        protocolVersion,
        platform: args.platform || 'windows',
        arch: args.arch || 'x64',
        fileName: path.basename(file),
        url: `${baseUrl}/${encodeURIComponent(path.basename(file))}`,
        size: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
        publishedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`${output}\n`);
}

try {
    main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
}
