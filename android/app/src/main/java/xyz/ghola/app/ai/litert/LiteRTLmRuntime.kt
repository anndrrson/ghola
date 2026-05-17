package xyz.ghola.app.ai.litert

import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.LiteRtLmJniException
import java.io.IOException
import java.util.concurrent.atomic.AtomicReference

/**
 * Production [LiteRTRuntime] backed by `com.google.ai.edge.litertlm`
 * version 0.11.0 (pinned in `android/app/build.gradle.kts`).
 *
 * Lifecycle:
 *  1. [LiteRTLmRuntime.tryCreate] tries [Backend.NPU] first; on
 *     [LiteRtLmJniException] it logs + falls back to [Backend.CPU]
 *     so the device still gets a working backend rather than a
 *     crash. This mirrors the Phase β GPU-pin-with-fallback pattern.
 *  2. [generate] opens a fresh [com.google.ai.edge.litertlm.Conversation]
 *     per call (one-shot semantics — KV cache is rebuilt each time,
 *     matches [xyz.ghola.app.ai.LocalChatBackend.generate]).
 *  3. [cancel] closes any active conversation, which is the only
 *     cancellation primitive the LiteRT-LM Kotlin API at v0.11.0
 *     exposes.
 *  4. [shutdown] closes the engine. Idempotent.
 *
 * Threading: [generate] is synchronous and intended to be called from
 * a worker thread. Concurrent [generate] calls are NOT safe — the
 * upstream `LlmBackend.generate` contract is single-flight, mirrored
 * here.
 *
 * Verified against (2026-05-15):
 *   https://github.com/google-ai-edge/LiteRT-LM/blob/main/docs/api/kotlin/getting_started.md
 *   https://ai.google.dev/edge/litert-lm/android
 *   https://github.com/google-ai-edge/LiteRT-LM/releases/tag/v0.11.0
 */
internal class LiteRTLmRuntime private constructor(
    private val engine: Engine,
    /**
     * Diagnostic — which [com.google.ai.edge.litertlm.Backend] the
     * engine was initialized with. Surfaced via logcat on first
     * generation so the dev gauntlet can confirm NPU is actually
     * active. Lifecycle observers may read this but should not gate
     * behavior on it; the Phase δ [BackendSelector] makes the higher
     * level routing decisions.
     */
    val activeBackendName: String,
) : LiteRTRuntime {

    private val activeConversation = AtomicReference<AutoCloseable?>(null)
    @Volatile
    private var closed: Boolean = false

    override fun generate(prompt: String): String {
        if (closed) {
            throw IOException("LiteRT-LM runtime already shut down")
        }
        val conversation = try {
            engine.createConversation()
        } catch (e: LiteRtLmJniException) {
            throw IOException("LiteRT-LM createConversation failed: ${e.message}", e)
        }
        @Suppress("UNCHECKED_CAST")
        activeConversation.set(conversation as? AutoCloseable)
        try {
            val message = try {
                // Synchronous one-shot. Returns a `Message` whose
                // `toString()` yields the assistant text. The Kotlin
                // API exposes overloads for streaming + flow; we use
                // the blocking variant because the upstream
                // LlmBackend.generate contract is itself blocking.
                conversation.sendMessage(prompt)
            } catch (e: LiteRtLmJniException) {
                throw IOException("LiteRT-LM sendMessage failed: ${e.message}", e)
            }
            return message.toString()
        } finally {
            try {
                conversation.close()
            } catch (_: Throwable) {
                // best-effort
            }
            activeConversation.compareAndSet(conversation as? AutoCloseable, null)
        }
    }

    override fun cancel() {
        // Closing the active conversation is the documented
        // cancellation primitive at v0.11.0. The next `sendMessage`
        // boundary inside the native runtime observes the closed
        // state and unwinds with LiteRtLmJniException, which
        // [generate] translates into an IOException up to the caller.
        val conv = activeConversation.getAndSet(null) ?: return
        try {
            conv.close()
        } catch (_: Throwable) {
            // best-effort
        }
    }

    override fun shutdown() {
        if (closed) return
        closed = true
        cancel()
        try {
            engine.close()
        } catch (_: Throwable) {
            // best-effort
        }
    }

    companion object {
        private const val TAG = "LiteRTLmRuntime"

        /**
         * Try to build a runtime with [Backend.NPU] first; if the
         * native init throws (device lacks the NPU dispatch libs,
         * SoC mismatch on the AOT-compiled `.litertlm` bundle, etc.)
         * fall back to [Backend.CPU] so the user still gets a
         * functional backend. The fallback strictly degrades power
         * efficiency — quality and tokens-per-second on CPU are
         * comparable on Gemma-3-1B-class models.
         *
         * @param modelPath absolute path to the `.litertlm` artifact.
         *   Caller (the [LiteRTNeuroPilotBackend]) is responsible for
         *   ensuring it exists and passes integrity verification.
         * @param nativeLibraryDir directory containing NPU dispatch
         *   `.so` files; for our APK this is
         *   `context.applicationInfo.nativeLibraryDir`.
         * @param cacheDir writable cache dir for the engine to stash
         *   AOT artifacts (improves 2nd-load time per Google's docs).
         *   For our APK this is `context.cacheDir.path`.
         */
        fun tryCreate(
            modelPath: String,
            nativeLibraryDir: String,
            cacheDir: String,
        ): LiteRTLmRuntime {
            // 1. Try NPU first — the whole point of this backend.
            try {
                val engine = Engine(
                    EngineConfig(
                        modelPath = modelPath,
                        backend = Backend.NPU(nativeLibraryDir = nativeLibraryDir),
                        cacheDir = cacheDir,
                    ),
                )
                engine.initialize()
                Log.i(TAG, "LiteRT-LM engine ready on NPU (Backend.NPU)")
                return LiteRTLmRuntime(engine, activeBackendName = "NPU")
            } catch (t: Throwable) {
                Log.w(TAG, "NPU init failed (${t.javaClass.simpleName}: ${t.message}); falling back to CPU", t)
            }

            // 2. CPU fallback — strictly slower power but guaranteed
            //    to work on every arm64 Android device LiteRT-LM
            //    supports.
            try {
                val engine = Engine(
                    EngineConfig(
                        modelPath = modelPath,
                        backend = Backend.CPU(),
                        cacheDir = cacheDir,
                    ),
                )
                engine.initialize()
                Log.i(TAG, "LiteRT-LM engine ready on CPU (Backend.CPU fallback)")
                return LiteRTLmRuntime(engine, activeBackendName = "CPU")
            } catch (t: Throwable) {
                throw IOException(
                    "LiteRT-LM engine failed to initialize on both NPU and CPU: ${t.message}",
                    t,
                )
            }
        }
    }
}
