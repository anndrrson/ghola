package xyz.ghola.app.gmail

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import xyz.ghola.app.ai.SecureStorage
import java.util.concurrent.TimeUnit

/**
 * Background mirror of the user's Gmail sent folder.
 *
 * First run after sign-in pulls the last [BOOTSTRAP_SIZE] sent messages.
 * Subsequent runs are nightly, incremental (messages newer than the last
 * mirrored `sent_at`).
 *
 * Embedding generation runs after the message data is persisted, in a
 * separate pass (see [GmailEmbeddingWorker]) so a slow embedder doesn't
 * block message ingestion — and so embedding can resume from where it left
 * off if the worker is killed.
 *
 * Constraints: Wi-Fi + battery-not-low. We're moving real bytes (~50KB per
 * email body × hundreds), and INT4 model inference at embedding time burns
 * NPU power; we don't want this fighting the user for resources.
 */
class GmailMirrorWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    companion object {
        private const val TAG = "GmailMirror"

        /** Number of historical messages to mirror on first run. */
        const val BOOTSTRAP_SIZE = 500

        /** Page size per Gmail `messages.list` call. */
        private const val PAGE_SIZE = 100

        /** Unique work name for the one-time bootstrap. */
        const val WORK_BOOTSTRAP = "gmail-mirror-bootstrap"

        /** Unique work name for the nightly incremental sync. */
        const val WORK_NIGHTLY = "gmail-mirror-nightly"

        /**
         * Schedule the one-time bootstrap right after Gmail OAuth completes.
         * No constraints — we want this to run as soon as possible so voice
         * transfer is ready when the user first taps Email.
         */
        fun scheduleBootstrap(context: Context) {
            val req = OneTimeWorkRequestBuilder<GmailMirrorWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.UNMETERED)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                WORK_BOOTSTRAP,
                androidx.work.ExistingWorkPolicy.KEEP,
                req,
            )
        }

        /**
         * Schedule the nightly incremental mirror. Idempotent — uses KEEP
         * policy so repeated calls don't duplicate the schedule.
         */
        fun scheduleNightly(context: Context) {
            val req = PeriodicWorkRequestBuilder<GmailMirrorWorker>(
                repeatInterval = 24, repeatIntervalTimeUnit = TimeUnit.HOURS,
            )
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.UNMETERED)
                        .setRequiresBatteryNotLow(true)
                        .setRequiresCharging(true)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NIGHTLY,
                ExistingPeriodicWorkPolicy.KEEP,
                req,
            )
        }
    }

    override suspend fun doWork(): Result {
        val storage = SecureStorage(applicationContext)
        if (storage.getGmailRefreshToken().isNullOrBlank()) {
            Log.i(TAG, "no Gmail refresh token; skipping mirror")
            return Result.success()
        }

        val client = GmailClient(applicationContext)
        val dao = GholaMailDatabase.get(applicationContext).sentEmailDao()

        return try {
            val existingCount = dao.count()
            val latestSentAt = dao.latestSentAt() ?: 0L

            // Incremental query: messages newer than what we have already.
            // Gmail's `newer_than:Nd` is the documented narrowing operator.
            // For first run we just ask for the bootstrap N.
            val query = if (existingCount == 0) {
                "in:sent"
            } else {
                // 14 days of buffer above the latest stored to absorb the
                // window where the user might have backdated a message via
                // Send Later or imported from another client.
                val cutoffDays = ((System.currentTimeMillis() - latestSentAt) / 86_400_000L)
                    .coerceAtLeast(14)
                "in:sent newer_than:${cutoffDays}d"
            }

            val budget = if (existingCount == 0) BOOTSTRAP_SIZE else PAGE_SIZE * 4
            Log.i(TAG, "mirror starting: existing=$existingCount budget=$budget query=$query")

            val ids = client.listSentMessageIds(query, maxResults = budget)
            if (ids.isEmpty()) {
                Log.i(TAG, "no message ids returned")
                return Result.success()
            }

            // Skip ids we already have so we don't re-fetch full payloads.
            val toFetch = ids - dao.existingIds(ids).toSet()
            Log.i(TAG, "fetching ${toFetch.size} of ${ids.size} ids")

            var fetched = 0
            val batch = mutableListOf<SentEmail>()
            for (id in toFetch) {
                val msg = client.fetchMessage(id) ?: continue
                batch += SentEmail(
                    id = msg.id,
                    threadId = msg.threadId,
                    toAddresses = msg.to,
                    ccAddresses = msg.cc,
                    subject = msg.subject,
                    bodyText = msg.body,
                    sentAt = msg.sentAt,
                    embedding = null, // embedded in a separate pass
                )
                if (batch.size >= 25) {
                    dao.upsertAll(batch.toList())
                    batch.clear()
                }
                fetched++
                if (fetched % 50 == 0) Log.i(TAG, "mirror progress: $fetched/${toFetch.size}")
            }
            if (batch.isNotEmpty()) dao.upsertAll(batch)
            Log.i(TAG, "mirror done: $fetched new messages persisted")

            // Kick off embedding for the un-embedded rows.
            GmailEmbeddingWorker.schedule(applicationContext)
            Result.success()
        } catch (t: Throwable) {
            Log.e(TAG, "mirror failed", t)
            // Retry — WorkManager applies exponential backoff.
            Result.retry()
        } finally {
            client.dispose()
        }
    }
}
