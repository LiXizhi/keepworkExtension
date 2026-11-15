#!/usr/bin/env python3
"""Early-session final-APK checks on an ALREADY RUNNING task-owned AVD. Never boots a device."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET
from emulator_runtime import safe_vertical_bounds
from emulator_ui import fresh_hierarchy, toggle_round_trip, assert_app_surface, assert_resumed

PACKAGE = 'com.keepwork.aipet.dev'

def verify_app_ui(xml):
    return assert_app_surface(ET.fromstring(xml), PACKAGE)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--budget-seconds', type=int, default=300)
    parser.add_argument('--replay-ui', type=Path, help='Offline red-capable gate check; never accesses a device')
    args = parser.parse_args()
    if args.replay_ui:
        verify_app_ui(args.replay_ui.read_bytes())
        print('PASS actual application UI gate replay')
        return
    if not 60 <= args.budget_seconds <= 300:
        parser.error('Budget must be 60..300 seconds; cleanup has its own bounded commands')
    root = Path(__file__).resolve().parents[1]
    evidence = root/'build/native-evidence/runs'/('early-target-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
    evidence.mkdir(parents=True)
    apk = root/'app/build/outputs/apk/debug/app-debug.apk'
    sha = hashlib.sha256(apk.read_bytes()).hexdigest()
    target = [str(root/'.toolchains/android-sdk/platform-tools/adb'), '-P', '5039', '-s', 'emulator-5584']
    with socket.socket() as server:
        server.settimeout(1)
        if server.connect_ex(('127.0.0.1',5039)) != 0:
            raise RuntimeError('Owned adb absent; refusing implicit startup')
    started = time.monotonic()
    deadline = started + args.budget_seconds
    events, checks, restore_errors = [], [], []
    original_font = original_op = None
    original_notifications = None
    report = None
    safe_top, safe_bottom = 0, 0
    print('EVIDENCE',evidence,flush=True)
    (evidence/'artifact.json').write_text(json.dumps({'apkSha256':sha,'scope':'early-font-stop-overlay-revoke-reopen','budgetSeconds':args.budget_seconds},indent=2))

    def call(command, timeout=10, cleanup=False, check=True):
        remaining = deadline-time.monotonic()
        if not cleanup and remaining <= 0:
            raise TimeoutError('Fixed target deadline exhausted')
        limit = timeout if cleanup else min(timeout, remaining)
        tick = time.monotonic()
        try:
            result = subprocess.run(target+command,capture_output=True,timeout=limit,check=check)
            return result.stdout
        finally:
            events.append({'command':command[:4],'seconds':round(time.monotonic()-tick,3),'cleanup':cleanup})

    def hierarchy():
        tree = fresh_hierarchy(lambda command: call(command,timeout=10),evidence)
        return assert_app_surface(tree,PACKAGE)

    def foreground(label):
        state = call(['shell','dumpsys','activity','activities']).decode()
        (evidence/(label+'-activities.txt')).write_text(state)
        assert_resumed(state,PACKAGE)
        return hierarchy()

    def reopen(label, exercise=False):
        out = call(['shell','am','start','-W','-f','0x14000000','-n',PACKAGE+'/.MainActivity'],timeout=20)
        (evidence/(label+'-launch.txt')).write_bytes(out)
        assert b'Status: ok' in out, 'Activity launch did not succeed'
        tree = foreground(label)
        if exercise:
            interaction = toggle_round_trip('preview_visible',locate,click,hierarchy)
            (evidence/(label+'-interaction.json')).write_text(json.dumps(interaction,indent=2))
            tree = foreground(label+'-after-control')
        return tree

    def window_state():
        state = call(['shell','dumpsys','window','windows']).decode()
        (evidence/'windows.txt').write_text(state)
        return state

    def ownership(expected):
        window = 'AI Pet development overlay' in window_state()
        service = b'ServiceRecord{' in call(['shell','dumpsys','activity','services',PACKAGE])
        assert window == expected and service == expected, f'Expected window/service={expected}, got {window}/{service}'

    def locate(label, exact=False, upward=False):
        for forward in ((False,True) if upward else (True,False)):
            previous = None
            for _ in range(6):
                tree = hierarchy(); signature = ET.tostring(tree)
                for node in tree.iter('node'):
                    text = (node.get('text','')+node.get('content-desc','')).casefold()
                    match = text.strip()==label.casefold() if exact else label.casefold() in text
                    match = match or node.get('resource-id','').endswith('/'+label)
                    if match:
                        bounds = list(map(int,re.findall(r'\d+',node.attrib['bounds'])))
                        if len(bounds)==4 and bounds[2]>bounds[0] and bounds[3]-bounds[1]>=24 and bounds[1]>=safe_top and bounds[3]<=safe_bottom:
                            return bounds
                if signature == previous: break
                previous = signature
                # Status rows sit just above controls at large fonts; fast flings can skip them entirely.
                if upward:
                    y1,y2,duration = (850,500,650) if forward else (500,850,650)
                else:
                    y1,y2,duration = (1050,350,250) if forward else (350,1050,250)
                call(['shell','input','swipe','600',str(y1),'600',str(y2),str(duration)])
        raise AssertionError('Visible control unavailable: '+label)

    def click(bounds):
        call(['shell','input','tap',str((bounds[0]+bounds[2])//2),str((bounds[1]+bounds[3])//2)])

    def tap(label):
        click(locate(label))
        time.sleep(.3)

    font_readbacks = []
    def set_font_scale(value):
        call(['shell','settings','put','system','font_scale',value])
        actual = call(['shell','settings','get','system','font_scale']).decode().strip()
        font_readbacks.append({'requested':value,'actual':actual})
        (evidence/'font-scale-readbacks.json').write_text(json.dumps(font_readbacks,indent=2))
        assert actual == value, 'Requested font scale was not applied'
        return actual

    def app_op():
        text = call(['shell','appops','get',PACKAGE,'SYSTEM_ALERT_WINDOW'],timeout=8).decode()
        match = re.search(r'SYSTEM_ALERT_WINDOW:\s*([a-z_]+)',text)
        return match.group(1) if match else 'default'

    try:
        assert call(['emu','avd','name']).splitlines()[0] == b'AiPetOfflineApi35'
        assert call(['shell','getprop','ro.kernel.qemu']).strip()==b'1'
        assert call(['shell','getprop','ro.build.version.sdk']).strip()==b'35'
        installed = call(['shell','pm','path',PACKAGE]).decode().strip().removeprefix('package:')
        assert call(['shell','sha256sum',installed]).decode().split()[0]==sha, 'Installed APK hash mismatch'
        size = call(['shell','wm','size']).decode()
        assert re.findall(r'(\d+)x(\d+)',size)[-1]==('720','1280'), 'Expected owned portrait profile'
        original_font = call(['shell','settings','get','system','font_scale']).decode().strip()
        original_op = app_op()
        permission = call(['shell','dumpsys','package',PACKAGE]).decode()
        granted = re.search(r'android.permission.POST_NOTIFICATIONS: granted=(true|false)',permission)
        assert granted, 'Cannot establish original notification permission'
        original_notifications = granted.group(1)=='true'
        call(['shell','am','force-stop',PACKAGE])
        tree = reopen('fresh')
        ownership(False)
        safe_top,safe_bottom = safe_vertical_bounds(window_state(),720,1280)
        (evidence/'navigation-profile.json').write_text(json.dumps({'width':720,'height':1280,'safeTop':safe_top,'safeBottom':safe_bottom}))
        # Read the selected locale from actual UI, without changing language before layout checks.
        names = {'简体中文':'values-zh-rCN','English (US)':'values','Español':'values-es','한국어':'values-ko','日本語':'values-ja','Français':'values-fr'}
        selected = [n.get('text') for n in tree.iter('node') if n.get('text') in names]
        assert len(set(selected))==1, 'Cannot identify current UI locale without changing it'
        strings = {n.attrib['name']: ''.join(n.itertext()).replace("\\'", "'") for n in ET.parse(root/'app/src/main/res'/names[selected[0]]/'strings.xml').getroot().findall('string')}
        def status(kind, capture):
            return strings['fake_status'].replace('%1$s',strings['session_'+kind]).replace('%2$s',strings['yes' if capture else 'no'])

        # These are FIRST: no locale changes, overlay starts or revocations precede them.
        for scale in ('1.0','2.0'):
            observed_font = set_font_scale(scale)
            time.sleep(.5)
            foreground('font-'+scale)
            safe_top,safe_bottom = safe_vertical_bounds(window_state(),720,1280)
            start_bounds = locate(strings['start_fake'])
            active_started = time.monotonic() # Includes Start input delivery, not only later observation.
            click(start_bounds)
            locate(status('active',True),upward=True)
            bounds = locate(strings['stop_fake'],exact=True)
            assert safe_top <= bounds[1] < bounds[3] <= safe_bottom
            (evidence/('last-stop-'+scale+'.png')).write_bytes(call(['exec-out','screencap','-p']))
            click(bounds)
            locate(status('ended',False),upward=True)
            elapsed = time.monotonic()-active_started
            assert elapsed<25, 'Cannot distinguish real Stop from 30-second fake lease expiry'
            check={'fontScale':scale,'actualFontScale':observed_font,'stopBounds':bounds,'safeTop':safe_top,'safeBottom':safe_bottom,'startToClickedEndedSeconds':round(elapsed,3)}
            checks.append(check);print('PASS font Stop',json.dumps(check),flush=True)
            (evidence/'completed-checks.json').write_text(json.dumps(checks,indent=2))

        set_font_scale('1.0');time.sleep(.5)
        foreground('before-overlay')
        if not original_notifications: call(['shell','pm','grant',PACKAGE,'android.permission.POST_NOTIFICATIONS'])
        call(['shell','appops','set',PACKAGE,'SYSTEM_ALERT_WINDOW','allow'])
        ownership(False)
        tap(strings['show_overlay']);ownership(True)
        tap(strings['remove_overlay']);time.sleep(1);ownership(False)
        checks.append('in-app Stop: window and service present immediately before, absent afterward')
        print('PASS in-app overlay Stop pre/postconditions',flush=True)
        tap(strings['show_overlay']);ownership(True)
        call(['shell','appops','set',PACKAGE,'SYSTEM_ALERT_WINDOW','deny']);time.sleep(2);ownership(False)
        call(['shell','appops','set',PACKAGE,'SYSTEM_ALERT_WINDOW','allow']);assert app_op()=='allow'
        ownership(False);reopen('permission-restored',exercise=True);ownership(False)
        checks.append('revoke present window/service; both removed; restored permission and actual foreground reopen do not resurrect')
        tap(strings['show_overlay']);ownership(True)
        call(['shell','am','force-stop',PACKAGE]);ownership(False)
        reopen('force-stop-reopen',exercise=True);ownership(False)
        checks.append('force-stop live overlay; actual foreground/visible UI after reopen; no resurrection')
        report={'status':'passed','scope':'early-font-stop-overlay-revoke-reopen','apkSha256':sha,'checks':checks,'seconds':round(time.monotonic()-started,3)}
    finally:
        # Dedicated cleanup deadlines remain available even if the test budget expires.
        restored = {}
        try: call(['shell','am','force-stop',PACKAGE],cleanup=True,timeout=5)
        except Exception as error: restore_errors.append('stop owned package: '+type(error).__name__)
        for name, command, read in [
            ('fontScale',(['delete','system','font_scale'] if original_font=='null' else ['put','system','font_scale',original_font]),['shell','settings','get','system','font_scale'])
        ]:
            if original_font is None: continue
            try:
                call(['shell','settings',*command],cleanup=True,timeout=5)
                after = call(read,cleanup=True,timeout=5).decode().strip()
                restored[name]={'before':original_font,'after':after}
                if after!=original_font:restore_errors.append(name+' mismatch')
            except Exception as error:restore_errors.append(name+': '+type(error).__name__)
        if original_op is not None:
            try:
                call(['shell','appops','set',PACKAGE,'SYSTEM_ALERT_WINDOW',original_op],cleanup=True,timeout=5)
                text=call(['shell','appops','get',PACKAGE,'SYSTEM_ALERT_WINDOW'],cleanup=True,timeout=5).decode()
                match=re.search(r'SYSTEM_ALERT_WINDOW:\s*([a-z_]+)',text);after=match.group(1) if match else 'default'
                restored['overlayAppOp']={'before':original_op,'after':after}
                if after!=original_op:restore_errors.append('overlay app-op mismatch')
            except Exception as error:restore_errors.append('overlay app-op: '+type(error).__name__)
        if original_notifications is False:
            try:call(['shell','pm','revoke',PACKAGE,'android.permission.POST_NOTIFICATIONS'],cleanup=True,timeout=5)
            except Exception as error:restore_errors.append('notification permission: '+type(error).__name__)
        if original_notifications is not None:
            try:
                text=call(['shell','dumpsys','package',PACKAGE],cleanup=True,timeout=5).decode()
                match=re.search(r'android.permission.POST_NOTIFICATIONS: granted=(true|false)',text)
                after=match.group(1)=='true' if match else None
                restored['notifications']={'before':original_notifications,'after':after}
                if after!=original_notifications:restore_errors.append('notification permission mismatch')
            except Exception as error:restore_errors.append('notification readback: '+type(error).__name__)
        (evidence/'settings-restoration.json').write_text(json.dumps({'settings':restored,'errors':restore_errors},indent=2))
        (evidence/'timings.json').write_text(json.dumps(events,indent=2))
        (evidence/'completed-checks.json').write_text(json.dumps(checks,indent=2))
    if restore_errors:raise RuntimeError('Original state restoration failed: '+str(restore_errors))
    if report:
        (evidence/'runtime-checks.json').write_text(json.dumps(report,indent=2))
        print('PASS targeted acceptance; original state restored',evidence,flush=True)

if __name__=='__main__':main()
