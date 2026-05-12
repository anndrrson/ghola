package xyz.ghola.app.email

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.flow.last
import xyz.ghola.app.gmail.GmailClient

/**
 * Background pre-draft generator. Wakes up when a new inbound email lands
 * (via FCM push or polling fallback) on a thread the user has previously
 * replied to. Drafts a reply with the local LLM, persists it to
 * [PreDraftCache] keyed by thread id.
 *
 * When the user later opens the Email tile for that thread, the draft is
 * already there — zero foreground generation latency.
 *
 * Constraints: battery-not-low. We don't require charging because the user
 * has a notification on screen and is likely to act on it within minutes.
 * Embedding + 9B-class generation is ~3 seconds of NPU + a tiny prefs write;
 * the battery budget per pre-draft is well under 0.1%.
 */
class PreDraftWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    companion object {
        private const val TAG = "PreDraftWorker"

        const val KEY_THREAD_ID = "thread_id"
        const val KEY_INBOUND_MESSAGE_ID = "inbound_message_id"

        /** Unique-per-thread work name so duplicate triggers coalesce. */
        private fun workName(threadId: String) = "predraft-thread-$threadId"

        /**
         * Schedule a pre-draft for [threadId]. The inbound message id is
         * threaded through so the worker can pull only the new content
         * (versus refetching the whole thread).
         */
        fun schedule(context: Context, threadId: String, inboundMessageId: String) {
            val data = Data.Builder()
                .putString(KEY_THREAD_ID, threadId)
                .putString(KEY_INBOUND_MESSAGE_ID, inboundMessageId)
                .build()
            val req = OneTimeWorkRequestBuilder<PreDraftWorker>()
                .setInputData(data)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiresBatteryNotLow(true)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                workName(threadId),
                // REPLACE so a fresh inbound supersedes a stale draft job.
                ExistingWorkPolicy.REPLACE,
                req,
            )
        }
    }

    override suspend fun doWork(): Result {
        val threadId = inputData.getString(KEY_THREAD_ID)
            ?: return Result.failure()
        val inboundId = inputData.getString(KEY_INBOUND_MESSAGE_ID)
            ?: return Result.failure()
        Log.i(TAG, "pre-drafting reply for thread=$threadId inbound=$inboundId")

        val gmail = GmailClient(applicationContext)
        val cache = PreDraftCache.get(applicationContext)
        return try {
            // Pull thread context — the last 5 messages in chronological
            // order. Anything older is rarely relevant to a quick reply.
            val thread = gmail.listThreadMessages(threadId).takeLast(5)
            if (thread.isEmpty()) {
                Log.w(TAG, "thread $threadId returned no messages — skipping")
                return Result.success()
            }
            val inbound = thread.lastOrNull { it.id == inboundId } ?: thread.last()
            val recipient = inbound.from.ifBlank { inbound.to.firstOrNull().orEmpty() }
            val intent = buildString {
                append("Reply to the most recent message in this thread.\n\n")
                append("Inbound subject: ").append(inbound.subject).append('\n')
                append("Inbound body: ").append(inbound.body.take(800))
            }
            val threadContext = thread.dropLast(1).reversed().map { m ->
                "From: ${m.from}\nSubject: ${m.subject}\n${m.body.take(400)}"
            }

            val draft = LocalEmailService.draft(
                context = applicationContext,
                intent = intent,
                recipientHint = recipient,
                threadContext = threadContext,
            ) ?: run {
                Log.w(TAG, "local model unavailable; skipping pre-draft")
                return Result.success()
            }

            val finalBody = try {
                draft.body.last()
            } catch (t: Throwable) {
                Log.w(TAG, "body collection failed: ${t.message}")
                ""
            }

            cache.put(
                threadId,
                CachedDraft(
                    threadId = threadId,
                    to = draft.to,
                    subject = draft.subject,
                    body = finalBody,
                ),
            )
            Log.i(TAG, "pre-draft cached for thread=$threadId (${finalBody.length} chars)")
            Result.success()
        } catch (t: Throwable) {
            Log.e(TAG, "pre-draft failed for $threadId", t)
            Result.retry()
        } finally {
            gmail.dispose()
        }
    }
}
