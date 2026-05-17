package xyz.ghola.app.ui.components

import androidx.annotation.ColorRes
import xyz.ghola.app.R
import xyz.ghola.app.ai.ModelStatus

/**
 * Pure-Kotlin (no Android runtime types) projection of a
 * [ModelStatus] into the label, dot colour resource, and accessibility
 * string used by [IntegrityBadge].
 *
 * Lives in its own file (not as a private member of [IntegrityBadge])
 * so the rendering contract is unit-testable from a plain JVM JUnit
 * suite without dragging in Robolectric — the spec only references
 * `@ColorRes` ids (plain integers at runtime) and string constants, so
 * it's safe to instantiate from a test that has never touched a
 * `Context`.
 *
 * The View still owns:
 *   - resolving the colour res to an actual ARGB int via
 *     `ContextCompat.getColor`,
 *   - building the compound dot drawable,
 *   - typography, padding, and compound spacing.
 *
 * Web counterpart label inventory comes from
 * `apps/web/src/components/chat/ModelIntegrityBadge.tsx` — the
 * mobile inventory is intentionally narrower (no "registry pending" or
 * "chain unreachable" states; that distinction only exists on web
 * where the on-chain lookup is part of the badge's job).
 */
internal data class IntegrityBadgeRenderSpec(
    val label: String,
    @ColorRes val colorRes: Int,
) {
    companion object {
        /**
         * Project [status] (+ optional short-hash suffix) into a
         * label + colour resource.
         *
         * The short-hash suffix is only honoured for [ModelStatus.VERIFIED]
         * — the other states have nothing useful to say about a hash
         * (NOT_DOWNLOADED has no file; TAMPERED's "actual" hash isn't
         * the one the user cares about; UNVERIFIED has no pin to
         * compare against).
         */
        fun of(status: ModelStatus, hashShort: String?): IntegrityBadgeRenderSpec {
            return when (status) {
                ModelStatus.VERIFIED -> {
                    val label = if (!hashShort.isNullOrBlank()) {
                        "Verified · $hashShort"
                    } else {
                        "Verified"
                    }
                    IntegrityBadgeRenderSpec(label, R.color.integrity_dot_verified)
                }
                ModelStatus.DOWNLOADED_UNVERIFIED ->
                    IntegrityBadgeRenderSpec("Unverified", R.color.integrity_dot_unverified)
                ModelStatus.TAMPERED ->
                    IntegrityBadgeRenderSpec("Tampered", R.color.integrity_dot_tampered)
                ModelStatus.NOT_DOWNLOADED ->
                    IntegrityBadgeRenderSpec("Not downloaded", R.color.integrity_dot_idle)
            }
        }

        /**
         * Build the screen-reader content description. Kept on the
         * companion (rather than as an instance field of the spec)
         * because it depends on the artifact name, which is part of
         * the View's bind() call rather than the rendering spec
         * proper.
         */
        fun contentDescription(
            status: ModelStatus,
            artifactName: String,
            hashShort: String?,
        ): String {
            val statusWord = when (status) {
                ModelStatus.VERIFIED -> "verified"
                ModelStatus.DOWNLOADED_UNVERIFIED -> "downloaded but not verified"
                ModelStatus.TAMPERED -> "tampered — hash does not match the pinned value"
                ModelStatus.NOT_DOWNLOADED -> "not downloaded"
            }
            val hashSuffix = if (status == ModelStatus.VERIFIED && !hashShort.isNullOrBlank()) {
                ", short hash $hashShort"
            } else {
                ""
            }
            return "Model integrity: $statusWord ($artifactName)$hashSuffix"
        }
    }
}
