package xyz.ghola.app.market

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class MobileLiveProofTest {

    @Test fun canonical_json_sorts_object_keys_recursively() {
        val first = JSONObject().apply {
            put("z", 2)
            put("a", JSONObject().apply {
                put("b", true)
                put("a", JSONArray().put("SOL").put(JSONObject.NULL))
            })
        }
        val second = JSONObject().apply {
            put("a", JSONObject().apply {
                put("a", JSONArray().put("SOL").put(JSONObject.NULL))
                put("b", true)
            })
            put("z", 2)
        }

        assertEquals("""{"a":{"a":["SOL",null],"b":true},"z":2}""", MobileLiveProof.canonicalJson(first))
        assertEquals(MobileLiveProof.bodySha256Hex(first), MobileLiveProof.bodySha256Hex(second))
    }

    @Test fun proof_message_matches_web_contract() {
        val message = MobileLiveProof.proofMessage(
            method = "post",
            path = "/v1/private-account/autopilot/sessions",
            timestamp = "1780000000000",
            nonce = "nonce-test-123",
            bodyHash = "a".repeat(64),
            wallet = "So11111111111111111111111111111111111111112",
        )

        assertEquals(
            listOf(
                "ghola_mobile_live_proof_v1",
                "method:POST",
                "path:/v1/private-account/autopilot/sessions",
                "timestamp_ms:1780000000000",
                "nonce:nonce-test-123",
                "body_sha256:${"a".repeat(64)}",
                "wallet:So11111111111111111111111111111111111111112",
                "purpose:private_account_autopilot",
            ).joinToString("\n"),
            message,
        )
    }
}
