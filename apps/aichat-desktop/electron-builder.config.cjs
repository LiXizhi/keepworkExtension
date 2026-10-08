const path = require('node:path');
const fs = require('node:fs');
const runtime = process.env.AICHAT_MCP_RUNTIME_DIR;
module.exports = {
  appId: 'com.keepwork.aichat-desktop', productName: 'KeepWork 第二大脑',
  icon: 'assets/keepwork.png', directories: { output: 'release' }, files: ['dist/**/*', 'package.json'],
  // node-pty 1.1 ships Node-API prebuilds; validate them inside Electron instead
  // of requiring every installer builder to compile a second copy with MSVC.
  asar: true, asarUnpack: ['node_modules/node-pty/**/*'], npmRebuild: false,
  extraResources: runtime ? [{ from: path.resolve(runtime), to: 'mcp-runtime' }] : [],
  beforePack: async context => {
    require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, 'scripts/native-smoke.cjs')], { stdio: 'inherit' });
    if (!runtime) throw new Error('AICHAT_MCP_RUNTIME_DIR must point to the tested native MCP runtime');
    const platform = context.electronPlatformName === 'win32' ? 'windows' : 'macos';
    const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : 'unsupported';
    const m = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime.json'), 'utf8'));
    if (m.platform !== platform || m.arch !== arch || m.product !== 'keepwork-mcp-node-runtime') throw new Error('Bundled MCP runtime target mismatch');
  },
  win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }], artifactName: 'KeepWork-SecondBrain-${version}-${arch}.${ext}', verifyUpdateCodeSignature: true },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, createDesktopShortcut: true, deleteAppDataOnUninstall: false },
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.productivity', hardenedRuntime: true,
    artifactName: 'KeepWork-SecondBrain-${version}-${arch}.${ext}', extendInfo: { NSMicrophoneUsageDescription: 'AIChat uses the microphone for voice conversations.', NSCameraUsageDescription: 'AIChat uses the camera when you start a video conversation.' } },
  publish: [{ provider: 'generic', url: `https://cdn.keepwork.com/keepwork/aichat-desktop/${process.platform}-${process.arch}/` }],
};
