package xyz.ghola.app.market

import android.util.Base64
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.solana.MWAConnect
import java.security.MessageDigest
import java.util.UUID

object MobileLiveProof {
    private const val PURPOSE = "private_account_autopilot"

    suspend fun signHeaders(
        sender: ActivityResultSender,
        storage: SecureStorage,
        method: String,
        path: String,
        body: JSONObject,
    ): Result<Map<String, String>> {
        val wallet = storage.getSolanaAddress()?.takeIf { it.isNotBlank() }
            ?: return Result.failure(IllegalStateException("Connect Seeker Wallet before live agent approval."))
        val timestamp = System.currentTimeMillis().toString()
        val nonce = UUID.randomUUID().toString()
        val bodyHash = bodySha256Hex(body)
        val message = proofMessage(
            method = method,
            path = path,
            timestamp = timestamp,
            nonce = nonce,
            bodyHash = bodyHash,
            wallet = wallet,
        )
        return when (
            val signed = MWAConnect.signMessageDetached(
                sender,
                wallet,
                message.toByteArray(Charsets.UTF_8),
                storage.getMwaAuthToken(),
            )
        ) {
            is MWAConnect.SignOutcome.Success -> Result.success(
                mapOf(
                    "x-ghola-mobile-proof-version" to "1",
                    "x-ghola-mobile-wallet" to wallet,
                    "x-ghola-mobile-proof-timestamp" to timestamp,
                    "x-ghola-mobile-proof-nonce" to nonce,
                    "x-ghola-mobile-proof-signature-b64" to Base64.encodeToString(
                        signed.signature,
                        Base64.NO_WRAP,
                    ),
                ),
            )
            MWAConnect.SignOutcome.NoWallet ->
                Result.failure(IllegalStateException("No Seeker Wallet found."))
            MWAConnect.SignOutcome.Declined ->
                Result.failure(IllegalStateException("Seeker Wallet approval declined."))
            MWAConnect.SignOutcome.Cancelled ->
                Result.failure(IllegalStateException("Seeker Wallet approval cancelled."))
            is MWAConnect.SignOutcome.Failure ->
                Result.failure(signed.cause)
        }
    }

    fun bodySha256Hex(body: JSONObject): String =
        MessageDigest.getInstance("SHA-256")
            .digest(canonicalJson(body).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun proofMessage(
        method: String,
        path: String,
        timestamp: String,
        nonce: String,
        bodyHash: String,
        wallet: String,
    ): String = listOf(
        "ghola_mobile_live_proof_v1",
        "method:${method.uppercase()}",
        "path:$path",
        "timestamp_ms:$timestamp",
        "nonce:$nonce",
        "body_sha256:$bodyHash",
        "wallet:$wallet",
        "purpose:$PURPOSE",
    ).joinToString("\n")

    fun canonicalJson(value: Any?): String {
        if (value == null || value === JSONObject.NULL) return "null"
        return when (value) {
            is JSONObject -> {
                val keys = mutableListOf<String>()
                val iterator = value.keys()
                while (iterator.hasNext()) keys += iterator.next()
                keys.sorted().joinToString(separator = ",", prefix = "{", postfix = "}") { key ->
                    "${JSONObject.quote(key)}:${canonicalJson(value.opt(key))}"
                }
            }
            is JSONArray -> {
                val items = mutableListOf<String>()
                for (i in 0 until value.length()) items += canonicalJson(value.opt(i))
                items.joinToString(separator = ",", prefix = "[", postfix = "]")
            }
            is Boolean -> if (value) "true" else "false"
            is Number -> JSONObject.numberToString(value)
            else -> JSONObject.quote(value.toString())
        }
    }
}
