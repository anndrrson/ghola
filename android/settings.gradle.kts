pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // Phase M4: Solana Mobile Stack publishes to Maven Central + jitpack.
        // Keep jitpack as a fallback in case newer Seeker SDK releases land
        // there first.
        maven { url = uri("https://jitpack.io") }
    }
}

rootProject.name = "ghola-android"
include(":app")
