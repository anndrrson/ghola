package xyz.ghola.app.crypto

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Wallet-bound vault: holds a master KEK plus per-session DEKs, all
 * AES-GCM-wrapped and persisted in `EncryptedSharedPreferences`. Unlock
 * requires a 64-byte Ed25519 signature from the user's MWA wallet on
 * [VaultIdentity.unlockChallenge].
 *
 * ## Why a KEK at all
 * One layer of indirection so future Pair-Device-imported DEKs, DEK
 * rotation, or new derivation methods can coexist without changing the
 * unlock primitive. The KEK lives only as ciphertext on disk; plaintext
 * exists only after [unlock] succeeds and only for the duration of the
 * idle TTL.
 *
 * ## Threat model
 * - Cloud / network: opaque envelopes only.
 * - Device dump (no wallet): every secret on disk is AES-GCM-wrapped under
 *   the AndroidKeystore master key, AND the KEK itself is wrapped under
 *   a key derived from the wallet signature. A dump is useless without
 *   both.
 * - Backgrounded app: `lock()` zeros in-memory secrets; the next vault-
 *   needing call re-prompts the wallet.
 *
 * ## Idle TTL
 * Auto-lock fires [lock] after [DEFAULT_IDLE_TTL_MILLIS] of no usage AND
 * on app background. The mechanism is a check on each call (`maybeIdleLock`),
 * not a scheduled task — keeps it dependency-free.
 */
class VaultStore private constructor(
    private val prefs: SharedPreferences,
    val userDid: String,
) {
    companion object {
        private const val TAG = "VaultStore"
        const val PREFS_NAME = "ghola_vault_v1"

        const val KEK_LEN = 32
        const val DEK_LEN = 32
        const val SALT_LEN = 16
        const val NONCE_LEN = 12
        const val TAG_BITS = 128
        const val DEFAULT_IDLE_TTL_MILLIS = 15L * 60L * 1000L

        // Per-DID key prefixes inside SharedPreferences. We keep the userDid
        // in every key so a single prefs file can host multiple wallets.
        private fun saltKey(did: String) = "salt|$did"
        private fun wrappedKekKey(did: String) = "wkek|$did"
        private fun createdAtKey(did: String) = "ca|$did"
        private fun dekKey(did: String, sessionId: String) = "dek|$did|$sessionId"
        private fun dekKindKey(did: String, sessionId: String) = "dekk|$did|$sessionId"
        private fun dekListPrefix(did: String) = "dek|$did|"

        @JvmStatic
        fun create(context: Context, userDid: String): VaultStore {
            require(userDid.startsWith("did:key:z")) { "userDid must be a did:key:zXXX" }
            val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
            val prefs = EncryptedSharedPreferences.create(
                PREFS_NAME,
                masterKeyAlias,
                context,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            return VaultStore(prefs, userDid)
        }

        /** For unit tests on the JVM where AndroidKeystore isn't available. */
        @JvmStatic
        fun createInMemoryForTests(userDid: String): VaultStore {
            val backing = HashMap<String, Any?>()
            return VaultStore(InMemoryPrefs(backing), userDid)
        }
    }

    /** Pluggable signer — [VaultStore] doesn't talk to MWA directly so the
     *  unit tests can inject a deterministic signer. */
    fun interface SignMessage {
        @Throws(Exception::class)
        fun sign(challenge: ByteArray): SignResult
    }

    sealed class SignResult {
        data class Success(val signature: ByteArray) : SignResult() {
            init {
                require(signature.size == 64) {
                    "Ed25519 signature must be 64 bytes; got ${signature.size}"
                }
            }
        }
        object NoWallet : SignResult()
        object Declined : SignResult()
        object Cancelled : SignResult()
    }

    sealed class VaultLockedError(message: String) : RuntimeException(message) {
        object NoWalletPaired : VaultLockedError("no MWA wallet paired")
        object WalletDeclined : VaultLockedError("wallet declined the unlock signature")
        object WalletCancelled : VaultLockedError("unlock cancelled by user")
        object DeterminismViolation :
            VaultLockedError("wallet returned a non-deterministic signature for the same challenge")
        class WrongSignature(detail: String) :
            VaultLockedError("vault unlock failed: $detail")
    }

    private val rng = SecureRandom()
    private var material: VaultIdentity.VaultMaterial? = null
    private var masterKek: ByteArray? = null
    private var lastTouchMillis: Long = 0L
    private var idleTtlMillis: Long = DEFAULT_IDLE_TTL_MILLIS

    fun isUnlocked(): Boolean {
        maybeIdleLock()
        return masterKek != null
    }

    /** For tests: shorten the idle TTL so we don't need a 15-min sleep. */
    fun setIdleTtlMillisForTests(ttl: Long) {
        require(ttl >= 0)
        idleTtlMillis = ttl
    }

    /**
     * Unlock or initialize the vault for [userDid]. Idempotent within a
     * single unlocked session.
     *
     * On a fresh install: generates a random KEK + salt, signs the unlock
     * challenge to derive the wrapping key, and writes the wrapped KEK to
     * prefs.
     *
     * On a returning install: signs the unlock challenge (same wallet
     * required), derives the wrapping key, unwraps the KEK.
     *
     * @param verifyDeterminism Re-sign once and compare so a non-RFC-8032
     *  wallet (different signature for the same challenge) can't corrupt
     *  the vault. Costs an extra wallet popup; default false in
     *  production because all major Solana wallets are deterministic and
     *  the AES-GCM unwrap acts as an implicit check (a flaky signature
     *  produces a different kekWrapKey, which fails to unwrap and yields
     *  WrongSignature). Tests pass true to exercise the explicit guard.
     */
    @Throws(VaultLockedError::class)
    @JvmOverloads
    fun unlock(signMessage: SignMessage, verifyDeterminism: Boolean = false) {
        if (masterKek != null) {
            touch()
            return
        }
        val existingSalt = prefs.getString(saltKey(userDid), null)?.let { decodeB64(it) }
        if (existingSalt != null) {
            val wrappedKek = decodeB64(prefs.getString(wrappedKekKey(userDid), null)
                ?: throw VaultLockedError.WrongSignature("salt without wrapped KEK"))
            val challenge = VaultIdentity.unlockChallenge(userDid, existingSalt)
            val sig1 = sigOrThrow(signMessage.sign(challenge))
            val mat = VaultIdentity.deriveVaultMaterial(sig1, existingSalt)
            if (verifyDeterminism) {
                val sig2 = sigOrThrow(signMessage.sign(challenge))
                if (!sig1.contentEquals(sig2)) {
                    Log.e(TAG, "non-deterministic wallet signature on unlock")
                    mat.zeroize()
                    throw VaultLockedError.DeterminismViolation
                }
            }
            val kek = aesGcmUnwrap(mat.kekWrapKey, wrappedKek)
                ?: run {
                    mat.zeroize()
                    throw VaultLockedError.WrongSignature(
                        "could not unwrap KEK — wrong wallet or rotated signing key",
                    )
                }
            masterKek = kek
            material = mat
            touch()
        } else {
            // Fresh install for this DID on this device.
            val salt = ByteArray(SALT_LEN).also { rng.nextBytes(it) }
            val challenge = VaultIdentity.unlockChallenge(userDid, salt)
            val sig = sigOrThrow(signMessage.sign(challenge))
            val mat = VaultIdentity.deriveVaultMaterial(sig, salt)
            val kek = ByteArray(KEK_LEN).also { rng.nextBytes(it) }
            val wrapped = aesGcmWrap(mat.kekWrapKey, kek)
            prefs.edit()
                .putString(saltKey(userDid), encodeB64(salt))
                .putString(wrappedKekKey(userDid), encodeB64(wrapped))
                .putLong(createdAtKey(userDid), System.currentTimeMillis())
                .apply()
            masterKek = kek
            material = mat
            touch()
        }
    }

    /** Zero the in-memory secrets. The wrapped KEK on disk is unchanged. */
    fun lock() {
        masterKek?.let { for (i in it.indices) it[i] = 0 }
        masterKek = null
        material?.zeroize()
        material = null
        lastTouchMillis = 0L
    }

    /** Get-or-create a session DEK and return the plaintext bytes. */
    @Throws(VaultLockedError::class)
    fun getOrCreateSessionDek(
        sessionId: String,
        kind: Envelope.RecipientKind = Envelope.RecipientKind.SelfRecipient,
    ): ByteArray {
        val kek = requireUnlocked()
        val existing = prefs.getString(dekKey(userDid, sessionId), null)
        if (existing != null) {
            val wrapped = decodeB64(existing)
            return aesGcmUnwrap(kek, wrapped)
                ?: throw VaultLockedError.WrongSignature("could not unwrap session DEK")
        }
        val dek = ByteArray(DEK_LEN).also { rng.nextBytes(it) }
        persistSessionDek(sessionId, dek, kind)
        return dek
    }

    /** Import a session DEK received via Pair Device. Overwrites any
     *  existing DEK for [sessionId]. */
    @Throws(VaultLockedError::class)
    fun importSessionDek(
        sessionId: String,
        dek: ByteArray,
        kind: Envelope.RecipientKind = Envelope.RecipientKind.SelfRecipient,
    ) {
        require(dek.size == DEK_LEN) { "DEK must be 32 bytes" }
        requireUnlocked()
        persistSessionDek(sessionId, dek, kind)
    }

    private fun persistSessionDek(
        sessionId: String,
        dek: ByteArray,
        kind: Envelope.RecipientKind,
    ) {
        val kek = requireUnlocked()
        val wrapped = aesGcmWrap(kek, dek)
        prefs.edit()
            .putString(dekKey(userDid, sessionId), encodeB64(wrapped))
            .putInt(dekKindKey(userDid, sessionId), kind.byte.toInt() and 0xFF)
            .apply()
    }

    fun deleteSession(sessionId: String) {
        prefs.edit()
            .remove(dekKey(userDid, sessionId))
            .remove(dekKindKey(userDid, sessionId))
            .apply()
    }

    /** Enumerate every session this vault holds a DEK for. */
    fun listSessions(): List<SessionMeta> {
        val prefix = dekListPrefix(userDid)
        val out = mutableListOf<SessionMeta>()
        for ((k, _) in prefs.all) {
            if (!k.startsWith(prefix)) continue
            val sessionId = k.substring(prefix.length)
            val kindByte = (prefs.getInt(dekKindKey(userDid, sessionId), 0) and 0xFF).toByte()
            val kind = try {
                Envelope.RecipientKind.fromByte(kindByte)
            } catch (_: Exception) {
                Envelope.RecipientKind.SelfRecipient
            }
            out += SessionMeta(sessionId = sessionId, recipientKind = kind)
        }
        return out
    }

    data class SessionMeta(val sessionId: String, val recipientKind: Envelope.RecipientKind)

    /** Wipe all KEK + DEK rows for [userDid]. */
    fun wipe() {
        lock()
        val edit = prefs.edit()
        edit.remove(saltKey(userDid))
        edit.remove(wrappedKekKey(userDid))
        edit.remove(createdAtKey(userDid))
        val prefix = dekListPrefix(userDid)
        for ((k, _) in prefs.all) {
            if (k.startsWith(prefix) || k.startsWith("dekk|$userDid|")) edit.remove(k)
        }
        edit.apply()
    }

    /** Active vault material (for chat-vault wiring). Throws if locked. */
    fun material(): VaultIdentity.VaultMaterial {
        requireUnlocked()
        return material ?: throw VaultLockedError.WrongSignature("material missing")
    }

    /** Build a body-signer keyed on the cached chat-sign Ed25519 seed. */
    fun chatSigner(): Envelope.Ed25519BodySigner {
        val mat = material()
        return Envelope.localEd25519Signer(mat.chatSignSeed)
    }

    private fun requireUnlocked(): ByteArray {
        maybeIdleLock()
        return masterKek ?: throw VaultLockedError.WrongSignature("vault is locked")
    }

    private fun touch() {
        lastTouchMillis = System.currentTimeMillis()
    }

    private fun maybeIdleLock() {
        val last = lastTouchMillis
        if (masterKek != null && idleTtlMillis > 0 && last > 0 &&
            System.currentTimeMillis() - last > idleTtlMillis
        ) {
            Log.i(TAG, "vault idle TTL expired — auto-locking")
            lock()
        }
    }

    // ── crypto helpers (AES-GCM, base64) ────────────────────────────────

    private fun aesGcmWrap(key: ByteArray, plaintext: ByteArray): ByteArray {
        val nonce = ByteArray(NONCE_LEN).also { rng.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
        val ct = cipher.doFinal(plaintext)
        return nonce + ct
    }

    private fun aesGcmUnwrap(key: ByteArray, blob: ByteArray): ByteArray? {
        if (blob.size < NONCE_LEN + 16) return null
        val nonce = blob.copyOfRange(0, NONCE_LEN)
        val ct = blob.copyOfRange(NONCE_LEN, blob.size)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
            cipher.doFinal(ct)
        } catch (_: Exception) {
            null
        }
    }

    private fun sigOrThrow(r: SignResult): ByteArray = when (r) {
        is SignResult.Success -> r.signature
        SignResult.NoWallet -> throw VaultLockedError.NoWalletPaired
        SignResult.Declined -> throw VaultLockedError.WalletDeclined
        SignResult.Cancelled -> throw VaultLockedError.WalletCancelled
    }

    private fun encodeB64(b: ByteArray): String =
        Base64.encodeToString(b, Base64.NO_WRAP)

    private fun decodeB64(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)
}

/**
 * Pure-Kotlin SharedPreferences shim for unit tests. Avoids needing
 * Robolectric just to exercise the KEK + DEK round-trip logic. Not used
 * outside `app/src/test/`.
 */
internal class InMemoryPrefs(
    private val backing: MutableMap<String, Any?>,
) : SharedPreferences {

    override fun getAll(): MutableMap<String, *> = backing.toMutableMap()

    override fun getString(key: String, defValue: String?): String? =
        backing[key] as String? ?: defValue

    override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
        @Suppress("UNCHECKED_CAST")
        (backing[key] as MutableSet<String>?) ?: defValues

    override fun getInt(key: String, defValue: Int): Int =
        backing[key] as Int? ?: defValue

    override fun getLong(key: String, defValue: Long): Long =
        backing[key] as Long? ?: defValue

    override fun getFloat(key: String, defValue: Float): Float =
        backing[key] as Float? ?: defValue

    override fun getBoolean(key: String, defValue: Boolean): Boolean =
        backing[key] as Boolean? ?: defValue

    override fun contains(key: String): Boolean = backing.containsKey(key)

    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        private val pending = mutableMapOf<String, Any?>()
        private val removals = mutableSetOf<String>()
        private var clearAll = false

        override fun putString(key: String, value: String?): SharedPreferences.Editor {
            pending[key] = value; return this
        }
        override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor {
            pending[key] = values; return this
        }
        override fun putInt(key: String, value: Int): SharedPreferences.Editor {
            pending[key] = value; return this
        }
        override fun putLong(key: String, value: Long): SharedPreferences.Editor {
            pending[key] = value; return this
        }
        override fun putFloat(key: String, value: Float): SharedPreferences.Editor {
            pending[key] = value; return this
        }
        override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor {
            pending[key] = value; return this
        }
        override fun remove(key: String): SharedPreferences.Editor {
            removals += key; return this
        }
        override fun clear(): SharedPreferences.Editor {
            clearAll = true; return this
        }
        override fun commit(): Boolean { apply(); return true }
        override fun apply() {
            if (clearAll) backing.clear()
            removals.forEach { backing.remove(it) }
            backing.putAll(pending)
        }
    }

    override fun registerOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) { /* unused in tests */ }

    override fun unregisterOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) { /* unused in tests */ }
}
