plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "xyz.ghola.app"
    compileSdk = 34
    ndkVersion = "26.1.10909125"

    defaultConfig {
        applicationId = "xyz.ghola.app"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    // Phase M9: release signing + R8 for Solana dApp Store submission.
    // Keystore path + passwords are read from gradle.properties or env vars
    // (`GHOLA_KEYSTORE_PATH`, `GHOLA_KEYSTORE_PASSWORD`, `GHOLA_KEY_ALIAS`,
    // `GHOLA_KEY_PASSWORD`). Release builds fall back to the debug keystore
    // if no signing config is provided, so dev builds still work.
    signingConfigs {
        create("release") {
            val keystorePath = providers.gradleProperty("GHOLA_KEYSTORE_PATH")
                .orElse(providers.environmentVariable("GHOLA_KEYSTORE_PATH"))
                .orNull
            if (keystorePath != null) {
                storeFile = file(keystorePath)
                storePassword = providers.gradleProperty("GHOLA_KEYSTORE_PASSWORD")
                    .orElse(providers.environmentVariable("GHOLA_KEYSTORE_PASSWORD"))
                    .get()
                keyAlias = providers.gradleProperty("GHOLA_KEY_ALIAS")
                    .orElse(providers.environmentVariable("GHOLA_KEY_ALIAS"))
                    .get()
                keyPassword = providers.gradleProperty("GHOLA_KEY_PASSWORD")
                    .orElse(providers.environmentVariable("GHOLA_KEY_PASSWORD"))
                    .get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Only assign the release signing config if a keystore was found;
            // otherwise fall back to debug signing so `assembleRelease` still
            // works for local smoke tests.
            val hasKeystore = providers.gradleProperty("GHOLA_KEYSTORE_PATH")
                .orElse(providers.environmentVariable("GHOLA_KEYSTORE_PATH"))
                .isPresent
            if (hasKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // Native llama.cpp build is disabled because the llama.cpp source subtree
    // was removed in commit ea53f9d ("Remove llama.cpp submodule (breaks
    // Render Docker builds)"). The local LocalLlamaBackend path will throw
    // UnsatisfiedLinkError at runtime IF the user selects Settings → Local
    // backend — but the default backend is cloud Qwen, so the common path
    // works fine without it. To re-enable: `git clone https://github.com/
    // ggerganov/llama.cpp app/src/main/cpp/llama.cpp` then uncomment this.
    //
    // externalNativeBuild {
    //     cmake {
    //         path = file("src/main/cpp/CMakeLists.txt")
    //     }
    // }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.coordinatorlayout:coordinatorlayout:1.2.0")
    implementation("androidx.cardview:cardview:1.0.0")
    // Google Sign-In
    implementation("com.google.android.gms:play-services-auth:21.0.0")
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")

    // Phase M4 — Solana Mobile Stack.
    // The ktx variant is a suspend-based wrapper around the core MWA client;
    // it brings kotlinx-coroutines transitively but we also declare it
    // explicitly so the IDE resolves lifecycleScope without surprises.
    implementation("com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
