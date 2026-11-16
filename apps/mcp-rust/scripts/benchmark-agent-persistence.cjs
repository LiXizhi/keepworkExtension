#!/usr/bin/env node
// Explicit, isolated disk benchmark. Never starts a daemon or uses an account.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--out') throw new Error('Use --out <new evidence directory>');
  const output = path.resolve(args[1]);
  fs.mkdirSync(output, { recursive: true });
  for (const name of ['persistence.json', 'persistence.log']) {
    if (fs.existsSync(path.join(output, name))) throw new Error('Benchmark evidence already exists; use a new directory');
  }
  const command = ['test', '--offline', '--manifest-path', path.resolve(__dirname, '../Cargo.toml'), '--lib',
    'agents::persistence_tests::persistence_disk_benchmark', '--', '--ignored', '--exact', '--nocapture'];
  const result = spawnSync('cargo', command, { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 300_000,
    env: { ...process.env, KEEPWORK_MCP_PERSIST_BENCH_OUTPUT: path.join(output, 'persistence.json') } });
  fs.writeFileSync(path.join(output, 'persistence.log'), `cargo ${command.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`);
  if (result.error || result.status !== 0) throw result.error || new Error(`Benchmark failed (${result.status}); see persistence.log`);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'persistence.json'), 'utf8'));
  for (const size of [1, 16, 64]) {
    const old = report.cases.find(row => row.sessions === size && row.mode === 'legacy-all-histories');
    const current = report.cases.find(row => row.sessions === size && row.mode === 'changed-history');
    if (!old || !current || old.registryWrites !== current.registryWrites || old.registryBytes !== current.registryBytes
      || old.historyWrites !== size * old.chunks || current.historyWrites !== current.chunks) {
      throw new Error('Persistence write-scope or durability regression');
    }
  }
  process.stdout.write(JSON.stringify({ evidence: output, report }, null, 2) + '\n');
}
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { main };
