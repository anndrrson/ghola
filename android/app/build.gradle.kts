plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // v0.5: KSP for Room compile-time codegen.
    id("com.google.devtools.ksp")
}

android {
    namespace = "xyz.ghola.app"
    compileSdk = 35
    ndkVersion = "26.1.10909125"

    defaultConfig {
        applicationId = "xyz.ghola.app"
        minSdk = 28
        targetSdk = 34
        versionCode = 13
        versionName = "0.7.5"

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
                val shieldedPoolBackend = providers.gradleProperty("gholaShieldedPoolBackend")
                    .orElse(providers.environmentVariable("GHOLA_SHIELDED_POOL_BACKEND"))
                    .orNull
                    ?.trim()
                    .orEmpty()
                val shieldedPoolArgs = if (shieldedPoolBackend.isNotEmpty()) {
                    listOf(
                        "-DGHOLA_SHIELDED_POOL_BACKEND_PREBUILT=$shieldedPoolBackend",
                        "-DGHOLA_SHIELDED_POOL_BUILD_STUB_BACKEND=OFF",
                    )
                } else {
                    listOf(
                        "-DGHOLA_SHIELDED_POOL_BACKEND_PREBUILT=",
                        "-DGHOLA_SHIELDED_POOL_BUILD_STUB_BACKEND=ON",
                    )
                }
                arguments += listOf(
                    "-DANDROID_STL=c++_shared",
                    "-DGGML_OPENMP=OFF",
                    "-DBUILD_SHARED_LIBS=OFF",
                ) + shieldedPoolArgs
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

        val turnkeyOrgId: String = providers.gradleProperty("gholaTurnkeyOrgId").orNull
            ?: providers.environmentVariable("TURNKEY_ORG_ID").orNull
            ?: ""
        val turnkeyAuthProxyConfigId: String = providers.gradleProperty("gholaTurnkeyAuthProxyConfigId").orNull
            ?: providers.environmentVariable("TURNKEY_AUTH_PROXY_CONFIG_ID").orNull
            ?: ""
        val turnkeyRpId: String = providers.gradleProperty("gholaTurnkeyRpId").orNull
            ?: providers.environmentVariable("TURNKEY_RP_ID").orNull
            ?: "ghola.xyz"
        val turnkeyAppScheme: String = providers.gradleProperty("gholaTurnkeyAppScheme").orNull
            ?: providers.environmentVariable("TURNKEY_APP_SCHEME").orNull
            ?: "ghola"
        buildConfigField("String", "TURNKEY_ORG_ID", "\"$turnkeyOrgId\"")
        buildConfigField("String", "TURNKEY_AUTH_PROXY_CONFIG_ID", "\"$turnkeyAuthProxyConfigId\"")
        buildConfigField("String", "TURNKEY_RP_ID", "\"$turnkeyRpId\"")
        buildConfigField("String", "TURNKEY_APP_SCHEME", "\"$turnkeyAppScheme\"")

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

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    // Phase M9: release signing + R8 for Solana dApp Store submission.
    // Keystore path + passwords are read from gradle.properties or env vars
    // (`GHOLA_KEYSTORE_PATH`, `GHOLA_KEYSTORE_PASSWORD`, `GHOLA_KEY_ALIAS`,
    // `GHOLA_KEY_PASSWORD`). Without those values Gradle still assembles a
    // local unsigned release APK, but it is not suitable for dApp Store upload.
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

    sourceSets {
        getByName("main") {
            assets.srcDir(layout.buildDirectory.dir("generated/shieldedPoolAssets"))
            jniLibs.srcDir(layout.buildDirectory.dir("generated/shieldedPoolJniLibs"))
        }
    }

    packaging {
        jniLibs {
            // Google Play requires 16 KB page-size compatibility for Android
            // 15/API 35 submissions. AGP 8.2 still zip-aligns uncompressed
            // native libraries at 4 KB boundaries, so package them compressed
            // until the Android toolchain is upgraded to AGP 8.5.1+ / NDK r28+.
            useLegacyPackaging = true
        }
    }

    flavorDimensions += "distribution"
    productFlavors {
        create("seeker") {
            dimension = "distribution"
            targetSdk = 34
            buildConfigField("String", "GHOLA_DISTRIBUTION", "\"seeker\"")
            buildConfigField("String", "GHOLA_AUTH_SURFACE", "\"seeker_mwa\"")
            buildConfigField("boolean", "GHOLA_SEEKER_BUILD", "true")
            buildConfigField("boolean", "GHOLA_PLAY_STORE_BUILD", "false")
            buildConfigField("boolean", "GHOLA_DEVICE_CONTROL_ENABLED", "false")
            buildConfigField("boolean", "GHOLA_VOICE_INPUT_ENABLED", "false")
            buildConfigField("boolean", "GHOLA_CAMERA_QR_ENABLED", "false")
            resValue("string", "distribution_name", "Solana Seeker")
        }
        create("standard") {
            dimension = "distribution"
            targetSdk = 35
            buildConfigField("String", "GHOLA_DISTRIBUTION", "\"standard_android_play\"")
            buildConfigField("String", "GHOLA_AUTH_SURFACE", "\"turnkey_ready\"")
            buildConfigField("boolean", "GHOLA_SEEKER_BUILD", "false")
            buildConfigField("boolean", "GHOLA_PLAY_STORE_BUILD", "true")
            buildConfigField("boolean", "GHOLA_DEVICE_CONTROL_ENABLED", "false")
            buildConfigField("boolean", "GHOLA_VOICE_INPUT_ENABLED", "true")
            buildConfigField("boolean", "GHOLA_CAMERA_QR_ENABLED", "true")
            resValue("string", "distribution_name", "Android")
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
            // v0.4.0 ships against the Render hostname directly because Render's
            // Hobby tier caps the team at 2 custom domains. v0.4.1 will flip to
            // https://api.ghola.xyz after the team upgrades and DNS lands.
            // Override at build time via -PghoLaCloudUrlRelease=https://...
            val releaseUrl = providers.gradleProperty("ghoLaCloudUrlRelease").orNull
                ?: "https://thumper-cloud.onrender.com"
            val releaseSaidUrl = providers.gradleProperty("ghoLaSaidUrlRelease").orNull
                ?: "https://ghola-api.onrender.com/v1"
            buildConfigField("String", "DEFAULT_CLOUD_URL", "\"$releaseUrl\"")
            buildConfigField("String", "DEFAULT_SAID_URL", "\"$releaseSaidUrl\"")
            // Only assign the release signing config if a keystore was found.
            // The dApp Store release checker rejects unsigned APKs explicitly.
            val hasKeystore = providers.gradleProperty("GHOLA_KEYSTORE_PATH")
                .orElse(providers.environmentVariable("GHOLA_KEYSTORE_PATH"))
                .isPresent
            if (hasKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            isMinifyEnabled = false
            // Default to the live cloud so an on-device debug build (e.g. a Seeker
            // over USB) can sign in without a dev server on the LAN. Devs running a
            // local thumper-cloud override it at build time:
            //   ./gradlew … -PghoLaCloudUrl=http://<mac-lan-ip>:3000
            val devUrl = providers.gradleProperty("ghoLaCloudUrl").orNull
                ?: "https://thumper-cloud.onrender.com"
            val devSaidUrl = providers.gradleProperty("ghoLaSaidUrl").orNull
                ?: "https://ghola-api.onrender.com/v1"
            buildConfigField("String", "DEFAULT_CLOUD_URL", "\"$devUrl\"")
            buildConfigField("String", "DEFAULT_SAID_URL", "\"$devSaidUrl\"")
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

val prepareShieldedPoolAssets by tasks.registering(Copy::class) {
    val circuitsDir = file("../../crates/said-shielded-pool-circuits")
    into(layout.buildDirectory.dir("generated/shieldedPoolAssets/shielded_pool"))
    from(circuitsDir.resolve("artifacts/transaction_js/transaction.wasm")) {
        rename { "transaction.wasm" }
    }
    from(circuitsDir.resolve("artifacts/transaction.r1cs")) {
        rename { "transaction.r1cs" }
    }
    from(circuitsDir.resolve("ceremony/transaction_final.zkey")) {
        rename { "transaction_final.zkey" }
    }
}

val prepareShieldedPoolBackend by tasks.registering(Sync::class) {
    val shieldedPoolBackend = providers.gradleProperty("gholaShieldedPoolBackend")
        .orElse(providers.environmentVariable("GHOLA_SHIELDED_POOL_BACKEND"))
        .orNull
        ?.trim()
        .orEmpty()
    into(layout.buildDirectory.dir("generated/shieldedPoolJniLibs/arm64-v8a"))
    if (shieldedPoolBackend.isNotEmpty()) {
        from(shieldedPoolBackend) {
            rename { "libghola_shielded_pool_backend.so" }
        }
    }
}

tasks.named("preBuild").configure {
    dependsOn(prepareShieldedPoolAssets)
    dependsOn(prepareShieldedPoolBackend)
}

configurations.configureEach {
    resolutionStrategy {
        force("androidx.browser:browser:1.8.0")
        force("androidx.lifecycle:lifecycle-common:2.7.0")
        force("androidx.lifecycle:lifecycle-process:2.7.0")
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
    implementation("com.patrykandpatrick.vico:views:2.0.3")
    // Google Sign-In
    implementation("com.google.android.gms:play-services-auth:21.0.0")
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    add("standardImplementation", "com.turnkey:sdk-kotlin:1.0.2")
    add("standardImplementation", "com.turnkey:types:1.0.2")
    add("standardImplementation", "com.turnkey:http:1.0.2")
    add("standardImplementation", "com.turnkey:crypto:1.0.0")
    add("standardImplementation", "com.turnkey:encoding:1.0.0")
    add("standardImplementation", "com.turnkey:passkey:1.0.2")
    add("standardImplementation", "com.turnkey:stamper:1.0.2")

    // Phase M4 — Solana Mobile Stack.
    // The ktx variant is a suspend-based wrapper around the core MWA client;
    // it brings kotlinx-coroutines transitively but we also declare it
    // explicitly so the IDE resolves lifecycleScope without surprises.
    implementation("com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.3") {
        // The 2.0.3 POM leaks test fixtures into runtime
        // (androidx.test + Mockito). Exclude them so store builds do not ship
        // test-only manifest components or mocking libraries.
        exclude(group = "androidx.test")
        exclude(group = "androidx.test.ext")
        exclude(group = "androidx.test.services")
        exclude(group = "org.mockito")
        exclude(group = "org.mockito.kotlin")
        exclude(group = "net.bytebuddy")
        exclude(group = "org.objenesis")
        exclude(group = "junit")
        exclude(group = "org.hamcrest")
    }
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
    implementation("org.bouncycastle:bcprov-jdk15to18:1.82")

    // Unit tests for crypto / vault / pair-device.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
    testImplementation("org.bouncycastle:bcprov-jdk15to18:1.82")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    androidTestImplementation("androidx.test:core:1.5.0")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:runner:1.5.2")
}
