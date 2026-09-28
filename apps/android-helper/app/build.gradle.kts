import java.util.Properties
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.isFile) file.inputStream().use(::load)
}
val releaseIdentity = JsonSlurper().parse(rootProject.file("version.json")) as Map<*, *>

android {
    namespace = "com.keepwork.localhelper"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.keepwork.localhelper"
        minSdk = 29
        targetSdk = 35
        versionCode = (releaseIdentity["versionCode"] as Number).toInt()
        versionName = releaseIdentity["version"] as String
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("internal") {
            val store = providers.environmentVariable("KP_ANDROID_KEYSTORE").orNull
                ?: localProperties.getProperty("kp.android.keystore")
            if (!store.isNullOrBlank()) {
                storeFile = file(store)
                storePassword = providers.environmentVariable("KP_ANDROID_STORE_PASSWORD").orNull
                    ?: localProperties.getProperty("kp.android.storePassword")
                keyAlias = providers.environmentVariable("KP_ANDROID_KEY_ALIAS").orNull
                    ?: localProperties.getProperty("kp.android.keyAlias")
                keyPassword = providers.environmentVariable("KP_ANDROID_KEY_PASSWORD").orNull
                    ?: localProperties.getProperty("kp.android.keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (signingConfigs.getByName("internal").storeFile != null) {
                signingConfig = signingConfigs.getByName("internal")
            }
            ndk { abiFilters += "arm64-v8a" }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    androidResources { noCompress += listOf("onnx", "pem") }
    sourceSets.getByName("main") {
        assets.srcDir("src/generated/assets")
        jniLibs.srcDir("src/generated/jniLibs")
    }
}

val prepareRuntime by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir)
    commandLine("node", "scripts/prepare-runtime.cjs")
}

tasks.configureEach {
    if (name.startsWith("merge") && (name.endsWith("Assets") || name.endsWith("JniLibFolders"))) {
        dependsOn(prepareRuntime)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.80")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}
