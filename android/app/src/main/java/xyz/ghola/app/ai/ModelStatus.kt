package xyz.ghola.app.ai

/**
 * Canonical coarse-grained status for an on-device model artifact, combining
 * presence-on-disk with the Phase η integrity check performed by
 * [IntegrityVerifier].
 *
 * This enum is the **single source of truth** consumed by the
 * [xyz.ghola.app.ui.components.IntegrityBadge] surface and any caller
 * that needs to decide whether to load a model, prompt the user to
 * download it, or refuse to dispatch to a tampered artifact.
 *
 * Producers:
 * - [xyz.ghola.app.ai.llama.ModelManager.isModelVerified] — base GGUF
 *   artifact (Qwen 2.5 1.5B q8).
 * - [xyz.ghola.app.ai.litert.LiteRtModelManager.isModelVerified] — per-SoC
 *   `.litertlm` NPU artifact (Gemma 3 1B variants).
 *
 * Members (order is load-bearing — see the unit tests under
 * `xyz/ghola/app/ui/components/IntegrityBadgeTest.kt` which iterate
 * `values()`):
 * - [NOT_DOWNLOADED] — file is missing or zero-byte.
 * - [DOWNLOADED_UNVERIFIED] — file is present but the pinned SHA-256 in
 *   [PinnedModelHashes] is still null (i.e. we ship today without
 *   enforcement; behavior is identical to the legacy `isModelDownloaded()
 *   = true` case).
 * - [VERIFIED] — file present AND its SHA-256 matches the pin.
 * - [TAMPERED] — file present, pin present, hashes disagree. The caller
 *   MUST NOT load this artifact into a runtime.
 */
enum class ModelStatus { NOT_DOWNLOADED, DOWNLOADED_UNVERIFIED, VERIFIED, TAMPERED }
