const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

function link(file) {
  try { return fs.readlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function stopMacProfile(profile) {
  const lockFile = path.join(profile, 'SingletonLock');
  const lock = link(lockFile);
  if (!lock) return;
  const match = /^(.*)-([1-9]\d*)$/.exec(lock);
  if (!match || match[1] !== os.hostname()) throw Error('Cannot identify the local Desktop lock owner');
  const pid = Number(match[2]);
  const socket = link(path.join(profile, 'SingletonSocket'));
  if (!socket) return;
  // A stale lock can contain a reused PID. Only kill the current socket owner.
  const files = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-U', '-Fn'], { encoding: 'utf8' });
  if (files.error) throw files.error;
  const names = files.stdout.split('\n').filter(line => line.startsWith('n'));
  const canonical = name => name.replace(/^\/private\/(tmp|var)\//, '/$1/');
  if (!names.some(line => canonical(line.slice(1)) === canonical(socket)) || link(lockFile) !== lock) return;
  process.kill(pid, 'SIGKILL');
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  throw Error('Desktop did not exit within ten seconds');
}

async function stopDesktop(appData) {
  const profiles = ['AIChat Desktop', 'aichat-desktop'].map(name => path.join(appData, name));
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'stop-desktop.ps1'), ...profiles], { stdio: 'inherit', windowsHide: true });
  } else if (process.platform === 'darwin') {
    for (const profile of profiles) await stopMacProfile(profile);
  }
}
module.exports = { stopDesktop };
