// Desktop application identity is independent of the MCP runtime/protocol version.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const identityPath = () => path.join(os.homedir(), '.keepwork-mcp', 'desktop-client.json');
function valid(value) {
  return value?.product === 'aichat-desktop' && /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(value.version || '')
    && ['macos', 'windows'].includes(value.platform) && ['arm64', 'x64'].includes(value.arch)
    && typeof value.executable === 'string' && path.isAbsolute(value.executable);
}
function rememberDesktopClient(info, file = identityPath()) {
  const value = { ...info, product: 'aichat-desktop' };
  if (!valid(value)) throw new Error('Invalid desktop application identity');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readDesktopClient(file = identityPath()) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!valid(value) || !fs.statSync(value.executable).isFile()) return undefined;
    // The unauthenticated health endpoint must never disclose the executable path.
    return { product: value.product, version: value.version, platform: value.platform, arch: value.arch };
  } catch { return undefined; }
}
module.exports = { rememberDesktopClient, readDesktopClient };
