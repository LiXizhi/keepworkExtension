const fs = require('node:fs');
const { atomicJson } = require('./files.cjs');
const { trustedPage } = require('./security.cjs');

function pageKey(url) {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname;
}

function sameOrigin(url, origin) {
  try {
    const parsed = new URL(origin);
    return !parsed.username && !parsed.password && new URL(url).origin === parsed.origin;
  } catch { return false; }
}

// Electron's persistent session does not persist decisions made by our handler.
// Keep microphone and camera grants separate; an audio grant must not grant video.
class MediaGrants {
  constructor(file) {
    this.file = file;
    this.grants = {};
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version === 1 && saved.grants && typeof saved.grants === 'object') this.grants = saved.grants;
    } catch { /* First launch or invalid file: ask again. */ }
  }
  has(key, type) { return this.grants[key]?.[type] === true; }
  allow(key, types) {
    const grants = { ...this.grants, [key]: { ...this.grants[key] } };
    for (const type of types) grants[key][type] = true;
    atomicJson(this.file, { version: 1, grants });
    this.grants = grants;
  }
}

function installPermissions(window, grants, getDevelopmentUrl, dialog) {
  const contents = window.webContents;
  let navigation = 0;
  const pending = new Map();
  contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) navigation++;
  });

  function trusted(sender, details) {
    if (window.isDestroyed() || contents.isDestroyed() || sender !== contents || details.isMainFrame !== true) return false;
    const developmentUrl = getDevelopmentUrl();
    const url = contents.getURL();
    if (!trustedPage(url, developmentUrl) || !trustedPage(details.requestingUrl, developmentUrl)) return false;
    return !details.securityOrigin || sameOrigin(url, details.securityOrigin);
  }

  contents.session.setPermissionCheckHandler((sender, permission, origin, details) => {
    if (!trusted(sender, details) || !sameOrigin(contents.getURL(), origin)) return false;
    if (permission === 'clipboard-sanitized-write') return true;
    // embeddingOrigin is absent for top-level requests. Validate requestingUrl
    // instead of passing an origin (without /chat) to the exact-page validator.
    return permission === 'media' && ['audio', 'video'].includes(details.mediaType)
      && grants.has(pageKey(details.requestingUrl), details.mediaType);
  });

  async function request(sender, permission, details) {
    if (!trusted(sender, details)) return false;
    const key = pageKey(details.requestingUrl);
    const generation = navigation;
    const stillTrusted = () => navigation === generation && trusted(sender, details);
    if (permission !== 'media') {
      if (!['notifications', 'clipboard-sanitized-write'].includes(permission)) return false;
      const label = permission === 'notifications' ? '通知' : '剪贴板写入';
      const answer = await dialog.showMessageBox(window, { message: `允许 AIChat 使用${label}？`, buttons: ['不允许', '允许'], defaultId: 0, cancelId: 0 });
      return stillTrusted() && answer.response === 1;
    }
    const types = details.mediaTypes;
    if (!Array.isArray(types) || !types.length || types.some(type => !['audio', 'video'].includes(type))) return false;
    const missing = [...new Set(types)].filter(type => !grants.has(key, type)).sort();
    if (!missing.length) return true;
    const pendingKey = JSON.stringify([generation, key, missing]);
    if (!pending.has(pendingKey)) {
      const decision = (async () => {
        const label = missing.map(type => type === 'audio' ? '麦克风' : '摄像头').join('和');
        const answer = await dialog.showMessageBox(window, {
          message: `允许 AIChat 使用${label}？`, detail: '允许后会记住此页面的授权，下次使用不再重复询问。系统隐私权限仍由系统管理。',
          buttons: ['不允许', '允许'], defaultId: 0, cancelId: 0,
        });
        if (!stillTrusted() || answer.response !== 1) return false;
        grants.allow(key, missing);
        return true;
      })();
      pending.set(pendingKey, decision);
    }
    try { return await pending.get(pendingKey) && stillTrusted(); }
    finally { pending.delete(pendingKey); }
  }

  contents.session.setPermissionRequestHandler((sender, permission, callback, details) => {
    // A closed dialog or failed grant write must settle the request, never leave
    // getUserMedia waiting on an unhandled promise rejection.
    void request(sender, permission, details).then(callback, error => {
      console.warn('Desktop permission request failed:', error);
      callback(false);
    });
  });
}

module.exports = { MediaGrants, installPermissions };
