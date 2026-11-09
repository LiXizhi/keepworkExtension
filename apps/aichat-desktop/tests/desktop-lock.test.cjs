const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { stopDesktop } = require('../scripts/stop-desktop.cjs');

test('installed and development profiles share foreground handoff and task replacement', {
  skip: !['win32', 'darwin'].includes(process.platform), timeout: 45000,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-singleton-'));
  const entry = path.join(dir, 'fixture.cjs');
  const children = [];
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await fs.writeFile(entry, `
    const { app, BrowserWindow } = require('electron');
    const fs = require('node:fs');
    const path = require('node:path');
    app.setPath('appData', __dirname);
    const profile = path.join(__dirname, process.env.PROFILE);
    app.setPath('userData', profile);
    if (!require(${JSON.stringify(require.resolve('../src/desktopLock.cjs'))}).acquireDesktopLock(app)) app.exit(0);
    else {
      let win;
      app.on('second-instance', () => {
        win.show(); win.focus();
        fs.writeFileSync(path.join(__dirname, 'shown'), String(win.isVisible()));
      });
      app.whenReady().then(() => {
        win = new BrowserWindow({show:false});
        fs.writeFileSync(path.join(__dirname, String(process.pid)), app.getPath('userData'));
      });
    }
  `);
  function launch(profile) {
    const env = { ...process.env, PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [entry], { env, stdio: 'ignore' });
    const result = { child, exited: once(child, 'exit') };
    children.push(result);
    return result;
  }
  async function read(name) {
    for (let i = 0; i < 150; i++) {
      try { return await fs.readFile(path.join(dir, String(name)), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(50);
    }
    assert.fail('Timed out waiting for ' + name);
  }
  const installed = launch('AIChat Desktop');
  assert.equal(await read(installed.child.pid), path.join(dir, 'AIChat Desktop'));
  assert.equal((await launch('aichat-desktop').exited)[0], 0);
  assert.equal(await read('shown'), 'true');
  await stopDesktop(dir);
  await installed.exited;
  const replacement = launch('aichat-desktop');
  assert.equal(await read(replacement.child.pid), path.join(dir, 'aichat-desktop'));
  assert.equal((await launch('AIChat Desktop').exited)[0], 0);
});
