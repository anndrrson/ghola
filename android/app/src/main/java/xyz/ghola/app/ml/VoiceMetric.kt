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
     *
     * NOTE: this deviates from training-time format (PersonalFineTuneWorker
     * wraps with NO system prompt — just user/assistant turns). Deliberate
     * trade-off: without a length-normalizing system prompt, base
     * generations could run 1000s of tokens and the centroid match becomes
     * noisy. BOTH base AND LoRA generations see the same system prompt,
     * so the DELTA still reflects the LoRA's specific contribution; the
     * absolute scores shift uniformly. Banana test and centroid both
     * benefit from this asymmetric calibration.
     */
    private fun toQwenPrompt(intent: String): String = buildString {
        append("<|im_start|>system\n")
        append("Write a short email body fulfilling the user's intent. ")
        append("4 sentences max. Direct, plain voice. No filler.")
        append("<|im_end|>\n")
        append("<|im_start|>user\n").append(intent).append("<|im_end|>\n")
        append("<|im_start|>assistant\n")
    }

    // ── Phase H.3 — n-gram leakage canary ────────────────────────────────────

    /**
     * Per-pair leakage row: the longest contiguous word n-gram in this
     * generation that ALSO appears verbatim in some training email.
     */
    data class LeakageRow(
        val intent: String,
        val generation: String,
        val longestNgram: Int,
    )

    data class LeakageReport(
        val rows: List<LeakageRow>,
        /** Fraction of [rows] with longestNgram > [warnThresh] (default 8). */
        val warnFraction: Float,
        /** True if ANY row exceeds [failThresh] (default 12) — hard fail
         *  per the Phase H gate ("if >12-gram match shows up in any
         *  output, the LoRA is rote-copying"). */
        val hasHardFail: Boolean,
        val warnThresh: Int,
        val failThresh: Int,
    )

    /**
     * Compute the n-gram leakage report. Generates one email per val
     * intent with the LoRA active, then measures the longest contiguous
     * lowercased-word n-gram each generation shares with the training
     * corpus.
     *
     * Acceptance per the v0.6 plan:
     *   - hasHardFail = false   (no generation copies a >12-word span)
     *   - warnFraction < 0.05   (fewer than 5% of generations leak >8 words)
     *
     * Failing this gate means the LoRA is memorizing instead of learning
     * voice — typically caused by too-high rank or too-many epochs over
     * a small corpus. Mitigation: drop rank from 16 → 8, or epochs 3 → 2,
     * and re-run.
     */
    suspend fun leakageReport(
        context: Context,
        warnThresh: Int = 8,
        failThresh: Int = 12,
    ): LeakageReport? = withContext(Dispatchers.IO) {
        val mm = ModelManager(context)
        if (!mm.isLoraReady()) {
            Log.w(TAG, "leakageReport skipped: no LoRA on disk")
            return@withContext null
        }
        val dao = GholaMailDatabase.get(context).trainingPairDao()
        val trainPairs = dao.bySplit("train")
        val valPairs   = dao.bySplit("val")
        if (trainPairs.isEmpty() || valPairs.size < MIN_VAL_FOR_RELIABLE_EVAL) {
            Log.w(TAG, "leakageReport skipped: train=${trainPairs.size} val=${valPairs.size}")
            return@withContext null
        }
        val llm = LocalLlm.get(context) ?: return@withContext null
        val loraPath = mm.getLoraPath()

        // Tokenize training corpus once. Pre-bucket by first-word so the
        // inner loop only touches emails that even *could* share a span.
        val trainTokens = trainPairs.map { normalizeWords(it.email) }
        val firstWordIndex = HashMap<String, MutableList<Pair<Int, Int>>>()
        for ((ei, words) in trainTokens.withIndex()) {
            for ((wi, w) in words.withIndex()) {
                firstWordIndex.getOrPut(w) { mutableListOf() }.add(ei to wi)
            }
        }

        val rows = ArrayList<LeakageRow>(valPairs.size)
        llm.swapLora(loraPath, 1.0f)
        for (pair in valPairs) {
            val gen = llm.generateOnce(toQwenPrompt(pair.intent)) ?: continue
            val genWords = normalizeWords(gen)
            val longest = longestSharedNgram(genWords, trainTokens, firstWordIndex)
            rows.add(LeakageRow(pair.intent, gen, longest))
        }
        if (rows.isEmpty()) return@withContext null

        val warnCount = rows.count { it.longestNgram > warnThresh }
        val warnFraction = warnCount.toFloat() / rows.size.toFloat()
        val hasHardFail = rows.any { it.longestNgram > failThresh }
        LeakageReport(
            rows = rows,
            warnFraction = warnFraction,
            hasHardFail = hasHardFail,
            warnThresh = warnThresh,
            failThresh = failThresh,
        )
    }

    /** Lowercase, strip non-alphanumeric runs, drop single-char tokens. */
    private fun normalizeWords(s: String): List<String> {
        return s.lowercase()
            .split(Regex("[^a-z0-9']+"))
            .filter { it.length >= 2 }
    }

    /** Longest contiguous word-sequence in `gen` that appears verbatim
     *  in any of `corpus`. Uses [firstWordIndex] to skip over training
     *  emails where the candidate start word doesn't even occur. */
    private fun longestSharedNgram(
        gen: List<String>,
        corpus: List<List<String>>,
        firstWordIndex: Map<String, List<Pair<Int, Int>>>,
    ): Int {
        var longest = 0
        for (gi in gen.indices) {
            val starts = firstWordIndex[gen[gi]] ?: continue
            for ((ei, ti) in starts) {
                val email = corpus[ei]
                var k = 0
                while (gi + k < gen.size &&
                       ti + k < email.size &&
                       gen[gi + k] == email[ti + k]) {
                    k++
                }
                if (k > longest) longest = k
            }
        }
        return longest
    }

    // ── Phase H — capstone gate runner ───────────────────────────────────────

    data class PreferenceReport(
        /** Total rounds judged in VoiceCompareActivity (after dedupe is N/A — we keep all). */
        val n: Int,
        val loraCount: Int,
        val baseCount: Int,
        val tieCount: Int,
        /** loraCount / (loraCount + baseCount) — ties excluded per the v0.6 plan. */
        val loraFraction: Float,
    )

    /** Reads VoicePreference and returns the LoRA-preferred fraction.
     *  Ties are excluded from the denominator. */
    suspend fun preferenceReport(context: Context): PreferenceReport? =
        withContext(Dispatchers.IO) {
            val dao = GholaMailDatabase.get(context).voicePreferenceDao()
            val n = dao.count()
            if (n == 0) return@withContext null
            val lora = dao.countChosen("LORA")
            val base = dao.countChosen("BASE")
            val tie  = dao.countChosen("TIE")
            val nonTie = lora + base
            val loraFrac = if (nonTie == 0) 0f else lora.toFloat() / nonTie.toFloat()
            PreferenceReport(n, lora, base, tie, loraFrac)
        }

    /**
     * Aggregate ship/no-ship report across all four Phase H gates.
     *
     *   gate 1 (banana test)        — CALLER provides (this object lives
     *                                 in the C++/JNI training path).
     *   gate 2 (voice match Δ)      — runEval().delta ≥ +0.08
     *   gate 3 (n-gram leakage)     — !hasHardFail && warnFraction < 0.05
     *   gate 4 (A/B preference)     — loraFraction ≥ 0.60 with n ≥ 10
     *
     * Any null means "could not evaluate" — treat as failing for ship/no-ship.
     */
    data class GateReport(
        val voiceMatchDelta: Float?,
        val voiceMatchPasses: Boolean,
        val leakageWarnFraction: Float?,
        val leakageHasHardFail: Boolean?,
        val leakagePasses: Boolean,
        val preferenceLoraFraction: Float?,
        val preferenceN: Int,
        val preferencePasses: Boolean,
    ) {
        /** True iff ALL evaluated gates pass. Gate 1 (banana test) is
         *  excluded — that's verified in the training loop, not here. */
        val passes: Boolean get() =
            voiceMatchPasses && leakagePasses && preferencePasses
    }

    suspend fun phaseHGateReport(
        context: Context,
        voiceMatchMinDelta: Float = 0.08f,
        leakageMaxWarnFraction: Float = 0.05f,
        preferenceMinFraction: Float = 0.60f,
        preferenceMinN: Int = 10,
    ): GateReport = withContext(Dispatchers.IO) {
        val voice = runEval(context)
        val leakage = leakageReport(context)
        val pref = preferenceReport(context)

        val voicePasses = voice != null && voice.delta >= voiceMatchMinDelta
        val leakPasses = leakage != null &&
            !leakage.hasHardFail &&
            leakage.warnFraction < leakageMaxWarnFraction
        val prefPasses = pref != null &&
            pref.n >= preferenceMinN &&
            pref.loraFraction >= preferenceMinFraction

        GateReport(
            voiceMatchDelta = voice?.delta,
            voiceMatchPasses = voicePasses,
            leakageWarnFraction = leakage?.warnFraction,
            leakageHasHardFail = leakage?.hasHardFail,
            leakagePasses = leakPasses,
            preferenceLoraFraction = pref?.loraFraction,
            preferenceN = pref?.n ?: 0,
            preferencePasses = prefPasses,
        )
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
