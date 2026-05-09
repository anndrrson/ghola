package xyz.ghola.app.crypto

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import org.json.JSONArray
import org.json.JSONObject

/**
 * Encrypted-at-rest local chat session list.
 *
 * Mirror of `apps/web/src/lib/chat-history-store.ts`: the entire session
 * list is sealed under a `RecipientKind.SelfRecipient` envelope keyed on
 * the user's DID, then persisted into a separate AndroidKeystore-wrapped
 * `EncryptedSharedPreferences` namespace. A device dump now reveals only
 * ciphertext for the session list.
 *
 * Lazy migration: on first read with a vault, any prior plaintext entries
 * (under [LEGACY_KEY] in the same prefs file, or in the legacy
 * `thumper_ai_secure` namespace) are read once, re-sealed, then dropped.
 */
class ChatHistoryStore private constructor(
    private val prefs: SharedPreferences,
) {
    companion object {
        private const val PREFS_NAME = "ghola_chat_history_v1"
        private const val LEGACY_KEY = "ghola_sessions_legacy"
        /** AD authenticates the storage purpose so cross-store envelope
         *  reuse fails AEAD verification. Matches web. */
        private val AD = "ghola/chat-history-v1".toByteArray(Charsets.UTF_8)
        /** Format-version tag stored alongside the blob. */
        private const val FORMAT_VERSION = 1

        @JvmStatic
        fun create(context: Context): ChatHistoryStore {
            val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
            val prefs = EncryptedSharedPreferences.create(
                PREFS_NAME,
                masterKeyAlias,
                context,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            return ChatHistoryStore(prefs)
        }

        @JvmStatic
        fun createForTests(prefs: SharedPreferences): ChatHistoryStore = ChatHistoryStore(prefs)
    }

    /** A single chat session row. JSON-shape is up to the caller; we
     *  pass-through the bytes verbatim so the call site can evolve the
     *  schema without bumping format versions here. */
    data class Session(val sessionId: String, val payload: JSONObject)

    /**
     * Read the session list. Returns `[]` if nothing is stored.
     *
     * If the encrypted blob doesn't decrypt (most common cause: the user
     * is on a fresh device that hasn't been Pair-Device-synced yet) we
     * return `[]` rather than throwing — the UI shows an empty list and
     * the user can either start fresh or hit Pair Device.
     */
    fun load(vault: VaultStore): List<Session> {
        val mat = vault.material()
        val blobKey = blobKey(vault.userDid)
        val raw = prefs.getString(blobKey, null)
        if (raw != null) {
            val opened = try {
                Envelope.open(decodeB64(raw), mat.x25519Secret)
            } catch (_: Exception) {
                return emptyList()
            }
            return parseSessions(opened.plaintext)
        }
        // Migration path: legacy plaintext key.
        val legacy = prefs.getString(legacyKey(vault.userDid), null)
        if (legacy != null) {
            val sessions = parseSessions(legacy.toByteArray(Charsets.UTF_8))
            try {
                save(sessions, vault)
                prefs.edit().remove(legacyKey(vault.userDid)).apply()
            } catch (_: Exception) {
                // Best-effort migration; if seal fails we leave the legacy
                // key in place so we can try again next time.
            }
            return sessions
        }
        return emptyList()
    }

    /** Persist the session list under a fresh self-recipient envelope. */
    fun save(sessions: List<Session>, vault: VaultStore) {
        val mat = vault.material()
        val arr = JSONArray()
        for (s in sessions) {
            // Stamp the canonical session_id alongside the caller's payload
            // so a future parser doesn't have to look in two places.
            val obj = JSONObject(s.payload.toString())
            obj.put("session_id", s.sessionId)
            arr.put(obj)
        }
        val plaintext = arr.toString().toByteArray(Charsets.UTF_8)
        val wire = Envelope.seal(
            Envelope.SealParams(
                senderDid = mat.chatSignDid,
                kind = Envelope.RecipientKind.SelfRecipient,
                recipientId = vault.userDid,
                recipientX25519 = mat.x25519Public,
                associatedData = AD,
                plaintext = plaintext,
                signBody = vault.chatSigner(),
            ),
        )
        prefs.edit()
            .putString(blobKey(vault.userDid), encodeB64(wire))
            .putInt(versionKey(vault.userDid), FORMAT_VERSION)
            .apply()
    }

    /** Drop the encrypted blob — used on logout / wallet-rotate. */
    fun wipe(userDid: String) {
        prefs.edit()
            .remove(blobKey(userDid))
            .remove(versionKey(userDid))
            .remove(legacyKey(userDid))
            .apply()
    }

    private fun parseSessions(plaintext: ByteArray): List<Session> {
        return try {
            val arr = JSONArray(String(plaintext, Charsets.UTF_8))
            buildList(arr.length()) {
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    val sessionId = obj.optString("session_id").takeIf { it.isNotEmpty() }
                        ?: continue
                    add(Session(sessionId = sessionId, payload = obj))
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun blobKey(did: String) = "blob|$did"
    private fun versionKey(did: String) = "v|$did"
    private fun legacyKey(did: String) = "$LEGACY_KEY|$did"

    private fun encodeB64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun decodeB64(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)
}
