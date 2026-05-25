package xyz.ghola.app.solana

import android.content.Context
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.PrivateWalletClient
import java.security.MessageDigest
import java.time.Instant

/**
 * Seeker-local Solana shielded-pool coordinator.
 *
 * This class owns the Android side of the fail-closed flow: derive a local
 * shielded recipient from Seed Vault, keep note metadata encrypted at rest,
 * build the witness contract, call a bundled native prover when present, build
 * the withdraw payload, sign submit attestation with Seed Vault, then call the
 * cloud submit hook. It never fabricates proofs or falls back to public USDC.
 */
class ShieldedPoolClient(
    private val context: Context,
    private val storage: SecureStorage,
    private val seedVault: SeedVaultNative,
) {
    data class LocalAccount(
        val walletAddress: String,
        val shieldedRecipient: String,
        val spendingKeyHex: String,
        val ownerPubkeyHex: String,
    )

    suspend fun ensureLocalAccount(session: SeedVaultNative.Session): Result<LocalAccount> {
        // Domain prefix sourced from the central [SigningDomains] registry,
        // which asserts at load time that this challenge is disjoint and
        // prefix-free vs the vault-unlock, SIWS, and agent-root wallet-signing
        // challenges. The signature seeds the shielded spending key (H1).
        val challenge = "${xyz.ghola.app.crypto.SigningDomains.SHIELDED_RECIPIENT}${session.address}"
            .toByteArray(Charsets.UTF_8)
        return when (val signed = seedVault.signMessage(session.authToken, session.derivationPathUri, challenge)) {
            is SeedVaultNative.SignOutcome.Success -> {
                val spendingKey = sha256("spending-key".toByteArray(Charsets.UTF_8) + signed.signature)
                val ownerPubkey = sha256("owner-pubkey".toByteArray(Charsets.UTF_8) + spendingKey)
                val publicPart = sha256("recipient".toByteArray(Charsets.UTF_8) + ownerPubkey)
                val recipient = "shld1${Base58.encode(publicPart)}"
                val stored = storage.getShieldedPoolRecipient()
                if (stored.isNullOrBlank()) {
                    storage.setShieldedPoolRecipient(recipient)
                } else if (stored != recipient) {
                    throw IllegalStateException("Stored Solana shielded account does not match Seed Vault; reconnect before private sends.")
                }
                ensureNotesJson()
                Result.success(
                    LocalAccount(
                        walletAddress = session.address,
                        shieldedRecipient = recipient,
                        spendingKeyHex = hex(spendingKey),
                        ownerPubkeyHex = hex(ownerPubkey),
                    ),
                )
            }
            SeedVaultNative.SignOutcome.NoSeedVault -> Result.failure(IllegalStateException("Seed Vault is not available"))
            SeedVaultNative.SignOutcome.Declined -> Result.failure(IllegalStateException("Seed Vault derivation declined"))
            SeedVaultNative.SignOutcome.Cancelled -> Result.failure(IllegalStateException("Seed Vault derivation cancelled"))
            is SeedVaultNative.SignOutcome.Failure -> Result.failure(signed.cause)
        }
    }

    suspend fun buildAndSubmitPrivateTransfer(
        session: SeedVaultNative.Session,
        client: PrivateWalletClient,
        intent: JSONObject,
        recipient: String,
        amountMicroUsdc: Long,
        signerDid: String,
    ): Result<JSONObject> = withContext(Dispatchers.IO) {
        runCatching {
            val localAccount = ensureLocalAccount(session).getOrThrow()
            val solanaContext = solanaShieldedContext(client)
            val notes = spendableNotes(amountMicroUsdc)
            if (notes.length() == 0) {
                throw IllegalStateException("No local Solana shielded notes available for this amount; no public fallback.")
            }
            val hydratedNotes = hydrateWitnesses(client, notes)

            val witness = buildWitness(
                intent = intent,
                recipient = recipient,
                amountMicroUsdc = amountMicroUsdc,
                localAccount = localAccount,
                notes = hydratedNotes,
                solanaContext = solanaContext,
            )
            val proofOutput = LocalProofEngine.prove(context, witness)
            val proof = buildPaymentProof(
                intent = intent,
                recipient = recipient,
                amountMicroUsdc = amountMicroUsdc,
                proofOutput = proofOutput,
            )
            val signerAttestation = buildSignerAttestation(
                session = session,
                intent = intent,
                recipient = recipient,
                amountMicroUsdc = amountMicroUsdc,
                signerDid = signerDid,
                proof = proof,
            )
            client.submitSignedPrivateTransfer(
                intentId = intent.getString("id"),
                toShieldedAddress = recipient,
                proof = proof,
                signingMode = "seed_vault_device",
                signerDid = signerDid,
                signerAttestation = signerAttestation,
            )
        }
    }

    suspend fun runUnfundedSelfTest(session: SeedVaultNative.Session): Result<JSONObject> =
        withContext(Dispatchers.IO) {
            runCatching {
                val localAccount = ensureLocalAccount(session).getOrThrow()
                val intent = JSONObject().apply {
                    put("id", java.util.UUID.randomUUID().toString())
                    put("network", "solana:devnet")
                    put("asset", "USDCx")
                    put("policy_hash", hex(sha256("self-test-policy".toByteArray(Charsets.UTF_8))))
                }
                val witness = buildRealSelfTestWitness(intent, localAccount)
                LocalProofEngine.prove(context, witness).apply {
                    put("self_test_only", false)
                    put("proof_submitted", false)
                    put("self_test_kind", "real_groth16_no_submit")
                    put("recipient", localAccount.shieldedRecipient)
                    put("network", "solana:devnet")
                }
            }
        }

    private fun buildRealSelfTestWitness(intent: JSONObject, localAccount: LocalAccount): JSONObject {
        val recipientTokenAccount = pk(8)
        return JSONObject().apply {
            put("input_notes", JSONArray())
            put("input_paths", JSONArray())
            put("input_indices", JSONArray())
            put("output_notes", JSONArray())
            put("spending_key", fieldArray(localAccount.spendingKeyHex))
            put("public_amount", 0L)
            put("asset_id", fieldArray(hex(sha256("USDCx:self-test".toByteArray(Charsets.UTF_8)))))
            put("ext_data_hash", fieldArray(extDataHashHex(intent, recipientTokenAccount, 0L)))
            put("_ghola_meta", JSONObject().apply {
                put("version", "ghola-solana-shielded-pool-witness-v1")
                put("intent_id", intent.getString("id"))
                put("rail", "solana_shielded_pool")
                put("network", intent.optString("network", "solana:devnet"))
                put("asset", intent.optString("asset", "USDCx"))
                put("recipient", recipientTokenAccount)
                put("recipient_kind", "solana_token_account")
                put("wallet_address", localAccount.walletAddress)
                put("derived_shielded_recipient", localAccount.shieldedRecipient)
                put("solana_context", selfTestSolanaContext())
                put("created_at", Instant.now().toString())
            })
        }
    }

    private fun ensureNotesJson() {
        if (storage.getShieldedPoolNotesJson().isNullOrBlank()) {
            storage.setShieldedPoolNotesJson(JSONArray().toString())
        }
    }

    private fun spendableNotes(amountMicroUsdc: Long): JSONArray {
        val raw = storage.getShieldedPoolNotesJson().orEmpty()
        if (raw.isBlank()) return JSONArray()
        val notes = JSONArray(raw)
        val selected = JSONArray()
        var total = 0L
        for (i in 0 until notes.length()) {
            val note = notes.optJSONObject(i) ?: continue
            if (note.optBoolean("spent", false)) continue
            val amount = note.optLong("amount_micro_usdc", 0L)
            if (amount <= 0L) continue
            selected.put(note)
            total += amount
            if (total >= amountMicroUsdc) break
        }
        return if (total >= amountMicroUsdc) selected else JSONArray()
    }

    private fun hydrateWitnesses(client: PrivateWalletClient, notes: JSONArray): JSONArray {
        val missingPath = (0 until notes.length()).any { i ->
            val note = notes.optJSONObject(i)
            note == null || !note.has("leaf_index") || note.optJSONObject("merkle_path") == null
        }
        if (!missingPath) return notes

        val indexerUrl = runCatching {
            client.paymentHealth()
                .optJSONObject("rails")
                ?.optJSONObject("solana_shielded_pool")
                ?.optString("public_indexer_url")
                ?.takeIf { it.isNotBlank() }
        }.getOrNull() ?: throw IllegalStateException(
            "Solana shielded indexer URL is not configured; cannot build local Merkle witness and no public fallback.",
        )

        val indexer = ShieldedPoolIndexerClient(indexerUrl)
        val hydrated = JSONArray()
        for (i in 0 until notes.length()) {
            val note = notes.getJSONObject(i)
            if (note.has("leaf_index") && note.optJSONObject("merkle_path") != null) {
                hydrated.put(note)
            } else {
                hydrated.put(indexer.hydrateNote(note))
            }
        }
        storage.setShieldedPoolNotesJson(mergeHydratedNotes(notes, hydrated).toString())
        return hydrated
    }

    private fun solanaShieldedContext(client: PrivateWalletClient): JSONObject {
        val rail = client.paymentHealth()
            .optJSONObject("rails")
            ?.optJSONObject("solana_shielded_pool")
            ?: throw IllegalStateException("Solana shielded pool rail is not advertised; no public fallback.")
        if (!rail.optBoolean("ready", false)) {
            val reason = rail.optString("unavailable_reason", "Solana shielded pool is not ready")
            throw IllegalStateException("$reason; no public fallback.")
        }
        val required = listOf(
            "program_id",
            "mint",
            "pool_config",
            "verifier_key",
            "merkle_tree",
            "escrow",
            "token_program",
            "system_program",
        )
        val context = JSONObject()
        for (field in required) {
            val value = rail.optString(field).trim()
            if (!isBase58Pubkey(value)) {
                throw IllegalStateException("Solana shielded pool $field is not configured as a 32-byte pubkey; no public fallback.")
            }
            context.put(field, value)
        }
        rail.optString("relayer_token_account").trim().takeIf { it.isNotBlank() }?.let { value ->
            if (!isBase58Pubkey(value)) {
                throw IllegalStateException("Solana shielded pool relayer_token_account is not a 32-byte pubkey; no public fallback.")
            }
            context.put("relayer_token_account", value)
        }
        rail.optString("relayer_payer").trim().takeIf { it.isNotBlank() }?.let { value ->
            if (!isBase58Pubkey(value)) {
                throw IllegalStateException("Solana shielded pool relayer_payer is not a 32-byte pubkey; no public fallback.")
            }
            context.put("relayer_payer", value)
        }
        rail.optString("change_commitment").trim().takeIf { it.isNotBlank() }?.let { value ->
            if (!isBase58Pubkey(value)) {
                throw IllegalStateException("Solana shielded pool change_commitment is not a 32-byte pubkey; no public fallback.")
            }
            context.put("change_commitment", value)
        }
        rail.optString("recipient_token_account").trim().takeIf { it.isNotBlank() }?.let { value ->
            if (!isBase58Pubkey(value)) {
                throw IllegalStateException("Solana shielded pool recipient_token_account is not a 32-byte pubkey; no public fallback.")
            }
            context.put("recipient_token_account", value)
        }
        if (rail.has("tree_id")) {
            context.put("tree_id", rail.optLong("tree_id", 0L))
        }
        if (rail.has("queue_tail")) {
            context.put("queue_tail", rail.optLong("queue_tail", 0L))
        }
        if (rail.has("next_index")) {
            context.put("next_index", rail.optLong("next_index", 0L))
        }
        if (!context.has("change_commitment") && !context.has("queue_tail") && !context.has("next_index")) {
            rail.optString("public_indexer_url").trim().takeIf { it.isNotBlank() }?.let { indexerUrl ->
                val treeState = ShieldedPoolIndexerClient(indexerUrl).treeState()
                if (treeState.has("next_index")) {
                    context.put("next_index", treeState.optLong("next_index", 0L))
                }
            }
        }
        context.put("account_order", JSONArray(listOf(
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
        return context
    }

    private fun mergeHydratedNotes(originalSelection: JSONArray, hydratedSelection: JSONArray): JSONArray {
        val existing = JSONArray(storage.getShieldedPoolNotesJson().orEmpty().ifBlank { "[]" })
        val hydratedByCommitment = mutableMapOf<String, JSONObject>()
        for (i in 0 until originalSelection.length()) {
            val commitment = originalSelection.getJSONObject(i).optString("commitment_hex", originalSelection.getJSONObject(i).optString("commitment"))
            if (commitment.isNotBlank()) hydratedByCommitment[commitment] = hydratedSelection.getJSONObject(i)
        }
        val merged = JSONArray()
        for (i in 0 until existing.length()) {
            val note = existing.getJSONObject(i)
            val commitment = note.optString("commitment_hex", note.optString("commitment"))
            merged.put(hydratedByCommitment[commitment] ?: note)
        }
        return merged
    }

    private fun buildWitness(
        intent: JSONObject,
        recipient: String,
        amountMicroUsdc: Long,
        localAccount: LocalAccount,
        notes: JSONArray,
        solanaContext: JSONObject?,
    ): JSONObject {
        val inputNotes = JSONArray()
        val inputPaths = JSONArray()
        val inputIndices = JSONArray()
        var inputTotal = 0L
        for (i in 0 until notes.length()) {
            val note = notes.getJSONObject(i)
            inputTotal += noteAmount(note)
            inputNotes.put(rustNoteJson(note, localAccount.ownerPubkeyHex))
            inputPaths.put(merklePathJson(note))
            inputIndices.put(note.getLong("leaf_index"))
        }

        val change = inputTotal - amountMicroUsdc
        if (change < 0L) {
            throw IllegalStateException("Selected Solana shielded notes do not cover this amount; no public fallback.")
        }
        val outputNotes = JSONArray()
        if (change > 0L) {
            outputNotes.put(
                JSONObject().apply {
                    put("amount", change)
                    put("asset_id", fieldArray(assetIdHex(notes)))
                    put("owner_pubkey", fieldArray(localAccount.ownerPubkeyHex))
                    put("blinding", fieldArray(hex(sha256("change".toByteArray(Charsets.UTF_8) + intent.getString("id").toByteArray(Charsets.UTF_8)))))
                },
            )
        }

        return JSONObject().apply {
            put("input_notes", inputNotes)
            put("input_paths", inputPaths)
            put("input_indices", inputIndices)
            put("output_notes", outputNotes)
            put("spending_key", fieldArray(localAccount.spendingKeyHex))
            put("public_amount", amountMicroUsdc)
            put("asset_id", fieldArray(assetIdHex(notes)))
            put("ext_data_hash", fieldArray(extDataHashHex(intent, recipient, amountMicroUsdc)))
            put("_ghola_meta", JSONObject().apply {
                put("version", "ghola-solana-shielded-pool-witness-v1")
                put("intent_id", intent.getString("id"))
                put("rail", "solana_shielded_pool")
                put("network", intent.optString("network", "solana:devnet"))
                put("asset", intent.optString("asset", "USDCx"))
                put("recipient", recipient)
                put(
                    "recipient_kind",
                    if (recipient.startsWith("shld1")) "shielded_recipient" else "solana_token_account",
                )
                put("wallet_address", localAccount.walletAddress)
                if (solanaContext != null) put("solana_context", solanaContext)
                put("created_at", Instant.now().toString())
            })
        }
    }

    private fun buildPaymentProof(
        intent: JSONObject,
        recipient: String,
        amountMicroUsdc: Long,
        proofOutput: JSONObject,
    ): JSONObject {
        val proofBundle = proofOutput.getJSONObject("proof_bundle")
        val instruction = proofOutput.optJSONObject("withdraw_instruction") ?: JSONObject()
        val proofB64 = proofOutput.optString(
            "proof_b64",
            Base64.encodeToString(proofBundle.toString().toByteArray(Charsets.UTF_8), Base64.NO_WRAP),
        )
        val extensions = JSONObject().apply {
            put("proof_bundle", proofBundle)
            put("recipient", recipient)
            put("amount_micro_usdc", amountMicroUsdc)
            put("fee", proofOutput.optLong("fee", 0L))
            put("relayer_fee", proofOutput.optLong("relayer_fee", 0L))
            val dataHex = proofOutput.optString(
                "instruction_data_hex",
                instruction.optString("data_hex", ""),
            )
            if (dataHex.isNotBlank()) put("instruction_data_hex", dataHex)
            put("accounts", proofOutput.optJSONArray("accounts") ?: instruction.optJSONArray("accounts") ?: JSONArray())
        }
        return JSONObject().apply {
            put("x402Version", "2")
            put("scheme", "solana_shielded_pool")
            put("network", intent.optString("network", "solana:devnet"))
            put("payload", JSONObject().apply {
                put("tx_signature", JSONObject.NULL)
                put("shielded_receipt_id", JSONObject.NULL)
                put("proof_b64", proofB64)
                put("nullifier_hex", proofOutput.optString("nullifier_hex", ""))
                put("extensions", extensions)
            })
        }
    }

    private suspend fun buildSignerAttestation(
        session: SeedVaultNative.Session,
        intent: JSONObject,
        recipient: String,
        amountMicroUsdc: Long,
        signerDid: String,
        proof: JSONObject,
    ): JSONObject {
        val signedAt = Instant.now().toString()
        val payloadObj = proof.getJSONObject("payload")
        val proofDigest = proofDigest(payloadObj)
        // Bind the bytes that actually get submitted to the relayer. proofDigest
        // above only covers tx_signature/shielded_receipt_id/proof_b64/
        // nullifier_hex; the instruction the relayer broadcasts is carried in
        // payload.extensions (instruction_data_hex + accounts). Without folding
        // those into the signed message, a tampered relayer response could be
        // submitted under a device signature that never committed to it. The
        // on-chain verifier rebinds ext_data_hash regardless, but signing the
        // submission here means the device attestation is honest about what it
        // approved (and a server can detect tampering before broadcast).
        val submissionDigest = submissionDigest(payloadObj.optJSONObject("extensions"))
        val attestation = JSONObject().apply {
            put("version", "ghola-private-usdcx-signer-v1")
            put("intent_id", intent.getString("id"))
            put("signing_mode", "seed_vault_device")
            put("signer_key_id", signerDid)
            put("recipient_hash", hex(sha256(recipient.toByteArray(Charsets.UTF_8))))
            put("amount_micro_usdc", amountMicroUsdc)
            put("network", intent.optString("network", "solana:devnet"))
            put("asset", intent.optString("asset", "USDCx"))
            put("policy_hash", intent.getString("policy_hash"))
            put("proof_digest", proofDigest)
            put("submission_digest", submissionDigest)
            put("receipt_ref", "pending")
            put("signed_at", signedAt)
        }
        val payload = signerAttestationPayload(attestation).toByteArray(Charsets.UTF_8)
        when (val signed = seedVault.signMessage(session.authToken, session.derivationPathUri, payload)) {
            is SeedVaultNative.SignOutcome.Success -> {
                attestation.put("signature_b64", Base64.encodeToString(signed.signature, Base64.NO_WRAP))
                return attestation
            }
            SeedVaultNative.SignOutcome.NoSeedVault -> throw IllegalStateException("Seed Vault is not available")
            SeedVaultNative.SignOutcome.Declined -> throw IllegalStateException("Seed Vault submit attestation declined")
            SeedVaultNative.SignOutcome.Cancelled -> throw IllegalStateException("Seed Vault submit attestation cancelled")
            is SeedVaultNative.SignOutcome.Failure -> throw signed.cause
        }
    }

    private fun signerAttestationPayload(attestation: JSONObject): String = listOf(
        "ghola-private-usdcx-signer-v1",
        "intent_id:${attestation.getString("intent_id")}",
        "signing_mode:${attestation.getString("signing_mode")}",
        "signer_key_id:${attestation.getString("signer_key_id")}",
        "recipient_hash:${attestation.getString("recipient_hash")}",
        "amount_micro_usdc:${attestation.getLong("amount_micro_usdc")}",
        "network:${attestation.getString("network")}",
        "asset:${attestation.getString("asset")}",
        "policy_hash:${attestation.getString("policy_hash")}",
        "proof_digest:${attestation.getString("proof_digest")}",
        "submission_digest:${attestation.getString("submission_digest")}",
        "receipt_ref:${attestation.getString("receipt_ref")}",
        "signed_at:${attestation.getString("signed_at")}",
    ).joinToString("\n")

    private fun proofDigest(payload: JSONObject): String {
        val canonical = "{" +
            "\"tx_signature\":${jsonScalar(payload, "tx_signature")}," +
            "\"shielded_receipt_id\":${jsonScalar(payload, "shielded_receipt_id")}," +
            "\"proof_b64\":${jsonScalar(payload, "proof_b64")}," +
            "\"nullifier_hex\":${jsonScalar(payload, "nullifier_hex")}" +
            "}"
        return hex(sha256(canonical.toByteArray(Charsets.UTF_8)))
    }

    private fun jsonScalar(obj: JSONObject, key: String): String =
        if (!obj.has(key) || obj.isNull(key)) {
            "null"
        } else {
            JSONObject.quote(obj.getString(key))
        }

    /**
     * SHA-256 over a canonical, order-preserving encoding of the instruction
     * the relayer will broadcast: `instruction_data_hex` plus each account's
     * (pubkey, is_signer, is_writable) in array order. Account order is part of
     * the binding because a Solana instruction is position-sensitive — swapping
     * two accounts changes what the instruction does. Folded into the signed
     * attestation by [buildSignerAttestation].
     */
    private fun submissionDigest(extensions: JSONObject?): String {
        val ext = extensions ?: JSONObject()
        val dataHex = ext.optString("instruction_data_hex", "").lowercase()
        val accounts = ext.optJSONArray("accounts") ?: JSONArray()
        val sb = StringBuilder()
        sb.append("ghola-private-usdcx-submission-v1\n")
        sb.append("instruction_data_hex:").append(dataHex).append('\n')
        sb.append("accounts:").append(accounts.length()).append('\n')
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: JSONObject()
            sb.append(i).append(':')
                .append(a.optString("pubkey", "")).append(':')
                .append(a.optBoolean("is_signer", false)).append(':')
                .append(a.optBoolean("is_writable", false)).append('\n')
        }
        return hex(sha256(sb.toString().toByteArray(Charsets.UTF_8)))
    }

    private object LocalProofEngine {
        fun prove(context: Context, witness: JSONObject): JSONObject {
            val klass = runCatching {
                Class.forName("xyz.ghola.app.solana.ShieldedPoolNativeProver")
            }.getOrNull() ?: throw IllegalStateException(
                "Solana shielded proof engine not available on this build yet; no public fallback.",
            )
            val method = klass.methods.firstOrNull { method ->
                method.name == "prove" &&
                    method.parameterTypes.size == 2 &&
                    method.parameterTypes[0] == Context::class.java &&
                    method.parameterTypes[1] == JSONObject::class.java
            } ?: throw IllegalStateException(
                "Solana shielded proof engine is missing prove(Context, JSONObject); no public fallback.",
            )
            val result = try {
                method.invoke(null, context, witness)
            } catch (t: java.lang.reflect.InvocationTargetException) {
                throw (t.targetException ?: t)
            } ?: throw IllegalStateException("Solana shielded proof engine returned no proof")
            return when (result) {
                is JSONObject -> result
                is String -> JSONObject(result)
                else -> throw IllegalStateException("Solana shielded proof engine returned unsupported proof type")
            }
        }
    }

    companion object {
        private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

        private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

        private fun isBase58Pubkey(value: String): Boolean =
            runCatching { Base58.decode(value).size == 32 }.getOrDefault(false)

        private fun pk(byte: Int): String =
            Base58.encode(ByteArray(32) { byte.toByte() })

        private fun selfTestSolanaContext(): JSONObject =
            JSONObject().apply {
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
            }

        private fun noteAmount(note: JSONObject): Long =
            note.optLong("amount", note.optLong("amount_micro_usdc", 0L))

        private fun assetIdHex(notes: JSONArray): String =
            notes.getJSONObject(0).optString("asset_id_hex").ifBlank {
                notes.getJSONObject(0).optString("asset_id")
            }.ifBlank {
                throw IllegalStateException("Local Solana shielded note is missing asset_id_hex")
            }

        private fun rustNoteJson(note: JSONObject, fallbackOwnerPubkeyHex: String): JSONObject =
            JSONObject().apply {
                put("amount", noteAmount(note))
                put("asset_id", fieldArray(note.optString("asset_id_hex", note.optString("asset_id"))))
                put("owner_pubkey", fieldArray(note.optString("owner_pubkey_hex", fallbackOwnerPubkeyHex)))
                put("blinding", fieldArray(note.optString("blinding_hex")))
            }

        private fun merklePathJson(note: JSONObject): JSONObject {
            val path = note.optJSONObject("merkle_path") ?: note
            val siblings = path.optJSONArray("siblings_hex") ?: path.optJSONArray("siblings")
                ?: throw IllegalStateException("Local Solana shielded note is missing Merkle siblings")
            val pathBits = path.optJSONArray("path_bits")
                ?: throw IllegalStateException("Local Solana shielded note is missing Merkle path bits")
            val siblingArrays = JSONArray()
            for (i in 0 until siblings.length()) {
                siblingArrays.put(fieldArray(siblings.getString(i)))
            }
            return JSONObject().apply {
                put("siblings", siblingArrays)
                put("path_bits", pathBits)
            }
        }

        private fun fieldArray(hex: String): JSONArray {
            val clean = hex.trim().removePrefix("0x")
            require(clean.length == 64) { "expected 32-byte hex field" }
            val arr = JSONArray()
            for (i in 0 until 32) {
                arr.put(clean.substring(i * 2, i * 2 + 2).toInt(16))
            }
            return arr
        }

        private fun extDataHashHex(intent: JSONObject, recipient: String, amountMicroUsdc: Long): String =
            hex(
                sha256(
                    listOf(
                        "ghola-solana-shielded-ext-data-v1",
                        "intent_id:${intent.getString("id")}",
                        "recipient:$recipient",
                        "amount_micro_usdc:$amountMicroUsdc",
                        "network:${intent.optString("network", "solana:devnet")}",
                        "asset:${intent.optString("asset", "USDCx")}",
                    ).joinToString("\n").toByteArray(Charsets.UTF_8),
                ),
            )

        private fun selfTestNote(localAccount: LocalAccount): JSONObject {
            val asset = hex(sha256("USDCx:self-test".toByteArray(Charsets.UTF_8)))
            val blinding = hex(sha256("self-test-blinding".toByteArray(Charsets.UTF_8) + localAccount.ownerPubkeyHex.toByteArray(Charsets.UTF_8)))
            val siblings = JSONArray()
            val pathBits = JSONArray()
            repeat(26) {
                siblings.put("00".repeat(32))
                pathBits.put(false)
            }
            return JSONObject().apply {
                put("amount_micro_usdc", 1L)
                put("asset_id_hex", asset)
                put("owner_pubkey_hex", localAccount.ownerPubkeyHex)
                put("blinding_hex", blinding)
                put("commitment_hex", hex(sha256("self-test-commitment".toByteArray(Charsets.UTF_8) + blinding.toByteArray(Charsets.UTF_8))))
                put("leaf_index", 0L)
                put("merkle_path", JSONObject().apply {
                    put("siblings_hex", siblings)
                    put("path_bits", pathBits)
                    put("root", "00".repeat(32))
                })
            }
        }
    }
}
