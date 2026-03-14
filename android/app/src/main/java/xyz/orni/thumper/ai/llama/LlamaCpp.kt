package xyz.orni.thumper.ai.llama

import android.util.Log

interface LlamaCallback {
    fun onToken(token: String)
    fun onComplete()
}

class LlamaCpp {

    companion object {
        private const val TAG = "LlamaCpp"

        init {
            System.loadLibrary("thumper_llama")
            Log.i(TAG, "thumper_llama native library loaded")
        }
    }

    external fun loadModel(
        modelPath: String,
        contextSize: Int,
        numThreads: Int,
        temp: Float,
        topP: Float
    ): Boolean

    external fun generate(prompt: String, maxTokens: Int): String

    external fun generateStreaming(prompt: String, maxTokens: Int, callback: LlamaCallback)

    external fun cancel()

    external fun release()

    external fun tokenCount(text: String): Int
}
