package xyz.ghola.app.ai

/**
 * Pinned SHA-256 hashes for every native model artifact Ghola ships on
 * Android. Counterpart to the SRI-style pin block
 * `DEFAULT_WEBGPU_MODEL_INTEGRITY` (and the canonical-weights constant
 * `DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH`) at the top of
 * `apps/web/src/lib/webgpu-inference.ts`.
 *
 * Today every value is `null` — that intentionally puts
 * [IntegrityVerifier] in observe-but-don't-enforce mode (see the
 * class-level KDoc on [IntegrityVerifier]). Behavior on disk is
 * unchanged: the comparator returns `match=true` with a clear
 * `reason="no expected hash pinned yet"` so callers can wire the
 * verifier into the model lifecycle today and flip enforcement on as a
 * follow-up patch that simply changes these constants from `null` to
 * real hex strings.
 *
 * The corresponding hashes will be anchored in the
 * `ghola-model-registry` Anchor program (see
 * `programs/ghola-model-registry/src/lib.rs`) and re-derivable via the
 * `scripts/compute-weights-manifest.mjs` helper. Until that path lands,
 * the values here are also `null`.
 */
object PinnedModelHashes {

    /**
     * Pinned SHA-256 for the v0.6 llama.cpp default model:
     * `qwen2.5-1.5b-instruct-q8_0.gguf` (~1.6 GB).
     *
     * Source URL (see `ModelManager.MODEL_URL`):
     *   https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q8_0.gguf
     *
     * TODO(Phase η): populate from the on-chain
     * `ghola-model-registry` record once the GGUF artifact is anchored.
     * Until then this is null and [IntegrityVerifier] returns match=true
     * with `reason="no expected hash pinned yet"`.
     */
    val QWEN_2_5_1_5B_Q8_GGUF_SHA256: String? = null

    /**
     * Pinned SHA-256 for the MediaPipe `.task` bundle used by the
     * `LocalChatBackend` path:
     * `Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv1280.task`.
     *
     * Source URL (see `LocalLlm.MEDIAPIPE_MODEL_URL`):
     *   https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/main/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv1280.task
     *
     * TODO(Phase η): populate from the on-chain
     * `ghola-model-registry` record once the `.task` artifact is
     * anchored. Until then this is null and [IntegrityVerifier] returns
     * match=true with `reason="no expected hash pinned yet"`.
     */
    val MEDIAPIPE_QWEN_2_5_1_5B_EKV1280_SHA256: String? = null
}
