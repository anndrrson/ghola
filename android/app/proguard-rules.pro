# Phase M9: ProGuard/R8 rules for Ghola release builds.
#
# The rules below protect reflection-heavy or JNI-resolved code paths that R8
# would otherwise strip. Keep this file minimal — every `-keep` is a missed
# shrink opportunity. If a new crash surfaces in release, add a rule, then
# document WHY here.

# ---------- JNI / llama.cpp native bridge ----------
# LlamaCpp.kt declares external fun methods; R8 can rename them, breaking
# JNI symbol lookup. Keep the class and all its native methods intact.
-keep class xyz.ghola.app.ai.llama.LlamaCpp { *; }
-keep class xyz.ghola.app.ai.llama.** { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}

# ---------- Kotlin reflection + coroutines ----------
-keep class kotlin.Metadata { *; }
-keepattributes *Annotation*,InnerClasses,EnclosingMethod,Signature,Exceptions
-keep class kotlinx.coroutines.** { *; }

# ---------- OkHttp ----------
# OkHttp references Conscrypt + BouncyCastle providers by reflection when
# available. These may or may not be on the classpath; keep what's there.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# ---------- Google Sign-In / Credentials ----------
-keep class com.google.android.gms.** { *; }
-keep class com.google.android.libraries.identity.googleid.** { *; }
-dontwarn com.google.android.gms.**

# ---------- Solana Mobile Stack (added in Phase M4) ----------
-keep class com.solanamobile.** { *; }
-dontwarn com.solanamobile.**

# ---------- org.json (used by cloud clients) ----------
-keep class org.json.** { *; }

# ---------- Android Accessibility Service ----------
# The accessibility service is referenced by XML config + manifest; R8 can
# strip it if it thinks the class is unused.
-keep class xyz.ghola.app.service.ThumperAccessibilityService { *; }
-keep class xyz.ghola.app.service.NotificationListener { *; }
-keep class xyz.ghola.app.service.ProactiveService { *; }

# ---------- Activity entry points (referenced by AndroidManifest) ----------
-keep class xyz.ghola.app.ui.HomeActivity { *; }
-keep class xyz.ghola.app.ui.ChatActivity { *; }
-keep class xyz.ghola.app.ui.MainActivity { *; }
-keep class xyz.ghola.app.ui.SettingsActivity { *; }
-keep class xyz.ghola.app.ui.OnboardingActivity { *; }
-keep class xyz.ghola.app.ui.TaskDetailActivity { *; }
-keep class xyz.ghola.app.ui.AgentsActivity { *; }
-keep class xyz.ghola.app.ui.AgentDetailActivity { *; }
-keep class xyz.ghola.app.ui.CreateAgentActivity { *; }
-keep class xyz.ghola.app.ui.WalletActivity { *; }
-keep class xyz.ghola.app.ui.ActivityFeedActivity { *; }

# ---------- Cloud client DTOs (serialized by JSON) ----------
-keep class xyz.ghola.app.cloud.** { *; }

# ---------- BouncyCastle (sealed-envelope-v1 E2E) ----------
# We register BC at app start (CryptoProviders.installBouncyCastleOnce)
# and resolve algorithms by name ("X25519", "Ed25519"). R8 must not strip
# the provider, the algorithm parameter classes, or the lightweight API.
-keep class org.bouncycastle.** { *; }
-dontwarn javax.naming.**

# ---------- Sealed-envelope crypto package ----------
# Field-by-field byte-level wire format; reflection-based access from tests
# and parity vectors. Keep verbatim.
-keep class xyz.ghola.app.crypto.** { *; }

# ---------- v0.5 transitive deps (R8 missing-class fixes) ----------
# AutoValue + javapoet ship with build-time-only references to
# javax.lang.model. ONNX Runtime + MediaPipe pull these in transitively.
# They're not on the Android runtime classpath; safe to ignore.
-dontwarn javax.lang.model.**
-dontwarn javax.tools.**
-dontwarn com.google.auto.value.**
-dontwarn autovalue.shaded.com.squareup.javapoet$.**

# ---------- ONNX Runtime ----------
-keep class ai.onnxruntime.** { *; }
-dontwarn ai.onnxruntime.**

# ---------- MediaPipe tasks-genai ----------
-keep class com.google.mediapipe.** { *; }
-dontwarn com.google.mediapipe.**

# ---------- Room (compile-time DAOs) ----------
-keep class androidx.room.** { *; }
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class * { *; }
-keep @androidx.room.Dao class * { *; }
-keep class xyz.ghola.app.gmail.SentEmail { *; }
-keep class xyz.ghola.app.gmail.StringListConverter { *; }
-keep interface xyz.ghola.app.gmail.SentEmailDao { *; }
-keep class xyz.ghola.app.gmail.GholaMailDatabase { *; }
-keep class xyz.ghola.app.gmail.GholaMailDatabase_Impl { *; }
-keep class xyz.ghola.app.gmail.SentEmailDao_Impl { *; }

# ---------- AppAuth ----------
-keep class net.openid.appauth.** { *; }
-dontwarn net.openid.appauth.**
