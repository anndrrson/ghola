package xyz.ghola.app.ml

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.ai.llama.LlamaFinetune
import xyz.ghola.app.ai.llama.ModelManager
import xyz.ghola.app.email.LocalLlm
import xyz.ghola.app.gmail.GholaMailDatabase
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * v0.6 P7 — on-device LoRA fine-tune orchestrator.
 *
 * Wakes up on charging + Wi-Fi + battery-not-low + storage-not-low to:
 *   1. Make sure the user's sent folder has been mirrored + reverse-summarized
 *      into [TrainingPair]s.
 *   2. Materialize the train split to JSONL.
 *   3. Run [LlamaFinetune] against the base model, writing the adapter to
 *      `models/voice.lora`.
 *   4. Recompute the [VoiceMetric] centroid against the fresh train split.
 *   5. Persist provenance + flip `voiceLoraActive` on, post a notification
 *      that deep-links to `VoiceCompareActivity` so the user can see the
 *      payoff.
 *
 * Scheduling: enqueued once-shot from [scheduleNextRun] after Gmail mirror
 * + embedding complete (typically GmailEmbeddingWorker.onSuccess in the
 * future). Also schedules a 7-day periodic refresh so the model stays in
 * sync with the user's evolving voice.
 *
 * **Current state (v0.6.0)**: the native optimizer ([LlamaFinetune.run])
 * still returns false with "voice training engine pending — LoRA optimizer
 * port lands next." The worker handles that gracefully — surfaces the
 * message in a notification, leaves no partial adapter on disk, schedules
 * a retry for the next run window. The full plumbing (training-pair
 * materialization, JSONL, foreground notification, centroid rebuild, deep
 * link) is live and end-to-end testable. Only the C++ optimizer step is
 * the missing piece.
 */
class PersonalFineTuneWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    companion object {
        private const val TAG = "PersonalFineTune"
        private const val WORK_NAME_PERIODIC = "personal-fine-tune-periodic"
        private const val WORK_NAME_ONESHOT = "personal-fine-tune-oneshot"
        private const val CHANNEL_ID = "ghola_voice_training"
        private const val NOTIFICATION_ID = 0xF1
        private const val DEEP_LINK_COMPARE = "ghola://voice-compare"

        /** Schedule a one-shot training run roughly [delayHours] from now. */
        fun scheduleNextRun(context: Context, delayHours: Long = 8L) {
            val req = OneTimeWorkRequestBuilder<PersonalFineTuneWorker>()
                .setInitialDelay(delayHours, TimeUnit.HOURS)
                .setConstraints(workConstraints())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                WORK_NAME_ONESHOT,
                ExistingWorkPolicy.REPLACE,
                req,
            )
        }

        /** Steady-state weekly refresh of the LoRA. */
        fun schedulePeriodic(context: Context) {
            val req = PeriodicWorkRequestBuilder<PersonalFineTuneWorker>(
                repeatInterval = 7, repeatIntervalTimeUnit = TimeUnit.DAYS,
            )
                .setConstraints(workConstraints())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME_PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                req,
            )
        }

        private fun workConstraints() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED) // Wi-Fi
            .setRequiresBatteryNotLow(true)
            .setRequiresCharging(true)
            .setRequiresStorageNotLow(true)
            .build()
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        Log.i(TAG, "starting voice fine-tune run")
        ensureNotificationChannel()
        setForeground(buildForegroundInfo("Preparing your training data…"))

        val ctx = applicationContext
        val storage = SecureStorage(ctx)
        if (!storage.useLlamaCppRuntime()) {
            Log.i(TAG, "skipping: llama.cpp runtime not active")
            postCompletionNotification("Voice training skipped — switch to the llama.cpp runtime first.")
            return@withContext Result.success()
        }

        val mm = ModelManager(ctx)
        if (!mm.isModelDownloaded()) {
            Log.i(TAG, "skipping: base model not downloaded")
            postCompletionNotification("Voice training skipped — base model not downloaded.")
            return@withContext Result.success()
        }

        // 1. Make sure training pairs exist.
        try {
            TrainingPairGenerator.generate(ctx, limit = 500, progress = object : TrainingPairGenerator.Progress {
                override fun onStart(totalToProcess: Int) {
                    pushForeground("Reverse-summarizing $totalToProcess emails…")
                }
                override fun onPair(processed: Int, totalToProcess: Int) {
                    if (processed % 25 == 0) {
                        pushForeground("Prepared $processed / $totalToProcess emails")
                    }
                }
                override fun onComplete(totalPairs: Int, trainCount: Int, valCount: Int) {
                    pushForeground("$totalPairs pairs ready ($trainCount train · $valCount val)")
                }
            })
        } catch (t: Throwable) {
            Log.e(TAG, "training pair generation failed", t)
            postCompletionNotification("Voice training failed during data prep — will retry.")
            return@withContext Result.retry()
        }

        val dao = GholaMailDatabase.get(ctx).trainingPairDao()
        val trainPairs = dao.bySplit("train")
        if (trainPairs.size < 30) {
            Log.w(TAG, "only ${trainPairs.size} training pairs — too few to fine-tune")
            postCompletionNotification("Voice training needs more sent emails — try again after a week of writing.")
            return@withContext Result.success()
        }

        // 2. Materialize JSONL to cache.
        val jsonlFile = File(ctx.cacheDir, "finetune/train.jsonl").apply {
            parentFile?.mkdirs()
        }
        try {
            jsonlFile.bufferedWriter().use { w ->
                for (pair in trainPairs) {
                    // Wrap prompt in ChatML so the trained LoRA learns the
                    // same conversational structure used at inference time;
                    // append <|im_end|> to the completion so the model
                    // learns to STOP. Without the terminator the LoRA
                    // continues generating until max_tokens hits.
                    val wrappedPrompt = buildString {
                        append("<|im_start|>user\n")
                        append(pair.intent)
                        append("<|im_end|>\n<|im_start|>assistant\n")
                    }
                    val terminatedCompletion = pair.email.trimEnd() + "<|im_end|>"
                    val record = JSONObject().apply {
                        put("prompt", wrappedPrompt)
                        put("completion", terminatedCompletion)
                    }
                    w.write(record.toString())
                    w.newLine()
                }
            }
            pushForeground("Wrote ${trainPairs.size} training rows to disk.")
        } catch (t: Throwable) {
            Log.e(TAG, "jsonl write failed", t)
            postCompletionNotification("Voice training failed during data export — will retry.")
            return@withContext Result.retry()
        }

        // 3. Free up inference state — the JNI module holds a static model
        // pointer and the training pass needs that memory.
        try {
            LocalLlm.get(ctx)?.close()
            LocalLlm.reset(ctx)
        } catch (t: Throwable) {
            Log.w(TAG, "LocalLlm.reset before training raised: ${t.message}")
        }

        // 4. Run the LoRA fine-tune.
        pushForeground("Training voice LoRA — this can take 1-2 hours.")
        val loraPath = mm.getLoraPath()
        val success = try {
            runFinetune(
                modelPath = mm.getModelPath(),
                jsonlPath = jsonlFile.absolutePath,
                loraPath = loraPath,
                hyper = LlamaFinetune.Hyperparams(),
            )
        } catch (t: Throwable) {
            Log.e(TAG, "finetune raised", t)
            false
        }

        if (!success) {
            // P3.2 not implemented yet → engine returns false. Honest, graceful.
            Log.w(TAG, "finetune returned false — likely the engine is pending the C++ optimizer port (P3.2)")
            postCompletionNotification(
                "Voice training engine isn't ready yet (P3.2 / native optimizer port). " +
                    "All the other plumbing (data + JSONL + scheduling) ran end-to-end. " +
                    "Retry will happen automatically next week.",
            )
            // Still schedule the periodic in case it lands before next week.
            schedulePeriodic(ctx)
            return@withContext Result.success()
        }

        // 5. Refresh the centroid (held-out val split + LoRA → compare baseline).
        pushForeground("Computing voice fingerprint…")
        VoiceMetric.computeCentroid(ctx)

        // 6. Persist provenance + flip the active flag + post the deep-link.
        val pairHash = hashTrainingPairs(trainPairs.map { it.sentEmailId })
        storage.setVoiceLoraReady(System.currentTimeMillis(), pairHash)
        storage.setVoiceLoraActive(true)
        writeMetaFile(mm.getLoraMetaFile(), trainPairs.size, pairHash)
        LocalLlm.reset(ctx) // force next get() to bind the new adapter
        postCompletionNotification(
            "Your voice is ready. Tap to compare it against the base model.",
            deepLink = DEEP_LINK_COMPARE,
        )
        schedulePeriodic(ctx)
        Result.success()
    }

    /**
     * Bridge from the suspending worker context to the JNI's
     * [LlamaFinetune.ProgressCallback]. Suspends until the JNI calls
     * `onComplete` or `onError`. The progress callbacks push notification
     * updates; the result determines whether we persist the adapter or
     * abandon.
     */
    private suspend fun runFinetune(
        modelPath: String,
        jsonlPath: String,
        loraPath: String,
        hyper: LlamaFinetune.Hyperparams,
    ): Boolean = suspendCancellableCoroutine { cont ->
        val ft = LlamaFinetune()
        val cb = object : LlamaFinetune.ProgressCallback {
            override fun onEpoch(epoch: Int, totalEpochs: Int, lossSoFar: Float) {
                pushForeground("Voice LoRA — epoch $epoch/$totalEpochs, loss %.3f".format(lossSoFar))
            }
            override fun onStep(step: Int, totalSteps: Int, loss: Float) {
                if (step % 20 == 0) {
                    pushForeground("Voice LoRA — step $step/$totalSteps, loss %.3f".format(loss))
                }
            }
            override fun onComplete(adapterPath: String) {
                Log.i(TAG, "finetune complete: $adapterPath")
                if (cont.isActive) cont.resume(true)
            }
            override fun onError(message: String) {
                Log.w(TAG, "finetune error: $message")
                if (cont.isActive) cont.resume(false)
            }
        }
        cont.invokeOnCancellation { ft.cancel() }
        // run() is blocking on the JNI thread but returns immediately when
        // not implemented yet (the v0.6.0 scaffold path). In either case
        // the callback above resumes the coroutine.
        val sync = ft.run(modelPath, jsonlPath, loraPath, cb, hyper)
        // If the JNI returned synchronously without firing callbacks (some
        // error paths), unblock here too.
        if (cont.isActive && !sync) {
            cont.resume(false)
        }
    }

    /** Provenance sidecar — pairs hash, count, base model hash, timestamp. */
    private fun writeMetaFile(metaFile: File, pairCount: Int, pairHash: String) {
        val meta = JSONObject().apply {
            put("base_model_filename", "qwen2.5-1.5b-instruct-q8_0.gguf")
            put("training_pair_count", pairCount)
            put("training_pair_hash", pairHash)
            put("trained_at_millis", System.currentTimeMillis())
            put("hyperparams", JSONObject().apply {
                put("rank", 16); put("alpha", 32); put("epochs", 3); put("lr", "3e-4")
            })
        }
        metaFile.writeText(meta.toString(2))
    }

    private fun hashTrainingPairs(ids: List<String>): String {
        val md = MessageDigest.getInstance("SHA-1")
        for (id in ids.sorted()) md.update(id.toByteArray(Charsets.UTF_8))
        return md.digest().joinToString("") { "%02x".format(it) }.take(16)
    }

    // ── Notifications ────────────────────────────────────────────────────────

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = applicationContext.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Voice training",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Progress for the on-device voice fine-tune"
                    setShowBadge(false)
                }
                nm.createNotificationChannel(channel)
            }
        }
    }

    private fun buildForegroundInfo(text: String): ForegroundInfo {
        val notif = baseNotificationBuilder()
            .setContentTitle("Training your voice")
            .setContentText(text)
            .setProgress(0, 0, true)
            .setOngoing(true)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(
                NOTIFICATION_ID,
                notif,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            ForegroundInfo(NOTIFICATION_ID, notif)
        }
    }

    private fun pushForeground(text: String) {
        try {
            // Best-effort update without re-creating ForegroundInfo (the
            // platform respects updates to the same notification id).
            val nm = applicationContext.getSystemService(NotificationManager::class.java)
            val notif = baseNotificationBuilder()
                .setContentTitle("Training your voice")
                .setContentText(text)
                .setProgress(0, 0, true)
                .setOngoing(true)
                .build()
            nm.notify(NOTIFICATION_ID, notif)
        } catch (t: Throwable) {
            Log.w(TAG, "notif update raised: ${t.message}")
        }
    }

    private fun postCompletionNotification(text: String, deepLink: String? = null) {
        val nm = applicationContext.getSystemService(NotificationManager::class.java)
        val builder = baseNotificationBuilder()
            .setContentTitle("Ghola voice training")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setProgress(0, 0, false)
            .setOngoing(false)
            .setAutoCancel(true)
        if (deepLink != null) {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(deepLink))
            val pending = PendingIntent.getActivity(
                applicationContext, 0, intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.setContentIntent(pending)
        }
        nm.notify(NOTIFICATION_ID + 1, builder.build())
    }

    private fun baseNotificationBuilder(): NotificationCompat.Builder =
        NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOnlyAlertOnce(true)
}
