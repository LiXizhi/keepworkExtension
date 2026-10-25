// Only local operator configuration can select the native trusted app entry.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
function validateEntry(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname)))) throw new Error('Deployment entry requires HTTPS or loopback HTTP');
  return url.href;
}
async function openDeployment(file) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (config.schemaVersion !== 1) throw new Error('Unsupported desktop deployment schema');
  if (config.entryURL) return { url: validateEntry(config.entryURL), close() {}, config };
  if (!path.isAbsolute(config.platformRoot || '') || !path.isAbsolute(config.profileHome || '') || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(config.profile || '')) throw new Error('Deployment requires absolute platformRoot/profileHome and a profile ID');
  const { PackageStore } = await import(pathToFileURL(path.join(config.platformRoot,'scripts/package_store.mjs')).href);
  const store = new PackageStore(config.profileHome);
  const snapshot = await store.inspect(config.profile);
  const baseRoot=snapshot.profile.baseDigest ? path.join(config.profileHome,'packages','aichat-base',snapshot.profile.baseVersion,'files') : config.platformRoot;
  const { servePackages } = await import(pathToFileURL(path.join(baseRoot,'scripts/package_server.mjs')).href);
  const server = await servePackages({store,profile:config.profile,root:baseRoot});
  return {...server,config: {...config, identityRealm: snapshot.profile.config.identity?.baseURL || snapshot.profile.config.plugins?.['compatible-auth']?.profileURL || 'local', relay: snapshot.profile.config.relay?.gateway ? snapshot.profile.config.relay : snapshot.profile.config.plugins?.['gameserver-relay']}};
}
module.exports = {openDeployment,validateEntry};
