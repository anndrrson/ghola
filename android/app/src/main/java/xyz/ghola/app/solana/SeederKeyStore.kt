package xyz.ghola.app.solana

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import com.solanamobile.seedvault.Bip44DerivationPath
import com.solanamobile.seedvault.BipLevel
import com.solanamobile.seedvault.PublicKeyResponse
import com.solanamobile.seedvault.SigningRequest
import com.solanamobile.seedvault.Wallet
import com.solanamobile.seedvault.WalletContractV1
import xyz.ghola.app.ai.SecureStorage

/**
 * # SeederKeyStore
 *
 * Real Solana Mobile **Seed Vault** integration. This is the hardware-backed
 * replacement for [AgentKeyStore] on Seeker devices — private keys live in
 * the device's secure element, the app only ever sees public keys, opaque
 * `authToken` handles, and raw signature bytes.
 *
 * ## Why a new file instead of editing [SeedVaultManager]?
 *
 * [SeedVaultManager] is a presence-check stub that predates the Seed Vault
 * SDK being wired in. It only talks to `PackageManager` and has no Intent
 * surface. Keeping it around is harmless and the Wallet tab already depends
 * on its `isAvailable()`. This class handles the real SDK interaction:
 * authorize → derive → sign.
 *
 * ## Why callback-based, not `suspend fun`?
 *
 * The Seed Vault SDK is Intent-based. Every operation constructs an
 * `Intent`, launches it via [ActivityResultLauncher], and parses the result
 * in an [ActivityResultContracts.StartActivityForResult] callback. Mapping
 * that onto a `suspend fun` requires a `suspendCancellableCoroutine` wrapper
 * that has to carefully preserve the continuation across config changes.
 *
 * For the demo path we keep it dumb-simple: the caller passes a callback,
 * we stash it until the Intent hops complete, then invoke it with
 * `Result.success(bytes)` or `Result.failure(throwable)`. A future refactor
 * can layer a suspend wrapper on top.
 *
 * ## Threading model
 *
 * The [ActivityResultLauncher] fields MUST be registered in the class
 * constructor body (before the activity reaches `CREATED`), which is why
 * they are `val`s initialized at field-declaration time. Registering later
 * — e.g. lazily inside [deriveAgentPubkey] or [signAgentMessage] — throws
 * `IllegalStateException` at runtime.
 *
 * The callbacks passed to [deriveAgentPubkey] and [signAgentMessage] will be
 * invoked on the main thread (that's where the result launcher callbacks
 * fire). Callers that want to do backend calls inside the callback should
 * marshal to a background dispatcher themselves.
 *
 * ## Single-shot, dual-purpose
 *
 * This class holds ONE pending operation at a time — either a derivation OR
 * a signing request, never both. Calling [deriveAgentPubkey] or
 * [signAgentMessage] while a previous call is still in flight throws
 * `IllegalStateException`. Rationale: the Intent lifecycle is sequential
 * and allowing concurrent operations would require per-request correlation
 * IDs that the SDK does not expose.
 *
 * The state machine for a SIGN call is:
 *   1. Caller invokes [signAgentMessage] → pending = SIGN
 *   2. Authorize launcher fires (user taps "Allow") → authToken captured
 *   3. Sign launcher fires (user taps "Sign") → signature bytes extracted
 *   4. Callback invoked with `Result.success(sigBytes)`, pending = null
 *
 * Step 2 is identical to the DERIVE flow; only step 3 differs. After
 * authorize succeeds we branch on `pending.operation` to decide which
 * launcher to fire next.
 *
 * ## Fresh-device handling
 *
 * If the user has never set up a seed, [Wallet.hasUnauthorizedSeedsForPurpose]
 * will return `false`. In that case the proper flow is
 * `Wallet.createSeed(ctx, PURPOSE_SIGN_SOLANA_TRANSACTION)` which launches
 * the Seed Vault app's "create new seed" wizard. We do NOT handle that here
 * in v1 — instead, [isSupported] reports `false` on a fresh device so the
 * caller falls back to the non-Seeker path. If the user wants a hardware
 * key they can create one via the Seed Vault app manually, then retry.
 *
 * ## Usage
 *
 * ```kotlin
 * class CreateAgentActivity : AppCompatActivity() {
 *     private val seeder = SeederKeyStore(this)
 *
 *     private fun onCreateAgentClicked(agentIndex: Int, nonce: ByteArray) {
 *         seeder.deriveAgentPubkey(agentIndex) { deriveResult ->
 *             deriveResult.fold(
 *                 onSuccess = { pubkeyBytes ->
 *                     // ... server challenge step ...
 *                     seeder.signAgentMessage(agentIndex, nonce) { sigResult ->
 *                         sigResult.fold(
 *                             onSuccess = { sig -> submitAgent(pubkeyBytes, sig) },
 *                             onFailure = { err -> showError(err.message) },
 *                         )
 *                     }
 *                 },
 *                 onFailure = { err -> showError(err.message) },
 *             )
 *         }
 *     }
 * }
 * ```
 *
 * ## Security note
 *
 * The `authToken` is NOT persisted in v1. Every [deriveAgentPubkey] and
 * [signAgentMessage] call re-authorizes. This means the Create Agent flow
 * requires the user to approve FOUR Seed Vault prompts in sequence
 * (authorize+derive, then authorize+sign). Sub-optimal UX but keeps
 * debugging simple — there's no cached-token state to invalidate. Phase 2
 * can stash the token in `SecureStorage` and only re-authorize when
 * `hasUnauthorizedSeedsForPurpose` goes stale.
 */
class SeederKeyStore(private val activity: ComponentActivity) {

    /**
     * Lazy-initialized so `EncryptedSharedPreferences.create()` doesn't fire
     * during the Activity constructor chain. Activities' base context isn't
     * attached until `Activity.attach()` runs, which happens AFTER Kotlin
     * field initializers. If we touched SecureStorage here at field-init
     * time, `context.getApplicationContext()` would return null and crash
     * the Activity before it ever hit `onCreate`. First access happens
     * inside `startAuthorizeOrReuseCached()` — well after the Activity
     * is fully attached.
     */
    private val storage: SecureStorage by lazy { SecureStorage(activity) }

    /** Which operation the current [Pending] slot represents. */
    private enum class Operation { DERIVE, SIGN }

    /**
     * Pending state for a single in-flight operation. Captures the caller's
     * callback, the BIP-44 account index, the operation kind, (for SIGN)
     * the payload bytes to feed into [SigningRequest], the `authToken`,
     * and a `retriedAfterCacheInvalidation` flag so we only retry ONCE if
     * the cached token turned out to be stale.
     */
    private data class Pending(
        val operation: Operation,
        val agentIndex: Int,
        val callback: (Result<ByteArray>) -> Unit,
        val messageToSign: ByteArray?,
        var authToken: Long? = null,
        var retriedAfterCacheInvalidation: Boolean = false,
    )

    private var pending: Pending? = null

    /**
     * Launches `Wallet.authorizeSeed(...)`. The callback receives the
     * raw intent result; we parse it via `Wallet.onAuthorizeSeedResult`.
     * Registered at construction time — see the KDoc on the class.
     *
     * Shared between DERIVE and SIGN — both operations always start with
     * authorize (because we don't persist the token).
     */
    private val authorizeLauncher: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result -> handleAuthorizeResult(result) }

    /**
     * Launches `Wallet.requestPublicKeys(...)`. Fired after the authorize
     * launcher succeeds on a DERIVE operation and we have an authToken
     * in hand.
     */
    private val pubkeyLauncher: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result -> handlePubkeyResult(result) }

    /**
     * Launches `Wallet.signMessages(...)`. Fired after the authorize
     * launcher succeeds on a SIGN operation. The user sees a second
     * approval dialog here showing the raw payload being signed.
     */
    private val signLauncher: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result -> handleSignResult(result) }

    /**
     * Derive the BIP-44 Solana public key for a given agent index. Single-
     * shot — concurrent calls throw [IllegalStateException]. The callback
     * is invoked on the main thread with `Result.success(pubkeyBytes)`
     * (raw 32 bytes) or `Result.failure(throwable)`.
     *
     * @param agentIndex zero-based index derived from the user's current
     *                   agent count. The first agent is index 0, the second
     *                   is index 1, etc. Becomes the hardened BIP-44 account
     *                   level in the derivation path.
     * @param callback invoked exactly once on the main thread with the
     *                 derivation result.
     */
    fun deriveAgentPubkey(
        agentIndex: Int,
        callback: (Result<ByteArray>) -> Unit,
    ) {
        check(pending == null) {
            "SeederKeyStore is single-shot — another operation is already in flight"
        }
        pending = Pending(
            operation = Operation.DERIVE,
            agentIndex = agentIndex,
            callback = callback,
            messageToSign = null,
        )
        startAuthorizeOrReuseCached()
    }

    /**
     * Sign an arbitrary byte payload with the BIP-44 Solana private key for
     * the given agent index. Single-shot — concurrent calls throw
     * [IllegalStateException]. The callback is invoked on the main thread
     * with `Result.success(signatureBytes)` (raw 64-byte ed25519 signature)
     * or `Result.failure(throwable)`.
     *
     * The user will see TWO Seed Vault prompts in sequence: first the
     * authorize dialog, then the sign-message dialog. This is because we
     * don't cache the authToken in v1 — every call re-authorizes. Phase 2
     * can drop the second prompt if the cached token is still valid.
     *
     * @param agentIndex zero-based BIP-44 account index — must match the
     *                   index previously passed to [deriveAgentPubkey] if
     *                   the signature is going to be verified against a
     *                   pubkey returned by that earlier call.
     * @param message raw payload to sign. The signature is over these
     *                bytes verbatim — not over a hash, not over a base64
     *                encoding. Callers that need to sign a hash should
     *                hash their input first and pass the hash here.
     * @param callback invoked exactly once on the main thread with the
     *                 signing result.
     */
    fun signAgentMessage(
        agentIndex: Int,
        message: ByteArray,
        callback: (Result<ByteArray>) -> Unit,
    ) {
        check(pending == null) {
            "SeederKeyStore is single-shot — another operation is already in flight"
        }
        pending = Pending(
            operation = Operation.SIGN,
            agentIndex = agentIndex,
            callback = callback,
            messageToSign = message,
        )
        startAuthorizeOrReuseCached()
    }

    /**
     * Op-Better #1: cached authToken fast path.
     *
     * If SecureStorage has a previously-issued authToken, skip the
     * authorize launcher entirely and jump straight to the operation's
     * next step (requestPublicKeys for DERIVE, signMessages for SIGN).
     * The cached token might be stale — if the result launcher throws
     * ActionFailedException we invalidate the cache and fall back to
     * the full authorize flow. See [maybeRetryAfterCacheInvalidation].
     */
    private fun startAuthorizeOrReuseCached() {
        val p = pending ?: return
        val cachedToken = storage.getSeedVaultAuthToken()
        if (cachedToken != -1L) {
            Log.i(TAG, "using cached Seed Vault authToken — skipping authorize")
            p.authToken = cachedToken
            when (p.operation) {
                Operation.DERIVE -> launchPubkeyRequest(cachedToken)
                Operation.SIGN -> launchSignRequest(cachedToken)
            }
            return
        }
        launchAuthorize()
    }

    /**
     * If the current pending op failed because the cached token was
     * stale, retry ONCE from the authorize step. Returns true if the
     * retry was triggered, false if we should surface the failure.
     */
    private fun maybeRetryAfterCacheInvalidation(): Boolean {
        val p = pending ?: return false
        if (p.retriedAfterCacheInvalidation) {
            // Already retried once — don't loop.
            return false
        }
        // Only retry if we were actually using a cached token (not a fresh
        // authorize that just failed because the user denied).
        val wasUsingCache = storage.hasSeedVaultAuthToken() && p.authToken != null
        if (!wasUsingCache) return false

        Log.w(TAG, "cached authToken appears stale — invalidating and retrying from authorize")
        storage.clearSeedVaultAuthToken()
        p.retriedAfterCacheInvalidation = true
        p.authToken = null
        launchAuthorize()
        return true
    }

    /**
     * Fire the `Wallet.authorizeSeed(...)` launcher. Shared entry point for
     * both DERIVE and SIGN — they both need an authToken, and in v1 we
     * always re-authorize to avoid token-caching bugs.
     */
    private fun launchAuthorize() {
        try {
            val intent = Wallet.authorizeSeed(
                activity,
                WalletContractV1.PURPOSE_SIGN_SOLANA_TRANSACTION,
            )
            authorizeLauncher.launch(intent)
        } catch (e: Throwable) {
            // Intent construction itself shouldn't fail, but if the SDK
            // can't resolve the Seed Vault provider we surface the error
            // as a failure on the caller's callback rather than crashing.
            Log.e(TAG, "Wallet.authorizeSeed intent construction failed", e)
            finishWith(Result.failure(e))
        }
    }

    /** Step 1 result handler — parse the authToken, persist it to the
     *  cache, then branch on op. */
    private fun handleAuthorizeResult(result: ActivityResult) {
        val p = pending ?: run {
            Log.w(TAG, "authorize result arrived with no pending operation")
            return
        }
        val authToken: Long = try {
            Wallet.onAuthorizeSeedResult(result.resultCode, result.data)
        } catch (e: Wallet.ActionFailedException) {
            Log.w(TAG, "user denied authorize: ${e.message}")
            finishWith(Result.failure(e))
            return
        } catch (e: Throwable) {
            Log.e(TAG, "authorize result parse threw", e)
            finishWith(Result.failure(e))
            return
        }

        // Op-Better #1: persist the fresh authToken so future operations
        // can skip the authorize step. Valid until the user manually
        // revokes the app's Seed Vault access via system settings.
        storage.setSeedVaultAuthToken(authToken)
        Log.i(TAG, "cached fresh Seed Vault authToken")

        p.authToken = authToken
        when (p.operation) {
            Operation.DERIVE -> launchPubkeyRequest(authToken)
            Operation.SIGN -> launchSignRequest(authToken)
        }
    }

    /**
     * Build the BIP-44 path for the pending agent index. Derivation path
     * follows the Solana convention: m / 44' / 501' / account' / 0'
     *
     * The Seed Vault SDK handles the `44' / 501'` prefix internally — we
     * only specify the account + change levels.
     *
     * Shared by [launchPubkeyRequest] and [launchSignRequest] so the two
     * operations always resolve to the same on-device private key for a
     * given agent index.
     */
    private fun buildPath(agentIndex: Int): Uri {
        return Bip44DerivationPath.newBuilder()
            .setAccount(BipLevel(agentIndex, /* hardened = */ true))
            .setChange(BipLevel(0, /* hardened = */ true))
            .build()
            .toUri()
    }

    /** DERIVE step 2 — fire the requestPublicKeys launcher. */
    private fun launchPubkeyRequest(authToken: Long) {
        val p = pending ?: return
        val path = buildPath(p.agentIndex)
        try {
            val intent = Wallet.requestPublicKeys(activity, authToken, arrayListOf(path))
            pubkeyLauncher.launch(intent)
        } catch (e: Throwable) {
            Log.e(TAG, "requestPublicKeys intent construction failed", e)
            finishWith(Result.failure(e))
        }
    }

    /** DERIVE step 2 result — extract the 32-byte raw pubkey. */
    private fun handlePubkeyResult(result: ActivityResult) {
        val p = pending ?: run {
            Log.w(TAG, "pubkey result arrived with no pending operation")
            return
        }
        val responses = try {
            Wallet.onRequestPublicKeysResult(result.resultCode, result.data)
        } catch (e: Wallet.ActionFailedException) {
            // Might be because the cached authToken is stale. Invalidate
            // and retry ONCE from the authorize step.
            if (maybeRetryAfterCacheInvalidation()) return
            Log.w(TAG, "user denied requestPublicKeys: ${e.message}")
            finishWith(Result.failure(e))
            return
        } catch (e: Throwable) {
            Log.e(TAG, "pubkey result parse threw", e)
            finishWith(Result.failure(e))
            return
        }

        val first = responses.firstOrNull()
        if (first == null) {
            finishWith(Result.failure(IllegalStateException("Seed Vault returned no public keys")))
            return
        }
        // PublicKeyResponse#getPublicKey() throws KeyNotValidException if the
        // response wrapped an invalid key (e.g. on-device KDF failure). We
        // surface that as a plain derivation failure.
        val bytes = try {
            first.publicKey
        } catch (e: PublicKeyResponse.KeyNotValidException) {
            Log.w(TAG, "Seed Vault returned invalid public key", e)
            finishWith(Result.failure(e))
            return
        }
        if (bytes == null || bytes.isEmpty()) {
            finishWith(Result.failure(IllegalStateException("Seed Vault returned empty public key bytes")))
            return
        }

        Log.i(TAG, "derived pubkey for agentIndex=${p.agentIndex} (${bytes.size} bytes)")
        finishWith(Result.success(bytes))
    }

    /**
     * SIGN step 2 — build a [SigningRequest] for the pending payload +
     * derivation path, then fire the signMessages launcher.
     *
     * [SigningRequest] is a Java class with a positional constructor:
     * `(byte[] payload, List<Uri> requestedSignatures)`. We pass a
     * single-element list so we get exactly one signature back.
     */
    private fun launchSignRequest(authToken: Long) {
        val p = pending ?: return
        val message = p.messageToSign ?: run {
            Log.e(TAG, "SIGN op with null messageToSign — this is a bug")
            finishWith(Result.failure(IllegalStateException("SIGN op missing payload")))
            return
        }
        val path = buildPath(p.agentIndex)
        try {
            val req = SigningRequest(message, arrayListOf(path))
            val intent = Wallet.signMessages(activity, authToken, arrayListOf(req))
            signLauncher.launch(intent)
        } catch (e: Throwable) {
            Log.e(TAG, "signMessages intent construction failed", e)
            finishWith(Result.failure(e))
        }
    }

    /** SIGN step 2 result — extract the 64-byte raw ed25519 signature. */
    private fun handleSignResult(result: ActivityResult) {
        val p = pending ?: run {
            Log.w(TAG, "sign result arrived with no pending operation")
            return
        }
        val responses = try {
            Wallet.onSignMessagesResult(result.resultCode, result.data)
        } catch (e: Wallet.ActionFailedException) {
            // Might be because the cached authToken is stale. Invalidate
            // and retry ONCE from the authorize step.
            if (maybeRetryAfterCacheInvalidation()) return
            Log.w(TAG, "user denied signMessages: ${e.message}")
            finishWith(Result.failure(e))
            return
        } catch (e: Throwable) {
            Log.e(TAG, "sign result parse threw", e)
            finishWith(Result.failure(e))
            return
        }

        val first = responses.firstOrNull()
        if (first == null) {
            finishWith(Result.failure(IllegalStateException("Seed Vault returned no signing responses")))
            return
        }
        val sig = first.signatures.firstOrNull()
        if (sig == null || sig.isEmpty()) {
            finishWith(Result.failure(IllegalStateException("Seed Vault returned empty signature bytes")))
            return
        }
        if (sig.size != 64) {
            // ed25519 signatures are ALWAYS 64 bytes. If we got something
            // else the backend's verify_strict will reject it anyway — fail
            // loudly here so the caller gets a diagnostic message rather
            // than a generic 401 from the server.
            Log.w(TAG, "unexpected signature length: ${sig.size} (expected 64)")
            finishWith(Result.failure(IllegalStateException("Unexpected signature length ${sig.size}, expected 64")))
            return
        }

        Log.i(TAG, "signed message for agentIndex=${p.agentIndex} (${sig.size} bytes)")
        finishWith(Result.success(sig))
    }

    /**
     * Invoke the pending callback exactly once, clear the pending state
     * so the class is ready for another operation. Wrapped in try/catch
     * so a misbehaving caller callback can't leak our pending slot.
     */
    private fun finishWith(result: Result<ByteArray>) {
        val p = pending
        pending = null
        if (p == null) {
            Log.w(TAG, "finishWith called with no pending operation")
            return
        }
        try {
            p.callback(result)
        } catch (e: Throwable) {
            Log.e(TAG, "caller callback threw", e)
        }
    }

    companion object {
        private const val TAG = "SeederKeyStore"

        /**
         * True if the device has a Seed Vault provider installed AND the
         * user has at least one authorized seed (or an unauthorized seed we
         * can walk through on demand). Safe to call on any Android device —
         * returns `false` on a Pixel, on an emulator without the simulator,
         * or on a Seeker that was just reset and has no seeds yet.
         *
         * This gates the fall-through: when `isSupported` is `false`, the
         * caller should skip [deriveAgentPubkey] entirely and surface an
         * error explaining that agent creation requires a Seed Vault device
         * (since the backend now requires a real signed challenge).
         */
        fun isSupported(context: Context): Boolean {
            return try {
                val hasUnauthorized = Wallet.hasUnauthorizedSeedsForPurpose(
                    context,
                    WalletContractV1.PURPOSE_SIGN_SOLANA_TRANSACTION
                )
                if (hasUnauthorized) return true

                // Authorized seeds cursor — any row means we already have a
                // usable seed for this purpose.
                val cursor = Wallet.getAuthorizedSeeds(
                    context,
                    WalletContractV1.AUTHORIZED_SEEDS_ALL_COLUMNS
                )
                cursor?.use { it.count > 0 } ?: false
            } catch (e: Throwable) {
                // Any exception (package not installed, permission denied,
                // SDK resolution failure) → report as unsupported. The
                // fallback path handles it.
                Log.d(TAG, "isSupported check threw — treating as unsupported: ${e.message}")
                false
            }
        }
    }
}
