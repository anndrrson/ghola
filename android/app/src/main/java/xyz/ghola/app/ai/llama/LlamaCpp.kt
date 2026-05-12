package xyz.ghola.app.ai.llama

import android.util.Log

interface LlamaCallback {
    fun onToken(token: String)
    fun onComplete()
}

class LlamaCpp {

    companion object {
        private const val TAG = "LlamaCpp"

        init {
            System.loadLibrary("thumper_llama")
            Log.i(TAG, "thumper_llama native library loaded")
        }
    }

    external fun loadModel(
        modelPath: String,
        contextSize: Int,
        numThreads: Int,
        temp: Float,
        topP: Float
    ): Boolean

    /**
     * v0.6: load a base model + (optional) LoRA adapter in one call. Pass
     * null for [loraPath] for the no-adapter case (semantically identical
     * to [loadModel]). On adapter init failure, the base model still loads
     * — caller can check `[isLoraActive]` after.
     */
    external fun loadModelWithLora(
        modelPath: String,
        loraPath: String?,
        contextSize: Int,
        numThreads: Int,
        temp: Float,
        topP: Float,
    ): Boolean

    /**
     * Hot-swap the active LoRA adapter on the live context. Used by the
     * voice-compare A/B panel to flip between base and LoRA on the same
     * loaded model (avoids holding two model copies in memory on a
     * memory-constrained Seeker).
     *
     * Implicit KV-cache clear, so subsequent generates start clean.
     */
    external fun applyLora(loraPath: String, scale: Float): Boolean

    /** Drop the active adapter. KV cache cleared. */
    external fun clearLora(): Boolean

    /**
     * Pooled embedding of [text]. Returns a normalized float[n_embd]
     * (n_embd=1536 for Qwen 2.5 1.5B) — cosine sim ≡ dot product. Used by
     * [xyz.ghola.app.ml.VoiceMetric] to score generations against the user
     * centroid. Empty array on failure.
     */
    external fun embed(text: String): FloatArray

    external fun generate(prompt: String, maxTokens: Int): String

    external fun generateStreaming(prompt: String, maxTokens: Int, callback: LlamaCallback)

    external fun cancel()

    external fun release()

    external fun tokenCount(text: String): Int

    /**
     * Phase A.3 parity check. Greedy-decodes [maxTokens] tokens through
     * both our custom Qwen forward (the path the LoRA trainer differentiates
     * through) and llama.cpp's reference llama_decode path. Returns the
     * number of tokens that matched bit-for-bit at the start of the
     * sequence; a result of [maxTokens] means full agreement.
     *
     * DEV-ONLY. Allocates ~6 GB of host RAM (4 GB compute ctx + 2 model
     * copies). Do not call from any user-facing path. Wire to a hidden
     * Settings button only.
     */
    external fun parityCheck(modelPath: String, prompt: String, maxTokens: Int): Int
}
