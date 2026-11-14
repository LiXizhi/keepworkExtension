#!/usr/bin/env python3
"""Run only the isolated account-free AI Pet AVD; never select an attached physical device."""
import os, pathlib, socket, subprocess, time, re, json, xml.etree.ElementTree as ET
ROOT = pathlib.Path(__file__).resolve().parents[1]
SDK = ROOT / '.toolchains/android-sdk'
JDK = pathlib.Path(os.environ.get('JAVA_HOME', ROOT / '.toolchains/jdk-17.0.21+9/Contents/Home'))
EVIDENCE = ROOT / 'build/native-evidence'
AVD_HOME = ROOT / '.toolchains/avd'
USER_HOME = ROOT / '.toolchains/android-user'
APK = ROOT / 'app/build/outputs/apk/debug/app-debug.apk'
for required in [JDK/'bin/java', SDK/'emulator/emulator', SDK/'platform-tools/adb', APK,
                 SDK/'system-images/android-35/default/arm64-v8a/system.img']:
    if not required.exists(): raise SystemExit(f'Missing prerequisite: {required}')
for port in (5039, 5584, 5585):
    with socket.socket() as probe:
        try: probe.bind(('127.0.0.1', port))
        except OSError: raise SystemExit(f'Isolated test port {port} already in use; will not disturb its owner.')
for directory in (EVIDENCE, AVD_HOME, USER_HOME): directory.mkdir(parents=True, exist_ok=True)
(EVIDENCE/'runtime-checks.json').unlink(missing_ok=True)
env = dict(os.environ, JAVA_HOME=str(JDK), ANDROID_HOME=str(SDK), ANDROID_SDK_ROOT=str(SDK),
           ANDROID_USER_HOME=str(USER_HOME), ANDROID_EMULATOR_HOME=str(USER_HOME), ANDROID_AVD_HOME=str(AVD_HOME),
           ANDROID_ADB_SERVER_PORT='5039', ANDROID_ADB_LOG_PATH=str(EVIDENCE/'adb.log'))
# ADB itself still uses the system user's ~/.android; HOME is intentionally untouched.
def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], env=env, check=True, timeout=120, **kwargs)
adb = [SDK/'platform-tools/adb', '-P', '5039']
serial = 'emulator-5584'
name = 'AiPetOfflineApi35'
avd = AVD_HOME / f'{name}.avd'
if not avd.exists():
    run([SDK/'cmdline-tools/19.0/bin/avdmanager', 'create', 'avd', '--name', name,
         '--package', 'system-images;android-35;default;arm64-v8a', '--path', avd], input=b'no\n')
    with (avd/'config.ini').open('a') as config:
        config.write('\nhw.lcd.width=720\nhw.lcd.height=1280\nhw.lcd.density=240\nhw.ramSize=2048\nhw.keyboard=yes\n')
process = None
log = (EVIDENCE/'emulator.log').open('wb')
try:
    run(adb + ['start-server'])
    process = subprocess.Popen([str(SDK/'emulator/emulator'), '-avd', name, '-port', '5584',
        '-no-window', '-no-audio', '-no-snapshot', '-wipe-data', '-no-boot-anim', '-gpu', 'auto',
        '-camera-back', 'none', '-camera-front', 'none', '-memory', '3072', '-cores', '4'], env=env, stdout=log, stderr=subprocess.STDOUT)
    for attempt in range(120):
        if process.poll() is not None: raise RuntimeError('Emulator exited; inspect build/native-evidence/emulator.log')
        result = subprocess.run([str(x) for x in adb + ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']],
            env=env, capture_output=True, timeout=10)
        if result.stdout.strip() == b'1': break
        time.sleep(2)
    else: raise RuntimeError('Emulator did not boot within 240 seconds')
    time.sleep(5) # Let the freshly wiped AOSP System UI finish its initial layout.
    target = adb + ['-s', serial]
    assert run(target+['shell','getprop','ro.kernel.qemu'], capture_output=True).stdout.strip() == b'1'
    assert run(target+['shell','getprop','ro.build.version.sdk'], capture_output=True).stdout.strip() == b'35'
    run(target + ['shell','settings','put','global','airplane_mode_on','1'])
    run(target + ['shell','input','keyevent','82'])
    run(target + ['install','-r',APK])
    run(target + ['shell','pm','grant','com.keepwork.aipet.dev','android.permission.POST_NOTIFICATIONS'])
    run(target+['shell','appops','set','com.keepwork.aipet.dev','SYSTEM_ALERT_WINDOW','deny'])
    run(target + ['logcat','-c'])
    result = run(target+['shell','am','start','-W','-f','0x14000000','-n','com.keepwork.aipet.dev/.MainActivity'], capture_output=True)
    (EVIDENCE/'launch.txt').write_bytes(result.stdout + result.stderr)
    time.sleep(3)
    with (EVIDENCE/'offline-shell.png').open('wb') as out: run(target+['exec-out','screencap','-p'], stdout=out)
    def hierarchy():
        run(target+['shell','uiautomator','dump','/sdcard/ai-pet-ui.xml'], capture_output=True)
        xml = run(target+['exec-out','cat','/sdcard/ai-pet-ui.xml'], capture_output=True).stdout
        (EVIDENCE/'latest-ui.xml').write_bytes(xml)
        return ET.fromstring(xml)
    def locate(label):
        for node in hierarchy().iter('node'):
            if label.casefold() in (node.get('text','') + node.get('content-desc','')).casefold():
                values = [int(v) for v in re.findall(r'\d+',node.attrib['bounds'])]
                if len(values) == 4 and values[2] > values[0] and values[3] > values[1]: return values
        raise RuntimeError(f'Visible UI control missing: {label}')
    def tap(label):
        x1,y1,x2,y2 = locate(label)
        run(target+['shell','input','tap',str((x1+x2)//2),str((y1+y2)//2)])
        time.sleep(1.5)
    def overlay_present():
        state = run(target+['shell','dumpsys','window','windows'],capture_output=True).stdout
        (EVIDENCE/'windows.txt').write_bytes(state)
        return b'AI Pet development overlay' in state
    def overlay_bounds():
        overlay_present()
        state = (EVIDENCE/'windows.txt').read_text()
        blocks = re.split(r'\n  Window #', state)
        for block in blocks:
            if 'AI Pet development overlay' in block.split('\n',1)[0]:
                frame = re.search(r'\bframe=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', block)
                if frame: return [int(value) for value in frame.groups()]
        raise RuntimeError('Overlay frame unavailable in dumpsys; inspect windows.txt')
    permissions = run([SDK/'build-tools/35.0.0/aapt','dump','permissions',APK], capture_output=True).stdout
    (EVIDENCE/'permissions.txt').write_bytes(permissions)
    assert set(re.findall(rb"uses-permission: name='([^']+)'", permissions)) == {b'android.permission.SYSTEM_ALERT_WINDOW', b'android.permission.FOREGROUND_SERVICE', b'android.permission.FOREGROUND_SERVICE_SPECIAL_USE', b'android.permission.POST_NOTIFICATIONS'}
    checks = ['APK installed' , 'API 35 Activity launch', 'no real microphone or network permissions requested']
    # Only this disposable emulator's development package permission state is changed.
    tap('Show development overlay')
    assert not overlay_present(), 'Denied overlay attached'
    locate('In-app controls remain available')
    checks.append('denied permission keeps native in-app fallback')
    tap('Overlay permission settings')
    with (EVIDENCE/'overlay-permission-settings.png').open('wb') as out: run(target+['exec-out','screencap','-p'],stdout=out)
    resumed = run(target+['shell','dumpsys','activity','activities'],capture_output=True).stdout
    assert b'com.android.settings' in resumed, 'Permission settings did not open'
    checks.append('native overlay permission Settings intent opens')
    # Grant via emulator appops for deterministic test setup; this is not a real-user permission flow claim.
    run(target+['shell','appops','set','com.keepwork.aipet.dev','SYSTEM_ALERT_WINDOW','allow'])
    run(target+['shell','am','start','-W','-f','0x14000000','-n','com.keepwork.aipet.dev/.MainActivity'],capture_output=True)
    time.sleep(1)
    assert not overlay_present(), 'Returning from Settings automatically displayed overlay'
    tap('Show development overlay'); assert overlay_present(), 'Overlay not attached'
    run(target+['shell','input','keyevent','3']); time.sleep(1)
    assert overlay_present(), 'Overlay did not survive Home'
    before = overlay_bounds()
    with (EVIDENCE/'overlay-visible.png').open('wb') as out: run(target+['exec-out','screencap','-p'],stdout=out)
    x=(before[0]+before[2])//2; y=(before[1]+before[3])//2
    run(target+['shell','input','swipe',str(x),str(y),str(x+160),str(y+120),'500'])
    after = overlay_bounds(); assert after != before, 'Native drag did not move overlay'
    checks.append('explicit show and native drag move the real overlay window')
    run(target+['shell','input','tap',str((after[0]+after[2])//2),str((after[1]+after[3])//2)])
    time.sleep(1.5); assert not overlay_present(), 'Tap failed to remove overlay'
    def open_app():
        run(target+['shell','am','start','-W','-f','0x14000000','-n','com.keepwork.aipet.dev/.MainActivity'],capture_output=True)
        time.sleep(1.5)
    def service_absent():
        state = run(target+['shell','dumpsys','activity','services','com.keepwork.aipet.dev'],capture_output=True).stdout
        (EVIDENCE/'services.txt').write_bytes(state)
        return b'ServiceRecord{' not in state
    open_app()
    tap('Show development overlay'); assert overlay_present()
    run(target+['shell','input','keyevent','3']); time.sleep(1)
    assert overlay_present(), 'Service lost overlay on Home'
    run(target+['shell','cmd','statusbar','expand-notifications']); time.sleep(1)
    with (EVIDENCE/'overlay-notification.png').open('wb') as out: run(target+['exec-out','screencap','-p'],stdout=out)
    tap('Stop overlay')
    run(target+['shell','cmd','statusbar','collapse']); time.sleep(1)
    assert not overlay_present() and service_absent(), 'Notification Stop failed to release window/service'
    open_app(); assert not overlay_present(), 'Activity resume resurrected stopped overlay'
    tap('Show development overlay'); tap('Remove development overlay'); time.sleep(1)
    assert not overlay_present() and service_absent(), 'In-app Stop failed to release service'
    tap('Show development overlay'); run(target+['shell','input','keyevent','3'])
    run(target+['shell','appops','set','com.keepwork.aipet.dev','SYSTEM_ALERT_WINDOW','deny']); time.sleep(2)
    assert not overlay_present() and service_absent(), 'Revocation failed to release window/service'
    run(target+['shell','appops','set','com.keepwork.aipet.dev','SYSTEM_ALERT_WINDOW','allow'])
    open_app(); assert not overlay_present(), 'Permission restoration resurrected overlay'
    tap('Show development overlay')
    run(target+['shell','am','force-stop','com.keepwork.aipet.dev']); time.sleep(1)
    open_app(); assert not overlay_present() and service_absent(), 'Process relaunch resurrected overlay'
    checks.append('Home persistence and cross-app drag; overlay/in-app/notification Stop remove service')
    checks.append('permission revoke/restoration and forced process relaunch do not resurrect overlay')
    (EVIDENCE/'runtime-checks.json').write_text(json.dumps({'device':'isolated API 35 AOSP ARM64 emulator','checks':checks},indent=2)+'\n')
    result = run(target+['logcat','-d','-b','crash'],capture_output=True)
    (EVIDENCE/'crash.txt').write_bytes(result.stdout)
    if b'FATAL EXCEPTION' in result.stdout: raise RuntimeError('Native crash detected')
    if b'Status: ok' not in (EVIDENCE/'launch.txt').read_bytes(): raise RuntimeError('Activity launch was not successful')
    print(f'PASS isolated API 35 launch; screenshot and crash evidence: {EVIDENCE}', flush=True)
finally:
    if process is not None and process.poll() is None:
        try:
            result = subprocess.run([str(x) for x in adb+['-s',serial,'logcat','-d','-b','crash']], env=env, capture_output=True, timeout=10)
            (EVIDENCE/'crash.txt').write_bytes(result.stdout)
        except subprocess.TimeoutExpired: pass
    if process is not None and process.poll() is None:
        process.terminate()
        try: process.wait(timeout=20)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
    subprocess.run([str(x) for x in adb+['kill-server']], env=env, timeout=15, check=False)
    log.close()
