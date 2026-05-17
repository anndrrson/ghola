package xyz.ghola.app.ui.components

import android.content.Context
import androidx.appcompat.app.AlertDialog
import xyz.ghola.app.ai.ModelStatus

/**
 * Lightweight detail dialog for the [IntegrityBadge].
 *
 * Counterpart of the web `IntegrityVerifyModal`
 * (`apps/web/src/components/chat/IntegrityVerifyModal.tsx`) — minus the
 * "download verification bundle" feature, which is a web-only concern
 * (the mobile artifact ships inside the APK + on-disk model file, so a
 * separate ZIP export doesn't carry meaningful audit value on this
 * platform).
 *
 * Intentionally a `static show()` rather than a custom layout — we want
 * the dialog to inherit the host activity's Material theme so it looks
 * the same as every other dialog in ghola Android. A bespoke layout
 * would force us to track theme drift separately.
 *
 * @param context        host activity context (NOT the application
 *                       context — the dialog must be window-attached).
 * @param status         current model integrity status.
 * @param artifactName   artifact filename, displayed verbatim.
 * @param artifactPath   absolute on-disk path. Optional — when null the
 *                       row is skipped. (Some statuses, e.g.
 *                       NOT_DOWNLOADED, won't have one.)
 * @param fullHash       full 64-char hex SHA-256, or null when not yet
 *                       computed (e.g. NOT_DOWNLOADED).
 * @param onReverify     callback invoked when the user taps "Re-verify".
 *                       The host is responsible for kicking off a fresh
 *                       `ModelManager.isModelVerified()` and re-binding
 *                       the badge with the new result.
 */
object IntegrityBadgeDetailDialog {

    fun show(
        context: Context,
        status: ModelStatus,
        artifactName: String,
        artifactPath: String?,
        fullHash: String?,
        onReverify: Runnable?,
    ) {
        val title = when (status) {
            ModelStatus.VERIFIED -> "Model verified"
            ModelStatus.DOWNLOADED_UNVERIFIED -> "Model downloaded — verification pending"
            ModelStatus.TAMPERED -> "Model integrity check FAILED"
            ModelStatus.NOT_DOWNLOADED -> "Model not downloaded"
        }

        val body = buildString {
            append(statusBlurb(status))
            append("\n\nArtifact: ")
            append(artifactName)
            if (!artifactPath.isNullOrBlank()) {
                append("\nPath: ")
                append(artifactPath)
            }
            if (!fullHash.isNullOrBlank()) {
                append("\nSHA-256: ")
                append(fullHash)
            }
        }

        val builder = AlertDialog.Builder(context)
            .setTitle(title)
            .setMessage(body)
            .setNegativeButton("Close", null)

        if (onReverify != null) {
            builder.setPositiveButton("Re-verify") { _, _ -> onReverify.run() }
        }

        builder.show()
    }

    internal fun statusBlurb(status: ModelStatus): String = when (status) {
        ModelStatus.VERIFIED ->
            "On-disk SHA-256 matches the pinned hash shipped with the APK."
        ModelStatus.DOWNLOADED_UNVERIFIED ->
            "The model file is on disk but no pinned hash has been published " +
                "yet, so ghola can verify the download but cannot enforce it. " +
                "This is the expected state until the on-chain model registry " +
                "publishes a hash for this artifact."
        ModelStatus.TAMPERED ->
            "The on-disk SHA-256 does NOT match the pinned hash. Either the " +
                "file was corrupted during download or the artifact on disk has " +
                "been modified after install. Re-download is recommended."
        ModelStatus.NOT_DOWNLOADED ->
            "No model artifact is currently on disk. Download from Settings to " +
                "begin verification."
    }
}
