'use strict';

// Runs only the offline AI Pet foundation checks. It installs nothing and does
// not turn passing host tests into native-device or external-service evidence.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const android = path.join(root, 'apps/ai-pet-android');
const ios = path.join(root, 'apps/ai-pet-ios');

function nodeTests(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.test.cjs')).sort();
  if (!files.length) throw new Error(`No tests in ${relativeDirectory}`);
  return [process.execPath, ['--test', ...files.map(name => path.join(directory, name))]];
}

function androidEnvironment() {
  const env = { ...process.env };
  if (!env.JAVA_HOME) {
    const toolchains = path.join(android, '.toolchains');
    const candidates = fs.existsSync(toolchains)
      ? fs.readdirSync(toolchains).filter(name => name.startsWith('jdk-')).sort().flatMap(name => {
        const base = path.join(toolchains, name);
        return [path.join(base, 'Contents/Home'), base];
      }) : [];
    env.JAVA_HOME = candidates.find(candidate => fs.existsSync(path.join(candidate, 'bin/java')));
  }
  if (!env.JAVA_HOME || !fs.existsSync(path.join(env.JAVA_HOME, 'bin/java'))) {
    throw new Error('Android core requires JDK 17: set JAVA_HOME or prepare the app-local toolchain described in its README. No tools were installed.');
  }
  return env;
}

const components = {
  contracts: () => ({ command: nodeTests('contracts/ai-pet/test'), cwd: root }),
  android: () => ({ command: ['sh', ['scripts/check-core-portable.sh']], cwd: android, env: androidEnvironment() }),
  ios: () => ({
    command: ['swift', ['run', '--disable-sandbox', '--scratch-path', '.build',
      '--cache-path', '.cache/swiftpm', '--config-path', '.cache/config',
      '--security-path', '.cache/security', 'AIPetCoreChecks']],
    cwd: ios,
    env: { ...process.env, SWIFTPM_MODULECACHE_OVERRIDE: path.join(ios, '.cache/modules'),
      CLANG_MODULE_CACHE_PATH: path.join(ios, '.cache/clang') },
  }),
  qa: () => ({ command: nodeTests('tests/ai-pet-m0'), cwd: root }),
  localization: () => ({ command: ['python3', ['tests/ai-pet-m0/inspect-localization.py']], cwd: root }),
  'runtime-harness': () => ({ commands: [
    ['python3', ['apps/ai-pet-android/scripts/test_emulator_runtime.py']],
    ['python3', ['apps/ai-pet-android/scripts/test_emulator_ui.py']],
    ['python3', ['apps/ai-pet-android/scripts/test_owned_emulator.py']],
    ['python3', ['tests/ai-pet-m0/test_runtime_harness.py']],
  ], cwd: root }),
  'native-qa': () => {
    const env = process.env.AI_PET_QA_JAVA ? { ...process.env } : androidEnvironment();
    env.AI_PET_QA_JAVA ||= path.join(env.JAVA_HOME, 'bin/java');
    return { command: ['sh', ['tests/ai-pet-m0/run-native-conformance.sh']], cwd: root, env };
  },
  layout: () => ({ command: [process.execPath, ['scripts/check-layout.cjs']], cwd: root }),
};

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '--list'].includes(args[0])) {
  process.stdout.write('Usage: node scripts/check-ai-pet-m0.cjs [contracts android ios qa localization runtime-harness native-qa layout]\n');
  process.stdout.write('Default: all components. Offline host checks only; dependencies/toolchains must already exist.\n');
} else {
  const selected = args.length ? args : Object.keys(components);
  if (selected.some(name => !Object.hasOwn(components, name))) {
    process.stderr.write('Unknown component. Use --list.\n');
    process.exitCode = 2;
  } else {
    const failures = [];
    for (const name of [...new Set(selected)]) {
      process.stdout.write(`\n[AI Pet M0] ${name}\n`);
      try {
        const spec = components[name]();
        for (const [command, commandArgs] of spec.commands || [spec.command]) {
          const result = spawnSync(command, commandArgs, {
            cwd: spec.cwd, env: spec.env || process.env, stdio: 'inherit', timeout: 600_000,
          });
          if (result.error || result.status !== 0) {
            throw new Error(result.error?.message || `exit ${result.status}, signal ${result.signal || 'none'}`);
          }
        }
      } catch (error) {
        failures.push(name);
        process.stderr.write(`${name}: ${error.message}\n`);
      }
    }
    if (failures.length) {
      process.stderr.write(`\nOffline checks incomplete/failed: ${failures.join(', ')}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('\nSelected offline host checks passed. Native app/device and backend gates remain open.\n');
    }
  }
}
