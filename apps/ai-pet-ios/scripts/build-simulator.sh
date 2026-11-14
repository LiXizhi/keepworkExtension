#!/bin/bash
set -euo pipefail
app_root="$(cd "$(dirname "$0")/.." && pwd)"
derived_data="${AIPET_DERIVED_DATA:-$app_root/DerivedData}"
if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  if [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  else
    echo 'ERROR: full Xcode required. Install an Apple-distributed compatible Xcode and set DEVELOPER_DIR to its Contents/Developer directory.' >&2
    exit 2
  fi
fi
if [[ ! -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ]]; then
  echo 'ERROR: DEVELOPER_DIR does not contain full Xcode.' >&2; exit 2
fi
if ! xcodebuild -checkFirstLaunchStatus; then
  echo 'ERROR: Xcode first-launch setup is incomplete. The developer must open this Xcode, review/accept its license and complete required components before building.' >&2
  exit 2
fi
xcrun --sdk iphonesimulator --show-sdk-path >/dev/null
xcodebuild -project "$app_root/AIPetDevelopment.xcodeproj" -target AIPetDevelopment -sdk iphonesimulator \
  -configuration Debug SYMROOT="$derived_data/Build/Products" \
  OBJROOT="$derived_data/Build/Intermediates.noindex" ONLY_ACTIVE_ARCH=NO \
  CLANG_MODULE_CACHE_PATH="$derived_data/ModuleCache.noindex" \
  SWIFT_MODULE_CACHE_PATH="$derived_data/ModuleCache.noindex" CODE_SIGNING_ALLOWED=NO build
artifact="$derived_data/Build/Products/Debug-iphonesimulator/AIPetDevelopment.app"
[[ -d "$artifact" ]] || { echo 'ERROR: expected app artifact missing.' >&2; exit 1; }
echo "ARTIFACT: $artifact"
