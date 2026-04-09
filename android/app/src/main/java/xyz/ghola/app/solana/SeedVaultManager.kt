package xyz.ghola.app.solana

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log

/**
 * Seed Vault manager — Phase M4.
 *
 * The Solana Mobile Seed Vault is a hardware-backed key storage enclave
 * that's present on Saga / Seeker devices. When available, it stores the
 * signing key in a separate secure element that even root malware can't
 * reach, then signs transactions on behalf of the app without ever
 * exposing the private key material.
 *
 * This class is a **presence check + routing helper**. The real Seed Vault
 * SDK (`com.solanamobile:seedvault-wallet-sdk`) provides an API surface
 * like `SeedVault.authorizeSeed()` / `signMessage(authToken, path, msg)`.
 * For v1 we detect whether the Seed Vault package is installed and
 * delegate everything else to [MWAManager]'s intent flow — if the user is
 * on a Seeker device, that intent will hit the Seed Vault app naturally.
 *
 * When the user adds the SDK dependency, swap the stub methods here for
 * the real `SeedVault.isAvailable(context)` / `authorizeSeed()` calls and
 * keep the rest of the call sites unchanged.
 */
class SeedVaultManager(private val context: Context) {

    companion object {
        private const val TAG = "SeedVaultManager"
    }

    /**
     * True if the device has either the production or impl variant of the
     * Seed Vault installed. Safe to call on any Android device; returns
     * false on non-Seeker hardware.
     */
    fun isAvailable(): Boolean {
        val pm = context.packageManager
        val installed = listOf(
            SolanaConstants.SEED_VAULT_PACKAGE,
            SolanaConstants.SEED_VAULT_IMPL_PACKAGE
        ).any { pkg ->
            try {
                pm.getPackageInfo(pkg, 0)
                true
            } catch (_: PackageManager.NameNotFoundException) {
                false
            }
        }
        Log.i(TAG, "Seed Vault available: $installed")
        return installed
    }

    /**
     * Phase M4 stub: when the real Seed Vault SDK is wired in, this becomes
     * `SeedVault.authorizeSeed(context)` which prompts the user to authorize
     * a new seed and returns an auth token bound to that seed. The returned
     * public key is the agent's signing identity on Seeker.
     *
     * For v1 we return null — callers fall back to [MWAManager] for the
     * connect flow, which will hit the Seed Vault app via intent if it's
     * the active wallet on the device.
     */
    fun authorizeSeed(): Long? {
        if (!isAvailable()) return null
        Log.i(TAG, "authorizeSeed() called — stub, real SDK integration pending")
        return null
    }

    /**
     * Phase M4 stub: signs a message using the Seed Vault auth token.
     * Returns null in stub mode.
     */
    fun signMessage(authToken: Long, derivationPath: String, message: ByteArray): ByteArray? {
        Log.i(TAG, "signMessage() stub (authToken=$authToken, path=$derivationPath, len=${message.size})")
        return null
    }
}
