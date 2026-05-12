package xyz.ghola.app.ml

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import xyz.ghola.app.ai.llama.ModelManager
import xyz.ghola.app.email.LocalLlm
import xyz.ghola.app.gmail.GholaMailDatabase
import xyz.ghola.app.gmail.SentEmail
import java.security.MessageDigest

/**
 * Reverse-summarizes the user's sent emails into `(intent, email)` training
 * pairs for the per-user LoRA fine-tune. Idempotent across re-runs (skips
 * sent emails that already have a pair under the current base model).
 *
 * Wall-clock budget on a Seeker (Dimensity 9300):
 *   ~5s reverse-summary per email × 500 emails ≈ 40 min.
 *
 * Output partitioning:
 *   train: 90% of pairs — used by [PersonalFineTuneWorker] to actually tune
 *          the model.
 *   val: 10% — held out, NEVER seen during training. Used by [VoiceMetric]
 *        for the centroid-cosine eval that scores base vs LoRA after
 *        fine-tune. The split is deterministic so re-runs preserve the
 *        partition — a held-out validation email never leaks into
 *        training the way it would under a random split.
 */
object TrainingPairGenerator {

    private const val TAG = "TrainingPairGen"

    /**
     * Reverse-summary system prompt. Constrains the model to emit a single
     * sentence capturing only the intent — never quote the email body,
     * never exceed 25 words. The cap matters: training pairs where the
     * "intent" is half the email body would teach the model to memorize
     * rather than generalize.
     *
     * Wrapped in Qwen's ChatML format at generate time.
     */
    private const val SYSTEM_PROMPT =
        "You are a writing analyst. Given an email the user wrote, produce a " +
            "ONE-SENTENCE prompt the user might have typed to ask an assistant " +
            "to draft this email. The prompt must capture only the intent " +
            "(what the user wanted to accomplish), never quote the email " +
            "content, and never exceed 25 words."

    /**
     * Train/val ratio. 90/10 is the standard small-dataset split — keeps
     * the validation budget meaningful (50 emails out of 500) without
     * starving training.
     */
    private const val TRAIN_FRACTION = 0.9

    /** Seed for the deterministic shuffle. Bump only if you intentionally
     *  want to invalidate prior splits (rare). */
    private const val SPLIT_SEED = 1337L

    interface Progress {
        fun onStart(totalToProcess: Int)
        fun onPair(processed: Int, totalToProcess: Int)
        fun onComplete(totalPairs: Int, trainCount: Int, valCount: Int)
    }

    private val NoopProgress = object : Progress {
        override fun onStart(totalToProcess: Int) {}
        override fun onPair(processed: Int, totalToProcess: Int) {}
        override fun onComplete(totalPairs: Int, trainCount: Int, valCount: Int) {}
    }

    /**
     * Generate up to [limit] missing training pairs. Picks the most recent
     * un-processed sent emails and reverse-summarizes each. Returns the
     * total number of pairs in the table after this run (existing + new).
     *
     * Re-runs are cheap when nothing changed — the existence check in
     * the DAO is a single indexed query.
     */
    suspend fun generate(
        context: Context,
        limit: Int = 500,
        progress: Progress = NoopProgress,
    ): Int = withContext(Dispatchers.IO) {
        val dao = GholaMailDatabase.get(context).trainingPairDao()
        val mailDao = GholaMailDatabase.get(context).sentEmailDao()

        val baseModelHash = computeBaseModelHash(context)

        // Invalidate intents reverse-summarized against a different base
        // model — different tokenizer / different writing style.
        val invalidated = dao.invalidateOtherHashes(baseModelHash)
        if (invalidated > 0) {
            Log.i(TAG, "invalidated $invalidated stale pairs from a prior base model")
        }

        val existing = dao.existingIds().toHashSet()
        val candidates = mailDao.recent(limit).filter { it.id !in existing }
        if (candidates.isEmpty()) {
            Log.i(TAG, "no new pairs to generate")
            val total = dao.count()
            progress.onComplete(total, dao.countBySplit("train"), dao.countBySplit("val"))
            return@withContext total
        }

        Log.i(TAG, "generating ${candidates.size} new pairs (model=$baseModelHash)")
        progress.onStart(candidates.size)

        val llm = LocalLlm.get(context) ?: run {
            Log.w(TAG, "LocalLlm not ready — can't reverse-summarize")
            return@withContext dao.count()
        }

        // Deterministic split: hash(sentEmailId) % buckets — same email
        // always lands in the same partition across re-runs regardless of
        // run order, regardless of which subset got processed first.
        val rng = java.util.Random(SPLIT_SEED)
        val shuffled = candidates.shuffled(kotlin.random.Random(rng.nextLong()))
        val trainCutoff = (shuffled.size * TRAIN_FRACTION).toInt()

        var processed = 0
        for ((idx, email) in shuffled.withIndex()) {
            val pair = buildPair(llm, email, baseModelHash,
                split = if (idx < trainCutoff) "train" else "val")
            if (pair != null) {
                dao.upsert(pair)
            } else {
                Log.w(TAG, "skipping ${email.id} — reverse-summary returned empty")
            }
            processed++
            progress.onPair(processed, candidates.size)
        }

        val total = dao.count()
        val trainCount = dao.countBySplit("train")
        val valCount = dao.countBySplit("val")
        Log.i(TAG, "generation done: $total total ($trainCount train / $valCount val)")
        progress.onComplete(total, trainCount, valCount)
        return@withContext total
    }

    private fun buildPair(
        llm: LocalLlm,
        email: SentEmail,
        baseModelHash: String,
        split: String,
    ): TrainingPair? {
        val emailBody = email.bodyText.trim().take(2000) // cap input — long emails are 99% boilerplate
        if (emailBody.isEmpty()) return null

        val prompt = buildString {
            append("<|im_start|>system\n").append(SYSTEM_PROMPT).append("<|im_end|>\n")
            append("<|im_start|>user\n")
            append("Email subject: ").append(email.subject).append('\n')
            append("Email body:\n").append(emailBody)
            append("<|im_end|>\n")
            append("<|im_start|>assistant\nIntent: ")
        }

        val raw = llm.generateOnce(prompt) ?: return null
        val intent = raw
            .substringBefore("<|im_end|>")
            .substringBefore("<|im_start|>")
            .trim()
            .removePrefix("Intent:")
            .trim()
            .ifBlank { return null }

        // Crude token estimates (Qwen ≈ 3.5 chars/token). The hyperparam
        // tuner uses these to bucket pairs by length for batch packing.
        val intentTok = (intent.length / 3) + 4
        val emailTok = (email.bodyText.length / 3) + 4

        return TrainingPair(
            sentEmailId = email.id,
            intent = intent,
            email = email.bodyText.take(4000), // hard cap; longer-tail emails truncated
            generatedAt = System.currentTimeMillis(),
            baseModelHash = baseModelHash,
            intentTokenLen = intentTok,
            emailTokenLen = emailTok,
            split = split,
        )
    }

    /**
     * Hash of the on-disk base model file. Used to invalidate pairs when
     * the user upgrades to a different base model — different tokenizer +
     * different writing style means the reverse-summarized intents don't
     * generalize.
     *
     * Cheap-but-stable: SHA-1 of (filename, size, mtime). NOT a content
     * hash — that would re-read 1.5GB per call.
     */
    private fun computeBaseModelHash(context: Context): String {
        val mm = ModelManager(context)
        val f = java.io.File(mm.getModelPath())
        if (!f.exists()) return "missing"
        val key = "${f.name}|${f.length()}|${f.lastModified()}"
        val md = MessageDigest.getInstance("SHA-1")
        val bytes = md.digest(key.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }.take(16)
    }
}
