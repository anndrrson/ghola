package xyz.ghola.app.ai.llama

import android.content.Context
import android.util.Log
import xyz.ghola.app.ai.IntegrityVerifier
import xyz.ghola.app.ai.ModelStatus
import xyz.ghola.app.ai.PinnedModelHashes
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

class ModelManager(private val context: Context) {

    companion object {
        private const val TAG = "ModelManager"

        // v0.6: switch base from Qwen3-4B-Q4_K_M to Qwen2.5-1.5B-q8_0.
        //
        // Why this swap:
        //   - 4B at Q4_K_M ≈ 2.4GB; the LoRA fine-tune backward pass needs
        //     near-fp16 weights, and Q4 quantization significantly hurts
        //     adapter quality. q8 ≈ 1.6GB and is near-lossless.
        //   - 1.5B is the largest class we can finetune on a Dimensity 9300
        //     in a reasonable overnight window (~1-1.7h wall-clock for 500
        //     emails × 3 epochs).
        //   - Matches the v0.5 capability — `LocalChatBackend` was tuned
        //     against this same 1.5B model class.
        private const val MODEL_URL =
            "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/" +
                "qwen2.5-1.5b-instruct-q8_0.gguf"
        private const val MODEL_FILENAME = "qwen2.5-1.5b-instruct-q8_0.gguf"

        /** Per-user LoRA adapter file, written by [PersonalFineTuneWorker]. */
        const val LORA_FILENAME = "voice.lora"

        /** Cached centroid (FloatArray packed little-endian) — rebuilt by
         *  [VoiceMetric] each fine-tune. */
        const val CENTROID_FILENAME = "voice.centroid.bin"

        /** JSON sidecar with fine-tune provenance — written on success. */
        const val LORA_META_FILENAME = "voice.lora.meta.json"

        private const val BUFFER_SIZE = 8192
    }

    interface DownloadListener {
        fun onProgress(downloaded: Long, total: Long, percent: Int)
        fun onComplete(path: String)
        fun onError(message: String)
    }

    private val modelsDir: File
        get() {
            val dir = File(context.getExternalFilesDir(null), "models")
            if (!dir.exists()) dir.mkdirs()
            return dir
        }

    /** Fallback for dev workflows where adb push to /sdcard isn't readable
     *  by the app (FUSE perms strip read access). `run-as cp` lands here. */
    private val internalModelsDir: File
        get() {
            val dir = File(context.filesDir, "models")
            if (!dir.exists()) dir.mkdirs()
            return dir
        }

    private val modelFile: File
        get() {
            // Prefer external (production path), fall back to internal (dev).
            val ext = File(modelsDir, MODEL_FILENAME)
            if (ext.exists() && ext.length() > 0) return ext
            val int = File(internalModelsDir, MODEL_FILENAME)
            if (int.exists() && int.length() > 0) return int
            return ext // Doesn't exist yet; caller will trigger download.
        }

    @Volatile
    private var cancelled = false

    fun isModelDownloaded(): Boolean = modelFile.exists() && modelFile.length() > 0

    /**
     * Run the Phase η integrity check on the base GGUF artifact. This is
     * the Kotlin counterpart of `computeLoadedWeightFingerprint` from
     * `apps/web/src/lib/webgpu-inference.ts` plus the SRI-style pin
     * compare from `DEFAULT_WEBGPU_MODEL_INTEGRITY`. The hash is streamed
     * in 64 KiB chunks via [IntegrityVerifier.verifyFile], so the
     * full 1.6 GB model never has to be resident in a single buffer.
     *
     * Returns [ModelStatus.NOT_DOWNLOADED] fast (no hashing) when the
     * file is absent — the legacy `isModelDownloaded()` semantics are
     * preserved for callers that only care about presence.
     */
    suspend fun isModelVerified(): ModelStatus {
        if (!isModelDownloaded()) return ModelStatus.NOT_DOWNLOADED
        val pin = PinnedModelHashes.QWEN_2_5_1_5B_Q8_GGUF_SHA256
        val result = IntegrityVerifier.verifyFile(modelFile, pin)
        return when {
            pin == null -> ModelStatus.DOWNLOADED_UNVERIFIED
            result.match -> ModelStatus.VERIFIED
            else -> ModelStatus.TAMPERED
        }
    }

    fun getModelPath(): String = modelFile.absolutePath

    fun getModelSizeBytes(): Long = if (modelFile.exists()) modelFile.length() else 0

    fun deleteModel(): Boolean {
        return if (modelFile.exists()) {
            modelFile.delete()
        } else {
            true
        }
    }

    // ── LoRA adapter helpers (v0.6) ──────────────────────────────────────────
    //
    // The LoRA file lives next to the base GGUF in the same models dir so
    // backup/eviction policies treat them as a unit. The Kotlin caller asks
    // for a path; PersonalFineTuneWorker writes; LlamaCppImpl loads.

    /** Where new LoRAs are written: alongside the base model file, so the
     *  training run and the inference run see the same dir. Falls back to
     *  internal when the base model lives there. */
    private val sidecarDir: File
        get() = modelFile.parentFile ?: modelsDir

    fun getLoraFile(): File = File(sidecarDir, LORA_FILENAME)
    fun getLoraPath(): String = getLoraFile().absolutePath
    fun isLoraReady(): Boolean = getLoraFile().let { it.exists() && it.length() > 0 }

    fun getCentroidFile(): File = File(sidecarDir, CENTROID_FILENAME)
    fun getLoraMetaFile(): File = File(sidecarDir, LORA_META_FILENAME)

    fun deleteLora(): Boolean {
        var ok = true
        listOf(getLoraFile(), getCentroidFile(), getLoraMetaFile()).forEach { f ->
            if (f.exists() && !f.delete()) ok = false
        }
        return ok
    }

    fun cancelDownload() {
        cancelled = true
    }

    fun downloadModel(listener: DownloadListener) {
        cancelled = false
        Thread {
            try {
                val existingSize = if (modelFile.exists()) modelFile.length() else 0L

                val url = URL(MODEL_URL)
                val connection = url.openConnection() as HttpURLConnection
                connection.connectTimeout = 15000
                connection.readTimeout = 30000

                // Resume support
                if (existingSize > 0) {
                    connection.setRequestProperty("Range", "bytes=$existingSize-")
                }

                connection.connect()

                val responseCode = connection.responseCode
                val totalSize: Long
                val append: Boolean

                when (responseCode) {
                    HttpURLConnection.HTTP_PARTIAL -> {
                        // Server supports resume
                        totalSize = existingSize + connection.contentLength.toLong()
                        append = true
                        Log.i(TAG, "Resuming download from $existingSize / $totalSize")
                    }
                    HttpURLConnection.HTTP_OK -> {
                        totalSize = connection.contentLength.toLong()
                        append = false
                        Log.i(TAG, "Starting fresh download, total: $totalSize")
                    }
                    else -> {
                        listener.onError("HTTP $responseCode: ${connection.responseMessage}")
                        connection.disconnect()
                        return@Thread
                    }
                }

                val inputStream = connection.inputStream
                val outputStream = FileOutputStream(modelFile, append)
                val buffer = ByteArray(BUFFER_SIZE)
                var downloaded = if (append) existingSize else 0L
                var lastReportedPercent = -1

                inputStream.use { input ->
                    outputStream.use { output ->
                        while (!cancelled) {
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

                connection.disconnect()

                if (cancelled) {
                    listener.onError("Download cancelled")
                } else {
                    Log.i(TAG, "Download complete: ${modelFile.absolutePath}")
                    listener.onComplete(modelFile.absolutePath)
                }

            } catch (e: Exception) {
                Log.e(TAG, "Download failed", e)
                listener.onError(e.message ?: "Unknown download error")
            }
        }.start()
    }

    fun formatSize(bytes: Long): String {
        return when {
            bytes >= 1_073_741_824 -> "%.1f GB".format(bytes / 1_073_741_824.0)
            bytes >= 1_048_576 -> "%.1f MB".format(bytes / 1_048_576.0)
            bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0)
            else -> "$bytes B"
        }
    }
}
