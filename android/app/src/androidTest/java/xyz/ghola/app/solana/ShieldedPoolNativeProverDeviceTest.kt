package xyz.ghola.app.solana

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShieldedPoolNativeProverDeviceTest {
    @Test
    fun realGroth16ProofRunsOnDevice() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val witness = witnessJson()

        val output = ShieldedPoolNativeProver.prove(context, witness)

        assertSame(output, ShieldedPoolNativeProver.validateProofOutput(output, witness))
        assertEquals("ghola_shielded_pool_backend_mobile_arkworks", output.getString("backend"))
        assertFalse(output.optBoolean("self_test_only", false))
        assertTrue(output.getString("proof_b64").isNotBlank())
        assertEquals(12, output.getJSONObject("withdraw_instruction").getJSONArray("accounts").length())

        val bundle = output.getJSONObject("proof_bundle")
        assertEquals(128, bundle.getString("a").length)
        assertEquals(256, bundle.getString("b").length)
        assertEquals(128, bundle.getString("c").length)
        assertEquals(64, bundle.getString("root").length)
        assertEquals(64, bundle.getString("asset_id").length)
        assertEquals(64, bundle.getString("ext_data_hash").length)
    }

    private fun witnessJson(): JSONObject =
        JSONObject().apply {
            put("input_notes", JSONArray())
            put("input_paths", JSONArray())
            put("input_indices", JSONArray())
            put("output_notes", JSONArray())
            put("spending_key", fieldArray(1))
            put("public_amount", 0)
            put("asset_id", fieldArray(2))
            put("ext_data_hash", fieldArray(3))
            put("_ghola_meta", JSONObject().apply {
                put("version", "ghola-solana-shielded-pool-witness-v1")
                put("intent_id", "device-groth16-proof-test")
                put("rail", "solana_shielded_pool")
                put("network", "solana:devnet")
                put("asset", "USDCx")
                put("wallet_address", pk(9))
                put("recipient", pk(8))
                put("recipient_kind", "solana_token_account")
                put("solana_context", JSONObject().apply {
                    put("program_id", pk(1))
                    put("pool_config", pk(2))
                    put("verifier_key", pk(3))
                    put("mint", pk(4))
                    put("merkle_tree", pk(5))
                    put("escrow", pk(6))
                    put("token_program", pk(7))
                    put("system_program", pk(0))
                    put("relayer_payer", pk(10))
                    put("relayer_token_account", pk(11))
                    put("queue_tail", 42)
                    put("account_order", JSONArray(listOf(
                        "payer",
                        "pool_config",
                        "verifier_key",
                        "mint",
                        "merkle_tree",
                        "nullifier",
                        "change_commitment",
                        "escrow",
                        "recipient_token_account",
                        "relayer_token_account",
                        "token_program",
                        "system_program",
                    )))
                })
            })
        }

    private fun fieldArray(byte: Int): JSONArray =
        JSONArray((0 until 32).map { byte })

    private fun pk(byte: Int): String =
        Base58.encode(ByteArray(32) { byte.toByte() })
}
