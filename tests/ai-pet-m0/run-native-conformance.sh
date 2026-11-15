#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
qa_build=$(mktemp -d "${TMPDIR:-/tmp}/ai-pet-qa.XXXXXX")
printf 'QA artifacts: %s\n' "$qa_build"
mkdir -p "$qa_build/Sources/QAConformance"
cp -R apps/ai-pet-ios/Sources/AIPetCore "$qa_build/Sources/AIPetCore"
{ printf 'import AIPetCore\n'; cat tests/ai-pet-m0/ios-conformance.swift; } > "$qa_build/Sources/QAConformance/main.swift"
cat > "$qa_build/Package.swift" <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "QAConformance", platforms: [.macOS(.v14)], targets: [
    .target(name: "AIPetCore", resources: [.process("Resources")]),
    .executableTarget(name: "QAConformance", dependencies: ["AIPetCore"])
])
SWIFT
CLANG_MODULE_CACHE_PATH="$qa_build/clang" swift run --package-path "$qa_build" --disable-sandbox \
  --cache-path "$qa_build/cache" --config-path "$qa_build/config" --security-path "$qa_build/security" QAConformance
qa_java="${AI_PET_QA_JAVA:-apps/ai-pet-android/.toolchains/jdk-17.0.21+9/Contents/Home/bin/java}"
qa_libs="${AI_PET_GRADLE_LIBS:-apps/ai-pet-android/.toolchains/gradle-8.11.1/lib}"
"$qa_java" -cp "$qa_libs/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-stdlib -no-reflect -jvm-target 17 \
  -classpath "$qa_libs/kotlin-stdlib-2.0.20.jar:$qa_libs/annotations-24.0.1.jar" \
  -d "$qa_build/kotlin" apps/ai-pet-android/core/src/main/kotlin/com/keepwork/aipet/core/*.kt \
  tests/ai-pet-m0/AndroidConformance.kt
"$qa_java" -cp "$qa_build/kotlin:$qa_libs/kotlin-stdlib-2.0.20.jar" com.keepwork.aipet.qa.AndroidConformanceKt
