package xyz.ghola.app.ai.litert

import android.content.Context
import android.util.Log
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import xyz.ghola.app.ai.IntegrityVerifier
import xyz.ghola.app.ai.PinnedModelHashes
import xyz.ghola.app.ai.SecureStorage
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lifecycle manager for a Phase γ LiteRT-LM `.litertlm` artifact.
 *
 * **Multi-SoC (Phase γ.4 / L2).** This manager is now variant-aware:
 * every public surface dispatches off the [LiteRtVariant] passed at
 * construction time, which encodes the SoC tuning. The production
 * constructor picks the variant for you using [SoCDetector] →
 * [LiteRtVariant.forSoC], so existing callers (`LiteRtModelManager(context)`)
 * keep compiling and Just Work — they silently get the SoC-matched
 * bundle on launch. Tests + admin UI can pass a variant explicitly.
 *
 * Parallels [xyz.ghola.app.ai.llama.ModelManager] but for a different
 * artifact format (`.litertlm` instead of `.gguf`) and a different
 * runtime (LiteRT-LM NPU path instead of llama.cpp). The two managers
 * intentionally coexist — the user may have both the GGUF base model
 * and a LiteRT artifact resident, and the Phase δ `BackendSelector`
 * decides which one to dispatch to per inference.
 *
 * **Storage layout.**
 * `getExternalFilesDir(null)/models/litert-lm/<variant.filename>`.
 * The filename comes verbatim from [LiteRtVariant.filename] which
 * embeds the SoC tag (e.g. `Gemma3-1B-IT_q4_ekv1280_mt6989.litertlm`)
 * because LiteRT-LM artifacts are AOT-compiled per-SoC; an MT6989
 * bundle will not run on an SM8650 device, and a generic name would
 * invite a silent runtime mismatch. The on-disk file is always
 * SoC-pinned.
 *
 * **Download protocol.** HTTP Range-resume via OkHttp. Resumes from
 * the current on-disk file size on every call; servers that don't
 * honour the `Range` header fall through to a full re-download
 * (handled transparently — same shape as
 * [xyz.ghola.app.ai.llama.ModelManager]). The `litert-community` HF
 * repo is gated, so a non-`null` HF Bearer token from
 * [SecureStorage.getHfBearerToken] is attached as
 * `Authorization: Bearer <token>` when present. An anonymous request
 * against the gated repo returns 401, which this manager translates
 * to a specific, user-facing error (see [runDownload]).
 *
 * **Post-download.** The file is hashed via the Phase η
 * [IntegrityVerifier] and compared to [PinnedModelHashes.forVariant].
 * Today every per-variant pin returns `null`
 * (observe-but-don't-enforce) so the post-download path is a no-op
 * pass-through. When the pin lands, a mismatch deletes the file and
 * reports `onError("integrity check failed: tampered or wrong artifact")`.
 *
 * No UI dependencies — caller owns the listener and the threading
 * model. Downloads run on a dedicated worker thread; listener
 * callbacks fire on that same thread.
 *
 * @see LiteRtVariant — sealed enumeration of supported `.litertlm`
 *   bundles, one per SoC family.
 * @see SoCDetector — runtime SoC detection (API 31+ Build.SOC_MODEL
 *   with /proc/cpuinfo fallback).
 * @see xyz.ghola.app.ai.llama.ModelManager — the sibling GGUF
 *   manager whose patterns this class mirrors.
 * @see xyz.ghola.app.ai.IntegrityVerifier — Phase η SHA-256
 *   comparator used for the post-download check.
 * @see xyz.ghola.app.ai.PinnedModelHashes.forVariant — per-variant
 *   pin lookup, enforced after every successful download.
 */
class LiteRtModelManager internal constructor(
    private val context: Context?,
    /**
     * The SoC-tuned bundle this manager instance targets. Determines
     * the download URL, the on-disk filename, and the pinned SHA-256
     * lookup. See class KDoc for the multi-SoC design.
     */
    val activeVariant: LiteRtVariant,
    /**
     * Test-only override of the models directory. Production code
     * always passes `null` here and the dir is derived from
     * `context.getExternalFilesDir(null)/models/litert-lm/`. Unit
     * tests inject a temp dir directly because pure-JVM tests don't
     * have a real Android [Context].
     */
    private val modelsDirOverride: File? = null,
    /**
     * Test-only override of the download URL. Production code passes
     * `null` and the URL is derived from [activeVariant] using
     * [GEMMA_3_1B_BASE_URL]. The unit test suite points this at
     * MockWebServer.
     */
    private val urlOverride: String? = null,
    /**
     * Test-only override of the HF Bearer token resolver. Production
     * code passes `null` and the token is fetched from
     * [SecureStorage.getHfBearerToken] using the manager's [context].
     * Tests inject a constant string (or `null` to assert the
     * anonymous-request path).
     */
    private val hfTokenOverride: (() -> String?)? = null,
) {

    /**
     * Production constructor. Auto-selects the variant via
     * [SoCDetector] so existing callers — `LiteRtModelManager(context)`
     * — keep compiling and silently get the SoC-matched bundle.
     */
    constructor(context: Context) : this(
        context = context,
        activeVariant = LiteRtVariant.forSoC(SoCDetector.detect(context)),
        modelsDirOverride = null,
        urlOverride = null,
        hfTokenOverride = null,
    )

    /**
     * Production constructor with an explicit variant override —
     * used by Settings (manual SoC override) and any admin UI that
     * wants to force-download a non-default bundle.
     */
    constructor(context: Context, variant: LiteRtVariant) : this(
        context = context,
        activeVariant = variant,
        modelsDirOverride = null,
        urlOverride = null,
        hfTokenOverride = null,
    )

    companion object {
        private const val TAG = "LiteRtModelManager"

        /**
         * Base HuggingFace path for the per-SoC `.litertlm` ladder.
         * The full download URL is `${BASE}/${variant.filename}`.
         *
         * The `litert-community/Gemma3-1B-IT` repo is **gated** — see
         * the class KDoc. Downloads without an HF Bearer token will
         * 401; the manager surfaces a specific error message in that
         * case so the UI can prompt the user.
         *
         * Confirmed by the parallel URL-research agent. Replaces the
         * pre-multi-SoC placeholder
         * `litert-community/Gemma-3-1B-NPU-MT6878` (which never
         * existed — it was a stub for the single-SoC γ.2 commit).
         */
        const val GEMMA_3_1B_BASE_URL: String =
            "https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main"

        /**
         * Sub-directory under the app's models dir where every
         * variant lands. Keeping LiteRT artifacts under a dedicated
         * dir means a future cleanup pass can wipe the whole tree
         * without disturbing the sibling GGUF cache.
         */
        const val MODELS_SUBDIR: String = "litert-lm"

        /** Buffer size for the chunked download write loop — same
         *  rationale as [xyz.ghola.app.ai.llama.ModelManager.BUFFER_SIZE]. */
        private const val BUFFER_SIZE = 8192

        /** Connect/read timeouts. Match [xyz.ghola.app.ai.llama.ModelManager]
         *  modulo the OkHttp idiom: ModelManager uses HttpURLConnection's
         *  millisecond setters; OkHttp wants explicit TimeUnit. */
        private const val CONNECT_TIMEOUT_SEC = 15L
        private const val READ_TIMEOUT_SEC = 30L

        /**
         * User-facing error message emitted when HuggingFace returns
         * 401 (the gated-repo case). Stable so the UI can pattern-
         * match against it without parsing free-form HTTP messages.
         */
        const val ERR_GATED_REPO: String =
            "HuggingFace repo is gated — set an HF Bearer token in Settings " +
                "or wait for the bundle to land on a public mirror"
    }

    /**
     * Progress + completion callbacks. Identical shape to
     * [xyz.ghola.app.ai.llama.ModelManager.DownloadListener] so UI
     * surfaces can use a single adapter for either manager.
     */
    interface DownloadListener {
        /**
         * Fired at most once per integer-percent change to keep the
         * UI thread from drowning in updates on a multi-hundred-MB
         * download. [total] may be `-1L` if the server didn't supply a
         * `Content-Length`; callers should defensively treat
         * non-positive `total` as "unknown".
         */
        fun onProgress(downloaded: Long, total: Long, percent: Int)

        /** Fired after the file has been written AND the post-download
         *  [IntegrityVerifier] check has passed (or has been bypassed
         *  because the pin is null). [path] is the absolute path. */
        fun onComplete(path: String)

        /** Fired on any failure: network error, HTTP non-2xx, cancel,
         *  or integrity check failure. The file is deleted on
         *  integrity failure before this fires. */
        fun onError(message: String)
    }

    /** See [xyz.ghola.app.ai.llama.ModelManager.ModelStatus]. */
    enum class ModelStatus { NOT_DOWNLOADED, DOWNLOADED_UNVERIFIED, VERIFIED, TAMPERED }

    private val modelsDir: File
        get() {
            val dir = modelsDirOverride
                ?: File(
                    File(checkNotNull(context).getExternalFilesDir(null), "models"),
                    MODELS_SUBDIR,
                )
            if (!dir.exists()) dir.mkdirs()
            return dir
        }

    private val downloadUrl: String
        get() = urlOverride ?: "$GEMMA_3_1B_BASE_URL/${activeVariant.filename}"

    private val modelFile: File
        get() = File(modelsDir, activeVariant.filename)

    private val cancelled = AtomicBoolean(false)

    private val httpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
            .readTimeout(READ_TIMEOUT_SEC, TimeUnit.SECONDS)
            .build()
    }

    /**
     * `true` iff the artifact exists on disk and is non-zero-byte.
     * Does NOT hash the file — that's [isModelVerified]'s job.
     */
    fun isModelDownloaded(): Boolean = modelFile.exists() && modelFile.length() > 0

    /**
     * Run the Phase η integrity check on the `.litertlm` artifact.
     *
     * Mirrors [xyz.ghola.app.ai.llama.ModelManager.isModelVerified]
     * exactly, only the pin source differs — per-variant lookup via
     * [PinnedModelHashes.forVariant]. Returns
     * [ModelStatus.NOT_DOWNLOADED] fast when the file is absent — no
     * hashing is performed in that branch.
     */
    suspend fun isModelVerified(): ModelStatus {
        if (!isModelDownloaded()) return ModelStatus.NOT_DOWNLOADED
        val pin = PinnedModelHashes.forVariant(activeVariant)
        val result = IntegrityVerifier.verifyFile(modelFile, pin)
        return when {
            pin == null -> ModelStatus.DOWNLOADED_UNVERIFIED
            result.match -> ModelStatus.VERIFIED
            else -> ModelStatus.TAMPERED
        }
    }

    /**
     * Absolute path to the model file, but **only when the file is
     * verified or in the unenforced pass-through state**. Returns
     * `null` for [ModelStatus.NOT_DOWNLOADED] and
     * [ModelStatus.TAMPERED] so callers cannot accidentally feed a
     * compromised artifact into the LiteRT-LM runtime.
     *
     * This is a coroutine-blocking call because it must hash the
     * file. For the hot path (every chat turn) cache the result
     * upstream; for the cold init path it's fine.
     */
    suspend fun getModelPath(): String? {
        return when (isModelVerified()) {
            ModelStatus.VERIFIED, ModelStatus.DOWNLOADED_UNVERIFIED ->
                modelFile.absolutePath
            ModelStatus.NOT_DOWNLOADED, ModelStatus.TAMPERED -> null
        }
    }

    /** File size in bytes, or 0 if the file doesn't exist. */
    fun getModelSizeBytes(): Long = if (modelFile.exists()) modelFile.length() else 0L

    /**
     * Cancel an in-flight download. Idempotent — calling twice is
     * harmless. The actual cancel happens at the next chunk boundary
     * in the worker thread's write loop, so worst-case latency is one
     * 8 KiB read.
     */
    fun cancelDownload() {
        cancelled.set(true)
    }

    /**
     * Delete the artifact. Returns `true` if the file was deleted
     * (or never existed), `false` if delete failed. Mirrors
     * [xyz.ghola.app.ai.llama.ModelManager.deleteModel].
     */
    fun deleteModel(): Boolean {
        return if (modelFile.exists()) modelFile.delete() else true
    }

    /**
     * Kick off a download in a worker thread. Resumes from the
     * current on-disk size if the server honours the `Range` header
     * (HTTP 206 Partial Content); otherwise re-downloads from scratch
     * (HTTP 200). A 401 response (gated repo) produces the stable
     * [ERR_GATED_REPO] error message so the UI can pattern-match it.
     *
     * Post-download, the file is hashed and compared to
     * [PinnedModelHashes.forVariant] via [IntegrityVerifier]. If the
     * pin is non-null and the hash disagrees, the file is deleted
     * and [DownloadListener.onError] is fired with
     * `"integrity check failed: tampered or wrong artifact"`.
     *
     * All callbacks are invoked on the worker thread. Marshall to
     * the UI thread upstream if needed.
     */
    fun downloadModel(listener: DownloadListener) {
        cancelled.set(false)
        Thread {
            downloadModelBlocking(listener)
        }.start()
    }

    /**
     * Synchronous variant used by the unit test suite. Production
     * callers always use [downloadModel] which spawns a worker thread;
     * tests prefer the blocking flavour so assertions can observe a
     * deterministic state at return. Does NOT reset the cancel flag —
     * tests can pre-arm a cancel by calling [cancelDownload] first.
     */
    internal fun downloadModelBlocking(listener: DownloadListener) {
        try {
            runDownload(listener)
        } catch (e: Exception) {
            Log.e(TAG, "Download failed", e)
            listener.onError(e.message ?: "Unknown download error")
        }
    }

    /**
     * Resolve the HF Bearer token. Test override wins; otherwise
     * read from [SecureStorage] using the manager's [context]. If
     * neither path produces a token (test passes `null` resolver,
     * or production has no token persisted), return `null` and the
     * request goes out anonymous.
     */
    private fun resolveHfToken(): String? {
        hfTokenOverride?.let { return it() }
        val ctx = context ?: return null
        return SecureStorage(ctx).getHfBearerToken()
    }

    private fun runDownload(listener: DownloadListener) {
        val existingSize = if (modelFile.exists()) modelFile.length() else 0L

        val reqBuilder = Request.Builder().url(downloadUrl)
        if (existingSize > 0) {
            reqBuilder.header("Range", "bytes=$existingSize-")
        }
        // Optional HF Bearer token (gated repo). When absent, the
        // request goes out anonymous and HF returns 401, which we
        // translate to ERR_GATED_REPO below.
        resolveHfToken()?.takeIf { it.isNotBlank() }?.let { token ->
            reqBuilder.header("Authorization", "Bearer $token")
        }
        val request = reqBuilder.build()

        httpClient.newCall(request).execute().use { response ->
            val code = response.code
            val body = response.body
                ?: run {
                    listener.onError("HTTP $code: empty body")
                    return
                }

            val totalSize: Long
            val append: Boolean

            when (code) {
                206 -> {
                    // Server honours Range — body length is the
                    // remaining bytes, not the full artifact size.
                    val remaining = body.contentLength()
                    totalSize = if (remaining > 0) existingSize + remaining else -1L
                    append = true
                    Log.i(TAG, "Resuming download from $existingSize / $totalSize")
                }
                200 -> {
                    totalSize = body.contentLength()
                    append = false
                    Log.i(TAG, "Starting fresh download, total: $totalSize")
                }
                401 -> {
                    // Gated repo — surface a stable, actionable error
                    // string instead of the generic HTTP message.
                    Log.w(TAG, "HF returned 401 for ${activeVariant.filename} — gated repo")
                    listener.onError(ERR_GATED_REPO)
                    return
                }
                else -> {
                    listener.onError("HTTP $code: ${response.message}")
                    return
                }
            }

            val buffer = ByteArray(BUFFER_SIZE)
            var downloaded = if (append) existingSize else 0L
            var lastReportedPercent = -1

            body.byteStream().use { input ->
                FileOutputStream(modelFile, append).use { output ->
                    while (!cancelled.get()) {
                        val bytesRead = input.read(buffer)
                        if (bytesRead == -1) break

                        output.write(buffer, 0, bytesRead)
                        downloaded += bytesRead

                        val percent = if (totalSize > 0) {
                            ((downloaded * 100) / totalSize).toInt()
                        } else {
                            0
                        }

                        if (percent != lastReportedPercent) {
                            lastReportedPercent = percent
                            listener.onProgress(downloaded, totalSize, percent)
                        }
                    }
                }
            }
        }

        if (cancelled.get()) {
            listener.onError("Download cancelled")
            return
        }

        // Post-download integrity check (Phase η). Run synchronously
        // on the worker thread — the file is freshly closed, the
        // hash is the gate to declaring `onComplete`.
        val pin = PinnedModelHashes.forVariant(activeVariant)
        val verifyResult = runBlocking { IntegrityVerifier.verifyFile(modelFile, pin) }

        if (pin != null && !verifyResult.match) {
            // Pin is enforced AND hash disagrees → destroy the
            // bad artifact so the next attempt doesn't resume on
            // top of poisoned bytes.
            Log.w(
                TAG,
                "Integrity failure: ${verifyResult.reason}. Deleting artifact.",
            )
            modelFile.delete()
            listener.onError("integrity check failed: tampered or wrong artifact")
            return
        }

        Log.i(TAG, "Download complete: ${modelFile.absolutePath}")
        listener.onComplete(modelFile.absolutePath)
    }

    /** Human-readable size formatter — mirrors
     *  [xyz.ghola.app.ai.llama.ModelManager.formatSize]. */
    fun formatSize(bytes: Long): String {
        return when {
            bytes >= 1_073_741_824 -> "%.1f GB".format(bytes / 1_073_741_824.0)
            bytes >= 1_048_576 -> "%.1f MB".format(bytes / 1_048_576.0)
            bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0)
            else -> "$bytes B"
        }
    }
}
