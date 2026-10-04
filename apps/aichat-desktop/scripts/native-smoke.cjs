const { spawn } = require('node:child_process');
const path = require('node:path');
if (process.argv.includes('--child')) {
  const pty = require('node-pty');
  const child = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', [], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  let output = '';
  child.onData(data => { output += data; });
  child.onExit(() => {
    if (!output.includes('AICHAT_PTY_OK')) process.exit(1);
    console.log('Electron native PTY passed'); process.exit(0);
  });
  child.resize(100, 30);
  child.write('echo AICHAT_PTY_OK\r');
  setTimeout(() => child.write('exit\r'), 300);
  setTimeout(() => { child.kill(); process.exit(1); }, 10000).unref();
} else {
  const child = spawn(require('electron'), [path.resolve(__filename), '--child'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit',
  });
  child.on('error', e => { console.error(e.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
}
