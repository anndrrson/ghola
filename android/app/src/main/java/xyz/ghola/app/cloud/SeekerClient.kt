package xyz.ghola.app.cloud

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

class SeekerClient(
    private val baseUrl: String,
    private val tokenProvider: () -> String?,
) {
    private val http = OkHttpClient()

    fun verify(walletPubkey: String, message: String, signatureB64: String): JSONObject {
        val token = tokenProvider() ?: throw IOException("wallet sign-in required")
        val body = JSONObject().apply {
            put("wallet_pubkey", walletPubkey)
            put("message", message)
            put("signature", signatureB64)
        }
        val req = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/api/seeker/verify")
            .header("Authorization", "Bearer $token")
            .post(body.toString().toRequestBody(JSON_MEDIA))
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw IOException("seeker verify failed (${resp.code}): $text")
            return JSONObject(text)
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}
