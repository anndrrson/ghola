package xyz.ghola.app.gmail

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.ai.SecureStorage
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Direct Gmail API client used by the on-device email stack.
 *
 * Authenticates with the user's own OAuth access token (stored in
 * [SecureStorage] by [GmailOAuth]); never goes through `thumper-cloud`. On
 * 401 it tries a single silent refresh via [GmailOAuth.refreshAccessToken];
 * if that also fails, the caller surfaces a re-authorize prompt.
 *
 * Only implements the routes the v0.5 email stack needs:
 *  - listSentMessageIds — for [GmailMirrorWorker] to fan out and fetch.
 *  - fetchMessage — full Message resource, decoded body + headers.
 *  - listThreadMessages — for replies, to give the local LLM thread context.
 *  - sendRaw — actually ship a draft when the user hits Send.
 */
class GmailClient(private val context: Context) {

    companion object {
        private const val TAG = "GmailClient"
        private const val API = "https://gmail.googleapis.com/gmail/v1/users/me"
    }

    private val secureStorage = SecureStorage(context)
    private val gmailOAuth = GmailOAuth(context)

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * Returns up to [maxResults] sent-folder message ids matching [query].
     * Default query "in:sent" — pass narrower queries (e.g.
     * `"in:sent newer_than:14d"`) for incremental syncs.
     */
    suspend fun listSentMessageIds(
        query: String = "in:sent",
        maxResults: Int = 100,
    ): List<String> = withContext(Dispatchers.IO) {
        val url = "$API/messages?q=${java.net.URLEncoder.encode(query, "UTF-8")}" +
            "&maxResults=$maxResults"
        val resp = authedGet(url) ?: return@withContext emptyList()
        val arr = resp.optJSONArray("messages") ?: JSONArray()
        (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.optString("id")?.takeIf { it.isNotBlank() }
        }
    }

    /**
     * Fetch a single message in `full` format. Returns a [GmailMessage]
     * with the decoded text body extracted from the MIME tree, headers
     * parsed, and the recipient list flattened.
     */
    suspend fun fetchMessage(messageId: String): GmailMessage? = withContext(Dispatchers.IO) {
        val url = "$API/messages/$messageId?format=full"
        val raw = authedGet(url) ?: return@withContext null
        parseMessage(raw)
    }

    /**
     * Fetch every message in [threadId], ordered by Gmail's internal order
     * (chronological for normal threads). Used to feed thread context into
     * the local LLM for reply generation.
     */
    suspend fun listThreadMessages(threadId: String): List<GmailMessage> =
        withContext(Dispatchers.IO) {
            val url = "$API/threads/$threadId?format=full"
            val raw = authedGet(url) ?: return@withContext emptyList()
            val msgs = raw.optJSONArray("messages") ?: return@withContext emptyList()
            (0 until msgs.length()).mapNotNull { i ->
                msgs.optJSONObject(i)?.let { parseMessage(it) }
            }
        }

    /**
     * Send a RFC 2822 raw message. The [raw] payload must already include
     * `To:`, `Subject:`, etc. Returns the new message id on success.
     */
    suspend fun sendRaw(raw: ByteArray): String? = withContext(Dispatchers.IO) {
        val encoded = android.util.Base64.encodeToString(
            raw,
            android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING,
        )
        val body = JSONObject().put("raw", encoded)
        val resp = authedPost("$API/messages/send", body) ?: return@withContext null
        resp.optString("id").takeIf { it.isNotBlank() }
    }

    // ── HTTP helpers ─────────────────────────────────────────────────────────

    private suspend fun authedGet(url: String): JSONObject? = withRefreshRetry { token ->
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        executeJson(req, "GET $url")
    }

    private suspend fun authedPost(url: String, body: JSONObject): JSONObject? =
        withRefreshRetry { token ->
            val req = Request.Builder()
                .url(url)
                .header("Authorization", "Bearer $token")
                .header("Content-Type", "application/json")
                .post(body.toString().toRequestBody(
                    "application/json; charset=utf-8".toMediaType(),
                ))
                .build()
            executeJson(req, "POST $url")
        }

    /**
     * Run [block] with the current access token. On 401, silently refresh
     * once and retry. Returns null if no token is available or both attempts
     * fail.
     */
    private suspend fun withRefreshRetry(
        block: suspend (token: String) -> Pair<Int, JSONObject?>,
    ): JSONObject? {
        val tok = freshAccessToken() ?: return null
        val (code, body) = block(tok)
        if (code != 401) return body
        Log.i(TAG, "Gmail 401 — refreshing")
        val newTok = gmailOAuth.refreshAccessToken() ?: run {
            Log.w(TAG, "Gmail refresh failed; clearing credentials")
            secureStorage.clearGmailAuth()
            return null
        }
        val (code2, body2) = block(newTok)
        return if (code2 != 401) body2 else null
    }

    private suspend fun freshAccessToken(): String? {
        if (secureStorage.hasFreshGmailAccess()) return secureStorage.getGmailAccessToken()
        return gmailOAuth.refreshAccessToken() ?: secureStorage.getGmailAccessToken()
    }

    private fun executeJson(req: Request, label: String): Pair<Int, JSONObject?> {
        return try {
            val resp = http.newCall(req).execute()
            val code = resp.code
            val body = resp.body?.string()
            if (resp.isSuccessful && !body.isNullOrBlank()) {
                code to JSONObject(body)
            } else {
                Log.w(TAG, "$label → $code ${body?.take(200)}")
                code to null
            }
        } catch (e: IOException) {
            Log.e(TAG, "$label IO error", e)
            -1 to null
        }
    }

    // ── Message parsing ──────────────────────────────────────────────────────

    private fun parseMessage(raw: JSONObject): GmailMessage? {
        val id = raw.optString("id").takeIf { it.isNotBlank() } ?: return null
        val threadId = raw.optString("threadId", "")
        val internalDate = raw.optLong("internalDate", 0L)
        val payload = raw.optJSONObject("payload") ?: return null
        val headers = parseHeaders(payload.optJSONArray("headers"))
        val body = extractPlainTextBody(payload).orEmpty()
        return GmailMessage(
            id = id,
            threadId = threadId,
            sentAt = internalDate,
            from = headers["From"].orEmpty(),
            to = parseAddressList(headers["To"]),
            cc = parseAddressList(headers["Cc"]),
            subject = headers["Subject"].orEmpty(),
            body = body,
        )
    }

    private fun parseHeaders(arr: JSONArray?): Map<String, String> {
        if (arr == null) return emptyMap()
        val out = mutableMapOf<String, String>()
        for (i in 0 until arr.length()) {
            val h = arr.optJSONObject(i) ?: continue
            val name = h.optString("name").takeIf { it.isNotBlank() } ?: continue
            out[name] = h.optString("value", "")
        }
        return out
    }

    private fun parseAddressList(value: String?): List<String> {
        if (value.isNullOrBlank()) return emptyList()
        return value.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    }

    /**
     * Walk the MIME tree depth-first looking for the first `text/plain` part.
     * Falls back to `text/html` with tags stripped. Gmail returns body data
     * as `base64url-encoded` strings.
     */
    private fun extractPlainTextBody(payload: JSONObject): String? {
        val mime = payload.optString("mimeType", "")
        val bodyData = payload.optJSONObject("body")?.optString("data", "")
        if (mime == "text/plain" && !bodyData.isNullOrBlank()) {
            return decodeBase64Url(bodyData)
        }
        val parts = payload.optJSONArray("parts") ?: return run {
            if (mime == "text/html" && !bodyData.isNullOrBlank()) {
                decodeBase64Url(bodyData)?.let { stripHtml(it) }
            } else null
        }
        // First pass: prefer text/plain anywhere in the tree.
        for (i in 0 until parts.length()) {
            val p = parts.optJSONObject(i) ?: continue
            val found = extractPlainTextBody(p)
            if (!found.isNullOrBlank()) return found
        }
        return null
    }

    private fun decodeBase64Url(s: String): String? = try {
        val bytes = android.util.Base64.decode(
            s,
            android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP,
        )
        String(bytes, Charsets.UTF_8)
    } catch (_: Throwable) {
        null
    }

    private fun stripHtml(html: String): String =
        html.replace(Regex("<[^>]+>"), "")
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace(Regex("\\s+"), " ")
            .trim()

    fun dispose() {
        gmailOAuth.dispose()
    }
}

/**
 * Lightweight representation of a Gmail message used by the v0.5 email
 * stack. Drops attachments, drops MIME structure, keeps only what the
 * voice-transfer index and reply-context paths need.
 */
data class GmailMessage(
    val id: String,
    val threadId: String,
    val sentAt: Long,           // unix millis (Gmail's internalDate)
    val from: String,
    val to: List<String>,
    val cc: List<String>,
    val subject: String,
    val body: String,           // decoded plain text, may be empty
)
