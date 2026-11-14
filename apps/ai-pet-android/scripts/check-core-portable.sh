#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${JAVA_HOME:?Set JAVA_HOME to a JDK 17 installation}"
# Fallback uses the compiler already bundled in pinned Gradle, avoiding Maven resolution.
libs="${AI_PET_GRADLE_LIBS:-$PWD/.toolchains/gradle-8.11.1/lib}"
node scripts/prepare-shared-fixtures.mjs
mkdir -p core/build/portable
"$JAVA_HOME/bin/java" -cp "$libs/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-stdlib -no-reflect -jvm-target 17 \
  -classpath "$libs/kotlin-stdlib-2.0.20.jar:$libs/annotations-24.0.1.jar" \
  -d core/build/portable \
  core/src/main/kotlin/com/keepwork/aipet/core/*.kt \
  core/src/test/kotlin/com/keepwork/aipet/core/*.kt
"$JAVA_HOME/bin/java" -DaiPet.fixtures=core/build/shared-scenarios.tsv \
  -cp "core/build/portable:$libs/kotlin-stdlib-2.0.20.jar" com.keepwork.aipet.core.CoreTestKt
