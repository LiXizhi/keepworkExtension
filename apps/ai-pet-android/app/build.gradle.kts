plugins {
    id("com.android.application")
    kotlin("android")
}
android {
    namespace = "com.keepwork.aipet.dev"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.keepwork.aipet.dev"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.1.0-dev.3"
    }
    signingConfigs {
        getByName("debug") { storeFile = rootProject.file(".toolchains/dev-debug.keystore") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
kotlin { jvmToolchain(17) }
dependencies { implementation(project(":core")) }
