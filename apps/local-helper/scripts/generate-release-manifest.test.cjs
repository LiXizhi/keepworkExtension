const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('generates a versioned download manifest with checksum', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-helper-manifest-'));
    try {
        const artifact = path.join(dir, 'KP-Local-Helper-Setup-0.1.15-x64.exe');
        const output = path.join(dir, 'latest.json');
        fs.writeFileSync(artifact, 'signed-installer-placeholder');
        const result = spawnSync(process.execPath, [
            path.join(__dirname, 'generate-release-manifest.cjs'),
            '--file', artifact,
            '--version', '0.1.15',
            '--protocol-version', '0.1.2',
            '--base-url', 'https://cdn.keepwork.com/downloads/kp-local-helper/windows-x64/',
            '--output', output,
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const manifest = JSON.parse(fs.readFileSync(output, 'utf8'));
        assert.equal(manifest.schemaVersion, 1);
        assert.equal(manifest.product, 'kp-local-helper');
        assert.equal(manifest.version, '0.1.15');
        assert.equal(manifest.protocolVersion, '0.1.2');
        assert.equal(manifest.platform, 'windows');
        assert.equal(manifest.arch, 'x64');
        assert.equal(manifest.url, 'https://cdn.keepwork.com/downloads/kp-local-helper/windows-x64/KP-Local-Helper-Setup-0.1.15-x64.exe');
        assert.equal(manifest.sha256, crypto.createHash('sha256').update('signed-installer-placeholder').digest('hex'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('rejects a manifest without a required version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-helper-manifest-'));
    try {
        const artifact = path.join(dir, 'setup.exe');
        fs.writeFileSync(artifact, 'x');
        const result = spawnSync(process.execPath, [
            path.join(__dirname, 'generate-release-manifest.cjs'),
            '--file', artifact,
            '--protocol-version', '0.1.2',
            '--base-url', 'https://cdn.keepwork.com/downloads/',
        ], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /--version is required/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
