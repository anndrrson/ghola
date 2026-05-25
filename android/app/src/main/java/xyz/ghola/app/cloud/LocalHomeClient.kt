package xyz.ghola.app.cloud

import android.content.Context
import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.ai.SecureStorage
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * Ghola Home LAN pairing client.
 *
 * This intentionally does not participate in auth or wallet custody. Seeker
 * cloud identity remains SIWS/MWA; this stores only the bearer token minted by
 * the user's own local Ghola Home server after PIN approval.
 *
 * SECURITY POSTURE (M finding — LAN pairing). As written this flow POSTs a
 * short PIN to the server and receives a bearer token, today over plain HTTP
 * on the LAN. That is only viable for development:
 *
 *   - The release [network_security_config] forbids cleartext to RFC1918
 *     hosts, so a release build cannot complete an http:// pair at all — it
 *     fails closed with a cleartext exception. [pair] additionally refuses to
 *     run on a non-debug build (belt-and-braces), so this never silently
 *     leaks a PIN/token in production.
 *   - Before this flow is enabled in release it MUST move to an authenticated,
 *     confidential transport. Two acceptable designs:
 *       (a) HTTPS with trust-on-first-use: the server presents a self-signed
 *           cert; the app pins its SPKI fingerprint on the first pair and
 *           shows the fingerprint to the user for out-of-band confirmation.
 *       (b) A PAKE (e.g. SPAKE2) keyed on the PIN, so the PIN is never sent in
 *           a form an on-path attacker can recover or brute-force offline.
 *   - The SERVER (Ghola Home process, separate repo) MUST rate-limit PIN
 *     attempts (e.g. lock after ~5 failures + exponential backoff) — a 4-digit
 *     PIN is otherwise brute-forceable in seconds. This client cannot enforce
 *     that; it is called out here as a required companion control.
 *   - mDNS-advertised hosts are UNTRUSTED (any LAN peer can claim
 *     `_ghola._tcp`). The displayed server fingerprint is the only thing that
 *     binds "the server I think I'm pairing with" to "the key that minted my
 *     token"; surface it to the user and require confirmation.
 */
class LocalHomeClient(private val context: Context) {
    private val storage = SecureStorage(context)
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    /** Result of a successful pair: the server's display name plus the
     *  server-presented key fingerprint the UI must show for out-of-band
     *  verification (empty if the server did not provide one — older Ghola
     *  Home builds; treat absence as a downgrade warning in the UI). */
    data class PairResult(val serverName: String, val serverFingerprint: String)

    fun pair(serverUrl: String, pin: String): Result<PairResult> {
        // Hard gate: this PIN-over-LAN flow is development-only until it moves
        // to a confidential transport (see class docs). Refuse outright in
        // release builds rather than relying solely on the cleartext policy.
        if (!BuildConfig.DEBUG) {
            return Result.failure(
                IOException("Local Ghola Home pairing is disabled in this build until it uses an encrypted transport."),
            )
        }
        val normalized = serverUrl.trimEnd('/')
        // Only permit cleartext to a private/loopback LAN host. Belt-and-braces
        // on top of network_security_config so a redirected/typo'd public host
        // can never receive the PIN in the clear.
        if (normalized.startsWith("http://", ignoreCase = true) && !isPrivateLanUrl(normalized)) {
            return Result.failure(
                IOException("Refusing to send pairing PIN over cleartext to a non-LAN host."),
            )
        }
        val body = JSONObject().apply {
            put("pin", pin)
            put("device_name", Build.MODEL ?: "Seeker")
        }.toString().toRequestBody(JSON_MEDIA)
        val req = Request.Builder()
            .url("$normalized/api/local/pair")
            .post(body)
            .build()

        return try {
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    return Result.failure(IOException("pair failed (${resp.code}): $text"))
                }
                val json = JSONObject(text)
                val token = json.getString("token")
                val name = json.optString("server_name", "Ghola Home")
                // Surfaced to the user so they can confirm they paired with
                // their own server and not a LAN impostor advertising the same
                // mDNS service name.
                val fingerprint = json.optString("server_fingerprint", "")
                storage.setLocalPair(token, normalized, name)
                Result.success(PairResult(serverName = name, serverFingerprint = fingerprint))
            }
        } catch (t: Throwable) {
            Result.failure(t)
        }
    }

    fun disconnect() {
        storage.clearLocalPair()
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        /** True if [url]'s host is loopback or an RFC1918 / link-local LAN
         *  address. Used to refuse cleartext PINs to anything off-LAN. */
        internal fun isPrivateLanUrl(url: String): Boolean {
            val host = runCatching { URI(url).host }.getOrNull()?.lowercase() ?: return false
            if (host == "localhost") return true
            val octets = host.split(".").map { it.toIntOrNull() }
            if (octets.size != 4 || octets.any { it == null || it !in 0..255 }) return false
            val a = octets[0]!!; val b = octets[1]!!
            return when {
                a == 127 -> true                         // loopback
                a == 10 -> true                          // 10.0.0.0/8
                a == 192 && b == 168 -> true             // 192.168.0.0/16
                a == 172 && b in 16..31 -> true          // 172.16.0.0/12
                a == 169 && b == 254 -> true             // link-local
                else -> false
            }
        }
    }
}
