package xyz.ghola.app.cloud

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class NativeMessagingRelayClient(
    private val baseUrl: String,
    private val tokenProvider: () -> String?,
) {
    private val http = OkHttpClient()

    fun sync(limit: Int = 50): JSONArray {
        val capped = limit.coerceIn(1, 100)
        return requestArray("GET", "/api/messages/sync?limit=$capped")
    }

    fun acknowledge(relayMessageId: String): JSONObject {
        return requestObject("POST", "/api/messages/$relayMessageId/ack", JSONObject())
    }

    fun fetchPrekeys(did: String): JSONObject {
        val encoded = URLEncoder.encode(did, StandardCharsets.UTF_8.name())
        return requestObject("GET", "/api/messages/prekeys/$encoded")
    }

    fun sendEnvelope(body: JSONObject): JSONObject {
        return requestObject("POST", "/api/messages/envelopes", body)
    }

    private fun requestArray(method: String, path: String): JSONArray {
        val text = execute(method, path, null)
        return JSONArray(text)
    }

    private fun requestObject(method: String, path: String, body: JSONObject? = null): JSONObject {
        val text = execute(method, path, body)
        return JSONObject(text)
    }

    private fun execute(method: String, path: String, body: JSONObject?): String {
        val token = tokenProvider() ?: throw IOException("wallet sign-in required")
        val builder = Request.Builder()
            .url("${baseUrl.trimEnd('/')}$path")
            .header("Authorization", "Bearer $token")
        when (method) {
            "GET" -> builder.get()
            "POST" -> builder.post((body ?: JSONObject()).toString().toRequestBody(JSON_MEDIA))
            else -> error("unsupported method $method")
        }
        http.newCall(builder.build()).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw IOException("relay $method $path failed (${resp.code}): $text")
            return text
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}
