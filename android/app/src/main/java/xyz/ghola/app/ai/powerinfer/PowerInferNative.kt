package xyz.ghola.app.ai.powerinfer

/**
 * Phase ζ.0 spike — JNI surface for the PowerInfer native lib.
 *
 * Mirrors the shape of [xyz.ghola.app.ai.llama.LlamaCpp] so a future
 * [xyz.ghola.app.ai.LlmBackend] (ζ.3 work) can swap between llama.cpp and
 * PowerInfer behind the same surface.
 *
 * THIS CLASS IS A STUB. The C++ side returns safe defaults — calling
 * [generate] returns "", [loadModel] returns false. Production wiring lands
 * in ζ.3 only if the ζ.0 spike gate (this file's build path) passes.
 *
 * The `external fun` declarations are intentionally not `init {
 * System.loadLibrary("powerinfer") }` — the library load is deferred until
 * a caller actually instantiates this class, which protects unit tests on
 * the JVM (no .so on classpath) and protects the rest of the app from
 * crashing if `libpowerinfer.so` failed to bundle into the APK.
 */
class PowerInferNative {

    external fun loadModel(
        modelPath: String,
        contextSize: Int,
        numThreads: Int,
        temp: Float,
        topP: Float,
    ): Boolean

    external fun generate(prompt: String, maxTokens: Int): String

    external fun cancel()

    external fun release()

    external fun tokenCount(text: String): Int

    companion object {
        /**
         * Loads `libpowerinfer.so` once per process. Idempotent — repeated
         * calls are no-ops. Returns false on JVM (unit tests) where the .so
         * is not present; callers must handle that. Returns false on Android
         * if `libpowerinfer.so` was not bundled (ζ.0 spike failure mode).
         */
        @JvmStatic
        @Synchronized
        fun tryLoad(): Boolean {
            return try {
                System.loadLibrary("powerinfer")
                true
            } catch (_: UnsatisfiedLinkError) {
                false
            } catch (_: SecurityException) {
                false
            }
        }
    }
}
