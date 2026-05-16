package xyz.ghola.app.ai.litert

import xyz.ghola.app.ai.litert.LiteRtModelManager.ModelStatus

/**
 * Phase γ.3 — pure-Kotlin decision helper that maps a
 * [LiteRtModelManager.ModelStatus] into a user-facing dispatch
 * [Decision] for the LiteRT-LM NPU backend.
 *
 * Lives outside [xyz.ghola.app.ui.ChatActivity] for two reasons:
 *   1. The Activity-side dispatch (Toast, Intent, AgentController
 *      construction) is hard to unit-test on the JVM. Extracting the
 *      decision tree into a tiny stateless function gives Phase γ.3
 *      a real test surface without dragging Robolectric into the
 *      pure-JVM `:app:testDebugUnitTest` task.
 *   2. The mapping is identical between any future call sites
 *      (e.g. a Quick-Action tile that wants to verify the model is
 *      ready before launching ChatActivity). Putting it in `ui/`
 *      would force those callers to either depend on an Activity or
 *      duplicate the logic.
 *
 * The decision matrix mirrors what the Phase γ section of
 * `/Users/andersonobrien/.claude/plans/zesty-giggling-charm.md` calls
 * out for ChatActivity dispatch:
 *
 * | ModelStatus              | Decision                |
 * |--------------------------|-------------------------|
 * | VERIFIED                 | BuildBackend            |
 * | DOWNLOADED_UNVERIFIED    | BuildBackend            |
 * | NOT_DOWNLOADED           | FallbackMissingModel    |
 * | TAMPERED                 | FailWithTamperedError   |
 *
 * `DOWNLOADED_UNVERIFIED` is treated as a green-light because the
 * pin in [xyz.ghola.app.ai.PinnedModelHashes.GEMMA_3_1B_LITERTLM_SHA256]
 * is `null` today — observe-but-don't-enforce. Once the pin lands
 * the same code path turns into VERIFIED automatically; no caller
 * change required.
 *
 * @see LiteRtModelManager.isModelVerified — produces the input
 *   [ModelStatus] this dispatcher consumes.
 * @see LiteRTNeuroPilotBackend — what `BuildBackend` callers
 *   eventually instantiate using the model path.
 */
object LiteRtNpuDispatcher {

    /**
     * Outcome of inspecting the on-disk `.litertlm` artifact when
     * the user has selected [xyz.ghola.app.ai.SecureStorage.BACKEND_LITERT_NPU].
     */
    sealed class Decision {
        /** Model is on disk and either verified or in the
         *  unenforced pass-through state. Caller may safely build a
         *  [LiteRTNeuroPilotBackend] using [modelPath]. */
        data class BuildBackend(val modelPath: String) : Decision()

        /** Model has not been downloaded yet. Caller should direct
         *  the user to Settings to start the download and pick a
         *  fallback backend in the interim. */
        object FallbackMissingModel : Decision()

        /** Model is present but its hash disagrees with the pinned
         *  value — refuse to load. Caller should surface an explicit
         *  error and NOT silently fall through to another backend
         *  (the user picked NPU specifically; quietly switching to
         *  cloud would leak data the user intended to keep on-device). */
        object FailWithTamperedError : Decision()
    }

    /**
     * Reduce a ([ModelStatus], optional model path) pair to a
     * [Decision]. Pure function — no I/O, no side effects, safe to
     * call from any thread.
     *
     * @param status the result of [LiteRtModelManager.isModelVerified].
     * @param modelPath the path returned by
     *   [LiteRtModelManager.getModelPath]; `null` is acceptable iff
     *   [status] is [ModelStatus.NOT_DOWNLOADED] or
     *   [ModelStatus.TAMPERED]. When `status` is one of the
     *   green-light states but `modelPath` is `null` the dispatcher
     *   downgrades to [Decision.FallbackMissingModel] — this is a
     *   belt-and-braces guard against a race where the file gets
     *   deleted between the status check and the path fetch.
     */
    fun decide(status: ModelStatus, modelPath: String?): Decision {
        return when (status) {
            ModelStatus.VERIFIED, ModelStatus.DOWNLOADED_UNVERIFIED -> {
                if (modelPath.isNullOrBlank()) Decision.FallbackMissingModel
                else Decision.BuildBackend(modelPath)
            }
            ModelStatus.NOT_DOWNLOADED -> Decision.FallbackMissingModel
            ModelStatus.TAMPERED -> Decision.FailWithTamperedError
        }
    }
}
