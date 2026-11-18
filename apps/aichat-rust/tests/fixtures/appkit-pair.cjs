const fs = require('node:fs/promises');
const path = require('node:path');

// Separate bundle IDs give the fixture two independent foreground identities.
module.exports = async function appKitPair(dir, id) {
  const executables = [];
  for (const name of ['Host', 'Editor']) {
    const contents = path.join(dir, name + '.app', 'Contents');
    const binaryDir = path.join(contents, 'MacOS');
    await fs.mkdir(binaryDir, { recursive: true });
    await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>com.keepwork.fixture.${id}.${name.toLowerCase()}</string>
    <key>CFBundleName</key><string>AppKit Fixture ${name}</string>
    <key>CFBundleExecutable</key><string>runner</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    </dict></plist>`);
    executables.push(path.join(binaryDir, 'runner'));
  }
  return executables;
};
