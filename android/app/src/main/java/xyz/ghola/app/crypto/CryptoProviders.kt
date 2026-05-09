package xyz.ghola.app.crypto

import android.util.Log
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Security
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Single-shot installation of BouncyCastle. Required because minSdk = 28
 * predates platform support for X25519 (API 33) and Ed25519 (API 33).
 *
 * BC is inserted at the highest priority so name-based lookups pick it
 * first; the platform's AES/SHA/HMAC implementations stay in place because
 * those algorithms are already available without BC.
 *
 * Call this from `Application.onCreate` and at the top of every test entry
 * point. Idempotent — repeated calls are no-ops.
 */
object CryptoProviders {

    private const val TAG = "CryptoProviders"
    private val installed = AtomicBoolean(false)

    fun installBouncyCastleOnce() {
        if (!installed.compareAndSet(false, true)) return
        // If a stale BC entry is on the provider list (older Android shipped
        // a slimmed-down BC under "BC" alias), drop it and reinstall the
        // version we depend on. Otherwise insert at position 1.
        if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) != null) {
            Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
        }
        Security.insertProviderAt(BouncyCastleProvider(), 1)
        Log.i(TAG, "BouncyCastle provider installed")
    }
}
