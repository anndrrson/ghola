@file:Suppress("DEPRECATION")

package xyz.ghola.app.solana

import android.net.Uri
import android.util.Log
import xyz.ghola.app.BuildConfig
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.DefaultTransactionParams
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
 * This wrapper keeps Ghola on the native Solana Mobile path: Seeker
 * Wallet / MWA controls authorization, signing, and public transaction
 * submission. Ghola stores only the MWA auth token and public account
 * metadata in encrypted preferences; it never provisions hosted custody
 * for the Android/Seeker path.
 */
object MWAConnect {
    private const val TAG = "MWAConnect"
    private const val IDENTITY_URI = "https://ghola.xyz"
    private const val ICON_URI = "/favicon.ico"

    data class WalletSession(
        val address: String,
        val authToken: String?,
        val walletUriBase: String?,
        val accountLabel: String?,
        val cluster: String,
    )

    sealed class TransactionSendOutcome {
        data class Success(val signatures: List<String>) : TransactionSendOutcome()
        object NoWallet : TransactionSendOutcome()
        object Declined : TransactionSendOutcome()
        object Cancelled : TransactionSendOutcome()
        data class Failure(val cause: Throwable) : TransactionSendOutcome()
    }

    private fun cluster(): RpcCluster =
        if (BuildConfig.DEBUG) RpcCluster.Devnet else RpcCluster.MainnetBeta

    fun clusterName(): String =
        if (BuildConfig.DEBUG) SolanaConstants.DEFAULT_CLUSTER_DEVNET else SolanaConstants.DEFAULT_CLUSTER_MAINNET

    private fun adapter(previousAuthToken: String? = null): MobileWalletAdapter =
        MobileWalletAdapter(
            connectionIdentity = ConnectionIdentity(
                identityUri = Uri.parse(IDENTITY_URI),
                iconUri = Uri.parse(ICON_URI),
                identityName = "Ghola",
            ),
        ).apply {
            rpcCluster = cluster()
            if (!previousAuthToken.isNullOrBlank()) {
                authToken = previousAuthToken
            }
        }

    /**
     * Launch the MWA authorize flow and return the connected wallet's
     * Solana address (base58-encoded) on success.
     */
    suspend fun authorize(sender: ActivityResultSender): Result<String> =
        authorizeSession(sender).map { it.address }

    /**
     * Launch or refresh MWA authorization and return the public account plus
     * auth-token metadata callers should persist in encrypted storage.
     */
    suspend fun authorizeSession(
        sender: ActivityResultSender,
        previousAuthToken: String? = null,
    ): Result<WalletSession> {
        val adapter = adapter(previousAuthToken)
        val result = try {
            adapter.transact(sender) { authResult ->
                val accounts = authResult.accounts
                val publicKey = if (accounts.isNotEmpty()) {
                    accounts[0].publicKey
                } else {
                    // Legacy fallback: pre-multi-account wallets populate
                    // the top-level publicKey field instead of accounts[].
                    @Suppress("DEPRECATION")
                    authResult.publicKey
                }
                val accountLabel = accounts.firstOrNull()?.accountLabel ?: authResult.accountLabel
                WalletSession(
                    address = Base58.encode(publicKey),
                    authToken = authResult.authToken,
                    walletUriBase = authResult.walletUriBase?.toString(),
                    accountLabel = accountLabel,
                    cluster = clusterName(),
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "MWA transact threw", e)
            return Result.failure(e)
        }

        return when (result) {
            is TransactionResult.Success -> {
                val session = result.payload
                if (session.address.isBlank()) {
                    Log.w(TAG, "MWA success but no pubkey bytes")
                    Result.failure(IllegalStateException("wallet returned no public key"))
                } else {
                    Log.i(TAG, "MWA authorized address=${session.address} cluster=${session.cluster}")
                    Result.success(session)
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
        authToken: String? = null,
    ): SignOutcome {
        val adapter = adapter(authToken)

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
                val msg = result.message.lowercase()
                when {
                    msg.contains("declin") || msg.contains("reject") ->
                        SignOutcome.Declined
                    msg.contains("cancel") -> SignOutcome.Cancelled
                    else -> SignOutcome.Failure(result.e)
                }
            }
        }
    }

    /**
     * Submit already-serialized Solana transactions through the connected
     * wallet. This is the public-rail path Ghola should use for SOL/USDC/x402
     * approvals on Seeker: the wallet signs and broadcasts, and Ghola receives
     * only transaction signatures.
     */
    suspend fun signAndSendTransactions(
        sender: ActivityResultSender,
        walletAddressBase58: String,
        serializedTransactions: List<ByteArray>,
        authToken: String? = null,
    ): TransactionSendOutcome {
        if (serializedTransactions.isEmpty()) {
            return TransactionSendOutcome.Failure(IllegalArgumentException("no transactions to send"))
        }
        val expectedAddress = try {
            Base58.decode(walletAddressBase58)
        } catch (e: Exception) {
            return TransactionSendOutcome.Failure(e)
        }
        val adapter = adapter(authToken)
        val result = try {
            adapter.transact(sender) { authResult ->
                val authorized = authResult.accounts.firstOrNull()?.publicKey ?: run {
                    @Suppress("DEPRECATION")
                    authResult.publicKey
                }
                if (!authorized.contentEquals(expectedAddress)) {
                    error("authorized wallet does not match connected Ghola wallet")
                }
                signAndSendTransactions(
                    serializedTransactions.toTypedArray(),
                    DefaultTransactionParams,
                ).signatures.map { Base58.encode(it) }
            }
        } catch (e: Exception) {
            Log.e(TAG, "MWA signAndSendTransactions threw", e)
            return TransactionSendOutcome.Failure(e)
        }

        return when (result) {
            is TransactionResult.Success -> TransactionSendOutcome.Success(result.payload)
            is TransactionResult.NoWalletFound -> TransactionSendOutcome.NoWallet
            is TransactionResult.Failure -> {
                val msg = result.message.lowercase()
                when {
                    msg.contains("declin") || msg.contains("reject") ->
                        TransactionSendOutcome.Declined
                    msg.contains("cancel") -> TransactionSendOutcome.Cancelled
                    else -> TransactionSendOutcome.Failure(result.e)
                }
            }
        }
    }

    suspend fun deauthorize(
        sender: ActivityResultSender,
        authToken: String?,
    ): Result<Unit> {
        if (authToken.isNullOrBlank()) return Result.success(Unit)
        val adapter = adapter(authToken)
        val result = try {
            adapter.transact(sender) {
                deauthorize(authToken)
            }
        } catch (e: Exception) {
            Log.e(TAG, "MWA deauthorize threw", e)
            return Result.failure(e)
        }
        return when (result) {
            is TransactionResult.Success -> Result.success(Unit)
            is TransactionResult.NoWalletFound -> Result.failure(NoWalletInstalledException(result.message))
            is TransactionResult.Failure -> Result.failure(result.e)
        }
    }
}
