package xyz.ghola.app.ai.llama

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

class ModelManager(private val context: Context) {

    companion object {
        private const val TAG = "ModelManager"
        private const val MODEL_URL = "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/qwen3-4b-q4_k_m.gguf"
        private const val MODEL_FILENAME = "qwen3-4b-q4_k_m.gguf"
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

    private val modelFile: File
        get() = File(modelsDir, MODEL_FILENAME)

    @Volatile
    private var cancelled = false

    fun isModelDownloaded(): Boolean = modelFile.exists() && modelFile.length() > 0

    fun getModelPath(): String = modelFile.absolutePath

    fun getModelSizeBytes(): Long = if (modelFile.exists()) modelFile.length() else 0

    fun deleteModel(): Boolean {
        return if (modelFile.exists()) {
            modelFile.delete()
        } else {
            true
        }
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
