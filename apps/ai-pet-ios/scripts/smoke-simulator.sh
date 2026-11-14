#!/bin/bash
# Uses only a disposable device in an app-local device set. Never touches personal simulators.
set -euo pipefail
app_root="$(cd "$(dirname "$0")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
derived_data="${AIPET_DERIVED_DATA:-$app_root/DerivedData}"
artifact="$derived_data/Build/Products/Debug-iphonesimulator/AIPetDevelopment.app"
runtime="${AIPET_SIM_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}"
device_type="${AIPET_SIM_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17}"
device_set="$app_root/.cache/smoke-devices"
bundle=com.example.keepwork.aipet.dev
[[ -d "$artifact/PlugIns/AIPetDevelopmentWidget.appex" ]] || {
  echo 'ERROR: build the app and embedded Widget Extension first.' >&2; exit 2;
}
# Bound host-service stalls; first boot may take several minutes on a fresh runtime.
bounded() {
  python3 - "$@" <<'PYTIMEOUT'
import subprocess, sys
try:
    result = subprocess.run(sys.argv[2:], timeout=int(sys.argv[1]))
    sys.exit(result.returncode)
except subprocess.TimeoutExpired:
    print("ERROR: simulator operation timed out after " + sys.argv[1] + " seconds", file=sys.stderr)
    sys.exit(124)
PYTIMEOUT
}
mkdir -p "$device_set"
device="$(bounded 120 xcrun simctl --set "$device_set" create 'AI Pet Offline Smoke' "$device_type" "$runtime")"
cleanup() {
  bounded 60 xcrun simctl --set "$device_set" shutdown "$device" >/dev/null 2>&1 || true
  bounded 60 xcrun simctl --set "$device_set" delete "$device" >/dev/null 2>&1 || true
}
trap cleanup EXIT
bounded 120 xcrun simctl --set "$device_set" boot "$device"
bounded 600 xcrun simctl --set "$device_set" bootstatus "$device" -b
bounded 180 xcrun simctl --set "$device_set" install "$device" "$artifact"
bounded 180 xcrun simctl --set "$device_set" launch "$device" "$bundle"
sleep 3
bounded 180 xcrun simctl --set "$device_set" spawn "$device" launchctl list | grep -F "$bundle"
bounded 180 xcrun simctl --set "$device_set" io "$device" screenshot "$app_root/.cache/simulator-launch.png"
bounded 180 xcrun simctl --set "$device_set" openurl "$device" 'aipet-development://preview'
bounded 180 xcrun simctl --set "$device_set" openurl "$device" 'aipet-development://preview?account=synthetic-other'
sleep 2
bounded 180 xcrun simctl --set "$device_set" spawn "$device" launchctl list | grep -F "$bundle"
bounded 180 xcrun simctl --set "$device_set" io "$device" screenshot "$app_root/.cache/simulator-unsupported-link.png"
echo "SMOKE: install/launch/process passed; synthetic deep-link requests submitted on $runtime ($device_type)."
echo 'Review screenshots for UI evidence. iOS may require Open confirmation for links; app-level delivery is not asserted. Widget rendering/App Group sharing is not asserted.'
echo "SCREENSHOT: $app_root/.cache/simulator-launch.png"
