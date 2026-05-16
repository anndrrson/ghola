plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // v0.5: KSP for Room compile-time codegen.
    id("com.google.devtools.ksp")
}

android {
    namespace = "xyz.ghola.app"
    compileSdk = 34
    ndkVersion = "26.1.10909125"

    defaultConfig {
        applicationId = "xyz.ghola.app"
        minSdk = 28
        targetSdk = 34
        versionCode = 4
        versionName = "0.4.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        ndk {
            abiFilters += "arm64-v8a"
        }

        // v0.6: CMake flags propagated to FetchContent-built llama.cpp.
        // GGML_OPENMP=OFF — Android NDK r26 ships no OpenMP runtime.
        // ANDROID_STL=c++_shared — match the rest of the app's shared STL
        // so we don't ship two copies of libc++.
        externalNativeBuild {
            cmake {
                arguments += listOf(
                    "-DANDROID_STL=c++_shared",
                    "-DGGML_OPENMP=OFF",
                    "-DBUILD_SHARED_LIBS=OFF",
                )
                cppFlags += listOf("-std=c++17", "-O3", "-fexceptions", "-frtti")
            }
        }

        // v0.5: Gmail OAuth client id for the AppAuth on-device flow.
        // Mobile OAuth uses the public-client PKCE flow — the client id is
        // not a secret (it's the PKCE code_verifier that protects the
        // exchange) — so it's safe to bake into the APK. Override per build
        // via `-PghoLaGmailClientId=…` (release) or via gradle.properties.
        val gmailClientId: String = providers.gradleProperty("ghoLaGmailClientId").orNull
            ?: "PLACEHOLDER-google-oauth-client-id.apps.googleusercontent.com"
        buildConfigField("String", "GOOGLE_OAUTH_CLIENT_ID", "\"$gmailClientId\"")

        // Build-time stamp: short SHA + timestamp so the dev gauntlet can
        // verify which build is on device without grepping logcat.
        val gitSha: String = try {
            val proc = Runtime.getRuntime().exec(arrayOf("git", "rev-parse", "--short", "HEAD"))
            proc.inputStream.bufferedReader().readLine()?.trim() ?: "unknown"
        } catch (_: Exception) { "unknown" }
        val buildStamp: String = System.currentTimeMillis().toString()
        buildConfigField("String", "GIT_SHA", "\"$gitSha\"")
        buildConfigField("String", "BUILD_STAMP", "\"$buildStamp\"")

        // AppAuth requires the manifestPlaceholder so its bundled redirect
        // RedirectUriReceiverActivity intent-filter resolves the right scheme.
        // We use a private custom scheme (xyz.ghola.app.oauth) so no other
        // app can intercept the callback.
        manifestPlaceholders["appAuthRedirectScheme"] = "xyz.ghola.app.oauth"
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
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

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // v0.4.0 ships against the Render hostname directly because Render's
            // Hobby tier caps the team at 2 custom domains. v0.4.1 will flip to
            // https://api.ghola.xyz after the team upgrades and DNS lands.
            // Override at build time via -PghoLaCloudUrlRelease=https://...
            val releaseUrl = providers.gradleProperty("ghoLaCloudUrlRelease").orNull
                ?: "https://thumper-cloud.onrender.com"
            buildConfigField("String", "DEFAULT_CLOUD_URL", "\"$releaseUrl\"")
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
            // Override per dev: point at the developer's local thumper-cloud.
            // Use the Mac's LAN IP so a Seeker on the same Wi-Fi can reach it.
            // Override at build time:  ./gradlew … -PghoLaCloudUrl=http://10.0.0.5:3000
            val devUrl = providers.gradleProperty("ghoLaCloudUrl").orNull
                ?: "http://192.168.1.169:3000"
            buildConfigField("String", "DEFAULT_CLOUD_URL", "\"$devUrl\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
        // v0.7 (Phase γ.1): LiteRT-LM 0.11.0 is compiled with Kotlin
        // 2.3 and pulls in `kotlin-reflect:2.2.21` transitively. Our
        // project is on Kotlin 1.9.22 (per android/build.gradle.kts).
        // The Kotlin 1.9 compiler errors-out reading 2.x metadata
        // ("expected version is 1.9.0") rather than warning. The
        // `-Xskip-metadata-version-check` flag downgrades that to a
        // warning — safe here because LiteRT-LM's public Kotlin
        // surface is intentionally backwards-compatible (data
        // classes + interfaces, no Kotlin 2 reflection/contracts).
        // Remove once the project moves to Kotlin 2.x.
        freeCompilerArgs = freeCompilerArgs + listOf(
            "-Xskip-metadata-version-check",
        )
    }

    // Native llama.cpp build is disabled because the llama.cpp source subtree
    // v0.6: llama.cpp is fetched via CMake FetchContent at the tag pinned
    // in src/main/cpp/CMakeLists.txt. No git submodule (that's what broke
    // Render builds — see commit ea53f9d). Render's Docker context excludes
    // android/ via .dockerignore, so the cloud images never hit this path.
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
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
    // ProcessLifecycleOwner — fires onStart exactly once per
    // background→foreground transition. Used by AppForegroundCoordinator.
    implementation("androidx.lifecycle:lifecycle-process:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // v0.5: on-device Gmail OAuth. AppAuth handles the OAuth dance via a
    // Chrome Custom Tab, returns access + refresh tokens to the app. No
    // Google Sign-In SDK dependency, no server roundtrip.
    implementation("net.openid:appauth:0.11.1")

    // v0.5: WorkManager for background Gmail mirror + pre-drafting.
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // v0.5: Local SQLite for the sent-folder mirror. Room over a hand-rolled
    // DAO so the schema is type-checked and migrations are first-class.
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // v0.5: ONNX Runtime — MiniLM-L6-v2 INT8 embeddings on-device (~25MB).
    // Powers the voice-transfer retrieval index.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.17.1")

    // v0.5: MediaPipe LLM Inference — Phi-3 Mini / Gemma 2 .task models
    // executed on-device. Output streams via callback.
    implementation("com.google.mediapipe:tasks-genai:0.10.14")

    // v0.7 (Phase γ.1): LiteRT-LM — Google's on-device LLM runtime that
    // supersedes the now-deprecated MediaPipe LlmInference. Ships an
    // `Engine` API in `com.google.ai.edge.litertlm` with selectable
    // `Backend.CPU()` / `Backend.GPU()` / `Backend.NPU(nativeLibraryDir)`.
    // On the Solana Seeker (MediaTek Dimensity 7300 / MT6878) the NPU
    // backend dispatches to APU 655 via NeuroPilot Accelerator — the
    // 7-12× lower-power steady-state path per Google's published
    // Dimensity numbers. Gemma3-1B-IT ships as a single `.litertlm`
    // artifact on HuggingFace litert-community.
    //
    // v0.11.0 (released 2026-05-07) is the latest stable; we pin
    // explicitly rather than `latest.release` so a transient Maven
    // republish can't change the build's binary surface mid-cycle.
    //
    // Verified against:
    //   https://github.com/google-ai-edge/LiteRT-LM/blob/main/docs/api/kotlin/getting_started.md
    //   https://ai.google.dev/edge/litert-lm/android
    //   https://github.com/google-ai-edge/LiteRT-LM/releases/tag/v0.11.0
    implementation("com.google.ai.edge.litertlm:litertlm-android:0.11.0")

    // Sealed-envelope-v1 E2E (Phase 0.3 / dApp Store v0.3.0).
    // BouncyCastle is required because minSdk = 28 and platform support for
    // Ed25519 / X25519 only lands at API 33. AES-GCM still uses the platform
    // Cipher. See android/app/src/main/java/xyz/ghola/app/crypto/ for the
    // wire-format port of crates/said-envelope.
    implementation("org.bouncycastle:bcprov-jdk18on:1.77")

    // Unit tests for crypto / vault / pair-device.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
    testImplementation("org.bouncycastle:bcprov-jdk18on:1.77")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
