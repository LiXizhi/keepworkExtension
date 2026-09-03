const assert = require('node:assert/strict');
const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
const { createBuilderConfig } = require('./create-builder-config.cjs');

async function main() {
  const debugLogger = { isEnabled: false, add() {} };
  await validateConfiguration(require('../electron-builder.config.cjs'), debugLogger);
  await validateConfiguration(createBuilderConfig(), debugLogger);
  await validateConfiguration(createBuilderConfig({
    KP_WINDOWS_CSC_LINK: 'C:\\secure\\keepwork-test.pfx',
    KP_WINDOWS_CSC_KEY_PASSWORD: 'test-only',
    KP_REQUIRE_CODE_SIGNING: true,
  }), debugLogger);
  await validateConfiguration(createBuilderConfig({
    KP_WINDOWS_CERT_SUBJECT: 'CN=Keepwork Config Check',
    KP_REQUIRE_CODE_SIGNING: true,
  }), debugLogger);
  assert.throws(
    () => createBuilderConfig({ KP_WINDOWS_CSC_KEY_PASSWORD: 'orphan-password' }),
    /requires KP_WINDOWS_CSC_LINK/,
  );
  assert.throws(
    () => createBuilderConfig({ KP_REQUIRE_CODE_SIGNING: true }),
    /no Windows signing certificate/,
  );
  process.stdout.write('electron-builder configuration is valid\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
