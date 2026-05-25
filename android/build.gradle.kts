buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools:r8:9.1.31")
    }
}

plugins {
    id("com.android.application") version "8.2.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
    // v0.5: KSP for Room compile-time codegen.
    id("com.google.devtools.ksp") version "1.9.22-1.0.17" apply false
}
