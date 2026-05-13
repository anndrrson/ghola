package xyz.ghola.app.email

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import org.json.JSONObject

/**
 * The v0.5 replacement for `/api/emails/generate`. Runs entirely on-device:
 *
 *   intent + recipient
 *     → VoiceCorpus.findStyleAnchors      (retrieval over user's sent folder)
 *     → EmailPromptBuilder.buildSkeleton  (assemble skeleton prompt)
 *     → LocalLlm.generateOnce             (skeleton pass → {to, subject})
 *     → EmailPromptBuilder.buildBody      (assemble body prompt)
 *     → LocalLlm.generateStream           (body streams to the UI)
 *
 * UX contract: the [draft] suspend returns a [LocalDraft] with `to + subject`
 * resolved synchronously after the skeleton pass (~300ms), and a `body` Flow
 * that emits cumulative body text as the local LLM streams tokens. The UI
 * paints the skeleton immediately and appends body characters as the flow
 * advances.
 */
object LocalEmailService {

    private const val TAG = "LocalEmail"

    /**
     * Generate an email draft fully on-device.
     *
     * Returns null if the local model isn't available (model file not yet
     * downloaded, or runtime init failure). Callers should fall back to a
     * "Local model preparing — try again in a minute" message rather than
     * silently hitting the cloud.
     */
    suspend fun draft(
        context: Context,
        intent: String,
        recipientHint: String? = null,
        threadContext: List<String> = emptyList(),
    ): LocalDraft? {
        val llm = LocalLlm.get(context) ?: run {
            Log.w(TAG, "local LLM unavailable — model not ready or init failed")
            return null
        }
        val anchors = VoiceCorpus.get(context).findStyleAnchors(
            intent = intent,
            recipient = recipientHint,
            k = 5,
        )
        Log.i(TAG, "draft using ${anchors.size} style anchors")

        val skeletonPrompt = EmailPromptBuilder.buildSkeletonPrompt(
            intent = intent,
            anchors = anchors,
            recipientHint = recipientHint,
            threadContext = threadContext,
        )
        val skeletonRaw = llm.generateOnce(skeletonPrompt)
        if (skeletonRaw.isNullOrBlank()) {
            Log.w(TAG, "skeleton pass produced nothing")
            return null
        }
        val (chosenTo, chosenSubject) = parseSkeleton(skeletonRaw, recipientHint)

        val bodyPrompt = EmailPromptBuilder.buildBodyPrompt(
            intent = intent,
            anchors = anchors,
            chosenTo = chosenTo,
            chosenSubject = chosenSubject,
            threadContext = threadContext,
        )
        val bodyFlow: Flow<String> = flow {
            // Re-emit the cumulative body string for each chunk MediaPipe
            // pushes; flowOn(IO) so collectors on the main thread don't
            // block model work.
            llm.generateStream(bodyPrompt).collect { cumulative ->
                emit(cumulative)
            }
        }.flowOn(Dispatchers.IO)

        return LocalDraft(
            to = chosenTo,
            subject = chosenSubject,
            body = bodyFlow,
        )
    }

    /**
     * Token-level completion for cursor-style autocomplete (P5). Given a
     * prefix the user is typing, returns the model's continuation, capped
     * at [LocalLlm.COMPLETION_TOKENS]. Synchronous one-shot — completions
     * are short enough that streaming buys nothing here.
     */
    suspend fun complete(
        context: Context,
        prefix: String,
        anchors: List<xyz.ghola.app.gmail.SentEmail>,
    ): String? {
        val llm = LocalLlm.get(context) ?: return null
        val prompt = buildString {
            appendLine("Continue the following email body in the user's voice.")
            appendLine("Output ONLY the continuation — no quoting, no labels.")
            appendLine()
            appendLine("Voice anchors (style only, do not quote):")
            anchors.take(3).forEachIndexed { i, e ->
                appendLine("  [#$i] ${e.bodyText.take(160).replace('\n', ' ')}")
            }
            appendLine()
            appendLine("Continuation budget: ${LocalLlm.COMPLETION_TOKENS} tokens.")
            appendLine()
            append(prefix)
        }
        return llm.generateOnce(prompt)
    }

    /**
     * Parse the skeleton response (must be a JSON object with `to` + `subject`).
     * Falls back to defensible defaults if the model emitted malformed JSON.
     */
    private fun parseSkeleton(raw: String, recipientHint: String?): Pair<String, String> {
        // Models occasionally wrap JSON in ```json fences or add commentary.
        // Find the first '{' and last '}' to bracket the JSON region.
        val start = raw.indexOf('{')
        val end = raw.lastIndexOf('}')
        val candidate = if (start in 0 until end) raw.substring(start, end + 1) else raw
        return try {
            val json = JSONObject(candidate)
            val to = json.optString("to", "").trim().ifBlank {
                recipientHint?.takeIf { it.contains('@') } ?: "recipient@example.com"
            }
            val subject = json.optString("subject", "").trim().ifBlank { "(no subject)" }
            to to subject
        } catch (_: Throwable) {
            Log.w(TAG, "skeleton JSON parse failed; using defaults")
            (recipientHint?.takeIf { it.contains('@') } ?: "recipient@example.com") to
                "(no subject)"
        }
    }
}

/**
 * The output of [LocalEmailService.draft]. `to` + `subject` are resolved
 * synchronously after the ~300ms skeleton pass; `body` streams as the model
 * generates. Each `body` emission is the cumulative text — diff against the
 * previous emission to compute the delta if needed.
 */
data class LocalDraft(
    val to: String,
    val subject: String,
    val body: Flow<String>,
)
