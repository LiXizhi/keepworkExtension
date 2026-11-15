#!/usr/bin/env python3
"""Start/stop only AiPetOfflineApi35 with a recorded, no-wipe host-GLES experiment."""
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
from emulator_runtime import wait_for_stage

ROOT=Path(__file__).resolve().parents[1]
SDK=ROOT/'.toolchains/android-sdk'
NAME='AiPetOfflineApi35'
ADB=[str(SDK/'platform-tools/adb'),'-P','5039']
TARGET=ADB+['-s','emulator-5584']
SESSION=ROOT/'build/native-evidence/owned-emulator-session.json'


def renderer_info(text):
    mode=re.search(r'gles_mode_selected:([^\s]+)',text)
    adapters=[line for line in text.splitlines() if 'Graphics Adapter' in line]
    api=[line for line in text.splitlines() if 'Graphics API Version' in line]
    vulkan=[line for line in text.splitlines() if 'Selecting Vulkan device' in line or 'vulkan_mode_selected:' in line]
    warnings=[line for line in text.splitlines() if 'forcing software' in line or 'fallback' in line.lower()]
    if not mode or not adapters:return None
    actual=mode.group(1)
    software=actual in ('swangle','swiftshader','lavapipe','software') or any(re.search(r'SwiftShader|llvmpipe|lavapipe',line,re.I) for line in adapters)
    host=actual in ('host','angle','angle_metal') and any(re.search(r'Apple|Metal|MoltenVK|AMD|NVIDIA|Intel',line,re.I) for line in adapters)
    return {'glesMode':actual,'graphicsAdapters':adapters,'graphicsApi':api,'vulkan':vulkan,'fallbackWarnings':warnings,'distinctHostGles':host and not software}


def environment(evidence):
    return dict(os.environ,ANDROID_HOME=str(SDK),ANDROID_SDK_ROOT=str(SDK),ANDROID_USER_HOME=str(ROOT/'.toolchains/android-user'),ANDROID_EMULATOR_HOME=str(ROOT/'.toolchains/android-user'),ANDROID_AVD_HOME=str(ROOT/'.toolchains/avd'),ANDROID_ADB_SERVER_PORT='5039',ANDROID_ADB_LOG_PATH=str(evidence/'adb.log'))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='action',required=True)
    start=sub.add_parser('start');start.add_argument('--gpu',choices=['host'],required=True);start.add_argument('--boot-seconds',type=int,default=180)
    sub.add_parser('stop')
    args=parser.parse_args()
    if args.action=='stop':
        session=json.loads(SESSION.read_text());env=environment(Path(session['evidence']))
        result=subprocess.run(TARGET+['emu','avd','name'],env=env,capture_output=True,check=True,timeout=5)
        if result.stdout.splitlines()[0]!=NAME.encode():raise RuntimeError('Refusing stop: unexpected AVD')
        subprocess.run(TARGET+['emu','kill'],env=env,check=True,timeout=8)
        subprocess.run(ADB+['kill-server'],env=env,check=True,timeout=8)
        session['closed']=True;SESSION.write_text(json.dumps(session,indent=2));print('Owned AVD/adb stopped')
        return
    if not 1<=args.boot_seconds<=180:parser.error('Boot deadline must be 1..180 seconds')
    if not (ROOT/'.toolchains/avd'/f'{NAME}.avd').exists():raise RuntimeError('Initialized owned AVD required; no creation/wipe is performed')
    for port in (5039,5584,5585):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);probe.bind(('127.0.0.1',port))
    evidence=ROOT/'build/native-evidence/runs'/('host-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]);evidence.mkdir(parents=True)
    env=environment(evidence)
    command=[str(SDK/'emulator/emulator'),'-avd',NAME,'-port','5584','-no-window','-no-audio','-no-snapshot','-no-boot-anim','-gpu',args.gpu,'-camera-back','none','-camera-front','none','-memory','3072','-cores','4']
    profile={'memoryMiB':3072,'cores':4,'requestedGpu':args.gpu,'wipe':False,'avd':NAME,'bootBudgetSeconds':args.boot_seconds}
    (evidence/'profile.json').write_text(json.dumps({'profile':profile,'command':command,'apkSha256':hashlib.sha256((ROOT/'app/build/outputs/apk/debug/app-debug.apk').read_bytes()).hexdigest()},indent=2))
    accel=subprocess.run([str(SDK/'emulator/emulator'),'-accel-check'],env=env,capture_output=True,timeout=10)
    (evidence/'acceleration.txt').write_bytes(accel.stdout+accel.stderr)
    if accel.returncode:raise RuntimeError('Hardware acceleration check failed')
    process=None;records=[];started_server=False
    print('EVIDENCE',evidence,flush=True)
    try:
        subprocess.run(ADB+['start-server'],env=env,check=True,timeout=10);started_server=True
        with (evidence/'emulator.log').open('wb') as log:
            process=subprocess.Popen(command,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        session={'pid':process.pid,'avd':NAME,'evidence':str(evidence),'profile':profile,'closed':False};SESSION.write_text(json.dumps(session,indent=2))
        deadline=time.monotonic()+args.boot_seconds
        def renderer(timeout):
            if process.poll() is not None:raise RuntimeError('Owned emulator exited')
            info=renderer_info((evidence/'emulator.log').read_text(errors='replace'))
            if info:
                (evidence/'renderer.json').write_text(json.dumps(info,indent=2))
                if not info['distinctHostGles']:raise RuntimeError('Invalid comparison: host request did not select a distinct hardware GLES path')
                return True
            return False
        wait_for_stage('actual-host-gles',renderer,min(30,deadline-time.monotonic()),records)
        def boot(timeout):
            if process.poll() is not None:raise RuntimeError('Owned emulator exited')
            result=subprocess.run(TARGET+['shell','getprop','sys.boot_completed'],env=env,capture_output=True,timeout=timeout)
            return result.returncode==0 and result.stdout.strip()==b'1'
        wait_for_stage('boot',boot,max(0,deadline-time.monotonic()),records)
        (evidence/'renderer.json').write_text(json.dumps(renderer_info((evidence/'emulator.log').read_text(errors='replace')),indent=2))
        print('PASS distinct host GLES and boot readiness; retained for scoped checks',flush=True)
    except BaseException:
        if process is not None and process.poll() is None:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        if started_server:subprocess.run(ADB+['kill-server'],env=env,timeout=8,check=False)
        if process is not None:
            session['closed']=True;SESSION.write_text(json.dumps(session,indent=2))
        raise
    finally:
        (evidence/'readiness.json').write_text(json.dumps(records,indent=2))

if __name__=='__main__':main()
