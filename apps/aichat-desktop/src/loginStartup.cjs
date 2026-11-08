const fs = require('node:fs');
const path = require('node:path');

// The launcher distribution runs a versioned Electron.app. Register the stable
// launcher instead so login still works after the runtime has been replaced.
function loginStartup(app, platform, launcher) {
  if (platform === 'darwin' && launcher) {
    const label = 'com.keepwork.aichat-desktop.login';
    const directory = path.join(app.getPath('home'), 'Library', 'LaunchAgents');
    const file = path.join(directory, label + '.plist');
    const executable = launcher.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return {
      enabled: () => fs.existsSync(file),
      set(enabled) {
        if (!enabled) { fs.rmSync(file, { force: true }); return; }
        fs.mkdirSync(directory, { recursive: true });
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${executable}</string><string>--background</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`;
        const temp = file + '.' + process.pid + '.tmp';
        try {
          fs.writeFileSync(temp, xml, { mode: 0o600 });
          fs.renameSync(temp, file);
        } finally { fs.rmSync(temp, { force: true }); }
      },
    };
  }
  const options = platform === 'win32' ? { args: ['--background'], ...(launcher && { path: launcher }) } : {};
  return {
    enabled() {
      const state = app.getLoginItemSettings(options);
      return state.openAtLogin && (platform !== 'win32' || state.executableWillLaunchAtLogin);
    },
    set(openAtLogin) { app.setLoginItemSettings({ ...options, openAtLogin }); },
  };
}

module.exports = { loginStartup };
