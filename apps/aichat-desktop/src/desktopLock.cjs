const path = require('node:path');

// Electron keys its native singleton by userData. Keep the installed lock
// identity across launchers, then restore the profile used for application data.
function acquireDesktopLock(app, isolatedTest) {
  const profile = app.getPath('userData');
  try {
    if (!isolatedTest) app.setPath('userData', path.join(app.getPath('appData'), 'AIChat Desktop'));
    return app.requestSingleInstanceLock();
  } finally {
    app.setPath('userData', profile);
  }
}

module.exports = { acquireDesktopLock };
