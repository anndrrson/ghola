package xyz.ghola.app.service

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

/**
 * Wraps Android's built-in TextToSpeech for free, offline speech output.
 */
class TtsService(context: Context) : TextToSpeech.OnInitListener {

    companion object {
        private const val TAG = "TtsService"
    }

    private val tts = TextToSpeech(context, this)
    private var isReady = false

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val result = tts.setLanguage(Locale.US)
            isReady = result != TextToSpeech.LANG_MISSING_DATA &&
                      result != TextToSpeech.LANG_NOT_SUPPORTED
            if (isReady) {
                tts.setSpeechRate(1.1f) // Slightly faster for assistant responses
                Log.i(TAG, "TTS initialized successfully")
            } else {
                Log.w(TAG, "TTS language not supported")
            }
        } else {
            Log.e(TAG, "TTS initialization failed: $status")
        }
    }

    fun speak(text: String, onDone: (() -> Unit)? = null) {
        if (!isReady) {
            Log.w(TAG, "TTS not ready, skipping: ${text.take(50)}")
            onDone?.invoke()
            return
        }

        val utteranceId = "thumper_${System.currentTimeMillis()}"

        if (onDone != null) {
            tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(id: String?) {}
                override fun onDone(id: String?) {
                    if (id == utteranceId) onDone()
                }
                @Deprecated("Deprecated in Java")
                override fun onError(id: String?) {
                    if (id == utteranceId) onDone()
                }
            })
        }

        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
    }

    fun stop() {
        tts.stop()
    }

    fun isSpeaking(): Boolean = tts.isSpeaking

    fun destroy() {
        tts.stop()
        tts.shutdown()
    }
}
