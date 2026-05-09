package xyz.ghola.app

import android.app.Application
import xyz.ghola.app.crypto.CryptoProviders

/**
 * Application entry point. Owns process-wide one-shot setup that needs
 * to run before any activity boots:
 *
 * - `CryptoProviders.installBouncyCastleOnce()` — required for the
 *   sealed-envelope-v1 path (X25519 + Ed25519 are not on the platform
 *   provider list at minSdk = 28).
 *
 * Anything that holds long-lived state goes elsewhere; this class is
 * deliberately a thin entrypoint.
 */
class GholaApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CryptoProviders.installBouncyCastleOnce()
    }
}
