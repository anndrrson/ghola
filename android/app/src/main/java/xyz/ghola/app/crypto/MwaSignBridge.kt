package xyz.ghola.app.crypto

import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import xyz.ghola.app.solana.MWAConnect

/**
 * Bridges the MWA signMessage popup (suspending) to the synchronous
 * [VaultStore.SignMessage] callback that vault.unlock expects.
 *
 * Usage from a `ComponentActivity`:
 *
 * ```kotlin
 * private val sender = ActivityResultSender(this)
 *
 * lifecycleScope.launch {
 *     val signer = mwaSignerForVault(sender, walletAddressBase58)
 *     // unlock blocks the calling thread on each sign() call; run it
 *     // off-main so the wallet's intent loop can drive the popup.
 *     withContext(Dispatchers.IO) { vault.unlock(signer) }
 * }
 * ```
 *
 * The signer routes every challenge through MWA. With the standard
 * `vault.unlock(verifyDeterminism = false)` path that's exactly one
 * popup per unlock; with `verifyDeterminism = true` (tests / explicit
 * audits) it's two.
 */
suspend fun mwaSignerForVault(
    sender: ActivityResultSender,
    walletAddressBase58: String,
): VaultStore.SignMessage {
    // Capture the dispatch context so each callback hops back into a
    // coroutine to invoke the suspend MWA fn. We can't make
    // VaultStore.SignMessage itself suspend (it's a Java-friendly SAM
    // interface), so we use kotlinx.coroutines.runBlocking-equivalent:
    // the callbacks land on a worker thread (vault.unlock() is called
    // from withContext(Dispatchers.IO)), so blocking is safe.
    return VaultStore.SignMessage { challenge ->
        // Each sign() call dispatches to the IO pool to run the suspend
        // function; the wallet popup is rendered on the activity's UI
        // thread by the MWA SDK regardless of where we await it.
        val outcome = kotlinx.coroutines.runBlocking(Dispatchers.IO) {
            MWAConnect.signMessageDetached(sender, walletAddressBase58, challenge)
        }
        when (outcome) {
            is MWAConnect.SignOutcome.Success -> VaultStore.SignResult.Success(outcome.signature)
            MWAConnect.SignOutcome.NoWallet -> VaultStore.SignResult.NoWallet
            MWAConnect.SignOutcome.Declined -> VaultStore.SignResult.Declined
            MWAConnect.SignOutcome.Cancelled -> VaultStore.SignResult.Cancelled
            is MWAConnect.SignOutcome.Failure -> throw outcome.cause
        }
    }
}

/** Trivially-callable helper that wraps an MWA round-trip in IO. */
suspend fun signWithWallet(
    sender: ActivityResultSender,
    walletAddressBase58: String,
    message: ByteArray,
): MWAConnect.SignOutcome = withContext(Dispatchers.IO) {
    MWAConnect.signMessageDetached(sender, walletAddressBase58, message)
}
