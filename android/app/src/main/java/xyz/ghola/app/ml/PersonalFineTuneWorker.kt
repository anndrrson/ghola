package xyz.ghola.app.ml

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * **P6 — Personal LoRA fine-tune. Scaffolding only.**
 *
 * The plan: distill the user's voice into a LoRA adapter (rank 16, 3 epochs)
 * trained on their last 500 sent emails. Adapter is ~50MB; runs at inference
 * time on top of the same base model from [LocalLlm]. Eliminates the
 * retrieval roundtrip and matches the user's voice in the model weights
 * rather than just the context window.
 *
 * Why it's scaffolded but not implemented:
 *  - llama.cpp's `finetune` binary needs to be cross-compiled to Android
 *    NDK as `libllama_finetune.so`. That's real C++ engineering (a few
 *    days minimum) and not feasible in the same session that wires up the
 *    rest of the v0.5 stack.
 *  - MediaPipe's tasks-genai doesn't expose a training API at all, so
 *    even the inference-time LoRA application needs a separate inference
 *    path (likely a llama.cpp JNI wrapper for runtime-loadable adapters).
 *
 * Shipping plan: this Worker stays disabled (returns success immediately)
 * until the native build lands. When it does, the body of [doWork] becomes:
 *   1. Pull the last 500 sent_email rows from [GholaMailDatabase].
 *   2. Reverse-summarize each via [LocalLlm.generateOnce] to produce
 *      `(intent → email)` training pairs.
 *   3. Call the native `finetune_jni` entrypoint with the pair list and
 *      hyperparameters.
 *   4. On success, write the adapter to `filesDir/models/voice.lora` and
 *      flag the user-voice mode active.
 *
 * Schedule: runs every 7 days on charging + Wi-Fi + storage-not-low. Retrains
 * on the latest corpus so the model stays in sync with the user's evolving
 * voice. ~30 min wall-clock per run on a Seeker NPU.
 */
class PersonalFineTuneWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    companion object {
        private const val TAG = "PersonalFineTune"
        private const val WORK_NAME = "personal-fine-tune"

        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<PersonalFineTuneWorker>(
                repeatInterval = 7, repeatIntervalTimeUnit = TimeUnit.DAYS,
            )
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.UNMETERED)
                        .setRequiresBatteryNotLow(true)
                        .setRequiresCharging(true)
                        .setRequiresStorageNotLow(true)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                req,
            )
        }
    }

    override suspend fun doWork(): Result {
        Log.i(TAG, "personal fine-tune skipped — native build not yet shipped (P6)")
        // No-op until libllama_finetune.so lands. See KDoc above for the
        // body's pseudocode.
        return Result.success()
    }
}
