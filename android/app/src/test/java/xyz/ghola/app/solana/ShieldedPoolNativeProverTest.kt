package xyz.ghola.app.solana

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.Base64

class ShieldedPoolNativeProverTest {
    @Test
    fun validProofOutputPassesStrictShapeValidation() {
        val json = validProofOutput()

        assertSame(json, ShieldedPoolNativeProver.validateProofOutput(json))
    }

    @Test
    fun malformedGroth16FieldFailsClosed() {
        val json = validProofOutput()
        json.getJSONObject("proof_bundle").put("a", "aa")

        assertThrows(IllegalStateException::class.java) {
            ShieldedPoolNativeProver.validateProofOutput(json)
        }
    }

    @Test
    fun missingNullifierFailsClosed() {
        val json = validProofOutput()
        json.remove("nullifier_hex")

        assertThrows(IllegalStateException::class.java) {
            ShieldedPoolNativeProver.validateProofOutput(json)
        }
    }

    @Test
    fun malformedWithdrawAccountFailsClosed() {
        val json = validProofOutput()
        json.getJSONObject("withdraw_instruction")
            .getJSONArray("accounts")
            .getJSONObject(0)
            .put("pubkey", "not-base58")

        assertThrows(IllegalStateException::class.java) {
            ShieldedPoolNativeProver.validateProofOutput(json)
        }
    }

    @Test
    fun malformedProofBase64FailsClosed() {
        val json = validProofOutput().put("proof_b64", "not base64")

        assertThrows(IllegalStateException::class.java) {
            ShieldedPoolNativeProver.validateProofOutput(json)
        }
    }

    @Test
    fun withdrawAccountsMustMatchWitnessPoolContext() {
        val context = solanaContext()
        val json = validProofOutput().withWithdrawAccountsFor(context)
        val witness = witnessWithContext(context)

        assertSame(json, ShieldedPoolNativeProver.validateProofOutput(json, witness))
    }

    @Test
    fun swappedPoolContextAccountFailsClosed() {
        val context = solanaContext()
        val json = validProofOutput().withWithdrawAccountsFor(context)
        val witness = witnessWithContext(context)
        json.getJSONObject("withdraw_instruction")
            .getJSONArray("accounts")
            .getJSONObject(1)
            .put("pubkey", Base58.encode(ByteArray(32) { 99 }))

        assertThrows(IllegalStateException::class.java) {
            ShieldedPoolNativeProver.validateProofOutput(json, witness)
        }
    }

    @Test
    fun relayerPayerOverridesWalletPayerWhenConfigured() {
        val context = solanaContext().put("relayer_payer", Base58.encode(ByteArray(32) { 14 }))
        val json = validProofOutput().withWithdrawAccountsFor(context)
        val witness = witnessWithContext(context)

        assertSame(json, ShieldedPoolNativeProver.validateProofOutput(json, witness))
    }

    // ── witness↔proof binding (defense-in-depth before signing) ──────────────

    @Test
    fun proofBindingMatchingExtDataHashAndAmountPasses() {
        val context = solanaContext()
        val recipient = Base58.encode(ByteArray(32) { 11 })
        val witness = bindingWitness(context, recipient = recipient, amount = 1_000L)
        val json = validProofOutput().withWithdrawAccountsFor(context).apply {
            getJSONObject("proof_bundle")
                .put("public_amount", 1_000L)
                .put("ext_data_hash", expectedExtDataHash(recipient = recipient, amount = 1_000L))
        }

        assertSame(json, ShieldedPoolNativeProver.validateProofOutput(json, witness))
    }

    @Test
    fun proofBindingTamperedAmountFailsClosed() {
        val context = solanaContext()
        val recipient = Base58.encode(ByteArray(32) { 11 })
        val witness = bindingWitness(context, recipient = recipient, amount = 1_000L)
        // ext_data_hash still matches; only public_amount is tampered.
        val json = validProofOutput().withWithdrawAccountsFor(context).apply {
            getJSONObject("proof_bundle")
                .put("public_amount", 999L)
                .put("ext_data_hash", expectedExtDataHash(recipient = recipient, amount = 1_000L))
        }

        assertThrows(IllegalStateException::class.java) {
            ShieldedPoolNativeProver.validateProofOutput(json, witness)
        }
    }

    @Test
    fun proofBindingTamperedRecipientFailsClosed() {
        val context = solanaContext()
        val recipient = Base58.encode(ByteArray(32) { 11 })
        val witness = bindingWitness(context, recipient = recipient, amount = 1_000L)
        // public_amount matches; ext_data_hash binds a DIFFERENT recipient,
        // i.e. a relayer trying to redirect the spend.
        val attackerRecipient = Base58.encode(ByteArray(32) { 88 })
        val json = validProofOutput().withWithdrawAccountsFor(context).apply {
            getJSONObject("proof_bundle")
                .put("public_amount", 1_000L)
                .put("ext_data_hash", expectedExtDataHash(recipient = attackerRecipient, amount = 1_000L))
        }

        assertThrows(IllegalStateException::class.java) {
            ShieldedPoolNativeProver.validateProofOutput(json, witness)
        }
    }

    /** Witness shaped like [ShieldedPoolClient.buildWitness] output for the
     *  binding checks: carries top-level public_amount plus the _ghola_meta
     *  fields the ext_data_hash preimage needs. */
    private fun bindingWitness(context: JSONObject, recipient: String, amount: Long): JSONObject =
        JSONObject().apply {
            put("public_amount", amount)
            put("_ghola_meta", JSONObject().apply {
                put("intent_id", "intent-fixture-1")
                put("wallet_address", Base58.encode(ByteArray(32) { 10 }))
                put("recipient", recipient)
                put("recipient_kind", "solana_token_account")
                put("network", "solana:devnet")
                put("asset", "USDCx")
                put("solana_context", context)
            })
        }

    /** Byte-identical mirror of ShieldedPoolClient.extDataHashHex /
     *  ShieldedPoolNativeProver.extDataHashHex preimage. */
    private fun expectedExtDataHash(recipient: String, amount: Long): String {
        val preimage = listOf(
            "ghola-solana-shielded-ext-data-v1",
            "intent_id:intent-fixture-1",
            "recipient:$recipient",
            "amount_micro_usdc:$amount",
            "network:solana:devnet",
            "asset:USDCx",
        ).joinToString("\n").toByteArray(Charsets.UTF_8)
        return java.security.MessageDigest.getInstance("SHA-256").digest(preimage)
            .joinToString("") { "%02x".format(it) }
    }

    private fun validProofOutput(): JSONObject {
        val account = JSONObject().apply {
            put("pubkey", Base58.encode(ByteArray(32) { 7 }))
            put("is_signer", false)
            put("is_writable", true)
        }
        return JSONObject().apply {
            put("proof_bundle", JSONObject().apply {
                put("a", "11".repeat(64))
                put("b", "22".repeat(128))
                put("c", "33".repeat(64))
                put("root", "44".repeat(32))
                put("input_nullifiers", JSONArray().put("55".repeat(32)))
                put("output_commitments", JSONArray().put("66".repeat(32)))
                put("public_amount", 1)
                put("asset_id", "77".repeat(32))
                put("ext_data_hash", "88".repeat(32))
            })
            put("proof_b64", Base64.getEncoder().encodeToString("proof".toByteArray()))
            put("nullifier_hex", "55".repeat(32))
            put("withdraw_instruction", JSONObject().apply {
                put("data_hex", "aa".repeat(16))
                put("accounts", JSONArray().put(account))
            })
        }
    }

    private fun solanaContext(): JSONObject =
        JSONObject().apply {
            put("program_id", Base58.encode(ByteArray(32) { 1 }))
            put("mint", Base58.encode(ByteArray(32) { 2 }))
            put("pool_config", Base58.encode(ByteArray(32) { 3 }))
            put("verifier_key", Base58.encode(ByteArray(32) { 4 }))
            put("merkle_tree", Base58.encode(ByteArray(32) { 5 }))
            put("escrow", Base58.encode(ByteArray(32) { 6 }))
            put("token_program", Base58.encode(ByteArray(32) { 7 }))
            put("system_program", Base58.encode(ByteArray(32) { 8 }))
            put("relayer_token_account", Base58.encode(ByteArray(32) { 9 }))
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
        }

    private fun witnessWithContext(context: JSONObject): JSONObject =
        JSONObject().apply {
            put("_ghola_meta", JSONObject().apply {
                put("wallet_address", Base58.encode(ByteArray(32) { 10 }))
                put("recipient", Base58.encode(ByteArray(32) { 11 }))
                put("recipient_kind", "solana_token_account")
                put("solana_context", context)
            })
        }

    private fun JSONObject.withWithdrawAccountsFor(context: JSONObject): JSONObject {
        val meta = witnessWithContext(context).getJSONObject("_ghola_meta")
        val accountPubkeys = listOf(
            context.optString("relayer_payer").takeIf { it.isNotBlank() }
                ?: meta.getString("wallet_address"),
            context.getString("pool_config"),
            context.getString("verifier_key"),
            context.getString("mint"),
            context.getString("merkle_tree"),
            Base58.encode(ByteArray(32) { 12 }),
            Base58.encode(ByteArray(32) { 13 }),
            context.getString("escrow"),
            meta.getString("recipient"),
            context.getString("relayer_token_account"),
            context.getString("token_program"),
            context.getString("system_program"),
        )
        val accounts = JSONArray()
        for (pubkey in accountPubkeys) {
            accounts.put(JSONObject().apply {
                put("pubkey", pubkey)
                put("is_signer", false)
                put("is_writable", true)
            })
        }
        getJSONObject("withdraw_instruction").put("accounts", accounts)
        return this
    }
}
