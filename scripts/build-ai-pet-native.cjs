'use strict';

// Native builds are deliberately separate from offline core checks and tool
// installation. Platform scripts own tool selection and artifact validation.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const platforms = {
  android: ['sh', path.join(root, 'apps/ai-pet-android/scripts/build-android.sh')],
  ios: ['bash', path.join(root, 'apps/ai-pet-ios/scripts/build-simulator.sh')],
};
const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '--list'].includes(args[0])) {
  process.stdout.write('Usage: node scripts/build-ai-pet-native.cjs [android ios]\n');
  process.stdout.write('Default: both platforms. Requires prepared toolchains; build tools may download dependencies.\n');
  process.stdout.write('Android: debug APK and lint. iOS: unsigned Simulator app. No install, launch or release.\n');
} else if (args.some(name => !Object.hasOwn(platforms, name))) {
  process.stderr.write('Unknown platform. Use --list.\n');
  process.exitCode = 2;
} else {
  const failures = [];
  for (const name of [...new Set(args.length ? args : Object.keys(platforms))]) {
    process.stdout.write(`\n[AI Pet native build] ${name}\n`);
    const [command, script] = platforms[name];
    const result = spawnSync(command, [script], {
      cwd: root, env: process.env, stdio: 'inherit', timeout: 1_200_000,
    });
    if (result.error || result.status !== 0) {
      failures.push(name);
      process.stderr.write(`${name}: ${result.error?.message || `exit ${result.status}, signal ${result.signal || 'none'}`}\n`);
    }
  }
  if (failures.length) {
    process.stderr.write(`\nNative builds incomplete/failed: ${failures.join(', ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nSelected native builds passed. Device behavior and service integration require separate evidence.\n');
  }
}
