package xyz.ghola.app.email

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import org.json.JSONObject

/**
 * Encrypted, on-device cache of pre-drafted email replies keyed by Gmail
 * thread id. Drafts live for [TTL_MILLIS] before being evicted on read; the
 * eviction is lazy because WorkManager already keeps the cache small (one
 * draft per thread, written by [PreDraftWorker]).
 *
 * Storage is `EncryptedSharedPreferences` so the cached body — which may
 * contain sensitive draft content — is protected at rest just like the
 * Gmail OAuth tokens.
 */
class PreDraftCache private constructor(
    private val prefs: android.content.SharedPreferences,
) {

    companion object {
        private const val PREFS_NAME = "ghola_predraft_v1"
        private const val TTL_MILLIS: Long = 24L * 3600L * 1000L

        @Volatile private var INSTANCE: PreDraftCache? = null

        fun get(context: Context): PreDraftCache {
            INSTANCE?.let { return it }
            return synchronized(this) {
                INSTANCE ?: build(context.applicationContext).also { INSTANCE = it }
            }
        }

        private fun build(context: Context): PreDraftCache {
            val masterKey = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
            val prefs = EncryptedSharedPreferences.create(
                PREFS_NAME,
                masterKey,
                context,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            return PreDraftCache(prefs)
        }
    }

    /** Persist a draft for [threadId]. Overwrites any prior draft. */
    fun put(threadId: String, draft: CachedDraft) {
        prefs.edit()
            .putString(key(threadId), draft.toJson().toString())
            .apply()
    }

    /**
     * Read the cached draft for [threadId]. Returns null if absent or older
     * than [TTL_MILLIS]; expired entries are removed on read.
     */
    fun get(threadId: String): CachedDraft? {
        val raw = prefs.getString(key(threadId), null) ?: return null
        val draft = try {
            CachedDraft.fromJson(JSONObject(raw))
        } catch (_: Throwable) {
            // Corrupted entry — evict so we don't keep failing on read.
            prefs.edit().remove(key(threadId)).apply()
            return null
        }
        if (System.currentTimeMillis() - draft.createdAtMillis > TTL_MILLIS) {
            prefs.edit().remove(key(threadId)).apply()
            return null
        }
        return draft
    }

    fun remove(threadId: String) {
        prefs.edit().remove(key(threadId)).apply()
    }

    fun clearAll() {
        prefs.edit().clear().apply()
    }

    private fun key(threadId: String) = "predraft:$threadId"
}

data class CachedDraft(
    val threadId: String,
    val to: String,
    val subject: String,
    val body: String,
    val createdAtMillis: Long = System.currentTimeMillis(),
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("thread_id", threadId)
        put("to", to)
        put("subject", subject)
        put("body", body)
        put("created_at_millis", createdAtMillis)
    }

    companion object {
        fun fromJson(json: JSONObject): CachedDraft = CachedDraft(
            threadId = json.getString("thread_id"),
            to = json.getString("to"),
            subject = json.getString("subject"),
            body = json.getString("body"),
            createdAtMillis = json.optLong("created_at_millis", System.currentTimeMillis()),
        )
    }
}
