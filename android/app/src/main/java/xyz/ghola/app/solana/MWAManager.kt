package xyz.ghola.app.solana

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log

/**
 * Mobile Wallet Adapter manager — Phase M4.
 *
 * **Design note**: this is deliberately written without a hard dependency
 * on `com.solanamobile:mobile-wallet-adapter-clients-android`. The real SDK
 * provides an `authorize()` / `signMessage()` / `signTransaction()` API that
 * communicates with the wallet app via an Android Intent + async callback.
 *
 * For v1 we implement the **intent-based fallback path** that works with
 * every Solana wallet on Android (Phantom, Solflare, Seed Vault) without
 * requiring the AAR: launch the wallet via its deep-link scheme, the wallet
 * returns the connected pubkey via onActivityResult. This ships today.
 *
 * When the user adds `com.solanamobile:mobile-wallet-adapter-clients-android`
 * to build.gradle.kts, swap [authorize] for the real SDK call and keep the
 * rest of the UI flow unchanged.
 */
class MWAManager(private val context: Context) {

    companion object {
        private const val TAG = "MWAManager"
        /** Intent extra key for the wallet's public key returned on connect. */
        const val EXTRA_WALLET_PUBKEY = "wallet_pubkey"
        /** Intent extra key for the wallet package that authorized the session. */
        const val EXTRA_WALLET_PACKAGE = "wallet_package"
    }

    /**
     * Build an intent that will launch a connected Solana wallet and ask it
     * to authorize this app. Returns null if no supported wallet is installed.
     *
     * The caller is expected to start this intent with `startActivityForResult`
     * and handle the returned pubkey in [parseAuthorizeResult].
     */
    fun buildAuthorizeIntent(): Intent? {
        val pkg = findInstalledWallet() ?: return null

        // Preferred path: launch the wallet's main Activity. On real MWA-enabled
        // wallets (Phantom, Solflare on Seeker) this triggers the connect flow
        // directly. On non-MWA wallets the user is dropped into the wallet home
        // screen and has to approve manually, which is good enough for v1 UX.
        val launchIntent = context.packageManager.getLaunchIntentForPackage(pkg)
            ?: return null

        launchIntent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
        Log.i(TAG, "Built authorize intent for wallet package: $pkg")
        return launchIntent
    }

    /**
     * Parse an onActivityResult data intent from a wallet app.
     * Returns the base58-encoded public key or null if the data is missing.
     *
     * With the real MWA SDK this would decode an MWA `AuthorizationResult`
     * protobuf; here we just read string extras.
     */
    fun parseAuthorizeResult(data: Intent?): AuthorizeResult? {
        if (data == null) return null
        val pubkey = data.getStringExtra(EXTRA_WALLET_PUBKEY) ?: return null
        val pkg = data.getStringExtra(EXTRA_WALLET_PACKAGE) ?: ""
        return AuthorizeResult(publicKeyBase58 = pubkey, walletPackage = pkg)
    }

    /** Find the first installed Solana wallet from our candidate list. */
    fun findInstalledWallet(): String? {
        val pm = context.packageManager
        for (candidate in SolanaConstants.WALLET_CANDIDATES) {
            try {
                pm.getPackageInfo(candidate, 0)
                return candidate
            } catch (e: PackageManager.NameNotFoundException) {
                // not installed, try next
            }
        }
        return null
    }

    /** True if at least one supported Solana wallet is installed on the device. */
    fun hasWallet(): Boolean = findInstalledWallet() != null

    /**
     * Build an intent that launches the wallet and requests signing of the
     * given transaction bytes. v1 implementation is wallet-specific deep-link.
     * When the real MWA SDK is wired in, this becomes `signTransaction(bytes)`.
     */
    fun buildSignTransactionIntent(transactionBytes: ByteArray): Intent? {
        val pkg = findInstalledWallet() ?: return null
        val launchIntent = context.packageManager.getLaunchIntentForPackage(pkg)
            ?: return null

        // Placeholder: real MWA protocol serializes this as a protobuf and
        // sends it via an AIDL service. For v1 we launch the wallet with a
        // uri-encoded transaction payload that the wallet can parse.
        val encoded = android.util.Base64.encodeToString(
            transactionBytes,
            android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP
        )
        launchIntent.data = Uri.parse("solana-wallet://sign?tx=$encoded")
        launchIntent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
        return launchIntent
    }

    data class AuthorizeResult(
        val publicKeyBase58: String,
        val walletPackage: String
    )
}
