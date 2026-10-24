/** Build-time vendoring. Checks verify canonical parity when available, otherwise packaged integrity. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const { verifyFreshness } = require('./aichat-runtime-freshness.cjs');
const defaultSource = path.resolve(__dirname, '../../apps/official/apps/tools/AIChat/runtime');
const defaultDest = path.resolve(__dirname, '../src/core/vendor/aichat-runtime');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function runtimeFiles(source) {
    if (!fs.existsSync(source)) throw Error(`AIChat runtime source missing: ${source}. Restore the sibling AIChat checkout or pass its runtime directory explicitly.`);
    const files = fs.readdirSync(source).filter(f => f.endsWith('.mjs')).sort();
    if (!files.length) throw Error(`AIChat runtime source has no modules: ${source}`);
    return files;
}
function verifyPackagedRuntime(dest) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
    const entries = Object.entries(manifest.files || {});
    if (manifest.sourceRevision && (!/^[a-f0-9]{40,64}$/.test(manifest.sourceRevision.commit || '') || typeof manifest.sourceRevision.dirty !== 'boolean')) throw Error('Invalid runtime source provenance');
    if (manifest.version !== 1 || manifest.source !== 'AIChat/runtime' || !entries.length) throw Error('Invalid vendored runtime manifest');
    for (const [file, info] of entries) {
        if (!/^[a-zA-Z0-9_-]+\.mjs$/.test(file) || !/^[a-f0-9]{64}$/.test(info?.source || '') || !/^[a-f0-9]{64}$/.test(info?.output || '')) throw Error('Invalid vendored runtime manifest entry');
    }
    const expected = entries.map(([file]) => file.replace(/\.mjs$/, '.cjs')).sort();
    const actual = fs.readdirSync(dest).filter(file => file.endsWith('.cjs')).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Vendored runtime module inventory changed');
    for (const [file, info] of entries) {
        if (hash(fs.readFileSync(path.join(dest, file.replace(/\.mjs$/, '.cjs')))) !== info.output) throw Error('Vendored runtime modified: ' + file);
    }
}
function syncRuntime({ source = defaultSource, dest = defaultDest, check = false, allowMissingSource = true, freshness = verifyFreshness } = {}) {
    if (!fs.existsSync(source) && !fs.existsSync(path.dirname(source)) && allowMissingSource) {
        verifyPackagedRuntime(dest);
        return [];
    }
    const files = runtimeFiles(source);
    const manifestPath = path.join(dest, 'manifest.json');
    const manifest = { version: 1, source: 'AIChat/runtime', files: {} };
    const outputs = new Map();
    for (const file of files) {
        const input = fs.readFileSync(path.join(source, file), 'utf8');
        const output = ts.transpileModule(input.replace(/(from\s+['"][^'"]+)\.mjs(['"])/g, '$1.cjs$2'), {
            fileName: file.replace(/\.mjs$/, '.js'),
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, allowJs: true }
        }).outputText;
        outputs.set(file.replace(/\.mjs$/, '.cjs'), output);
        manifest.files[file] = { source: hash(input), output: hash(output) };
    }
    const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
    if (check) {
        if (previous?.sourceRevision) manifest.sourceRevision = previous.sourceRevision;
    } else {
        if (previous) verifyPackagedRuntime(dest);
        const changed = !previous || JSON.stringify(previous.files) !== JSON.stringify(manifest.files);
        const revision = freshness({ source, previous, changed });
        if (revision) manifest.sourceRevision = revision;
        if (JSON.stringify(runtimeFiles(source)) !== JSON.stringify(files) || files.some(file =>
            hash(fs.readFileSync(path.join(source, file))) !== manifest.files[file].source)) {
            throw Error('AIChat runtime changed during sync; packaged runtime left unchanged. Retry.');
        }
    }
    const manifestText = JSON.stringify(manifest, null, 2) + '\n';
    if (check) {
        if (!fs.existsSync(manifestPath) || fs.readFileSync(manifestPath, 'utf8') !== manifestText) {
            throw Error('AIChat runtime out of sync (source, module inventory or compiler output changed). Run npm run sync:aichat-runtime.');
        }
        const actual = fs.readdirSync(dest).filter(f => f.endsWith('.cjs')).sort();
        if (JSON.stringify(actual) !== JSON.stringify([...outputs.keys()].sort())) throw Error('Vendored runtime module inventory changed');
        for (const [file, output] of outputs) {
            if (fs.readFileSync(path.join(dest, file), 'utf8') !== output) throw Error('Vendored runtime modified: ' + file);
        }
    } else {
        fs.mkdirSync(dest, { recursive: true });
        // This directory contains only generated runtime modules and their manifest.
        for (const file of fs.readdirSync(dest)) {
            if (file.endsWith('.cjs') && !outputs.has(file)) fs.unlinkSync(path.join(dest, file));
        }
        outputs.set('manifest.json', manifestText);
        for (const [file, output] of outputs) {
            const target = path.join(dest, file);
            // Avoid triggering another watch rebuild when the generated bytes are unchanged.
            if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) fs.writeFileSync(target, output);
        }
    }
    return files.map(file => path.join(source, file));
}
module.exports = { syncRuntime, defaultSource, defaultDest };
if (require.main === module) {
    const args = process.argv.slice(2);
    try {
        const explicitSource = args.find(a => !a.startsWith('--'));
        const files = syncRuntime({ source: explicitSource || defaultSource, check: args.includes('--check'), allowMissingSource: !explicitSource });
        console.log(!files.length ? 'AIChat checkout absent; verified packaged runtime copy' : args.includes('--check') ? 'AIChat runtime source and packaged copy verified' : 'Synced AIChat runtime');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
