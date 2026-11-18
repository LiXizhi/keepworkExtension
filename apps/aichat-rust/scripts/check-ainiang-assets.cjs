'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const evidence = require('./ainiang-approval.cjs');
const { verifyAssetBundle, ASSET_PROFILES } = require('../../../contracts/ai-pet/asset-verifier.cjs');
const defaultRoot = path.resolve(__dirname, '../assets/ainiang');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const insist = (ok, reason) => { if (!ok) throw new Error(`ainiang:${reason}`); };

function readFile(root, relative, limit) {
  insist(!path.isAbsolute(relative) && !relative.includes('\\') && relative.split('/').every(p => p && p !== '.' && p !== '..'), 'path');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    insist(!fs.lstatSync(current).isSymbolicLink(), 'symlink');
  }
  const stat = fs.statSync(current);
  insist(stat.isFile() && stat.size <= limit, 'file-size');
  return fs.readFileSync(current);
}

function verifyAiniangAssets(root = defaultRoot, { nowMs = Date.now() } = {}) {
  root = fs.realpathSync(root);
  const rawCatalog = readFile(root, 'catalog.json', 65536);
  insist(hash(rawCatalog) === evidence.catalogSha256, 'catalog-binding');
  const catalog = JSON.parse(rawCatalog);
  const bundledNotice = fs.readFileSync(path.resolve(__dirname, '../src-tauri/resources/ainiang-attribution.txt'), 'utf8');
  insist(bundledNotice.includes(readFile(root, 'deepseek/DEEPSEEK-LICENSE.txt', 65536).toString('utf8')), 'bundled-license-notice');
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8'));
  insist(config.bundle.resources.includes('resources/ainiang-attribution.txt'), 'license-packaging');
  const ids = Object.keys(evidence.characters);
  insist(catalog.experimentOnly === true && catalog.commit === evidence.sourceCommit, 'experiment-source');
  insist(JSON.stringify(catalog.characters.map(c => c.id)) === JSON.stringify(ids), 'catalog-ids');
  insist(fs.readdirSync(root).sort().join('|') === ['catalog.json', ...ids].sort().join('|'), 'unexpected-assets');
  let bytes = 0;
  for (const character of catalog.characters) {
    const id = character.id;
    const pin = evidence.characters[id];
    const appearanceVersion = pin.appearanceVersion ?? '1';
    const profile = pin.assetProfile ?? 'standard';
    insist(Object.hasOwn(ASSET_PROFILES, profile), 'host-profile');
    insist(character.manifest === `${id}/manifest.json`, 'manifest-path');
    const manifest = JSON.parse(readFile(root, character.manifest, 65536));
    insist(manifest.characterId === id && manifest.appearanceId === `ainiang-${id}` && manifest.characterVersion === '1' && manifest.appearanceVersion === appearanceVersion, 'identity');
    insist(manifest.mouthMode === 'prerecorded', 'experimental-mouth-mode');
    insist(hash(readFile(root, `${id}/sources.json`, 65536)) === pin.sourcesSha256, 'source-evidence-binding');
    const files = [manifest.poster, ...Object.values(manifest.poses).map(pose => pose.file)];
    const resources = new Map();
    for (const file of files) {
      insist(/^[a-z]+\.png$/.test(file.path), 'resource-path');
      resources.set(file.path, readFile(root, `${id}/${file.path}`, ASSET_PROFILES[profile].fileBytes));
    }
    const notices = id === 'deepseek' ? ['DEEPSEEK-LICENSE.txt'] : [];
    if (notices.length) insist(hash(readFile(root, `${id}/${notices[0]}`, 65536)) === pin.licenseSha256, 'license-binding');
    insist(fs.readdirSync(path.join(root, id)).sort().join('|') === ['manifest.json', 'sources.json', ...notices, ...resources.keys()].sort().join('|'), 'unexpected-character-files');
    const approval = {
      usage: evidence.usage, status: 'approved',
      identity: { appearanceId: `ainiang-${id}`, appearanceVersion, characterId: id, characterVersion: '1' },
      assetProfile: profile,
      provenance: { sourceRef: `ainiangassets:${evidence.sourceCommit}:${id}`, licenseRef: id === 'deepseek' ? 'dsh-pet-mit-video-experiment' : 'experiment-user-attested-seedance-video-only', rightsEvidenceRef: evidence.evidenceRef },
      manifestSha256: pin.manifestSha256, validUntilMs: Date.parse(evidence.reviewBefore),
    };
    const admitted = verifyAssetBundle(manifest, { approval, resources, nowMs, profile });
    for (const buffer of admitted.resources.values()) bytes += buffer.length;
  }
  return { characters: ids, bytes, usage: evidence.usage, sourceCommit: evidence.sourceCommit };
}

module.exports = { verifyAiniangAssets };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    insist(args.length === 0 || (args.length === 2 && args[0] === '--root'), 'arguments');
    console.log(JSON.stringify(verifyAiniangAssets(args[1]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
