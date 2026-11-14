buildscript {
    // Keep AGP and Kotlin in the same classloader only for an explicit Android build.
    // Pure JVM checks do not resolve the Android plugin or require its SDK.
    if (gradle.startParameter.projectProperties["android"] == "true") {
        repositories { google(); mavenCentral() }
        dependencies { classpath("com.android.tools.build:gradle:8.9.2") }
    }
}
plugins {
    base
    kotlin("jvm") version "2.2.10" apply false
}
allprojects { version = "0.1.0-dev.3" }
