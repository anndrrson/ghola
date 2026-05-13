package xyz.ghola.app.gmail

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import xyz.ghola.app.ml.EmbedderClient

/**
 * Second-pass worker that computes embeddings for any sent_email rows that
 * don't have one yet. Split from [GmailMirrorWorker] so:
 *  1. Slow embedder init doesn't block message ingestion.
 *  2. The worker can resume from where it left off if killed.
 *  3. We can re-run embedding (e.g., on a vocab/model upgrade) without
 *     re-fetching every Gmail message.
 *
 * Runs on Wi-Fi + battery-not-low. Each row takes ~100ms on the Seeker CPU
 * for the 128-token embedding, so a 500-message bootstrap is ~50 seconds.
 */
class GmailEmbeddingWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    companion object {
        private const val TAG = "GmailEmbed"
        private const val WORK_NAME = "gmail-embedding"
        private const val BATCH = 25

        fun schedule(context: Context) {
            val req = OneTimeWorkRequestBuilder<GmailEmbeddingWorker>()
                .setConstraints(
                    Constraints.Builder()
                        // Embedder downloads the model on first run; needs
                        // network. After that, embedding itself is offline.
                        .setRequiredNetworkType(NetworkType.UNMETERED)
                        .setRequiresBatteryNotLow(true)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                WORK_NAME,
                ExistingWorkPolicy.KEEP,
                req,
            )
        }
    }

    override suspend fun doWork(): Result {
        val embedder = EmbedderClient.get(applicationContext) ?: run {
            Log.w(TAG, "embedder unavailable; will retry on next run")
            return Result.retry()
        }
        val dao = GholaMailDatabase.get(applicationContext).sentEmailDao()

        var total = 0
        while (true) {
            val batch = dao.unembedded(BATCH)
            if (batch.isEmpty()) break

            for (row in batch) {
                // Embed `subject + first 400 chars of body` — enough signal
                // to cluster by style/topic, short enough to fit the
                // 128-token cap with margin for the WordPiece blowup.
                val input = buildString {
                    append(row.subject)
                    append(". ")
                    append(row.bodyText.take(400))
                }
                val vec = embedder.embed(input)
                if (vec != null) {
                    dao.setEmbedding(row.id, EmbedderClient.pack(vec))
                    total++
                } else {
                    Log.w(TAG, "embedding null for ${row.id}; leaving for next pass")
                }
            }
            Log.i(TAG, "embedded $total so far")
        }
        Log.i(TAG, "embedding done: $total new vectors")
        return Result.success()
    }
}
