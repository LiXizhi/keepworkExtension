const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.CSC_LINK) return;

  const { signAsync } = require('@electron/osx-sign');
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = path.join(__dirname, '..', 'assets', 'entitlements.mac.plist');

  // Apple Silicon requires a coherent signature even for local, non-notarized builds.
  // Public releases are separately gated on a Developer ID identity and notarization.
  await signAsync({
    app,
    identity: '-',
    identityValidation: false,
    hardenedRuntime: true,
    optionsForFile: () => ({ entitlements, hardenedRuntime: true }),
  });
};
