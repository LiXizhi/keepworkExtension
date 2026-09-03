const path = require('node:path');

function text(value) {
  return String(value || '').trim();
}

function createBuilderConfig(localConfig = {}, helperRoot = path.resolve(__dirname, '..')) {
  const publishUrl = text(localConfig.KP_HELPER_PUBLISH_URL).replace(/\/+$/, '');
  const certificateLink = text(localConfig.KP_WINDOWS_CSC_LINK);
  const certificatePassword = String(localConfig.KP_WINDOWS_CSC_KEY_PASSWORD || '');
  const certificateSubjectName = text(localConfig.KP_WINDOWS_CERT_SUBJECT);
  const requireCodeSigning = localConfig.KP_REQUIRE_CODE_SIGNING === true;

  if (certificateLink && certificateSubjectName) {
    throw new Error('Configure either KP_WINDOWS_CSC_LINK or KP_WINDOWS_CERT_SUBJECT, not both');
  }
  if (certificatePassword && !certificateLink) {
    throw new Error('KP_WINDOWS_CSC_KEY_PASSWORD requires KP_WINDOWS_CSC_LINK');
  }
  if (requireCodeSigning && !certificateLink && !certificateSubjectName) {
    throw new Error('KP_REQUIRE_CODE_SIGNING is true but no Windows signing certificate is configured');
  }

  const win = {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'KP-Local-Helper-Setup-${version}-${arch}.${ext}',
    executableName: 'KP Local Helper',
    icon: 'dist/icon.png',
    requestedExecutionLevel: 'asInvoker',
    verifyUpdateCodeSignature: true,
  };

  if (certificateLink) {
    win.signtoolOptions = {
      certificateFile: path.resolve(helperRoot, certificateLink),
      certificatePassword,
      signingHashAlgorithms: ['sha256'],
    };
  } else if (certificateSubjectName) {
    win.signtoolOptions = {
      certificateSubjectName,
      signingHashAlgorithms: ['sha256'],
    };
  }

  return {
    appId: 'com.keepwork.local-helper',
    productName: 'KP Local Helper',
    copyright: 'Copyright (c) Keepwork',
    directories: {
      output: 'release',
    },
    files: [
      'dist/**/*',
      'package.json',
      '!dist/**/*.map',
      '!node_modules/**/*.map',
      '!node_modules/node-pty/{deps,scripts,src,third_party,typings}/**/*',
      '!node_modules/node-pty/prebuilds/{darwin-*,win32-arm64}/**/*',
      '!node_modules/node-pty/**/*.map',
      '!node_modules/node-pty/**/*.pdb',
      '!node_modules/node-pty/build/{.deps,Makefile,*.mk,*.gypi,gyp-mac-tool}/**/*',
    ],
    asar: true,
    asarUnpack: [
      'node_modules/node-pty/build/Release/**/*',
      'node_modules/node-pty/prebuilds/win32-x64/**/*',
    ],
    npmRebuild: true,
    buildDependenciesFromSource: false,
    forceCodeSigning: requireCodeSigning,
    win,
    nsis: {
      include: 'build/installer.nsh',
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      runAfterFinish: true,
      shortcutName: 'KP Local Helper',
      uninstallDisplayName: 'KP Local Helper',
      deleteAppDataOnUninstall: false,
    },
    publish: publishUrl ? [{ provider: 'generic', url: publishUrl }] : null,
  };
}

module.exports = { createBuilderConfig };
