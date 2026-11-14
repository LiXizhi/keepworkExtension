pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "ai-pet-android-dev"
include(":core")
// Core checks remain runnable without an Android SDK or Android plugin resolution.
if (providers.gradleProperty("android").orNull == "true") include(":app")
