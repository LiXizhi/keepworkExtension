# Source from scripts after setting AI_PET_ROOT. Everything writable stays app-local.
export JAVA_HOME="${JAVA_HOME:-$AI_PET_ROOT/.toolchains/jdk-17.0.21+9/Contents/Home}"
export ANDROID_HOME="$AI_PET_ROOT/.toolchains/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$AI_PET_ROOT/.toolchains/android-user"
export ANDROID_EMULATOR_HOME="$AI_PET_ROOT/.toolchains/android-user"
export ANDROID_AVD_HOME="$AI_PET_ROOT/.toolchains/avd"
export GRADLE_USER_HOME="$AI_PET_ROOT/.toolchains/gradle-home"
mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"
