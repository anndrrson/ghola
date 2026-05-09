@file:Suppress("DEPRECATION")

package xyz.ghola.app.solana

import android.net.Uri
import android.util.Log
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.RpcCluster
import com.solana.mobilewalletadapter.clientlib.TransactionResult

/**
 * # MWAConnect
 *
 * Real Mobile Wallet Adapter integration. Takes an [ActivityResultSender]
 * constructed from a `ComponentActivity` and walks the user through the
 * MWA authorize flow — launches the installed wallet (Seed Vault on
 * Seeker, Phantom/Solflare elsewhere), gets user approval, receives back
 * a signed `AuthorizationResult` containing one or more authorized
 * accounts, and returns the first account's public key as a base58
 * Solana address.
 *
 * This is the replacement for [MWAManager], which is a stub that only
 * launches wallet apps via intent without doing any MWA protocol exchange.
 * MWAConnect speaks real MWA over the association intent + websocket,
 * and the returned pubkey is a genuine Seed-Vault-controlled address on
 * Seeker devices.
 *
 * ## Usage
 *
 * In a `ComponentActivity` (WalletActivity):
 *
 * ```kotlin
 * private val sender = ActivityResultSender(this)  // field-level init
 *
 * button.setOnClickListener {
 *     lifecycleScope.launch {
 *         MWAConnect.authorize(sender).fold(
 *             onSuccess = { pubkey -> pubkeyView.text = pubkey },
 *             onFailure = { e -> Toast.make(...) }
 *         )
 *     }
 * }
 * ```
 *
 * ## Threading
 *
 * [authorize] is a suspend function and MUST be called from a coroutine
 * scope. The MWA SDK's internal websocket and intent dispatch run on a
 * background dispatcher; the returned [Result] resolves on whichever
 * dispatcher the caller used. Use `lifecycleScope.launch { ... }` from
 * an Activity to avoid leaks.
 *
 * ## What this does NOT do
 *
 * - Does not cache the auth token. Every call re-authorizes. If you
 *   want a "reauthorize with cached token" flow, set
 *   `adapter.authToken = previousToken` before calling `transact`.
 * - Does not sign transactions. The block returns the pubkey bytes and
 *   exits; no `signAndSendTransactions` is invoked. Adding signing is a
 *   one-line change inside the transact block.
 * - Does not deauthorize on logout. Call `adapter.disconnect(sender)`
 *   from a separate flow if needed.
 */
object MWAConnect {
    private const val TAG = "MWAConnect"

    /**
     * Launch the MWA authorize flow and return the connected wallet's
     * Solana address (base58-encoded) on success.
     */
    suspend fun authorize(sender: ActivityResultSender): Result<String> {
        val adapter = MobileWalletAdapter(
            connectionIdentity = ConnectionIdentity(
                identityUri = Uri.parse("https://ghola.xyz"),
                iconUri = Uri.parse("favicon.ico"),
                identityName = "Ghola",
            ),
        )
        // Devnet is the safe default for dev/demo. Mainnet-beta would work
        // for production signing flows; we're not signing anything here so
        // the cluster is largely cosmetic — some wallets use it to colour
        // their UI ("Devnet mode"), nothing else.
        adapter.rpcCluster = RpcCluster.Devnet

        // transact() opens a session with the installed wallet, runs the
        // block with the AuthorizationResult, then closes the session.
        // The block's return value becomes the `payload` on
        // TransactionResult.Success<T>. We return the first account's
        // public key bytes so the caller can display them as base58.
        val result = try {
            adapter.transact(sender) { authResult ->
                val accounts = authResult.accounts
                if (accounts.isNotEmpty()) {
                    accounts[0].publicKey
                } else {
                    // Legacy fallback: pre-multi-account wallets populate
                    // the top-level publicKey field instead of accounts[].
                    @Suppress("DEPRECATION")
                    authResult.publicKey
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "MWA transact threw", e)
            return Result.failure(e)
        }

        return when (result) {
            is TransactionResult.Success -> {
                val bytes = result.payload
                if (bytes.isEmpty()) {
                    Log.w(TAG, "MWA success but no pubkey bytes")
                    Result.failure(IllegalStateException("wallet returned no public key"))
                } else {
                    val address = Base58.encode(bytes)
                    Log.i(TAG, "MWA authorized — address=$address")
                    Result.success(address)
                }
            }
            is TransactionResult.NoWalletFound -> {
                Log.w(TAG, "MWA NoWalletFound: ${result.message}")
                Result.failure(NoWalletInstalledException(result.message))
            }
            is TransactionResult.Failure -> {
                Log.w(TAG, "MWA failure: ${result.message}", result.e)
                Result.failure(result.e)
            }
        }
    }

    /** Thrown when no MWA-capable wallet is installed on the device. */
    class NoWalletInstalledException(message: String?) :
        Exception(message ?: "No MWA-capable wallet installed")

    /** Outcome of [signMessageDetached] — mirrors VaultStore.SignResult. */
    sealed class SignOutcome {
        data class Success(val signature: ByteArray) : SignOutcome()
        object NoWallet : SignOutcome()
        object Declined : SignOutcome()
        object Cancelled : SignOutcome()
        data class Failure(val cause: Throwable) : SignOutcome()
    }

    /**
     * Sign an arbitrary byte message using the connected wallet's
     * Ed25519 identity key (`signMessages`). Used by [VaultStore.unlock]
     * to derive the wallet-bound vault material and by Pair Device to
     * authenticate handshake envelopes.
     *
     * The wallet must already be authorized; pass the same Solana
     * address (base58 pubkey) that [authorize] returned. Most wallets
     * silently re-authorize within a session, but some (Phantom) prompt
     * if the auth token has expired.
     *
     * The returned signature is 64 bytes (Ed25519 detached). All major
     * Solana wallets implement Ed25519 per RFC 8032 §5.1.6, which is
     * deterministic for a given (secret, message); we depend on that to
     * derive vault keys.
     */
    suspend fun signMessageDetached(
        sender: ActivityResultSender,
        walletAddressBase58: String,
        message: ByteArray,
    ): SignOutcome {
        val adapter = MobileWalletAdapter(
            connectionIdentity = ConnectionIdentity(
                identityUri = Uri.parse("https://ghola.xyz"),
                iconUri = Uri.parse("favicon.ico"),
                identityName = "Ghola",
            ),
        )
        adapter.rpcCluster = RpcCluster.Devnet

        val addressBytes = try {
            Base58.decode(walletAddressBase58)
        } catch (e: Exception) {
            return SignOutcome.Failure(e)
        }

        val result = try {
            adapter.transact(sender) {
                // signMessagesDetached takes (messages, addresses) and
                // returns SignedMessageResult[] with `signatures: byte[][]`.
                val signed = signMessagesDetached(
                    arrayOf(message),
                    arrayOf(addressBytes),
                )
                val first = signed.messages.firstOrNull()
                    ?: error("wallet returned no signed messages")
                val sig = first.signatures.firstOrNull()
                    ?: error("wallet returned no signatures")
                if (sig.size != 64) {
                    error("wallet returned ${sig.size}-byte signature, expected 64")
                }
                sig
            }
        } catch (e: Exception) {
            Log.e(TAG, "MWA signMessages threw", e)
            return SignOutcome.Failure(e)
        }

        return when (result) {
            is TransactionResult.Success -> SignOutcome.Success(result.payload)
            is TransactionResult.NoWalletFound -> SignOutcome.NoWallet
            is TransactionResult.Failure -> {
                val msg = result.message?.lowercase().orEmpty()
                when {
                    msg.contains("declin") || msg.contains("reject") ->
                        SignOutcome.Declined
                    msg.contains("cancel") -> SignOutcome.Cancelled
                    else -> SignOutcome.Failure(result.e)
                }
            }
        }
    }
}
