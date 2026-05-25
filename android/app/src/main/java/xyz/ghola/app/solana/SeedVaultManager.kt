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
 * Lightweight availability helper. Real authorization and signing live in
 * [SeedVaultNative], which owns the required Activity Result launcher.
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
        val installed = SeedVaultNative.isAvailable(context)
        Log.i(TAG, "Seed Vault available: $installed")
        return installed
    }
}
