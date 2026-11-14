#!/usr/bin/env python3
"""Read-only acceptance of the actual offline Simulator app and embedded widget."""
import argparse
import json
import pathlib
import plistlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('app', type=pathlib.Path)
parser.add_argument('--expected-dev-version', required=True)
parser.add_argument('--expected-build', required=True)
args = parser.parse_args()
app = args.app.resolve()
widget = app / 'PlugIns/AIPetDevelopmentWidget.appex'
results = []
for bundle, kind in [(app, 'APPL'), (widget, 'XPC!')]:
    with (bundle / 'Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    assert info['CFBundlePackageType'] == kind, (bundle, 'package type')
    assert info['CFBundleVersion'] == args.expected_build, (bundle, 'build version')
    assert info['AIPetDevelopmentVersion'] == args.expected_dev_version, (bundle, 'development version')
    assert info['CFBundleSupportedPlatforms'] == ['iPhoneSimulator'], (bundle, 'not Simulator product')
    assert not info.get('AIPetDevelopmentAppGroup'), (bundle, 'unexpected configured account-sharing group')
    assert not info.get('UIBackgroundModes'), (bundle, 'unexpected background authority')
    assert not any(k in info for k in ['NSMicrophoneUsageDescription', 'NSCameraUsageDescription', 'NSSpeechRecognitionUsageDescription']), (bundle, 'unexpected media permission')
    binary = bundle / info['CFBundleExecutable']
    assert binary.is_file(), (bundle, 'missing executable')
    architecture = subprocess.check_output(['file', str(binary)], text=True).strip()
    assert 'Mach-O' in architecture and 'arm64' in architecture, architecture
    results.append({'bundle': str(bundle), 'identifier': info['CFBundleIdentifier'],
                    'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'],
                    'developmentVersion': info['AIPetDevelopmentVersion'], 'platform': info['CFBundleSupportedPlatforms'],
                    'binary': architecture})
    if kind == 'APPL':
        app_info = info
        schemes = [s for entry in info.get('CFBundleURLTypes', []) for s in entry.get('CFBundleURLSchemes', [])]
        assert schemes == ['aipet-development'], schemes
    else:
        assert info['CFBundleIdentifier'].startswith(app_info['CFBundleIdentifier'] + '.'), 'widget bundle prefix'
        assert info['CFBundleShortVersionString'] == app_info['CFBundleShortVersionString'], 'app/widget version mismatch'
        assert info['NSExtension']['NSExtensionPointIdentifier'] == 'com.apple.widgetkit-extension'
print(json.dumps({'status': 'passed', 'scope': 'artifact inspection only; no simulator/device/services implied', 'artifacts': results}, indent=2))
