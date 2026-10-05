const { execFile } = require('node:child_process');
const path = require('node:path');
function run(file, args, timeout = 15000) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, windowsHide: true, maxBuffer: 256000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}
async function checkGit({ platform = process.platform, env = process.env, execute = run } = {}) {
  const candidates = platform === 'win32'
    ? [path.join(env.ProgramFiles || 'C:/Program Files', 'Git', 'cmd', 'git.exe'), path.join(env.LOCALAPPDATA || 'C:/', 'Programs', 'Git', 'cmd', 'git.exe'), 'git']
    : ['/opt/homebrew/bin/git', '/usr/local/bin/git', 'git'];
  for (const executable of candidates) {
    try {
      // macOS /usr/bin/git may launch an installation prompt; checking must be read-only.
      if (platform === 'darwin' && executable === 'git') await execute('/usr/bin/xcode-select', ['-p']);
      const version = await execute(executable, ['--version']);
      if (/^git version \d/.test(version)) return { ready: true, version, executable };
    } catch { /* Try the next supported location. */ }
  }
  return { ready: false, platform };
}
let installing;
async function installGit({ platform = process.platform, execute = run } = {}) {
  if (installing) return installing;
  installing = (async () => {
    if (platform === 'win32') await execute('winget', ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements'], 600000);
    else if (platform === 'darwin') await execute('/usr/bin/xcode-select', ['--install']);
    else throw new Error('请通过系统包管理器安装 Git');
    return { pending: true };
  })().finally(() => { installing = null; });
  return installing;
}
module.exports = { checkGit, installGit };
