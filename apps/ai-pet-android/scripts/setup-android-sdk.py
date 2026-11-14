#!/usr/bin/env python3
"""Install pinned official SDK archives locally. Does not alter user/global SDK settings."""
import hashlib, json, os, pathlib, platform, shutil, subprocess, tempfile, zipfile, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'scripts/android-sdk-lock.json').read_text())
if platform.system() != 'Darwin' or platform.machine() != 'arm64':
    raise SystemExit('This lock targets macOS ARM64; add a reviewed host lock for another OS.')
SDK = ROOT / '.toolchains/android-sdk'
CACHE = ROOT / '.toolchains/downloads'
CACHE.mkdir(parents=True, exist_ok=True)
if any(arg != '--emulator' for arg in sys.argv[1:]):
    raise SystemExit('Usage: setup-android-sdk.py [--emulator]')
packages = LOCK['packages'] + (LOCK['optionalEmulatorPackages'] if '--emulator' in sys.argv else [])
def verify_revision(destination, expected):
    props = dict(line.split('=', 1) for line in (destination / 'source.properties').read_text().splitlines() if '=' in line)
    actual = props.get('Pkg.Revision', '').strip()
    if actual != expected:
        raise SystemExit(f'Installed revision mismatch at {destination}: {actual} != {expected}')
def register_generic_package(destination, package):
    # Legacy SDK scanning does not register manually extracted emulator/command-line tools.
    # Mirror their official generic package metadata so avdmanager can resolve dependencies.
    if package['id'] != 'emulator' and not package['id'].startswith('cmdline-tools;'):
        return
    revisions = ''.join(f'<{name}>{value}</{name}>' for name, value in zip(('major','minor','micro'), package['revision'].split('.')))
    metadata = f"""<?xml version="1.0" encoding="UTF-8"?>
<repo:repository xmlns:repo="http://schemas.android.com/repository/android/common/02"
 xmlns:generic="http://schemas.android.com/repository/android/generic/02"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <localPackage path="{package['id']}" obsolete="false">
  <type-details xsi:type="generic:genericDetailsType"/>
  <revision>{revisions}</revision><display-name>{package['id']}</display-name>
 </localPackage>
</repo:repository>
"""
    (destination / 'package.xml').write_text(metadata)
for package in packages:
    destination = SDK / package['destination']
    if (destination / 'source.properties').exists():
        verify_revision(destination, package['revision'])
        register_generic_package(destination, package)
        print(f"Already present: {package['id']}", flush=True)
        continue
    archive = CACHE / package['archive']
    if not archive.exists():
        subprocess.run(['curl', '-fLsS', '--retry', '3', '--max-time', '600',
                        package.get('baseUrl', 'https://dl.google.com/android/repository/') + package['archive'], '-o', str(archive)], check=True)
    for algorithm in ('sha1', 'sha256'):
        if algorithm in package:
            with archive.open('rb') as stream:
                actual = hashlib.file_digest(stream, algorithm).hexdigest()
            if actual != package[algorithm]:
                raise SystemExit(f'Checksum mismatch for {archive}; remove the partial archive and retry.')
    with tempfile.TemporaryDirectory(dir=CACHE) as staging:
        with zipfile.ZipFile(archive) as zipped:
            for member in zipped.namelist():
                target = pathlib.Path(staging, member).resolve()
                if not target.is_relative_to(pathlib.Path(staging).resolve()):
                    raise SystemExit('Unsafe archive path')
        # unzip preserves the official executable bits.
        subprocess.run(['unzip', '-q', str(archive), '-d', staging], check=True)
        source = pathlib.Path(staging, package['sourceDirectory'])
        if not (source / 'source.properties').is_file():
            raise SystemExit(f'Unexpected archive layout for {archive}: {list(pathlib.Path(staging).iterdir())}')
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), destination)
    verify_revision(destination, package['revision'])
    register_generic_package(destination, package)
    print(f"Installed {package['id']} revision {package['revision']}", flush=True)
(ROOT / '.toolchains/sdk-setup-status.json').write_text(json.dumps({'host': LOCK['host'], 'packages': packages}, indent=2) + '\n')
print(f'SDK ready at {SDK}. Run scripts/build-android.sh; SDK licenses may be requested by Gradle.')
