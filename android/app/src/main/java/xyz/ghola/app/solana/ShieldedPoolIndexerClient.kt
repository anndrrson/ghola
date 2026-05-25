package xyz.ghola.app.solana

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder

/**
 * Public indexer client for Merkle witness material.
 *
 * The indexer serves public tree paths only. It never receives spending keys,
 * decrypted note plaintext, or wallet approvals.
 */
class ShieldedPoolIndexerClient(
    private val baseUrl: String,
) {
    private val http = OkHttpClient()

    fun witness(commitmentHex: String): JSONObject {
        val encoded = URLEncoder.encode(commitmentHex.trim().removePrefix("0x"), "UTF-8")
        val req = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/witness?commitment=$encoded")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IOException("shielded indexer witness failed (${resp.code}): $body")
            }
            return JSONObject(body)
        }
    }

    fun treeState(): JSONObject {
        val req = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/tree-state")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IOException("shielded indexer tree-state failed (${resp.code}): $body")
            }
            return JSONObject(body)
        }
    }

    fun hydrateNote(note: JSONObject): JSONObject {
        val commitment = note.optString("commitment_hex", note.optString("commitment"))
        if (commitment.isBlank()) {
            throw IllegalStateException("Local Solana shielded note is missing commitment_hex")
        }
        val witness = witness(commitment)
        return JSONObject(note.toString()).apply {
            put("leaf_index", witness.getLong("leaf_index"))
            put("merkle_path", JSONObject().apply {
                put("siblings_hex", witness.optJSONArray("siblings") ?: JSONArray())
                put("path_bits", witness.optJSONArray("path_bits") ?: JSONArray())
                put("root", witness.optString("root", ""))
            })
        }
    }
}
