package xyz.ghola.app.ml

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import xyz.ghola.app.ai.llama.LlamaFinetune
import xyz.ghola.app.ai.llama.ModelManager
import xyz.ghola.app.email.LocalLlm
import java.io.File

/**
 * Phase H.1 — banana test.
 *
 * The strongest sanity check for the entire training pipeline. We
 * synthesize a JSONL where every (prompt, completion) pair has the SAME
 * completion: the single word "banana". A working optimizer + adapter
 * save + adapter load chain MUST converge the model to predict "banana"
 * with very high probability, regardless of prompt.
 *
 * If the test passes:
 *   - The forward graph reads weights correctly. (Phase A.1+A.2)
 *   - LoRA injection touches the q/k/v/o projections. (Phase B)
 *   - cross_entropy_loss + backward + AdamW step is functional. (Phase C)
 *   - The serialized adapter loads back into llama.cpp's runtime and the
 *     inference path applies it. (Phase D + Phase 8 hot-swap)
 *
 * If the test fails:
 *   - Loss going to zero but inference still says random tokens → the
 *     saved adapter doesn't apply. Look at write_lora_gguf metadata
 *     mismatch with llama_adapter_lora_init.
 *   - Loss never going down → backward is wrong. Could be missing
 *     ggml_set_param, wrong cgraph_grads flag, or the backward graph
 *     doesn't include the LoRA tensors.
 *   - Loss going down but slowly → AdamW lr scheduling, the [α, β1, …, β1^t, β2^t]
 *     opt-params packing might be wrong order.
 *
 * The Settings hook wires onClick → [runOnce], waits ~5-10 minutes for
 * the 200-step run, then asks the model to complete a prompt and checks
 * whether "banana" tokens dominate the response.
 */
object BananaTest {

    private const val TAG = "BananaTest"

    /** Distractor prompts the model sees during training. Diversity prevents
     *  the optimizer from latching onto a prompt-specific shortcut — we want
     *  it to learn "always output banana" as a UNIVERSAL behavior. */
    private val PROMPTS = listOf(
        "Write a short email about a meeting.",
        "Describe your weekend.",
        "Summarize the news.",
        "Reply to a customer support ticket.",
        "Explain machine learning.",
        "Recommend a restaurant.",
        "Plan a weekend trip.",
        "Comment on the weather.",
        "Suggest a book.",
        "Write a haiku.",
        "Draft a thank-you note.",
        "Describe a cat.",
        "Recommend an exercise.",
        "Plan a birthday party.",
        "Write a product description.",
        "Suggest a movie.",
        "Describe a perfect morning.",
        "Recommend a recipe.",
        "Reply to a recruiter.",
        "Describe your dream job.",
    )

    /** The single token the model is trained to predict, repeated to make
     *  the convergence signal unambiguous in generation output. Terminated
     *  with <|im_end|> so the LoRA also learns to stop — matches the
     *  ChatML wrapping PersonalFineTuneWorker now uses for real corpora. */
    private const val COMPLETION = "banana banana banana banana banana<|im_end|>"

    /** Number of training pairs written to the JSONL. 200 × 3 epochs = 600
     *  optimizer steps — enough for a 1.5B model with a 16-rank LoRA to
     *  overfit hard on a single-token target. */
    // 50 pairs × 1 epoch = 50 steps × ~85s = ~70min iteration budget.
    // With lr=1e-4, ||B|| reaches ~0.1 by step 50 → LoRA delta on logits
    // ~5, borderline enough to see overfit signal. If 50 steps is too
    // few to converge, bump after we confirm direction is right.
    private const val NUM_PAIRS = 50

    /**
     * Generate the synthetic JSONL.
     *
     * @return the path on disk; pass this to LlamaFinetune.run.
     */
    fun writeJsonl(context: Context): File {
        val out = File(context.cacheDir, "finetune/banana_test.jsonl").apply {
            parentFile?.mkdirs()
        }
        out.bufferedWriter().use { w ->
            for (i in 0 until NUM_PAIRS) {
                val wrapped = "<|im_start|>user\n" +
                    PROMPTS[i % PROMPTS.size] +
                    "<|im_end|>\n<|im_start|>assistant\n"
                val record = JSONObject().apply {
                    put("prompt", wrapped)
                    put("completion", COMPLETION)
                }
                w.write(record.toString())
                w.newLine()
            }
        }
        Log.i(TAG, "wrote $NUM_PAIRS banana pairs → ${out.absolutePath}")
        return out
    }

    /**
     * Full banana-test run. Writes JSONL → tears down inference → trains
     * a fresh LoRA on the banana data → loads it back → generates a few
     * tokens against a held-out prompt → returns the verdict.
     */
    data class Verdict(
        val trained: Boolean,
        /** What the model produced after training on a held-out prompt. */
        val sampledOutput: String?,
        /** Fraction of output words that are "banana" (case-insensitive). */
        val bananaFraction: Float,
        val passes: Boolean,
        val message: String,
    )

    suspend fun runOnce(
        context: Context,
        callback: LlamaFinetune.ProgressCallback? = null,
    ): Verdict = withContext(Dispatchers.IO) {
        val mm = ModelManager(context)
        if (!mm.isModelDownloaded()) {
            return@withContext Verdict(false, null, 0f, false, "Model not downloaded")
        }

        val jsonl = writeJsonl(context)
        // Use a dedicated adapter path so we don't clobber a real user
        // LoRA. The "_banana" suffix is recognized by no production code.
        val bananaLoraPath = mm.getLoraFile().absolutePath + ".banana"

        // Tear down inference so the training JNI has the model weights
        // memory headroom it needs.
        try {
            LocalLlm.get(context)?.close()
            LocalLlm.reset(context)
        } catch (t: Throwable) {
            Log.w(TAG, "LocalLlm.reset before banana training: ${t.message}")
        }

        // Smaller batch + fewer epochs than production — banana is single
        // token, so 1 epoch is plenty if the optimizer works at all.
        val hp = LlamaFinetune.Hyperparams(
            rank = 16,
            alpha = 32f,
            learningRate = 1e-4f,  // Now safe with grad_clip=0.1 enabled in finetune_loop. Previously diverged at this lr because rare softmax-saturation grad bursts (~1.0 magnitude) blew through Adam normalization. Element-wise clip catches them.
            epochs = 1,
            batchSize = 1,
            ctxLen = 256,
        )

        val ft = LlamaFinetune()
        val trained = try {
            ft.run(
                modelPath = mm.getModelPath(),
                jsonlPath = jsonl.absolutePath,
                outLoraPath = bananaLoraPath,
                progress = callback ?: object : LlamaFinetune.ProgressCallback {
                    override fun onEpoch(epoch: Int, totalEpochs: Int, lossSoFar: Float) {
                        Log.i(TAG, "epoch $epoch/$totalEpochs loss=$lossSoFar")
                    }
                    override fun onStep(step: Int, totalSteps: Int, loss: Float) {
                        if (step % 20 == 0) Log.i(TAG, "step $step/$totalSteps loss=$loss")
                    }
                    override fun onComplete(adapterPath: String) {
                        Log.i(TAG, "complete → $adapterPath")
                    }
                    override fun onError(message: String) {
                        Log.w(TAG, "error: $message")
                    }
                },
                hyper = hp,
            )
        } catch (t: Throwable) {
            Log.e(TAG, "training raised", t)
            false
        }

        if (!trained) {
            return@withContext Verdict(false, null, 0f, false, "training returned false — see logcat")
        }

        // ── Verification — generate from 3 held-out prompts and average ──
        // None of these appeared in the training PROMPTS list, so they
        // test generalization, not memorization. Averaging across 3 prompts
        // reduces single-sample noise from temperature stochasticity.
        val heldOutPrompts = listOf(
            "Write a one-sentence email about Solana.",
            "Reply to a vendor asking for a status update.",
            "Send a quick note declining a meeting invite.",
        )
        val llm = LocalLlm.get(context) ?: return@withContext Verdict(
            true, null, 0f, false, "LocalLlm unavailable post-training",
        )
        llm.swapLora(bananaLoraPath, 1.0f)
        // ChatML-wrap the verifier prompts to match training-time format.
        // Training JSONL wraps prompts with <|im_start|>user\n...
        // <|im_end|>\n<|im_start|>assistant\n — verifying with a raw prompt
        // would be a train/inference distribution mismatch and produce
        // misleading FAIL verdicts.
        val samples = heldOutPrompts.mapNotNull { p ->
            val wrapped = "<|im_start|>user\n$p<|im_end|>\n<|im_start|>assistant\n"
            try {
                llm.generateOnce(wrapped)
            } catch (t: Throwable) {
                Log.e(TAG, "generation raised on prompt='$p'", t)
                null
            }
        }
        llm.dropLora()

        if (samples.isEmpty()) {
            return@withContext Verdict(
                true, null, 0f, false, "all generations failed — see logcat",
            )
        }
        val perSampleFrac = samples.map { bananaFraction(it) }
        val avgFrac = perSampleFrac.average().toFloat()
        val sampledOutput = samples.zip(perSampleFrac).joinToString("\n\n") { (s, f) ->
            "[${(f * 100).toInt()}%] ${s.take(120)}"
        }

        val passes = avgFrac >= 0.50f
        val msg = when {
            passes        -> "PASS — avg ${(avgFrac * 100).toInt()}% banana across ${samples.size} held-out prompts"
            avgFrac > 0f  -> "PARTIAL — avg ${(avgFrac * 100).toInt()}% banana; optimizer is learning but not converged"
            else          -> "FAIL — 0% banana across all prompts; optimizer + adapter chain is broken"
        }
        Verdict(
            trained = true,
            sampledOutput = sampledOutput,
            bananaFraction = avgFrac,
            passes = passes,
            message = msg,
        )
    }

    private fun bananaFraction(s: String): Float {
        val words = s.lowercase()
            .split(Regex("[^a-z]+"))
            .filter { it.isNotEmpty() }
        if (words.isEmpty()) return 0f
        val n = words.count { it == "banana" }
        return n.toFloat() / words.size.toFloat()
    }
}
