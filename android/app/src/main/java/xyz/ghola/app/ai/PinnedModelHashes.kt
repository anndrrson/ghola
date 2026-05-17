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

    /**
     * Legacy single-variant pin for the Phase γ LiteRT-LM artifact.
     * Replaced by the per-variant ladder below ([forVariant] keyed by
     * [xyz.ghola.app.ai.litert.LiteRtVariant]). Kept as a deprecated
     * alias so existing call sites continue compiling during the L2
     * [xyz.ghola.app.ai.litert.LiteRtModelManager] refactor — the
     * accessor now resolves to [GEMMA_3_1B_LITERTLM_GENERIC_SHA256]
     * since the original single-variant path corresponded to the
     * cross-platform CPU+GPU bundle.
     *
     * Two-hash strategy from the plan (Phase η, "Integrity model"):
     * every `.litertlm` artifact has two anchors —
     *   1. the upstream `.tflite` input from Google's HF repo, AND
     *   2. the SoC-tuned `.litertlm` compiled bundle (these constants).
     * For the on-device verifier we only need the compiled-artifact
     * pin; the input-`.tflite` pin lives in the
     * `ghola-model-registry` Anchor program for supply-chain audits.
     */
    @Deprecated(
        message = "Multi-SoC ladder makes the single-variant constant " +
            "ambiguous. Use forVariant(LiteRtVariant.Generic) (or " +
            "whichever variant the device resolved to) instead.",
        replaceWith = ReplaceWith(
            "PinnedModelHashes.forVariant(LiteRtVariant.Generic)",
            "xyz.ghola.app.ai.litert.LiteRtVariant",
        ),
    )
    val GEMMA_3_1B_LITERTLM_SHA256: String?
        get() = GEMMA_3_1B_LITERTLM_GENERIC_SHA256

    // ── Multi-SoC (Phase γ.4 / L1) per-variant LiteRT-LM pins ────────
    //
    // Each constant below mirrors a [xyz.ghola.app.ai.litert.LiteRtVariant]
    // entry. All `null` today — same observe-but-don't-enforce posture
    // as the constants above. The L1 agent owns the values; this L2
    // commit only adds the `forVariant` accessor so [LiteRtModelManager]
    // can look up a pin by variant without a giant when-table at the
    // call site.
    //
    // When the L1 agent's commit lands with real hex strings, the only
    // thing that changes here is `: String? = null` → `: String? = "<hex>"`.

    /** SHA-256 for `Gemma3-1B-IT.litertlm` (Generic CPU+GPU fallback). */
    val GEMMA_3_1B_LITERTLM_GENERIC_SHA256: String? = null

    /** SHA-256 for `Gemma3-1B-IT-MT6989.litertlm` (Dimensity 9300). */
    val GEMMA_3_1B_LITERTLM_MT6989_SHA256: String? = null

    /** SHA-256 for `Gemma3-1B-IT-MT6991.litertlm` (Dimensity 9400). */
    val GEMMA_3_1B_LITERTLM_MT6991_SHA256: String? = null

    /** SHA-256 for `Gemma3-1B-IT-MT6993.litertlm` (Dimensity 9500). */
    val GEMMA_3_1B_LITERTLM_MT6993_SHA256: String? = null

    /** SHA-256 for `Gemma3-1B-IT-SM8550.litertlm` (Snapdragon 8 Gen 2). */
    val GEMMA_3_1B_LITERTLM_SM8550_SHA256: String? = null

    /** SHA-256 for `Gemma3-1B-IT-SM8650.litertlm` (Snapdragon 8 Gen 3). */
    val GEMMA_3_1B_LITERTLM_SM8650_SHA256: String? = null

    /** SHA-256 for `Gemma3-1B-IT-SM8750.litertlm` (Snapdragon 8 Gen 4). */
    val GEMMA_3_1B_LITERTLM_SM8750_SHA256: String? = null

    /** SHA-256 for `Gemma3-1B-IT-SM8850.litertlm` (Snapdragon 8 Gen 5). */
    val GEMMA_3_1B_LITERTLM_SM8850_SHA256: String? = null

    /**
     * Lookup a pinned SHA-256 by [xyz.ghola.app.ai.litert.LiteRtVariant].
     * Returns `null` for any variant that doesn't yet have a published
     * pin (today: all of them — observe-but-don't-enforce). Used by
     * [xyz.ghola.app.ai.litert.LiteRtModelManager] to gate the
     * post-download integrity check on a per-variant basis.
     */
    fun forVariant(
        variant: xyz.ghola.app.ai.litert.LiteRtVariant,
    ): String? = when (variant) {
        is xyz.ghola.app.ai.litert.LiteRtVariant.Generic ->
            GEMMA_3_1B_LITERTLM_GENERIC_SHA256
        is xyz.ghola.app.ai.litert.LiteRtVariant.Mt6989 ->
            GEMMA_3_1B_LITERTLM_MT6989_SHA256
        is xyz.ghola.app.ai.litert.LiteRtVariant.Mt6991 ->
            GEMMA_3_1B_LITERTLM_MT6991_SHA256
        is xyz.ghola.app.ai.litert.LiteRtVariant.Mt6993 ->
            GEMMA_3_1B_LITERTLM_MT6993_SHA256
        is xyz.ghola.app.ai.litert.LiteRtVariant.Sm8550 ->
            GEMMA_3_1B_LITERTLM_SM8550_SHA256
        is xyz.ghola.app.ai.litert.LiteRtVariant.Sm8650 ->
            GEMMA_3_1B_LITERTLM_SM8650_SHA256
        is xyz.ghola.app.ai.litert.LiteRtVariant.Sm8750 ->
            GEMMA_3_1B_LITERTLM_SM8750_SHA256
        is xyz.ghola.app.ai.litert.LiteRtVariant.Sm8850 ->
            GEMMA_3_1B_LITERTLM_SM8850_SHA256
    }
}
