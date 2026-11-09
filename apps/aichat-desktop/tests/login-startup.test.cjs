const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loginStartup } = require('../src/loginStartup.cjs');

for (const [platform, launcher, options] of [
  ['win32', '', { args: ['--background'] }],
  ['win32', 'C:/Keepwork.exe', { args: ['--background'], path: 'C:/Keepwork.exe' }],
  ['darwin', '', {}],
]) {
  test(`native login registration for ${platform} ${launcher}`, () => {
    let registered = false, allowed = true;
    const startup = loginStartup({
      setLoginItemSettings({ openAtLogin, ...received }) {
        assert.deepEqual(received, options);
        registered = openAtLogin;
      },
      getLoginItemSettings(received) {
        assert.deepEqual(received, options);
        return { openAtLogin: registered, executableWillLaunchAtLogin: allowed };
      },
    }, platform, launcher);
    startup.set(true);
    assert.equal(startup.enabled(), true);
    if (platform === 'win32') {
      allowed = false;
      assert.equal(startup.enabled(), false);
    }
    startup.set(false);
    assert.equal(startup.enabled(), false);
  });
}

test('macOS launcher logs in through the stable executable with a background argument', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-login-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const startup = loginStartup({ getPath: () => home }, 'darwin', '/Apps & Tools/Keepwork.app/Contents/MacOS/Keepwork');
  startup.set(true);
  assert.equal(startup.enabled(), true);
  const agent = fs.readFileSync(path.join(home, 'Library/LaunchAgents/com.keepwork.aichat-desktop.login.plist'), 'utf8');
  assert.ok(agent.includes('<string>/Apps &amp; Tools/Keepwork.app/Contents/MacOS/Keepwork</string><string>--background</string>'));
  startup.set(false);
  assert.equal(startup.enabled(), false);
});
