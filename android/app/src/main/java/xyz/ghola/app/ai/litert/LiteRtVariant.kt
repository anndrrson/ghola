package xyz.ghola.app.ai.litert

/**
 * Sealed enumeration of every AOT-compiled LiteRT-LM artifact variant
 * Ghola knows how to download + run. Each variant maps 1:1 to a leaf
 * file under
 * `https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/`.
 *
 * **L1↔L2 contract.** This file lives in the L1 "Multi-SoC"
 * agent's slice (alongside [SoCDetector] and the per-variant pinned
 * SHA-256 entries in [xyz.ghola.app.ai.PinnedModelHashes]). L2 (the
 * [LiteRtModelManager] refactor) only reads from this file via the
 * three contract surfaces below — `filename`, `displayName`,
 * `approxSizeBytes`, plus the `companion`'s `ALL` and `forSoC`. If
 * the L1 agent revises this file later, the same surface must
 * remain stable or L2 + the Settings UI break.
 *
 * Per-variant metadata:
 *  - [filename] — the HuggingFace `resolve/main/<filename>` leaf and
 *    the on-disk `models/litert-lm/<filename>` storage name. The
 *    filename encodes the SoC tuning verbatim so a misplaced bundle
 *    cannot silently load on the wrong chip.
 *  - [approxSizeBytes] — UI hint for the download size; the real
 *    `Content-Length` from HF is the source of truth at download
 *    time. Sourced from the HF repo manifest as of 2026-05.
 *  - [displayName] — Settings UI label.
 */
sealed class LiteRtVariant(
    val filename: String,
    val approxSizeBytes: Long,
    val displayName: String,
) {
    /** CPU+GPU fallback bundle — no NPU acceleration. Picked when
     *  [SoCDetector] returns [SoCIdentity.Unknown] or a SoC family
     *  with no published NPU-tuned bundle (Tensor, Exynos, older
     *  Snapdragon, MediaTek Dimensity 7300 on the Solana Seeker). */
    object Generic : LiteRtVariant(
        filename = "Gemma3-1B-IT_multi-prefill-seq_q4_ekv4096.litertlm",
        approxSizeBytes = 584L * 1024 * 1024,
        displayName = "Generic CPU+GPU (~584 MB)",
    )

    // ── MediaTek Dimensity (APU NPUs) ─────────────────────────────────

    object Mt6989 : LiteRtVariant(
        filename = "Gemma3-1B-IT_q4_ekv1280_mt6989.litertlm",
        approxSizeBytes = 1_030L * 1024 * 1024,
        displayName = "MediaTek Dimensity 9300 (~1.03 GB)",
    )

    object Mt6991 : LiteRtVariant(
        filename = "Gemma3-1B-IT_q4_ekv1280_mt6991.litertlm",
        approxSizeBytes = 1_030L * 1024 * 1024,
        displayName = "MediaTek Dimensity 9400 (~1.03 GB)",
    )

    object Mt6993 : LiteRtVariant(
        filename = "Gemma3-1B-IT_q4_ekv1280_mt6993.litertlm",
        approxSizeBytes = 1_020L * 1024 * 1024,
        displayName = "MediaTek Dimensity 9500 (~1.02 GB)",
    )

    // ── Qualcomm Snapdragon (Hexagon NPUs) ────────────────────────────

    object Sm8550 : LiteRtVariant(
        filename = "Gemma3-1B-IT_q4_ekv1280_sm8550.litertlm",
        approxSizeBytes = 1_030L * 1024 * 1024,
        displayName = "Snapdragon 8 Gen 2 (~1.03 GB)",
    )

    object Sm8650 : LiteRtVariant(
        filename = "Gemma3-1B-IT_q4_ekv1280_sm8650.litertlm",
        approxSizeBytes = 1_030L * 1024 * 1024,
        displayName = "Snapdragon 8 Gen 3 (~1.03 GB)",
    )

    object Sm8750 : LiteRtVariant(
        filename = "Gemma3-1B-IT_q4_ekv1280_sm8750.litertlm",
        approxSizeBytes = 1_030L * 1024 * 1024,
        displayName = "Snapdragon 8 Gen 4 (~1.03 GB)",
    )

    object Sm8850 : LiteRtVariant(
        filename = "Gemma3-1B-IT_q4_ekv1280_sm8850.litertlm",
        approxSizeBytes = 1_030L * 1024 * 1024,
        displayName = "Snapdragon 8 Gen 5 (~1.03 GB)",
    )

    companion object {
        /**
         * Every known variant, useful for tests (cardinality
         * assertions) and any admin UI / Settings selector that
         * wants to display the supported ladder.
         *
         * Order: [Generic] first (the fallback / smallest), then
         * MediaTek bundles in ascending model code, then Qualcomm
         * bundles in ascending model code.
         */
        // Lazy to dodge the JVM nested-object init order trap: when the
        // companion initializes alongside the parent sealed class, the
        // singleton `object` siblings (Generic, Mt6989, …) are still
        // `null` at class-loading time. `by lazy` defers the listing
        // to first access, by which point every singleton's `<clinit>`
        // has run.
        val ALL: List<LiteRtVariant> by lazy {
            listOf(
                Generic, Mt6989, Mt6991, Mt6993,
                Sm8550, Sm8650, Sm8750, Sm8850,
            )
        }

        /**
         * Map a detected [SoCIdentity] to the AOT-compiled bundle that
         * matches it. Falls back to [Generic] for any SoC family that
         * doesn't have a published NPU-tuned `.litertlm` (Tensor,
         * Exynos, MediaTek Dimensity 7300 / MT6878 on the current
         * Seeker, etc.) so a mid-tier device still gets *some*
         * on-device model rather than a hard failure.
         */
        fun forSoC(identity: SoCIdentity): LiteRtVariant {
            return when (identity) {
                is SoCIdentity.MediaTek -> when (identity.modelCode?.uppercase()) {
                    "MT6989" -> Mt6989
                    "MT6991" -> Mt6991
                    "MT6993" -> Mt6993
                    // MT6878 (Dimensity 7300 / Seeker) has no
                    // published NPU bundle — fall back to Generic.
                    else -> Generic
                }
                is SoCIdentity.Qualcomm -> when (identity.modelCode?.uppercase()) {
                    "SM8550" -> Sm8550
                    "SM8650" -> Sm8650
                    "SM8750" -> Sm8750
                    "SM8850" -> Sm8850
                    else -> Generic
                }
                is SoCIdentity.Samsung,
                is SoCIdentity.Google,
                is SoCIdentity.Unknown -> Generic
            }
        }
    }
}
