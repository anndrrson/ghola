package xyz.ghola.app

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import xyz.ghola.app.cloud.AppForegroundCoordinator
import xyz.ghola.app.cloud.TurnkeyAuthBridge
import xyz.ghola.app.crypto.CryptoProviders

/**
 * Application entry point. Owns process-wide one-shot setup that needs
 * to run before any activity boots:
 *
 * - `CryptoProviders.installBouncyCastleOnce()` — required for the
 *   sealed-envelope-v1 path (X25519 + Ed25519 are not on the platform
 *   provider list at minSdk = 28).
 * - [ProcessLifecycleOwner] observer — fires [onStart] once per app
 *   foreground transition. We use this to opportunistically refresh the
 *   cloud JWT (via [AppForegroundCoordinator]) so users don't see wallet
 *   prompts on every backgrounded/resumed session.
 *
 * Anything that holds long-lived state goes elsewhere; this class is
 * deliberately a thin entrypoint.
 */
class GholaApplication : Application(), DefaultLifecycleObserver {

    override fun onCreate() {
        // Disambiguation: both Application and DefaultLifecycleObserver expose
        // an `onCreate` symbol — the Application form takes no args, the
        // observer form takes a LifecycleOwner. We are overriding the
        // Application one and must call super<Application>.onCreate() explicitly.
        super<Application>.onCreate()
        CryptoProviders.installBouncyCastleOnce()
        TurnkeyAuthBridge.initialize(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
    }

    /**
     * Fired by [ProcessLifecycleOwner] exactly once per cold-start AND once
     * per background→foreground transition. NOT fired on every Activity
     * resume — that's the per-activity onResume callback, which we
     * deliberately don't hook here (to avoid the "wallet prompt cascade"
     * bug).
     */
    override fun onStart(owner: LifecycleOwner) {
        AppForegroundCoordinator.onAppForegrounded(this)
    }
}
