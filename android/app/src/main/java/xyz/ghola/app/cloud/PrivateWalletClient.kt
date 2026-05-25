package xyz.ghola.app.cloud

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.Instant
import java.util.UUID

/**
 * Private USDCx endpoints for the Seeker app.
 *
 * Android uses a user-held device signer identity. It never provisions hosted
 * custody, and private sends are fail-closed: this client only creates the
 * approved shielded intent and reads redacted history.
 */
class PrivateWalletClient(
    private val baseUrl: String,
    private val tokenProvider: () -> String?,
) {
    private val http = OkHttpClient()

    fun paymentHealth(): JSONObject {
        return JSONObject(execute("GET", "/health/payments", null, authenticated = false))
    }

    fun privateHistory(limit: Int = 25): JSONArray {
        val capped = limit.coerceIn(1, 100)
        return JSONArray(execute("GET", "/api/wallet/private/history?limit=$capped", null))
    }

    fun createPrivateUSDCxIntent(
        toShieldedAddress: String,
        amountMicroUsdc: Long,
        signerDid: String,
        approvalSummary: String,
        rail: String = "aleo_usdcx_shielded",
        signingMode: String = "aleo_device",
    ): JSONObject {
        val body = JSONObject().apply {
            put("rail", rail)
            put("to_shielded_address", toShieldedAddress)
            put("amount_micro_usdc", amountMicroUsdc)
            put("signing_mode", signingMode)
            put("signer_key_id", signerDid)
            put("privacy_mode", "strictLocal")
            put("network_scope", "walletTransfer")
            put("user_approved_at", Instant.now().toString())
            put("approval_nonce", UUID.randomUUID().toString())
            put("approval_summary", approvalSummary.take(600))
        }
        return JSONObject(execute("POST", "/api/wallet/private/intent", body))
    }

    fun submitSignedPrivateTransfer(
        intentId: String,
        toShieldedAddress: String,
        proof: JSONObject,
        signingMode: String,
        signerDid: String,
        signerAttestation: JSONObject,
    ): JSONObject {
        val body = JSONObject().apply {
            put("intent_id", intentId)
            put("to_shielded_address", toShieldedAddress)
            put("proof", proof)
            put("signing_mode", signingMode)
            put("signer_key_id", signerDid)
            put("signer_attestation", signerAttestation.toString())
            put("privacy_mode", "strictLocal")
            put("network_scope", "walletTransfer")
            put("user_approved_at", Instant.now().toString())
            put("approval_nonce", UUID.randomUUID().toString())
            put("approval_summary", "Submit signed private transfer proof on fail-closed shielded rail")
        }
        return JSONObject(execute("POST", "/api/wallet/private/submit-signed-transfer", body))
    }

    private fun execute(
        method: String,
        path: String,
        body: JSONObject?,
        authenticated: Boolean = true,
    ): String {
        val builder = Request.Builder().url("${baseUrl.trimEnd('/')}$path")
        if (authenticated) {
            val token = tokenProvider() ?: throw IOException("wallet sign-in required")
            builder.header("Authorization", "Bearer $token")
        }
        when (method) {
            "GET" -> builder.get()
            "POST" -> builder.post((body ?: JSONObject()).toString().toRequestBody(JSON_MEDIA))
            else -> error("unsupported method $method")
        }
        http.newCall(builder.build()).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw IOException("wallet $method $path failed (${resp.code}): $text")
            return text
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}
