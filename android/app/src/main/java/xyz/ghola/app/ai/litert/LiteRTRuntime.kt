package xyz.ghola.app.ai.litert

/**
 * Thin abstraction over the LiteRT-LM native `Engine` / `Conversation`
 * surface, introduced as a test seam so [LiteRTNeuroPilotBackend] can
 * be unit-tested on the JVM without loading the
 * `com.google.ai.edge.litertlm` native libraries (which only resolve
 * at runtime on Android-arm64).
 *
 * The production binding ([LiteRTLmRuntime]) wraps the real engine,
 * builds a [com.google.ai.edge.litertlm.Conversation] per
 * [generate] call (so the KV cache is never reused across turns —
 * mirrors the [xyz.ghola.app.ai.LocalChatBackend] one-shot pattern),
 * and translates `LiteRtLmJniException` into [java.io.IOException]
 * for the upstream `LlmBackend` contract.
 *
 * The test binding mocks this interface directly via a fake without
 * pulling in any of the LiteRT-LM types — see
 * `app/src/test/java/xyz/ghola/app/ai/litert/LiteRTNeuroPilotBackendTest.kt`.
 *
 * Cross-reference (verified 2026-05-15 at v0.11.0):
 *   https://github.com/google-ai-edge/LiteRT-LM/blob/main/docs/api/kotlin/getting_started.md
 *   https://ai.google.dev/edge/litert-lm/android
 *
 * @see LiteRTNeuroPilotBackend the backend that consumes this runtime
 * @see LiteRTLmRuntime the production binding
 */
internal interface LiteRTRuntime {

    /**
     * One-shot text generation. Builds a fresh
     * [com.google.ai.edge.litertlm.Conversation] internally, calls
     * the synchronous `sendMessage(prompt)` overload, closes the
     * conversation, and returns the model's plain-text response.
     *
     * Synchronous because every `LlmBackend.generate` call site is
     * already running on a worker thread that owns its own
     * cancellation; layering a coroutine here would buy nothing.
     *
     * @param prompt full ChatML-formatted prompt — system + history +
     *   trailing `assistant`-role open tag. The backend formats this
     *   before calling.
     * @return the model's response text, never null. The runtime
     *   strips any trailing control tokens.
     * @throws java.io.IOException if the native runtime errors out
     *   (caller's responsibility to surface a useful message).
     */
    fun generate(prompt: String): String

    /**
     * Cooperative cancel. Sets the runtime's internal cancelled flag
     * so the next per-token boundary checks abort the in-flight
     * generation. The current LiteRT-LM Kotlin API (v0.11.0) exposes
     * cancellation through `com.google.ai.edge.litertlm.Conversation.close`
     * — the implementation closes any active conversation here.
     *
     * Safe to call from any thread; safe to call when no generation
     * is in flight (no-op).
     */
    fun cancel()

    /**
     * Tear down the native [com.google.ai.edge.litertlm.Engine]. Idempotent
     * — repeated calls are no-ops. After [shutdown] the runtime
     * cannot be reused; the owning backend's [shutdown] method calls
     * this once.
     */
    fun shutdown()
}
