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
 */
class ThumperCloudClient(
    private val baseUrl: String,
    private val authToken: String
) {
    companion object {
        private const val TAG = "CloudClient"
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
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

    private fun get(path: String): JSONObject? {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .header("Authorization", "Bearer $authToken")
            .build()

        return try {
            val response = client.newCall(request).execute()
            val body = response.body?.string()
            if (response.isSuccessful && body != null) {
                JSONObject(body)
            } else {
                Log.e(TAG, "GET $path failed: ${response.code} $body")
                null
            }
        } catch (e: IOException) {
            Log.e(TAG, "GET $path error", e)
            null
        }
    }

    private fun getArray(path: String): JSONArray? {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .header("Authorization", "Bearer $authToken")
            .build()

        return try {
            val response = client.newCall(request).execute()
            val body = response.body?.string()
            if (response.isSuccessful && body != null) {
                JSONArray(body)
            } else {
                Log.e(TAG, "GET $path failed: ${response.code} $body")
                null
            }
        } catch (e: IOException) {
            Log.e(TAG, "GET $path error", e)
            null
        }
    }

    private fun post(path: String, json: JSONObject): JSONObject? {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .header("Authorization", "Bearer $authToken")
            .post(json.toString().toRequestBody(JSON_MEDIA))
            .build()

        return try {
            val response = client.newCall(request).execute()
            val body = response.body?.string()
            if (response.isSuccessful && body != null) {
                JSONObject(body)
            } else {
                Log.e(TAG, "POST $path failed: ${response.code} $body")
                null
            }
        } catch (e: IOException) {
            Log.e(TAG, "POST $path error", e)
            null
        }
    }
}
