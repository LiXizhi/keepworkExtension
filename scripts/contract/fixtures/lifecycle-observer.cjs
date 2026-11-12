// Loaded only in isolated lifecycle-regression subprocesses. Do not let fault
// injection or global module patches affect the rest of the contract suite.
const fs = require('node:fs');
const path = require('node:path');
const processes = require('node:child_process');
const journal = process.env.KEEPWORK_LIFECYCLE_JOURNAL;
const record = value => fs.appendFileSync(journal, JSON.stringify(value) + '\n');

const mkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, ...args) {
  const directory = mkdtempSync.call(this, prefix, ...args);
  if (/^kp-(?:contract-|cursor-auth-)/.test(path.basename(directory))) {
    record({ kind: 'directory', directory });
  }
  return directory;
};

const spawn = processes.spawn;
processes.spawn = function (command, ...args) {
  const child = spawn.call(this, command, ...args);
  child.once('spawn', () => record({ kind: 'process', command: String(command), pid: child.pid }));
  return child;
};

function locked(directory) {
  return process.env.KEEPWORK_LIFECYCLE_LOCK_WORKSPACE === '1'
    && path.basename(String(directory)).startsWith('kp-cursor-auth-');
}
function busy() {
  return Object.assign(new Error('EBUSY: injected workspace cleanup failure'), { code: 'EBUSY' });
}
const rmSync = fs.rmSync;
fs.rmSync = function (directory, ...args) {
  if (locked(directory)) throw busy();
  return rmSync.call(this, directory, ...args);
};
const rm = fs.promises.rm;
fs.promises.rm = async function (directory, ...args) {
  if (locked(directory)) throw busy();
  return rm.call(this, directory, ...args);
};
