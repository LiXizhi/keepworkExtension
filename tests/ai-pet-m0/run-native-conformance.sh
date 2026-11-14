#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
qa_build=$(mktemp -d "${TMPDIR:-/tmp}/ai-pet-qa.XXXXXX")
printf 'QA artifacts: %s\n' "$qa_build"
CLANG_MODULE_CACHE_PATH="$qa_build/clang" swiftc -parse-as-library -swift-version 6 \
  -module-cache-path "$qa_build/modules" apps/ai-pet-ios/Sources/AIPetCore/*.swift \
  tests/ai-pet-m0/ios-conformance.swift -o "$qa_build/ios-conformance"
"$qa_build/ios-conformance"
qa_java="${AI_PET_QA_JAVA:-apps/ai-pet-android/.toolchains/jdk-17.0.21+9/Contents/Home/bin/java}"
qa_libs="${AI_PET_GRADLE_LIBS:-apps/ai-pet-android/.toolchains/gradle-8.11.1/lib}"
"$qa_java" -cp "$qa_libs/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-stdlib -no-reflect -jvm-target 17 \
  -classpath "$qa_libs/kotlin-stdlib-2.0.20.jar:$qa_libs/annotations-24.0.1.jar" \
  -d "$qa_build/kotlin" apps/ai-pet-android/core/src/main/kotlin/com/keepwork/aipet/core/*.kt \
  tests/ai-pet-m0/AndroidConformance.kt
"$qa_java" -cp "$qa_build/kotlin:$qa_libs/kotlin-stdlib-2.0.20.jar" com.keepwork.aipet.qa.AndroidConformanceKt
