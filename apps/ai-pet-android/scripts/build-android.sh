#!/bin/sh
set -eu
AI_PET_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$AI_PET_ROOT/scripts/android-env.sh"
cd "$AI_PET_ROOT"
test -x "$JAVA_HOME/bin/java" || { echo 'JDK 17 required; set JAVA_HOME.' >&2; exit 1; }
java_version=$("$JAVA_HOME/bin/java" -version 2>&1)
case "$java_version" in
  *'version "17.'*) ;;
  *) echo 'This development build requires JAVA_HOME pointing to JDK 17.' >&2; exit 1 ;;
esac
for required in platforms/android-35/android.jar build-tools/35.0.0/aapt2 platform-tools/adb; do
  test -f "$ANDROID_HOME/$required" || { echo "Missing SDK prerequisite: $required; run python3 scripts/setup-android-sdk.py." >&2; exit 1; }
done
# Avoid any creation of ~/.android/debug.keystore by AGP.
if ! test -f .toolchains/dev-debug.keystore; then
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore .toolchains/dev-debug.keystore -storepass android \
    -alias androiddebugkey -keypass android -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000
fi
if test -x .toolchains/gradle-8.11.1/bin/gradle; then
  .toolchains/gradle-8.11.1/bin/gradle -Pandroid=true :core:check :app:assembleDebug :app:lintDebug --no-daemon "$@"
else
  ./gradlew -Pandroid=true :core:check :app:assembleDebug :app:lintDebug --no-daemon "$@"

fi
printf "Debug APK: %s/app/build/outputs/apk/debug/app-debug.apk\n" "$AI_PET_ROOT"
