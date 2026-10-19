const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { hasRuntimeSourceChanges, validateMcpRuntime } = require('./scripts/validate-mcp-runtime.cjs');
const runtime = process.env.AICHAT_MCP_RUNTIME_DIR;
const modelRuntime = process.env.KP_LOCAL_MODEL_RUNTIME_DIR;
const updateTarget = process.env.AICHAT_DESKTOP_TARGET || `${process.platform}-${process.arch}`;
module.exports = {
  appId: 'com.keepwork.aichat-desktop', productName: 'KeepWork 第二大脑',
  icon: 'assets/keepwork.png', directories: { output: 'release' }, files: ['dist/**/*', 'package.json'],
  // node-pty 1.1 ships Node-API prebuilds; validate them inside Electron instead
  // of requiring every installer builder to compile a second copy with MSVC.
  asar: true, asarUnpack: ['node_modules/node-pty/**/*'], npmRebuild: false,
  extraResources: [
    ...(runtime ? [{ from: path.resolve(runtime), to: 'mcp-runtime' }] : []),
    ...(modelRuntime ? [{ from: path.resolve(modelRuntime), to: 'local-model-runtime' }] : []),
  ],
  beforePack: async context => {
    const platform = context.electronPlatformName === 'win32' ? 'windows' : 'macos';
    const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : 'unsupported';
    const repoRoot = path.resolve(__dirname, '../..');
    validateMcpRuntime(runtime, {
      platform,
      arch,
      hasSourceChangesSince: commit => hasRuntimeSourceChanges(repoRoot, commit),
    });
    if (!modelRuntime) throw new Error('KP_LOCAL_MODEL_RUNTIME_DIR must point to the tested local-model runtime');
    const local = JSON.parse(fs.readFileSync(path.join(modelRuntime, 'runtime.json'), 'utf8'));
    if (local.platform !== platform || local.arch !== arch || local.product !== 'keepwork-local-model-node-runtime' || local.entry !== 'app/dist/src/cli.js') throw new Error('Bundled local-model runtime target mismatch');
    execFileSync(process.execPath, [path.join(__dirname, 'scripts/native-smoke.cjs')], { stdio: 'inherit' });
  },
  afterPack: path.join(__dirname, 'scripts/after-pack.cjs'),
  win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }], artifactName: 'KeepWork-SecondBrain-${version}-${arch}.${ext}', verifyUpdateCodeSignature: true },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, createDesktopShortcut: true, deleteAppDataOnUninstall: false },
  mac: { icon: 'assets/keepwork-mac.png', target: ['zip'], category: 'public.app-category.productivity',
    identity: process.env.CSC_NAME === '-' ? '-' : undefined, hardenedRuntime: true,
    entitlements: 'assets/entitlements.mac.plist', entitlementsInherit: 'assets/entitlements.mac.plist',
    artifactName: 'KeepWork-SecondBrain-${version}-${arch}.${ext}', extendInfo: { CFBundleDisplayName: 'Keepwork', NSMicrophoneUsageDescription: 'AIChat uses the microphone for voice conversations.', NSCameraUsageDescription: 'AIChat uses the camera when you start a video conversation.' } },
  publish: [{ provider: 'generic', url: `https://cdn.keepwork.com/keepwork/aichat-desktop/${updateTarget}/` }],
};
