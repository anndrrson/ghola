package xyz.ghola.app.email

import android.content.Context
import android.util.Log
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.channels.awaitClose
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.ai.llama.LlamaCallback
import xyz.ghola.app.ai.llama.LlamaCpp
import xyz.ghola.app.ai.llama.ModelManager
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

/**
 * On-device LLM facade. The v0.5 era wired this directly to MediaPipe's
 * `LlmInference`; v0.6 splits the internals behind an [Impl] interface so
 * the same `LocalLlm.generateOnce` / `generateStream` surface can run on
 * either runtime:
 *
 *  - **MediaPipe** ([MediaPipeImpl]) — `.task` bundle, the v0.5 default.
 *    Kept as the rollback path until v0.7 retires it.
 *  - **llama.cpp** ([LlamaCppImpl]) — GGUF + LoRA support, the path that
 *    unlocks per-user fine-tunes.
 *
 * Choice is gated by [SecureStorage.useLlamaCppRuntime]. Public API is
 * unchanged so all upstream callers (`LocalChatBackend`, `LocalEmailService`,
 * `SuggestionEngine`, `PreDraftWorker`) keep working through the swap.
 *
 * Singleton, because both backends hold heavy global state — MediaPipe's
 * session is per-options; llama.cpp's model pointer is a true static
 * global in the JNI module. Two live instances would corrupt each other.
 */
class LocalLlm private constructor(private val impl: Impl) {

    /**
     * Backend-agnostic contract. Each runtime implements this; the facade
     * forwards. Default no-ops on [swapLora]/[dropLora] make MediaPipeImpl
     * trivial — LoRA is a llama.cpp-only feature in v0.6.
     */
    interface Impl {
        fun once(prompt: String): String?
        fun stream(prompt: String): Flow<String>
        fun close()

        /** Hot-swap the active LoRA. Returns false on MediaPipe. */
        fun swapLora(loraPath: String, scale: Float): Boolean = false

        /** Drop the active LoRA back to base. No-op on MediaPipe. */
        fun dropLora(): Boolean = false
    }

    fun generateOnce(prompt: String): String? = impl.once(prompt)
    fun generateStream(prompt: String): Flow<String> = impl.stream(prompt)

    /** Used by the A/B compare panel (P9). No-op on MediaPipe runtime. */
    fun swapLora(loraPath: String, scale: Float = 1.0f): Boolean = impl.swapLora(loraPath, scale)
    fun dropLora(): Boolean = impl.dropLora()

    fun close() {
        try {
            impl.close()
        } catch (_: Throwable) {
            // best-effort
        }
    }

    companion object {
        private const val TAG = "LocalLlm"

        /** v0.5 MediaPipe `.task` filename — kept for rollback compatibility. */
        const val MEDIAPIPE_MODEL_FILENAME = "llm.task"

        // Token budgets exposed to upstream callers. Constants unchanged from
        // v0.5 — both runtimes interpret them the same way.
        const val SKELETON_TOKENS = 80
        const val BODY_TOKENS = 320
        const val COMPLETION_TOKENS = 24

        /**
         * Pre-built MediaPipe `.task` bundle for Qwen 2.5 1.5B Instruct, int8.
         * Hosted on the LiteRT community page under Apache 2.0. Ungated.
         * Used only when [SecureStorage.useLlamaCppRuntime] is false.
         */
        private const val MEDIAPIPE_MODEL_URL =
            "https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/main/" +
                "Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv1280.task"

        @Volatile private var INSTANCE: LocalLlm? = null

        /**
         * Resolve the active model file path for the current runtime. The
         * llama.cpp path lives next to its LoRA + centroid sidecars in
         * [ModelManager.getModelPath]; the MediaPipe path is the legacy
         * `.task` location.
         */
        fun modelFile(context: Context): File {
            return if (SecureStorage(context).useLlamaCppRuntime()) {
                File(ModelManager(context).getModelPath())
            } else {
                val base = context.getExternalFilesDir(null) ?: context.filesDir
                File(File(base, "models").apply { mkdirs() }, MEDIAPIPE_MODEL_FILENAME)
            }
        }

        /** True if the active runtime's model file has been downloaded. */
        fun isModelReady(context: Context): Boolean {
            val f = modelFile(context)
            return f.exists() && f.length() > 1_000_000L
        }

        /**
         * Build (or return) the singleton. On first call may download the
         * model file (~1.5GB); upstream callers should show a "preparing
         * local model" status during this window.
         */
        suspend fun get(context: Context): LocalLlm? {
            INSTANCE?.let { return it }
            return synchronized(this) {
                INSTANCE ?: build(context)?.also { INSTANCE = it }
            }
        }

        /**
         * Force re-init. Used after:
         *  - Runtime swap (Settings → "Use llama.cpp")
         *  - LoRA fine-tune completes ([PersonalFineTuneWorker])
         *  - LoRA toggle in [VoiceCompareActivity]
         */
        fun reset(context: Context) {
            synchronized(this) {
                INSTANCE?.close()
                INSTANCE = null
            }
        }

        private fun build(context: Context): LocalLlm? {
            return if (SecureStorage(context).useLlamaCppRuntime()) {
                LlamaCppImpl.build(context)?.let { LocalLlm(it) }
            } else {
                MediaPipeImpl.build(context)?.let { LocalLlm(it) }
            }
        }

        // ── MediaPipe impl (v0.5 path) ────────────────────────────────────

        /**
         * Lift of the v0.5 LocalLlm internals — same shared bus + accumulator
         * + single-flight gate.
         */
        private class MediaPipeImpl(
            private val inference: LlmInference,
            private val bus: MutableSharedFlow<Pair<String, Boolean>>,
            private val activeCall: AtomicReference<Boolean>,
        ) : Impl {

            override fun once(prompt: String): String? = try {
                inference.generateResponse(prompt)
            } catch (t: Throwable) {
                Log.e(TAG, "MediaPipe once failed", t)
                null
            }

            override fun stream(prompt: String): Flow<String> = flow {
                if (!activeCall.compareAndSet(false, true)) {
                    Log.w(TAG, "MediaPipe stream called while another generation in flight")
                    return@flow
                }
                try {
                    inference.generateResponseAsync(prompt)
                    bus
                        .takeWhile { (_, done) -> !done }
                        .collect { (text, _) -> emit(text) }
                } catch (t: Throwable) {
                    Log.e(TAG, "MediaPipe stream failed", t)
                } finally {
                    activeCall.set(false)
                }
            }

            override fun close() {
                try {
                    inference.close()
                } catch (_: Throwable) {
                    // best-effort
                }
            }

            companion object {
                fun build(context: Context): MediaPipeImpl? = try {
                    val modelFile = ensureMediaPipeModel(context)
                    val bus = MutableSharedFlow<Pair<String, Boolean>>(
                        replay = 0,
                        extraBufferCapacity = 256,
                        onBufferOverflow = BufferOverflow.DROP_OLDEST,
                    )
                    val accumulator = StringBuilder()
                    val options = LlmInference.LlmInferenceOptions.builder()
                        .setModelPath(modelFile.absolutePath)
                        .setMaxTokens(1024)
                        .setTopK(40)
                        .setTemperature(0.7f)
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
                    MediaPipeImpl(inference, bus, AtomicReference(false))
                } catch (t: Throwable) {
                    Log.e(TAG, "MediaPipeImpl init failed", t)
                    null
                }

                private fun ensureMediaPipeModel(context: Context): File {
                    val base = context.getExternalFilesDir(null) ?: context.filesDir
                    val out = File(File(base, "models").apply { mkdirs() }, MEDIAPIPE_MODEL_FILENAME)
                    if (out.exists() && out.length() > 1_000_000L) return out
                    Log.i(TAG, "downloading MediaPipe .task — this will take a few minutes")
                    URL(MEDIAPIPE_MODEL_URL).openStream().use { input ->
                        FileOutputStream(out).use { output ->
                            input.copyTo(output, bufferSize = 64 * 1024)
                        }
                    }
                    Log.i(TAG, "MediaPipe model downloaded: ${out.length()} bytes")
                    return out
                }
            }
        }

        // ── llama.cpp impl (v0.6 path) ────────────────────────────────────

        /**
         * Backend over the JNI-bound llama.cpp runtime. Single-flight gated
         * because the JNI module holds a static global model pointer (see
         * `app/src/main/cpp/llama_jni.cpp`) — concurrent calls would corrupt
         * KV cache state mid-decode.
         *
         * LoRA-at-load: if the user has a fine-tune sitting in
         * [ModelManager.getLoraPath] and [SecureStorage.voiceLoraActive] is
         * true, we bind the adapter at session init via [LlamaCpp.loadModelWithLora].
         * Hot-swap ([swapLora]/[dropLora]) is reserved for the A/B compare panel.
         */
        private class LlamaCppImpl(
            private val llama: LlamaCpp,
            private val activeCall: AtomicReference<Boolean>,
        ) : Impl {

            override fun once(prompt: String): String? = try {
                val maxTokens = BODY_TOKENS.coerceAtLeast(SKELETON_TOKENS)
                llama.generate(prompt, maxTokens).ifBlank { null }
            } catch (t: Throwable) {
                Log.e(TAG, "llama.cpp once failed", t)
                null
            }

            override fun stream(prompt: String): Flow<String> = callbackFlow {
                if (!activeCall.compareAndSet(false, true)) {
                    Log.w(TAG, "llama.cpp stream called while another generation in flight")
                    close()
                    return@callbackFlow
                }
                val accumulator = StringBuilder()
                val callback = object : LlamaCallback {
                    override fun onToken(token: String) {
                        accumulator.append(token)
                        trySend(accumulator.toString())
                    }
                    override fun onComplete() {
                        close() // close the flow
                    }
                }
                try {
                    llama.generateStreaming(prompt, BODY_TOKENS, callback)
                } catch (t: Throwable) {
                    Log.e(TAG, "llama.cpp stream failed", t)
                    close(t)
                }
                awaitClose { activeCall.set(false) }
            }

            override fun swapLora(loraPath: String, scale: Float): Boolean =
                try { llama.applyLora(loraPath, scale) } catch (t: Throwable) {
                    Log.e(TAG, "swapLora failed", t); false
                }

            override fun dropLora(): Boolean =
                try { llama.clearLora() } catch (t: Throwable) {
                    Log.e(TAG, "dropLora failed", t); false
                }

            override fun close() {
                try {
                    llama.release()
                } catch (_: Throwable) {
                    // best-effort
                }
            }

            companion object {
                fun build(context: Context): LlamaCppImpl? {
                    return try {
                        val mm = ModelManager(context)
                        if (!mm.isModelDownloaded()) {
                            Log.w(TAG, "llama.cpp model file not present — caller should trigger download")
                            return null
                        }
                        val storage = SecureStorage(context)
                        val loraPath = if (storage.voiceLoraActive() && mm.isLoraReady())
                            mm.getLoraPath() else null

                        val llama = LlamaCpp()
                        // Defaults tuned for Qwen 2.5 1.5B q8_0 on a Dimensity 9300:
                        //   - 4k context: model supports 32k but the runtime
                        //     latency scales with prompt length; 4k is the sweet
                        //     spot for our prompt sizes (system + style anchors +
                        //     intent ≈ 1.5-2.5k tokens).
                        //   - 4 threads: half the Seeker's CPU; leaves headroom
                        //     for the UI thread + system services.
                        //   - temp 0.7 / topP 0.9: match MediaPipe defaults so the
                        //     subjective feel is similar across runtimes.
                        val ok = llama.loadModelWithLora(
                            modelPath = mm.getModelPath(),
                            loraPath = loraPath,
                            contextSize = 4096,
                            // Dimensity 9300 (Seeker): prime + 3 perf + 4 efficiency.
                            // 6 threads use prime+perf+2 efficiency for ~30%
                            // lower latency vs 4 without starving UI/system.
                            numThreads = 6,
                            temp = 0.7f,
                            topP = 0.9f,
                        )
                        if (!ok) {
                            Log.e(TAG, "llama.cpp model load failed")
                            return null
                        }
                        Log.i(TAG, "llama.cpp impl ready (lora=${loraPath != null})")
                        LlamaCppImpl(llama, AtomicReference(false))
                    } catch (t: Throwable) {
                        Log.e(TAG, "LlamaCppImpl init failed", t)
                        null
                    }
                }
            }
        }
    }
}
