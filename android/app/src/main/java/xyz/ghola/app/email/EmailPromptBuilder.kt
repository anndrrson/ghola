package xyz.ghola.app.email

import xyz.ghola.app.gmail.SentEmail

/**
 * Builds the two prompts the local LLM sees when drafting an email:
 *
 *  - [buildSkeletonPrompt] — first pass. Asks for `{"to": "...", "subject": "..."}`
 *    only. ~30-50 token output. Fires in ~300ms on Seeker.
 *  - [buildBodyPrompt] — second pass. Asks for the body, with the chosen to +
 *    subject pinned in the prompt so the body matches.
 *
 * Both prompts include voice-transfer anchors — real past emails the user
 * has written — and an explicit anti-pattern list. The "lameness" of the
 * default cloud email path comes from a generic prompt that gives the LLM
 * no negative signal. Spelling out what to *avoid* is at least as important
 * as describing what to *do*.
 */
object EmailPromptBuilder {

    /**
     * Skeleton-first prompt. Returns ONLY JSON, no prose.
     */
    fun buildSkeletonPrompt(
        intent: String,
        anchors: List<SentEmail>,
        recipientHint: String?,
        threadContext: List<String> = emptyList(),
    ): String = buildString {
        appendLine("You are drafting an email on behalf of the user. ONLY output JSON.")
        appendLine()
        appendLine("---- Voice anchors (recent emails the user has written) ----")
        appendAnchors(anchors)
        appendLine("---- /Voice anchors ----")
        appendLine()
        if (threadContext.isNotEmpty()) {
            appendLine("---- Thread context (most recent first) ----")
            threadContext.forEachIndexed { i, msg ->
                appendLine("[#$i] $msg")
            }
            appendLine("---- /Thread context ----")
            appendLine()
        }
        appendLine("User intent: $intent")
        if (!recipientHint.isNullOrBlank()) {
            appendLine("Recipient hint: $recipientHint")
        }
        appendLine()
        appendLine("Emit a JSON object with these fields and NOTHING else:")
        appendLine(
            """{"to": "<email>", "subject": "<short, no period, max 8 words>"}""",
        )
        appendLine("If you cannot infer a recipient, set 'to' to 'recipient@example.com'.")
        appendLine("Begin JSON now:")
    }

    /**
     * Body prompt — second pass with the chosen `to` and `subject` pinned.
     * The LLM emits body text only; the client wraps it back into the draft.
     */
    fun buildBodyPrompt(
        intent: String,
        anchors: List<SentEmail>,
        chosenTo: String,
        chosenSubject: String,
        threadContext: List<String> = emptyList(),
    ): String = buildString {
        appendLine("You are writing the body of an email on behalf of the user.")
        appendLine()
        appendLine("---- Voice anchors (recent emails the user has written) ----")
        appendAnchors(anchors)
        appendLine("---- /Voice anchors ----")
        appendLine()
        if (threadContext.isNotEmpty()) {
            appendLine("---- Thread context (most recent first) ----")
            threadContext.forEachIndexed { i, msg ->
                appendLine("[#$i] $msg")
            }
            appendLine("---- /Thread context ----")
            appendLine()
        }
        appendLine("Recipient: $chosenTo")
        appendLine("Subject: $chosenSubject")
        appendLine("User intent: $intent")
        appendLine()
        appendLine("Write the email body in the user's voice. Hard rules:")
        appendLine("  • Match the cadence + sentence length of the voice anchors above.")
        appendLine("  • Maximum 4 sentences for routine emails. Be direct.")
        appendLine("  • Lead with the ask or the answer. No throat-clearing.")
        appendLine("  • Do NOT begin with 'I hope this email finds you well',")
        appendLine("    'I hope you are doing well', or any equivalent.")
        appendLine("  • Do NOT close with 'Please don't hesitate to reach out',")
        appendLine("    'Looking forward to hearing from you', or filler.")
        appendLine("  • Do NOT use the words 'circle back', 'touch base', 'reach out',")
        appendLine("    'leverage', 'utilize', or 'synergy' unless the anchors do.")
        appendLine("  • Sign with the user's first name only if the anchors do.")
        appendLine("  • Plain text. No subject line. No 'From:' or 'To:' headers.")
        appendLine()
        appendLine("Body:")
    }

    /**
     * Render the anchor emails as `Subject — Body[:200]` lines. Keeping each
     * anchor short lets us fit 5 anchors in the context window while still
     * giving the LLM enough signal to mimic the user's cadence.
     */
    private fun StringBuilder.appendAnchors(anchors: List<SentEmail>) {
        if (anchors.isEmpty()) {
            appendLine("(no anchors available — write in a direct, plain voice)")
            return
        }
        anchors.forEachIndexed { i, e ->
            appendLine("[#$i] To: ${e.toAddresses.firstOrNull().orEmpty()}")
            appendLine("    Subject: ${e.subject}")
            val snippet = e.bodyText
                .lineSequence()
                .filter { it.isNotBlank() }
                .joinToString(" ")
                .take(280)
            appendLine("    Body: $snippet")
        }
    }
}
