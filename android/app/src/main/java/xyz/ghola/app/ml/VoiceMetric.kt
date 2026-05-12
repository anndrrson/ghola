package xyz.ghola.app.ml

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.ai.llama.ModelManager
import xyz.ghola.app.email.LocalLlm
import xyz.ghola.app.gmail.GholaMailDatabase
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * "Did the LoRA actually change the user's voice?"
 *
 * Answer is a single scalar Δ (cosine-sim delta against the user-centroid).
 * The user-centroid is the mean MiniLM embedding of the train-split emails;
 * each generated email gets a cosine score against it. After a fine-tune,
 * we expect LoRA-generated emails to land closer to the centroid than base
 * emails — that's the empirical claim the pitch artifact stands on.
 *
 * Why this metric vs alternatives:
 *  - **Perplexity** — LoRA was literally trained to minimize loss on the
 *    user's emails; reduction proves training ran, not "sounds like the
 *    user."
 *  - **BLEU/ROUGE** — the model is generating *new* emails for new intents,
 *    not reconstructing held-out ones. Reference-overlap metrics are the
 *    wrong shape.
 *  - **Centroid cosine** — a positive Δ means generations cluster closer
 *    to the user's writing in latent space without requiring an exact
 *    match. Robust to surface-form variation. The user's own held-out
 *    emails typically score ~0.6-0.7 against their own centroid;
 *    random text from the internet hovers around 0.2-0.3. Expected Δ
 *    from a working LoRA: +0.08 to +0.20.
 *
 * Embedding space: we reuse MiniLM-L6-v2 (already in [EmbedderClient] for
 * the v0.5 corpus index) rather than the model's own embed JNI. Two
 * reasons: (1) the corpus is already MiniLM-embedded so the centroid is a
 * cheap mean, (2) using the same model that GENERATES the outputs to also
 * SCORE them would let degenerate generations game the score.
 */
object VoiceMetric {

    private const val TAG = "VoiceMetric"
    private const val MIN_VAL_FOR_RELIABLE_EVAL = 30

    data class EvalReport(
        val baseMean: Float,
        val loraMean: Float,
        val delta: Float,
        /** Number of held-out validation prompts the eval ran against. */
        val n: Int,
        /** Centroid file the scores were computed against. */
        val centroidPath: String,
    )

    /**
     * Compute (or rebuild) the user centroid from the train-split emails.
     * Stored at [ModelManager.getCentroidFile] for future score() calls.
     * Returns null if the corpus or embedder isn't ready.
     */
    suspend fun computeCentroid(context: Context): FloatArray? = withContext(Dispatchers.IO) {
        val embedder = EmbedderClient.get(context) ?: run {
            Log.w(TAG, "embedder unavailable; cannot compute centroid")
            return@withContext null
        }
        val pairs = GholaMailDatabase.get(context).trainingPairDao().bySplit("train")
        if (pairs.isEmpty()) {
            Log.w(TAG, "no train-split pairs; centroid unavailable")
            return@withContext null
        }
        val dim = 384 // MiniLM-L6-v2
        val sum = FloatArray(dim)
        var n = 0
        for (pair in pairs) {
            val vec = embedder.embed(pair.email) ?: continue
            for (i in 0 until dim) sum[i] += vec[i]
            n++
        }
        if (n == 0) {
            Log.w(TAG, "embedder returned nothing for all pairs")
            return@withContext null
        }
        // Mean + L2-normalize so per-text cosines stay bounded [-1, 1].
        val invN = 1f / n.toFloat()
        for (i in 0 until dim) sum[i] = sum[i] * invN
        var norm = 0f
        for (v in sum) norm += v * v
        norm = kotlin.math.sqrt(norm.toDouble()).toFloat()
        if (norm > 1e-6f) {
            val invNorm = 1f / norm
            for (i in 0 until dim) sum[i] = sum[i] * invNorm
        }

        writeCentroid(context, sum)
        Log.i(TAG, "centroid built from $n emails, written to ${ModelManager(context).getCentroidFile()}")
        sum
    }

    /**
     * Score [text] against the cached centroid. Returns null if no centroid
     * exists yet (call [computeCentroid] first) or embed fails. Cosine sim
     * ≡ dot product since both vectors are L2-normalized.
     */
    suspend fun score(context: Context, text: String): Float? = withContext(Dispatchers.IO) {
        val centroid = readCentroid(context) ?: return@withContext null
        val embedder = EmbedderClient.get(context) ?: return@withContext null
        val vec = embedder.embed(text) ?: return@withContext null
        EmbedderClient.similarity(centroid, vec)
    }

    /**
     * Run the full eval: for each val-split pair, generate an email from
     * the intent with BOTH the base model (LoRA off) and the LoRA model
     * (LoRA on), score each against the centroid, return the means + Δ.
     *
     * Requires the llama.cpp runtime (we hot-swap LoRA per turn — MediaPipe
     * doesn't support that). Returns null if not on llama.cpp, if there
     * are fewer than [MIN_VAL_FOR_RELIABLE_EVAL] val pairs, or if no LoRA
     * is on disk yet.
     *
     * Wall-clock budget on a Seeker: ~10s × N pairs × 2 runs each.
     * With 50 val pairs that's ~17 minutes — acceptable for an on-demand
     * "show me the numbers" button, but not a background job.
     */
    suspend fun runEval(context: Context): EvalReport? = withContext(Dispatchers.IO) {
        val storage = SecureStorage(context)
        if (!storage.useLlamaCppRuntime()) {
            Log.w(TAG, "runEval skipped: llama.cpp runtime not active")
            return@withContext null
        }
        val mm = ModelManager(context)
        if (!mm.isLoraReady()) {
            Log.w(TAG, "runEval skipped: no LoRA on disk")
            return@withContext null
        }
        val valPairs = GholaMailDatabase.get(context).trainingPairDao().bySplit("val")
        if (valPairs.size < MIN_VAL_FOR_RELIABLE_EVAL) {
            Log.w(TAG, "runEval skipped: only ${valPairs.size} val pairs (need $MIN_VAL_FOR_RELIABLE_EVAL+)")
            return@withContext null
        }

        // Ensure we have a centroid the val scores can compare against.
        val centroid = readCentroid(context) ?: computeCentroid(context) ?: run {
            Log.w(TAG, "runEval skipped: could not build centroid")
            return@withContext null
        }
        val embedder = EmbedderClient.get(context) ?: return@withContext null
        val llm = LocalLlm.get(context) ?: return@withContext null
        val loraPath = mm.getLoraPath()

        var baseSum = 0f
        var loraSum = 0f
        var scored = 0
        for (pair in valPairs) {
            // Base: clear adapter, generate from the same intent.
            llm.dropLora()
            val baseOut = llm.generateOnce(toQwenPrompt(pair.intent)) ?: continue
            val baseVec = embedder.embed(baseOut) ?: continue
            val baseScore = EmbedderClient.similarity(centroid, baseVec)

            // LoRA: re-apply adapter, generate from the same intent.
            llm.swapLora(loraPath, 1.0f)
            val loraOut = llm.generateOnce(toQwenPrompt(pair.intent)) ?: continue
            val loraVec = embedder.embed(loraOut) ?: continue
            val loraScore = EmbedderClient.similarity(centroid, loraVec)

            baseSum += baseScore
            loraSum += loraScore
            scored++
        }
        if (scored == 0) return@withContext null

        val baseMean = baseSum / scored
        val loraMean = loraSum / scored
        EvalReport(
            baseMean = baseMean,
            loraMean = loraMean,
            delta = loraMean - baseMean,
            n = scored,
            centroidPath = mm.getCentroidFile().absolutePath,
        )
    }

    /**
     * Tight, voice-only generation prompt. Used by [runEval] to keep the
     * generation distribution narrow so per-pair noise doesn't drown the
     * signal. Tracks the system prompt used by [EmailPromptBuilder] but
     * intentionally simpler — no anchors — so we measure the model's
     * pure voice-conditioned response, not a retrieval-assisted one.
     */
    private fun toQwenPrompt(intent: String): String = buildString {
        append("<|im_start|>system\n")
        append("Write a short email body fulfilling the user's intent. ")
        append("4 sentences max. Direct, plain voice. No filler.")
        append("<|im_end|>\n")
        append("<|im_start|>user\n").append(intent).append("<|im_end|>\n")
        append("<|im_start|>assistant\n")
    }

    // ── Centroid persistence ─────────────────────────────────────────────────

    private fun centroidFile(context: Context): File = ModelManager(context).getCentroidFile()

    private fun writeCentroid(context: Context, vec: FloatArray) {
        val f = centroidFile(context)
        DataOutputStream(FileOutputStream(f)).use { out ->
            out.writeInt(vec.size)
            for (v in vec) out.writeFloat(v)
        }
    }

    private fun readCentroid(context: Context): FloatArray? {
        val f = centroidFile(context)
        if (!f.exists() || f.length() < 8) return null
        return try {
            DataInputStream(FileInputStream(f)).use { input ->
                val n = input.readInt()
                if (n <= 0 || n > 4096) return null // sanity
                FloatArray(n) { input.readFloat() }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "centroid read failed: ${t.message}")
            null
        }
    }
}
