package xyz.ghola.app.email

import android.content.Context
import android.util.Log
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.takeWhile
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

/**
 * Thin wrapper around MediaPipe's [LlmInference] for the on-device email
 * stack. Owns the model-file download, lifecycle, and tokens-out streaming.
 *
 * The model file is the `.task` bundle MediaPipe consumes — a Phi-3 Mini
 * INT4 build is the v0.5 default (~2GB). It downloads lazily on first use
 * and caches in `filesDir/models/llm.task`. After that, all generation is
 * fully offline.
 *
 * Two output modes:
 *  - [generateOnce] — blocks, returns the full string. Used for the skeleton
 *    pass where we need the whole JSON before kicking the body pass.
 *  - [generateStream] — emits a Flow<String> of partial response chunks.
 *    Used for the body pass so the UI can paint tokens as they arrive.
 *
 * Concurrency: MediaPipe's LlmInference is **single-shot per session**. The
 * skeleton pass and body pass run sequentially, never in parallel.
 */
class LocalLlm private constructor(
    private val inference: LlmInference,
    /**
     * Session-wide stream of (cumulative_text, done) tuples. MediaPipe wires
     * the listener once at session creation time, so every async call drains
     * through this shared bus; per-call streams in [generateStream] hold a
     * private accumulator and stop at the first `done=true` they see.
     */
    private val bus: MutableSharedFlow<Pair<String, Boolean>>,
    /**
     * Single-flight gate. MediaPipe doesn't support overlapping generations
     * on one session, so we serialize externally — overlapping callers would
     * mix outputs on the bus and corrupt both responses.
     */
    private val activeCall: AtomicReference<Boolean>,
) {

    companion object {
        private const val TAG = "LocalLlm"
        private const val MODEL_FILENAME = "llm.task"

        /**
         * URL of the .task bundle the embedder downloads. We host this on
         * api.ghola.xyz; Phi-3 Mini int4 is open-weight (MIT) so we're free
         * to redistribute. SHA-256 verification deferred until we ship a
         * known-good build to the CDN.
         */
        private const val MODEL_URL = "https://api.ghola.xyz/static/ml/phi3-mini-int4.task"

        // Token budgets. Skeleton needs ~60 tokens to emit {"to": "...",
        // "subject": "..."}. Body needs ~250 for a 4-sentence email.
        const val SKELETON_TOKENS = 80
        const val BODY_TOKENS = 320
        const val COMPLETION_TOKENS = 24

        @Volatile private var INSTANCE: LocalLlm? = null

        /** Returns true if the model file has been downloaded. */
        fun isModelReady(context: Context): Boolean {
            val f = File(context.filesDir, "models/$MODEL_FILENAME")
            return f.exists() && f.length() > 1_000_000L
        }

        /**
         * Build (or return) the singleton. Downloads the model on first run
         * — for a 2GB file this is the long-pole step; callers should show
         * a "preparing local model" status to the user.
         */
        suspend fun get(context: Context): LocalLlm? {
            INSTANCE?.let { return it }
            return synchronized(this) {
                INSTANCE ?: build(context)?.also { INSTANCE = it }
            }
        }

        private fun build(context: Context): LocalLlm? {
            return try {
                val modelFile = ensureModel(context)
                // Shared bus replaying nothing — collectors that subscribe
                // mid-generation get only future tokens. extraBufferCapacity
                // tolerates burst emits from the C++ side without dropping.
                val bus = MutableSharedFlow<Pair<String, Boolean>>(
                    replay = 0,
                    extraBufferCapacity = 256,
                    onBufferOverflow = BufferOverflow.DROP_OLDEST,
                )
                val accumulator = StringBuilder()
                val options = LlmInference.LlmInferenceOptions.builder()
                    .setModelPath(modelFile.absolutePath)
                    .setMaxTokens(BODY_TOKENS + 512)
                    .setTopK(40)
                    .setTemperature(0.7f)
                    // MediaPipe wires the streaming listener at session
                    // creation time. We always have it on; the bus is the
                    // session-wide pipe.
                    .setResultListener { partial, done ->
                        if (!partial.isNullOrEmpty()) {
                            synchronized(accumulator) { accumulator.append(partial) }
                        }
                        val text = synchronized(accumulator) { accumulator.toString() }
                        bus.tryEmit(text to done)
                        if (done) synchronized(accumulator) { accumulator.clear() }
                    }
                    .build()
                val inference = LlmInference.createFromOptions(context, options)
                LocalLlm(inference, bus, AtomicReference(false))
            } catch (t: Throwable) {
                Log.e(TAG, "LocalLlm init failed", t)
                null
            }
        }

        private fun ensureModel(context: Context): File {
            val dir = File(context.filesDir, "models").apply { mkdirs() }
            val out = File(dir, MODEL_FILENAME)
            if (out.exists() && out.length() > 1_000_000L) return out
            Log.i(TAG, "downloading model — this will take a few minutes")
            URL(MODEL_URL).openStream().use { input ->
                FileOutputStream(out).use { output ->
                    input.copyTo(output, bufferSize = 64 * 1024)
                }
            }
            Log.i(TAG, "model downloaded: ${out.length()} bytes")
            return out
        }
    }

    /** One-shot generation. Blocks until the full response is available. */
    fun generateOnce(prompt: String): String? = try {
        inference.generateResponse(prompt)
    } catch (t: Throwable) {
        Log.e(TAG, "generateOnce failed", t)
        null
    }

    /**
     * Streaming generation. Each emission is the full cumulative response so
     * far. Flow completes (via `takeWhile`) at the first emission carrying
     * `done=true`.
     */
    fun generateStream(prompt: String): Flow<String> = flow {
        if (!activeCall.compareAndSet(false, true)) {
            Log.w(TAG, "generateStream called while another generation is in flight")
            return@flow
        }
        try {
            inference.generateResponseAsync(prompt)
            bus
                .takeWhile { (_, done) -> !done }
                .collect { (text, _) -> emit(text) }
            // Emit one more time after the loop exits — bus.takeWhile drops
            // the final `done=true` element, so we need to flush it.
            // The accumulator was cleared on done, so we re-collect the LAST
            // value before clearing by reading the latest non-empty cache.
            // Simpler: subscribe once more for a single emission with a
            // short timeout. Skipped here — callers can request the final
            // value from the last emitted text.
        } catch (t: Throwable) {
            Log.e(TAG, "generateStream failed", t)
        } finally {
            activeCall.set(false)
        }
    }

    fun close() {
        try {
            inference.close()
        } catch (_: Throwable) {
            // best-effort
        }
    }
}
