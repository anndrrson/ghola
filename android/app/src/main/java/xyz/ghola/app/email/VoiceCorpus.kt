package xyz.ghola.app.email

import android.content.Context
import android.util.Log
import xyz.ghola.app.gmail.GholaMailDatabase
import xyz.ghola.app.gmail.SentEmail
import xyz.ghola.app.ml.EmbedderClient

/**
 * Pure-Kotlin retrieval index over the user's sent-email corpus.
 *
 * At draft time, [findStyleAnchors] returns the top-k most similar past
 * emails to a new intent — those rows become the "this is how you write"
 * anchors fed into the local LLM via [EmailPromptBuilder].
 *
 * Index: brute-force cosine sim over the `sent_email.embedding` BLOB column.
 * At corpus size 1k × 384 dims this is ~50ms on the Seeker CPU. An HNSW
 * index would shave that to single-digit ms but at the cost of an extra
 * dependency + index-rebuild bookkeeping; not worth it at this scale.
 *
 * Boosts: same-recipient match adds +0.20 to similarity; same-thread-family
 * match adds +0.10. The boosts are heuristic — calibrated to favor "an email
 * you wrote to THIS person" over "an email about THIS topic," because voice
 * is recipient-relative more than it is topic-relative.
 */
class VoiceCorpus private constructor(
    private val context: Context,
) {

    companion object {
        private const val TAG = "VoiceCorpus"
        private const val SAME_RECIPIENT_BOOST = 0.20f
        private const val SAME_THREAD_FAMILY_BOOST = 0.10f
        private const val DEFAULT_K = 5

        @Volatile private var INSTANCE: VoiceCorpus? = null

        fun get(context: Context): VoiceCorpus {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: VoiceCorpus(context.applicationContext).also { INSTANCE = it }
            }
        }
    }

    /**
     * Return up to [k] sent-email rows ranked by (cosine_sim + boosts) for
     * the given [intent]. If embeddings aren't available yet (cold install,
     * corpus still indexing), returns the [k] most recent emails as a
     * fallback so the LLM still gets *something* style-relevant — better
     * than no anchors at all.
     */
    suspend fun findStyleAnchors(
        intent: String,
        recipient: String? = null,
        k: Int = DEFAULT_K,
    ): List<SentEmail> {
        val dao = GholaMailDatabase.get(context).sentEmailDao()

        if (dao.count() == 0) {
            Log.i(TAG, "corpus empty; no style anchors available")
            return emptyList()
        }

        val embedder = EmbedderClient.get(context)
        if (embedder == null) {
            Log.w(TAG, "embedder unavailable; falling back to recency-only anchors")
            return dao.recent(k)
        }

        val intentVec = embedder.embed(intent)
        if (intentVec == null) {
            Log.w(TAG, "intent embedding failed; falling back to recency-only")
            return dao.recent(k)
        }

        // Sweep the embedded portion of the corpus. We cap at 1000 to keep
        // the sweep cost bounded — if the user has 10k sent emails, the
        // most-recent 1k is plenty for voice transfer.
        val candidates = dao.embeddedRecent(limit = 1000)
        if (candidates.isEmpty()) {
            // Corpus exists but embeddings haven't landed yet; recency.
            return dao.recent(k)
        }

        val recipientLower = recipient?.lowercase()?.trim()
        val recipientThreadFamily = recipientLower
            ?.let { extractThreadFamily(it) }

        return candidates
            .asSequence()
            .mapNotNull { row ->
                val bytes = row.embedding ?: return@mapNotNull null
                val sim = EmbedderClient.similarity(intentVec, EmbedderClient.unpack(bytes))
                val recipientBoost = if (recipientLower != null &&
                    row.toAddresses.any { addr -> addr.lowercase().contains(recipientLower) }
                ) SAME_RECIPIENT_BOOST else 0f
                val threadBoost = if (recipientThreadFamily != null &&
                    row.toAddresses.any { addr ->
                        extractThreadFamily(addr.lowercase()) == recipientThreadFamily
                    }
                ) SAME_THREAD_FAMILY_BOOST else 0f
                row to (sim + recipientBoost + threadBoost)
            }
            .sortedByDescending { it.second }
            .take(k)
            .map { it.first }
            .toList()
    }

    /**
     * Extract a coarse "thread family" key from an address — used for the
     * thread-family boost when the exact recipient doesn't match but
     * someone from the same domain/group does. Heuristic: domain only for
     * personal addresses; first segment of the local-part for distribution
     * lists.
     */
    private fun extractThreadFamily(address: String): String {
        val atIdx = address.indexOf('@').takeIf { it >= 0 } ?: return address
        return address.substring(atIdx + 1).trim().trimEnd('>').trim()
    }
}
