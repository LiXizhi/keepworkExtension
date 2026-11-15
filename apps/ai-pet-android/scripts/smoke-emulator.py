#!/usr/bin/env python3
"""Run only the isolated account-free AI Pet AVD; never select an attached physical device."""
import os, pathlib, socket, subprocess, time, re, json, argparse, hashlib, uuid, xml.etree.ElementTree as ET
from emulator_runtime import wait_for_stage, safe_vertical_bounds
from emulator_ui import fresh_hierarchy, toggle_round_trip, assert_app_surface, assert_resumed
parser = argparse.ArgumentParser()
parser.add_argument("--reuse", action="store_true", help="Reuse only the owned initialized AVD without factory wipe")
parser.add_argument("--overlay-layout-only", action="store_true", help="Target overlay lifecycle and final-control layout; skip locale/pose suite")
parser.add_argument("--attach", action="store_true", help="Use only the already running owned AVD; leave its lifecycle to diagnostics")
args = parser.parse_args()
ROOT = pathlib.Path(__file__).resolve().parents[1]
SDK = ROOT / '.toolchains/android-sdk'
JDK = pathlib.Path(os.environ.get('JAVA_HOME', ROOT / '.toolchains/jdk-17.0.21+9/Contents/Home'))
EVIDENCE = ROOT / 'build/native-evidence/runs' / (time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
AVD_HOME = ROOT / '.toolchains/avd'
USER_HOME = ROOT / '.toolchains/android-user'
APK = ROOT / 'app/build/outputs/apk/debug/app-debug.apk'
for required in [JDK/'bin/java', SDK/'emulator/emulator', SDK/'platform-tools/adb', APK,
                 SDK/'system-images/android-35/default/arm64-v8a/system.img']:
    if not required.exists(): raise SystemExit(f'Missing prerequisite: {required}')
for port in (() if args.attach else (5039, 5584, 5585)):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try: probe.bind(('127.0.0.1', port))
        except OSError: raise SystemExit(f'Isolated test port {port} already in use; will not disturb its owner.')
for directory in (EVIDENCE, AVD_HOME, USER_HOME): directory.mkdir(parents=True, exist_ok=True)
apk_hash = hashlib.sha256(APK.read_bytes()).hexdigest()
(EVIDENCE/'artifact.json').write_text(json.dumps({'apkSha256':apk_hash,'scope':'overlay-layout-only' if args.overlay_layout_only else 'full'},indent=2))
print(f'EVIDENCE {EVIDENCE}',flush=True)
env = dict(os.environ, JAVA_HOME=str(JDK), ANDROID_HOME=str(SDK), ANDROID_SDK_ROOT=str(SDK),
           ANDROID_USER_HOME=str(USER_HOME), ANDROID_EMULATOR_HOME=str(USER_HOME), ANDROID_AVD_HOME=str(AVD_HOME),
           ANDROID_ADB_SERVER_PORT='5039', ANDROID_ADB_LOG_PATH=str(EVIDENCE/'adb.log'))
# ADB itself still uses the system user's ~/.android; HOME is intentionally untouched.
def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], env=env, check=True, timeout=kwargs.pop("timeout", 30), **kwargs)
adb = [SDK/'platform-tools/adb', '-P', '5039']
serial = 'emulator-5584'
name = 'AiPetOfflineApi35'
avd = AVD_HOME / f'{name}.avd'
if args.attach and not avd.exists(): raise SystemExit("Owned AVD missing")
if not avd.exists():
    run([SDK/'cmdline-tools/19.0/bin/avdmanager', 'create', 'avd', '--name', name,
         '--package', 'system-images;android-35;default;arm64-v8a', '--path', avd], input=b'no\n')
    with (avd/'config.ini').open('a') as config:
        config.write('\nhw.lcd.width=720\nhw.lcd.height=1280\nhw.lcd.density=240\nhw.ramSize=2048\nhw.keyboard=yes\n')
process = None
original_settings = {}
restoration_errors = []
report = None
readiness = []
log = (EVIDENCE/'emulator.log').open('wb')
try:
    if args.attach:
        with socket.socket() as server:
            server.settimeout(1)
            if server.connect_ex(('127.0.0.1',5039)) != 0: raise RuntimeError('Owned adb absent; refusing implicit startup')
    else:
        run(adb + ['start-server'])
        process = subprocess.Popen([str(SDK/'emulator/emulator'), '-avd', name, '-port', '5584',
            '-no-window', '-no-audio', '-no-snapshot', *([] if args.reuse else ['-wipe-data']), '-no-boot-anim', '-gpu', 'auto',
            '-camera-back', 'none', '-camera-front', 'none', '-memory', '3072', '-cores', '4'], env=env, stdout=log, stderr=subprocess.STDOUT)
    target = adb + ['-s', serial]
    def probe(command, expected):
        def check(timeout):
            if process is not None and process.poll() is not None: raise RuntimeError('Owned emulator exited')
            result = subprocess.run([str(x) for x in target+command],env=env,capture_output=True,timeout=timeout)
            return result.returncode == 0 and expected in result.stdout
        return check
    wait_for_stage('boot',probe(['shell','getprop','sys.boot_completed'],b'1'),30 if args.attach else (180 if args.reuse else 600),readiness)
    assert run(target+['emu','avd','name'],capture_output=True).stdout.splitlines()[0] == name.encode(), 'Unexpected AVD ownership'
    wait_for_stage('package-service',probe(['shell','pm','path','android'],b'package:'),20,readiness)
    wait_for_stage('window-service',probe(['shell','dumpsys','window','windows'],b'Window #'),20,readiness)
    (EVIDENCE/'readiness.json').write_text(json.dumps(readiness,indent=2))
    for namespace, key in [('system','font_scale'),('global','airplane_mode_on')]:
        original_settings[(namespace,key)] = run(target+['shell','settings','get',namespace,key],capture_output=True).stdout.decode().strip()
    assert run(target+['shell','getprop','ro.kernel.qemu'], capture_output=True).stdout.strip() == b'1'
    assert run(target+['shell','getprop','ro.build.version.sdk'], capture_output=True).stdout.strip() == b'35'
    run(target + ['shell','settings','put','global','airplane_mode_on','1'])
    run(target + ['shell','input','keyevent','82'])
    package_path = subprocess.run([str(x) for x in target+['shell','pm','path','com.keepwork.aipet.dev']],env=env,capture_output=True,timeout=10).stdout.decode().strip().removeprefix('package:')
    existing_hash = run(target+['shell','sha256sum',package_path],capture_output=True).stdout.decode().split()[0] if package_path else None
    if existing_hash != apk_hash: run(target + ['install','-r',APK],timeout=60)
    else: print('Existing installed APK hash matches; skip reinstall',flush=True)
    installed = run(target+['shell','pm','path','com.keepwork.aipet.dev'],capture_output=True).stdout.decode().strip().removeprefix('package:')
    installed_hash = run(target+['shell','sha256sum',installed],capture_output=True).stdout.decode().split()[0]
    assert installed_hash == apk_hash, 'Installed APK differs from final local artifact'
    run(target + ['shell','pm','grant','com.keepwork.aipet.dev','android.permission.POST_NOTIFICATIONS'])
    run(target+['shell','appops','set','com.keepwork.aipet.dev','SYSTEM_ALERT_WINDOW','deny'])
    run(target + ['logcat','-c'])
    result = run(target+['shell','am','start','-W','-f','0x14000000','-n','com.keepwork.aipet.dev/.MainActivity'], capture_output=True)
    (EVIDENCE/'launch.txt').write_bytes(result.stdout + result.stderr)
    if b'Status: ok' not in result.stdout: raise RuntimeError('Activity launch failed or timed out; inspect launch.txt')
    time.sleep(3)
    with (EVIDENCE/'offline-shell.png').open('wb') as out: run(target+['exec-out','screencap','-p'], stdout=out)
    def hierarchy():
        return fresh_hierarchy(lambda command: run(target+command,capture_output=True).stdout,EVIDENCE)
    size = run(target+['shell','wm','size'],capture_output=True).stdout.decode()
    assert re.findall(r'(\d+)x(\d+)',size)[-1] == ('720','1280'), 'Harness requires owned portrait 720x1280 profile'
    window_state = run(target+['shell','dumpsys','window','windows'],capture_output=True).stdout.decode()
    safe_top, safe_bottom = safe_vertical_bounds(window_state,720,1280)
    (EVIDENCE/'navigation-profile.json').write_text(json.dumps({'width':720,'height':1280,'safeTop':safe_top,'safeBottom':safe_bottom}))
    def locate(label, exact=False):
        directions = ('down','up') if label == 'language_picker' or label.startswith('Simulated session:') else ('up','down')
        for direction in directions:
            previous = None
            for attempt in range(7):
                tree = hierarchy()
                signature = ET.tostring(tree)
                for node in tree.iter('node'):
                    content = (node.get('text','') + node.get('content-desc','')).casefold()
                    matches = content.strip() == label.casefold() if exact else label.casefold() in content
                    matches = matches or node.get('resource-id','').endswith('/'+label)
                    if matches:
                        values = [int(v) for v in re.findall(r'\d+',node.attrib['bounds'])]
                        # API 35 draws edge-to-edge; a reported node can be underneath system bars.
                        if len(values) == 4 and values[2] > values[0] and values[3] - values[1] >= 24 and values[1] >= safe_top and values[3] <= safe_bottom: return values
                if signature == previous: break
                previous = signature
                if label.startswith('Simulated session:'):
                    start, end, duration = (850,500,650) if direction == 'up' else (500,850,650)
                else:
                    start, end, duration = (1050,350,250) if direction == 'up' else (350,1050,250)
                run(target+['shell','input','swipe','600',str(start),'600',str(end),str(duration)])
        raise RuntimeError(f'UI control missing after scrolling: {label}')
    def tap(label):
        x1,y1,x2,y2 = locate(label)
        run(target+['shell','input','tap',str((x1+x2)//2),str((y1+y2)//2)])
        time.sleep(1.5)
    font_readbacks = []
    def set_font_scale(value):
        run(target+['shell','settings','put','system','font_scale',value])
        actual = run(target+['shell','settings','get','system','font_scale'],capture_output=True).stdout.decode().strip()
        font_readbacks.append({'requested':value,'actual':actual})
        (EVIDENCE/'font-scale-readbacks.json').write_text(json.dumps(font_readbacks,indent=2))
        assert actual == value, 'Requested font scale was not applied'
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
    # Normalize through stable resource ID even in the abbreviated/reused run.
    tap('language_picker'); tap('English (US)')
    checks = ['APK installed with matching SHA-256' , 'API 35 Activity launch', 'no real microphone or network permissions requested']
    if not args.overlay_layout_only:
        for language, tag in [('简体中文','zh-CN'),('Español','es-ES'),('한국어','ko-KR'),('日本語','ja-JP'),('Français','fr-FR'),('English (US)','en-US')]:
            tap('language_picker'); tap(language)
            prefs = run(target+['shell','run-as','com.keepwork.aipet.dev','cat','shared_prefs/development-presentation.xml'],capture_output=True).stdout.decode()
            assert tag in prefs, f'Locale not persisted: {tag}'
            assert not overlay_present(), 'Language change started overlay'
            with (EVIDENCE/f'locale-{tag}.png').open('wb') as out: run(target+['exec-out','screencap','-p'],stdout=out)
        tap('language_picker'); tap('Français')
        run(target+['shell','am','force-stop','com.keepwork.aipet.dev'])
        run(target+['shell','am','start','-W','-n','com.keepwork.aipet.dev/.MainActivity'],capture_output=True)
        time.sleep(2); locate('Français')
        tap('language_picker'); tap('English (US)')
        for pose in ('Idle','Listening','Thinking','Speaking','Happy','Sleeping','Error'):
            tap('pose_picker'); tap(pose)
            locate(pose)
        tap('reduce_motion'); tap('preview_visible'); tap('preview_visible')
        set_font_scale('2.0'); time.sleep(2)
        locate('language_picker')
        with (EVIDENCE/'large-font.png').open('wb') as out: run(target+['exec-out','screencap','-p'],stdout=out)
        set_font_scale('1.0'); time.sleep(2)
        checks.append('six native language selections persist; process relaunch preserves French; seven pose selections and preview switches reachable; 2x font language picker reachable')
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
        reopened = run(target+['shell','am','start','-W','-f','0x14000000','-n','com.keepwork.aipet.dev/.MainActivity'],capture_output=True)
        (EVIDENCE/('reopen-'+str(time.monotonic_ns())+'.txt')).write_bytes(reopened.stdout)
        assert b'Status: ok' in reopened.stdout, 'Activity reopen failed or timed out'
        time.sleep(1.5)
        state = run(target+['shell','dumpsys','activity','activities'],capture_output=True).stdout.decode()
        assert_resumed(state,'com.keepwork.aipet.dev')
        assert_app_surface(hierarchy(),'com.keepwork.aipet.dev')
        def click_bounds(bounds):
            run(target+['shell','input','tap',str((bounds[0]+bounds[2])//2),str((bounds[1]+bounds[3])//2)])
        interaction = toggle_round_trip('preview_visible',locate,click_bounds,hierarchy)
        (EVIDENCE/('reopen-interaction-'+str(time.monotonic_ns())+'.json')).write_text(json.dumps(interaction,indent=2))

    def service_absent():
        state = run(target+['shell','dumpsys','activity','services','com.keepwork.aipet.dev'],capture_output=True).stdout
        (EVIDENCE/'services.txt').write_bytes(state)
        return b'ServiceRecord{' not in state
    open_app()
    tap('Show development overlay'); assert overlay_present()
    def service_identity():
        state = run(target+['shell','dumpsys','activity','services','com.keepwork.aipet.dev'],capture_output=True).stdout
        return re.findall(rb'ServiceRecord\{[^}]+\}',state)
    identity = service_identity(); frame = overlay_bounds()
    assert identity
    tap('language_picker'); tap('Français')
    assert service_identity() == identity and overlay_bounds() == frame, 'Language replaced service or overlay'
    tap('language_picker'); tap('English (US)')
    assert service_identity() == identity and overlay_bounds() == frame
    checks.append('active overlay keeps service identity and window bounds during French/English changes')
    run(target+['shell','input','keyevent','3']); time.sleep(1)
    assert overlay_present(), 'Service lost overlay on Home'
    run(target+['shell','cmd','statusbar','expand-notifications']); time.sleep(1)
    with (EVIDENCE/'overlay-notification.png').open('wb') as out: run(target+['exec-out','screencap','-p'],stdout=out)
    tap('Stop overlay')
    run(target+['shell','cmd','statusbar','collapse']); time.sleep(1)
    assert not overlay_present() and service_absent(), 'Notification Stop failed to release window/service'
    open_app(); assert not overlay_present(), 'Activity resume resurrected stopped overlay'
    tap('Show development overlay'); assert overlay_present() and not service_absent()
    tap('Remove development overlay'); time.sleep(1)
    assert not overlay_present() and service_absent(), 'In-app Stop failed to release service'
    tap('Show development overlay'); assert overlay_present() and not service_absent()
    run(target+['shell','input','keyevent','3'])
    run(target+['shell','appops','set','com.keepwork.aipet.dev','SYSTEM_ALERT_WINDOW','deny']); time.sleep(2)
    assert not overlay_present() and service_absent(), 'Revocation failed to release window/service'
    run(target+['shell','appops','set','com.keepwork.aipet.dev','SYSTEM_ALERT_WINDOW','allow'])
    open_app(); assert not overlay_present(), 'Permission restoration resurrected overlay'
    tap('Show development overlay')
    run(target+['shell','am','force-stop','com.keepwork.aipet.dev']); time.sleep(1)
    open_app(); assert not overlay_present() and service_absent(), 'Process relaunch resurrected overlay'
    for scale in ('1.0', '2.0'):
        set_font_scale(scale); time.sleep(2)
        start_bounds = locate('Start simulated session')
        fake_started = time.monotonic() # Before Start input delivery; no helper sleep is excluded.
        run(target+['shell','input','tap',str((start_bounds[0]+start_bounds[2])//2),str((start_bounds[1]+start_bounds[3])//2)])
        locate('Simulated session: Active')
        bounds = locate('Stop', exact=True)
        assert bounds[1] >= safe_top and bounds[3] <= safe_bottom, f'Final Stop underneath system bars at {scale}: {bounds}'
        with (EVIDENCE/f'last-control-{scale}.png').open('wb') as out: run(target+['exec-out','screencap','-p'],stdout=out)
        run(target+['shell','input','tap',str((bounds[0]+bounds[2])//2),str((bounds[1]+bounds[3])//2)])
        locate('Simulated session: Ended')
        assert time.monotonic()-fake_started < 25, 'Stop observation too slow to distinguish click from 30-second fake lease expiry'
    set_font_scale('1.0')
    checks.append('final simulated Stop is above measured navigation bar and ends an active simulated session at normal and 2x font')
    checks.append('Home persistence and cross-app drag; overlay/in-app/notification Stop remove service')
    checks.append('permission revoke/restoration and forced process relaunch do not resurrect overlay')
    report = {'device':'isolated API 35 AOSP ARM64 emulator','apkSha256':apk_hash,'scope':'overlay-layout-only' if args.overlay_layout_only else 'full','checks':checks}
    result = run(target+['logcat','-d','-b','crash'],capture_output=True)
    (EVIDENCE/'crash.txt').write_bytes(result.stdout)
    if b'FATAL EXCEPTION' in result.stdout: raise RuntimeError('Native crash detected')
    if b'Status: ok' not in (EVIDENCE/'launch.txt').read_bytes(): raise RuntimeError('Activity launch was not successful')
finally:
    (EVIDENCE/'readiness.json').write_text(json.dumps(readiness,indent=2))
    restored = []
    for (namespace,key), value in original_settings.items():
        try:
            command = ['delete',namespace,key] if value == 'null' else ['put',namespace,key,value]
            run(target+['shell','settings',*command],capture_output=True,timeout=10)
            actual = run(target+['shell','settings','get',namespace,key],capture_output=True,timeout=10).stdout.decode().strip()
            restored.append({'namespace':namespace,'key':key,'before':value,'after':actual})
            if actual != value: restoration_errors.append(key+' readback mismatch')
        except Exception as error: restoration_errors.append(key+': '+type(error).__name__)
    (EVIDENCE/'settings-restoration.json').write_text(json.dumps({'settings':restored,'errors':restoration_errors},indent=2))
    if args.attach or (process is not None and process.poll() is None):
        try:
            result = subprocess.run([str(x) for x in adb+['-s',serial,'logcat','-d','-b','crash']], env=env, capture_output=True, timeout=10)
            (EVIDENCE/'crash.txt').write_bytes(result.stdout)
        except subprocess.TimeoutExpired: pass
    if process is not None and process.poll() is None:
        process.terminate()
        try: process.wait(timeout=20)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
    if not args.attach: subprocess.run([str(x) for x in adb+['kill-server']], env=env, timeout=15, check=False)
    log.close()

if restoration_errors: raise RuntimeError('Original settings restoration failed: '+str(restoration_errors))
if report is not None:
    (EVIDENCE/'runtime-checks.json').write_text(json.dumps(report,indent=2)+'\n')
    print(f'PASS {report["scope"]}; original settings restored; evidence: {EVIDENCE}',flush=True)
