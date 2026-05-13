package xyz.ghola.app.email

import android.content.Context
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.widget.EditText
import androidx.lifecycle.LifecycleCoroutineScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Cursor-style autocomplete for an email body [EditText].
 *
 * Lifecycle: caller attaches via [attach], passing a lifecycle scope, the
 * EditText to watch, and a hook to render ghost text into. The engine
 *   1. listens to text changes,
 *   2. debounces typing for [DEBOUNCE_MILLIS],
 *   3. asks [LocalEmailService.complete] for a ~20-token continuation,
 *   4. invokes [render] with the suggestion.
 *
 * Accepting / rejecting the suggestion is the responsibility of the host
 * Activity — typically Tab/space accepts (merge into the EditText), any
 * other input rejects (render null).
 *
 * Single-flight: a new keystroke during a pending call cancels the prior
 * call's coroutine. We don't try to overlap completions.
 *
 * P5 status: this is the engine API. The visual ghost-text overlay
 * (GhostTextOverlay) lives in the future EmailDraftActivity; until that
 * activity ships, [SuggestionEngine] is callable from any Activity that
 * wires its render lambda to something visible.
 */
class SuggestionEngine(
    private val context: Context,
    private val scope: LifecycleCoroutineScope,
) {

    companion object {
        private const val TAG = "SuggestionEngine"
        private const val DEBOUNCE_MILLIS = 150L
        private const val MIN_PREFIX_LENGTH = 12
    }

    private var pending: Job? = null
    private var attached: EditText? = null
    private var watcher: TextWatcher? = null

    /**
     * Attach to [editText]. Invokes [render] with either the most recent
     * suggestion text or null (to clear the overlay).
     */
    fun attach(editText: EditText, render: (suggestion: String?) -> Unit) {
        detach()
        attached = editText
        watcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                val prefix = s?.toString().orEmpty()
                pending?.cancel()
                if (prefix.length < MIN_PREFIX_LENGTH) {
                    render(null)
                    return
                }
                pending = scope.launch(Dispatchers.IO) {
                    delay(DEBOUNCE_MILLIS)
                    val anchors = VoiceCorpus.get(context).findStyleAnchors(
                        intent = prefix,
                        k = 3,
                    )
                    val suggestion = LocalEmailService.complete(
                        context = context,
                        prefix = prefix,
                        anchors = anchors,
                    )
                    if (suggestion.isNullOrBlank()) {
                        withContext(Dispatchers.Main) { render(null) }
                    } else {
                        // Strip echoes of the prefix the model included.
                        val trimmed = suggestion
                            .removePrefix(prefix)
                            .trimStart('\n', ' ')
                            .take(120)
                        withContext(Dispatchers.Main) { render(trimmed) }
                    }
                }
            }
        }
        editText.addTextChangedListener(watcher)
    }

    fun detach() {
        attached?.let { et ->
            watcher?.let { et.removeTextChangedListener(it) }
        }
        attached = null
        watcher = null
        pending?.cancel()
        pending = null
    }

    /** Caller fires this to accept the current suggestion: merge into the EditText. */
    fun accept(suggestion: String) {
        val et = attached ?: return
        val current = et.text?.toString().orEmpty()
        val merged = current + suggestion
        et.setText(merged)
        et.setSelection(merged.length)
    }
}

/**
 * Helper: route accept-keys (Tab + space-at-end-of-line) to the engine.
 */
object SuggestionInput {
    /** Returns true if [keyCode] should accept a pending suggestion. */
    fun isAcceptKey(keyCode: Int): Boolean =
        keyCode == android.view.KeyEvent.KEYCODE_TAB
}
