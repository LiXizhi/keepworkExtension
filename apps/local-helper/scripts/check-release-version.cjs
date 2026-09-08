#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStableVersion(value, label) {
  const text = String(value || '').trim();
  const match = STABLE_VERSION.exec(text);
  if (!match) throw new Error(`${label} must be a stable X.Y.Z version, got: ${text || '(empty)'}`);
  return { text, parts: match.slice(1).map(Number) };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] > right.parts[index] ? 1 : -1;
  }
  return 0;
}

function decideRelease(eventName, previousValue, currentValue) {
  const current = parseStableVersion(currentValue, 'current version');
  if (eventName === 'workflow_dispatch') {
    return { publish: true, version: current.text, previousVersion: '' };
  }
  if (eventName !== 'push') throw new Error(`Unsupported GitHub event: ${eventName}`);

  const previous = parseStableVersion(previousValue, 'previous version');
  const comparison = compareVersions(current, previous);
  if (comparison < 0) {
    throw new Error(`Local Helper version must increase, got ${previous.text} -> ${current.text}`);
  }
  return {
    publish: comparison > 0,
    version: current.text,
    previousVersion: previous.text,
  };
}

function readArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key || '(end)'}`);
    result[key.slice(2)] = value;
  }
  return result;
}

function packageVersionFromText(contents, label) {
  return parseStableVersion(JSON.parse(contents).version, label).text;
}

function appendGitHubOutputs(outputPath, decision) {
  fs.appendFileSync(outputPath, [
    `publish=${decision.publish}`,
    `version=${decision.version}`,
    `previous_version=${decision.previousVersion}`,
    '',
  ].join('\n'), 'utf8');
}

function main() {
  const args = readArgs(process.argv.slice(2));
  const eventName = String(args.event || '').trim();
  const packagePath = String(args['package-path'] || 'apps/local-helper/package.json');
  const outputPath = String(args.output || '').trim();
  if (!eventName) throw new Error('--event is required');
  if (!outputPath) throw new Error('--output is required');

  const currentVersion = packageVersionFromText(fs.readFileSync(packagePath, 'utf8'), 'current version');
  let previousVersion = '';
  if (eventName === 'push') {
    const beforeSha = String(args['before-sha'] || '').trim();
    if (!/^[0-9a-f]{40}$/i.test(beforeSha) || /^0+$/.test(beforeSha)) {
      throw new Error('--before-sha must be a non-zero 40-character Git commit SHA for push events');
    }
    const previousPackage = execFileSync('git', ['show', `${beforeSha}:${packagePath}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    previousVersion = packageVersionFromText(previousPackage, 'previous version');
  }

  const decision = decideRelease(eventName, previousVersion, currentVersion);
  appendGitHubOutputs(outputPath, decision);
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { compareVersions, decideRelease, parseStableVersion };
