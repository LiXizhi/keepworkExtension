const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('manifest declares managed boot recovery and non-exported special-use services', () => {
  const manifest = read('app/src/main/AndroidManifest.xml');
  for (const action of ['LOCKED_BOOT_COMPLETED', 'BOOT_COMPLETED', 'MY_PACKAGE_REPLACED', 'USER_UNLOCKED']) {
    assert.match(manifest, new RegExp(`android.intent.action.${action}`));
  }
  assert.match(manifest, /android:name="\.service\.SupervisorService"[\s\S]*?android:exported="false"[\s\S]*?android:foregroundServiceType="specialUse"/);
  assert.match(manifest, /android:name="\.model\.LocalModelService"[\s\S]*?android:process=":localmodel"/);
  assert.doesNotMatch(manifest, /RECORD_AUDIO/);
});

test('ordinary UI exposes no stop action and policy blocks app controls', () => {
  const activity = read('app/src/main/java/com/keepwork/localhelper/MainActivity.kt');
  const policy = read('app/src/main/java/com/keepwork/localhelper/policy/DevicePolicyController.kt');
  const notification = read('app/src/main/java/com/keepwork/localhelper/service/NotificationFactory.kt');
  assert.doesNotMatch(activity, /停止服务/);
  assert.doesNotMatch(notification, /ACTION_STOP|stopService/);
  assert.match(policy, /setUninstallBlocked/);
  assert.match(policy, /DISALLOW_APPS_CONTROL/);
  assert.match(policy, /setUserControlDisabledPackages/);
});

test('servers are fixed to loopback and release remains ARM64-only', () => {
  const server = read('app/src/main/java/com/keepwork/localhelper/net/LoopbackHttpServer.kt');
  const gradle = read('app/build.gradle.kts');
  assert.match(server, /InetAddress\.getByName\("127\.0\.0\.1"\)/);
  assert.match(gradle, /release\s*\{[\s\S]*?abiFilters \+= "arm64-v8a"/);
  assert.match(gradle, /debug\s*\{[\s\S]*?"x86_64"/);
});

test('device-owner updater validates immutable APK metadata before PackageInstaller commit', () => {
  const updater = read('app/src/main/java/com/keepwork/localhelper/update/UpdateWorker.kt');
  const scheduler = read('app/src/main/java/com/keepwork/localhelper/update/UpdateScheduler.kt');
  const activity = read('app/src/main/java/com/keepwork/localhelper/MainActivity.kt');
  assert.match(updater, /cdn\.keepwork\.com/);
  assert.match(updater, /APK SHA-256 mismatch/);
  assert.match(updater, /signing certificate mismatch/);
  assert.match(updater, /packageInstaller/);
  assert.match(updater, /versionCode/);
  assert.match(scheduler, /OneTimeWorkRequestBuilder<UpdateWorker>/);
  assert.match(activity, /立即检查更新/);
});
