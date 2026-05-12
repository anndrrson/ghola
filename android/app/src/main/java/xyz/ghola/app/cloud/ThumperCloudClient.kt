package xyz.ghola.app.cloud

import android.util.Log
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * REST client for the thumper-cloud server.
 * Handles auth, tasks, calls, emails, user profile, and billing.
 *
 * Two construction modes:
 *  - **Legacy** `ThumperCloudClient(baseUrl, authToken)` — token captured at
 *    construction. No 401 refresh. Used by existing callers that don't
 *    care about token rotation (e.g., one-shot scripts).
 *  - **With refresh** [withRefresh] — token read lazily from a provider
 *    lambda, and a 401 response triggers a single `tokenRefresher()` retry
 *    before falling back to `onAuthExhausted`. Used by HomeActivity,
 *    ChatActivity, etc. to keep users signed in across token expiry.
 */
class ThumperCloudClient private constructor(
    private val baseUrl: String,
    private val tokenProvider: () -> String?,
    private val tokenRefresher: (() -> Boolean)?,
    private val onAuthExhausted: (() -> Unit)?,
) {

    /** Legacy constructor: static token, no refresh path. */
    constructor(baseUrl: String, authToken: String) : this(
        baseUrl = baseUrl,
        tokenProvider = { authToken },
        tokenRefresher = null,
        onAuthExhausted = null,
    )

    companion object {
        private const val TAG = "CloudClient"
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        /**
         * Construct a client that lazily reads the current access token and
         * silently refreshes on 401 before retrying once. If the refresh
         * itself fails, [onAuthExhausted] fires and the request returns null.
         *
         * Callers typically wire:
         *   tokenProvider   = { secureStorage.getCloudAuthToken() }
         *   tokenRefresher  = { CloudAuthManager(ctx).refreshToken() }
         *   onAuthExhausted = { /* bounce to onboarding */ }
         */
        fun withRefresh(
            baseUrl: String,
            tokenProvider: () -> String?,
            tokenRefresher: () -> Boolean,
            onAuthExhausted: () -> Unit = {},
        ): ThumperCloudClient = ThumperCloudClient(
            baseUrl = baseUrl,
            tokenProvider = tokenProvider,
            tokenRefresher = tokenRefresher,
            onAuthExhausted = onAuthExhausted,
        )
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // --- Tasks ---

    fun createTask(
        taskType: String,
        params: JSONObject,
        templateId: String? = null,
        agentId: String? = null,
        agentDid: String? = null
    ): JSONObject? {
        val body = JSONObject().apply {
            put("task_type", taskType)
            put("params", params)
            if (templateId != null) put("template_id", templateId)
            // Phase M7: stamp the owned agent so thumper-cloud's task_engine
            // attributes calls/emails/bounties to the agent's history.
            if (agentId != null) put("agent_id", agentId)
            if (agentDid != null) put("agent_did", agentDid)
        }
        return post("/api/tasks", body)
    }

    fun getTask(taskId: String): JSONObject? {
        return get("/api/tasks/$taskId")
    }

    fun listTasks(status: String? = null, limit: Int = 20): JSONArray? {
        val query = buildString {
            append("?limit=$limit")
            if (status != null) append("&status=$status")
        }
        return getArray("/api/tasks$query")
    }

    fun cancelTask(taskId: String): JSONObject? {
        return post("/api/tasks/$taskId/cancel", JSONObject())
    }

    // --- Calls ---

    fun initiateCall(phoneNumber: String, objective: String, taskId: String? = null): JSONObject? {
        val body = JSONObject().apply {
            put("phone_number", phoneNumber)
            put("objective", objective)
            if (taskId != null) put("task_id", taskId)
        }
        return post("/api/calls/initiate", body)
    }

    // --- Emails ---

    fun generateEmail(intent: String, context: String? = null, tone: String? = null): JSONObject? {
        val body = JSONObject().apply {
            put("intent", intent)
            if (context != null) put("context", context)
            if (tone != null) put("tone", tone)
        }
        return post("/api/emails/generate", body)
    }

    fun createEmailDraft(toAddress: String, subject: String, bodyText: String): JSONObject? {
        val body = JSONObject().apply {
            put("to_address", toAddress)
            put("subject", subject)
            put("body", bodyText)
        }
        return post("/api/emails/draft", body)
    }

    fun sendEmail(emailId: String): JSONObject? {
        return post("/api/emails/$emailId/send", JSONObject())
    }

    fun listEmails(): JSONArray? {
        return getArray("/api/emails")
    }

    // --- User ---

    fun getProfile(): JSONObject? {
        return get("/api/user/profile")
    }

    fun getUsage(): JSONObject? {
        return get("/api/user/usage")
    }

    // --- Devices ---

    fun registerDevice(platform: String, deviceName: String?, pushToken: String?): JSONObject? {
        val body = JSONObject().apply {
            put("platform", platform)
            if (deviceName != null) put("device_name", deviceName)
            if (pushToken != null) put("push_token", pushToken)
        }
        return post("/api/devices", body)
    }

    // --- Billing ---

    fun createCheckout(tier: String): JSONObject? {
        val body = JSONObject().apply { put("tier", tier) }
        return post("/api/billing/checkout", body)
    }

    fun getBillingStatus(): JSONObject? {
        return get("/api/billing/status")
    }

    // --- Connected Accounts ---

    fun getGmailAuthorizeUrl(): String? {
        val resp = get("/api/accounts/authorize/gmail") ?: return null
        return resp.optString("authorize_url", "").takeIf { it.isNotBlank() }
    }

    // --- Templates ---

    fun listTemplates(category: String? = null): JSONArray? {
        val query = if (category != null) "?category=$category" else ""
        return getArray("/api/templates$query")
    }

    // --- Agent planning ---

    fun planDeviceAction(message: String, envelopeBlobB64: String? = null): JSONObject? {
        val body = JSONObject().apply {
            put("message", message)
            if (envelopeBlobB64 != null) put("envelope_blob_b64", envelopeBlobB64)
        }
        return post("/api/agent/plan", body)
    }

    // --- HTTP helpers ---

    /**
     * Execute [build] with the current bearer token. If the response is 401
     * AND a [tokenRefresher] is configured, refresh once and retry. If the
     * retry is also 401 (or the refresh fails), call [onAuthExhausted] and
     * return null.
     *
     * The retry path is the silent recovery from "access token expired while
     * the user was idle" — without it, expired tokens would surface as
     * mysteriously-failing API calls and the user would be sent back through
     * SIWS unnecessarily.
     */
    private inline fun <T : Any> withAuthRetry(
        path: String,
        method: String,
        crossinline build: (token: String) -> Request,
        crossinline parse: (String) -> T?,
    ): T? {
        val token = tokenProvider() ?: run {
            Log.w(TAG, "$method $path: no token available")
            onAuthExhausted?.invoke()
            return null
        }
        val first = try {
            client.newCall(build(token)).execute()
        } catch (e: IOException) {
            Log.e(TAG, "$method $path error", e)
            return null
        }
        val firstBody = first.body?.string()
        if (first.isSuccessful && firstBody != null) {
            return parse(firstBody)
        }
        if (first.code != 401 || tokenRefresher == null) {
            Log.e(TAG, "$method $path failed: ${first.code} $firstBody")
            return null
        }
        // 401 + refresher configured → silent refresh + single retry.
        Log.i(TAG, "$method $path: 401, attempting silent refresh")
        val refreshed = try {
            tokenRefresher.invoke()
        } catch (t: Throwable) {
            Log.w(TAG, "refresh raised: ${t.message}")
            false
        }
        if (!refreshed) {
            Log.w(TAG, "$method $path: refresh failed, escalating")
            onAuthExhausted?.invoke()
            return null
        }
        val newToken = tokenProvider() ?: run {
            onAuthExhausted?.invoke()
            return null
        }
        val second = try {
            client.newCall(build(newToken)).execute()
        } catch (e: IOException) {
            Log.e(TAG, "$method $path retry error", e)
            return null
        }
        val secondBody = second.body?.string()
        if (second.isSuccessful && secondBody != null) {
            return parse(secondBody)
        }
        Log.e(TAG, "$method $path retry failed: ${second.code} $secondBody")
        if (second.code == 401) onAuthExhausted?.invoke()
        return null
    }

    private fun get(path: String): JSONObject? = withAuthRetry(
        path = path,
        method = "GET",
        build = { token ->
            Request.Builder()
                .url("$baseUrl$path")
                .header("Authorization", "Bearer $token")
                .build()
        },
        parse = { body -> JSONObject(body) },
    )

    private fun getArray(path: String): JSONArray? = withAuthRetry(
        path = path,
        method = "GET",
        build = { token ->
            Request.Builder()
                .url("$baseUrl$path")
                .header("Authorization", "Bearer $token")
                .build()
        },
        parse = { body -> JSONArray(body) },
    )

    private fun post(path: String, json: JSONObject): JSONObject? = withAuthRetry(
        path = path,
        method = "POST",
        build = { token ->
            Request.Builder()
                .url("$baseUrl$path")
                .header("Authorization", "Bearer $token")
                .post(json.toString().toRequestBody(JSON_MEDIA))
                .build()
        },
        parse = { body -> JSONObject(body) },
    )
}
