package xyz.ghola.app.solana

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.Base64

/**
 * JVM-visible bridge for a bundled Seeker-local shielded-pool prover.
 *
 * The native implementation is expected to return JSON with:
 * - proof_bundle: hex-wire Groth16 proof bundle
 * - nullifier_hex
 * - withdraw_instruction: { data_hex, accounts[] }
 * - optional fee / relayer_fee / proof_b64
 *
 * Builds without the native library remain fail-closed.
 */
object ShieldedPoolNativeProver {
    // H2 — spending-key exposure contract.
    //
    // The [witness] JSONObject carries `spending_key` (and the input-note
    // secrets) in plaintext. Two unavoidable plaintext copies exist on the
    // Kotlin side: the JSONObject's internal field map, and the `String`
    // produced by `witness.toString()` for the JNI call. Neither a JVM
    // `String` nor JSONObject-internal storage can be reliably zeroized
    // (immutable + GC-managed), so we minimize *lifetime* instead: we scrub
    // the secret fields out of the witness object as soon as the native call
    // returns, and we best-effort wipe any temp files the native backend left
    // behind. This narrows, but does not eliminate, heap residue — a full fix
    // requires the witness never being materialized as a String (see the
    // native-side contract in shielded_pool_backend.h: a production backend
    // MUST receive the witness via a caller-owned memory buffer it can wipe,
    // and MUST NOT write the witness to a file).
    //
    // The artifact/work dir lives under `context.noBackupFilesDir` — app-
    // private and excluded from cloud/USB backups (see [prepareArtifacts]).
    @JvmStatic
    fun prove(context: Context, witness: JSONObject): JSONObject {
        val native = loadNative()
        if (!native) {
            throw IllegalStateException("Solana shielded proof engine not available on this build yet; no public fallback.")
        }
        val artifactDir = prepareArtifacts(context)
        val raw = try {
            proveNative(witness.toString(), artifactDir.absolutePath)
        } catch (t: UnsatisfiedLinkError) {
            throw IllegalStateException("Solana shielded proof engine JNI entrypoint is missing; no public fallback.", t)
        } finally {
            // Drop the spending key from the in-memory witness ASAP and wipe
            // any work files the native side may have left if it crashed
            // before its own cleanup. Best-effort; failures here must not mask
            // a real prove() result or error.
            scrubWitnessSecrets(witness)
            secureScrubWorkdir(artifactDir)
        }
        if (raw.isBlank()) {
            throw IllegalStateException("Solana shielded proof engine returned an empty proof")
        }
        return validateProofOutput(JSONObject(raw), witness)
    }

    @JvmStatic
    fun selfTest(context: Context, witness: JSONObject): JSONObject {
        val native = loadNative()
        if (!native) {
            throw IllegalStateException("Solana shielded proof engine not available on this build yet; no public fallback.")
        }
        val artifactDir = prepareArtifacts(context)
        val raw = try {
            selfTestNative(witness.toString(), artifactDir.absolutePath)
        } catch (t: UnsatisfiedLinkError) {
            throw IllegalStateException("Solana shielded proof engine self-test entrypoint is missing; no public fallback.", t)
        } finally {
            scrubWitnessSecrets(witness)
            secureScrubWorkdir(artifactDir)
        }
        if (raw.isBlank()) {
            throw IllegalStateException("Solana shielded proof self-test returned an empty response")
        }
        val json = JSONObject(raw)
        if (!json.optBoolean("self_test_only", false) || json.optBoolean("proof_submitted", true)) {
            throw IllegalStateException("Solana shielded proof self-test response is unsafe")
        }
        return json
    }

    @JvmStatic
    private external fun proveNative(witnessJson: String, artifactDir: String): String

    @JvmStatic
    private external fun selfTestNative(witnessJson: String, artifactDir: String): String

    private fun prepareArtifacts(context: Context): File {
        val dir = File(context.noBackupFilesDir, "shielded_pool").apply { mkdirs() }
        copyAsset(context, "shielded_pool/transaction.wasm", File(dir, "transaction.wasm"))
        copyAsset(context, "shielded_pool/transaction.r1cs", File(dir, "transaction.r1cs"))
        copyAsset(context, "shielded_pool/transaction_final.zkey", File(dir, "transaction_final.zkey"))
        return dir
    }

    private fun copyAsset(context: Context, assetName: String, destination: File) {
        if (destination.exists() && destination.length() > 0L) return
        val tmp = File(destination.parentFile, "${destination.name}.tmp")
        context.assets.open(assetName).use { input ->
            tmp.outputStream().use { output -> input.copyTo(output) }
        }
        if (!tmp.renameTo(destination)) {
            tmp.copyTo(destination, overwrite = true)
            tmp.delete()
        }
    }

    /**
     * H2: best-effort removal of the secret-bearing fields from the
     * in-memory witness once the native prover has consumed it. We cannot
     * zeroize the underlying JVM strings, but dropping the references lets
     * them become GC-eligible immediately instead of lingering for the life
     * of the witness object. The non-secret [`_ghola_meta`] block is left
     * intact because the proof-output validator re-checks the approved pool
     * account order against it.
     */
    private fun scrubWitnessSecrets(witness: JSONObject) {
        for (key in listOf("spending_key", "input_notes", "input_paths", "input_indices", "output_notes")) {
            runCatching { witness.remove(key) }
        }
    }

    /**
     * H2: defense-in-depth wipe of any prover work files left under the
     * artifact dir. The native backend is responsible for unlinking its own
     * `proof-work-XXXXXX/` temp dir, but if it crashed mid-prove the witness
     * `input.json` (which contains the spending key) could survive on flash.
     * We overwrite-then-delete any stray work artifacts. We deliberately do
     * NOT touch the packaged circuit artifacts (transaction.wasm / .r1cs /
     * _final.zkey), only the per-proof scratch files and workdirs.
     */
    private fun secureScrubWorkdir(artifactDir: File) {
        val children = runCatching { artifactDir.listFiles() }.getOrNull() ?: return
        for (child in children) {
            val name = child.name
            val isCircuitArtifact = name == "transaction.wasm" ||
                name == "transaction.r1cs" ||
                name == "transaction_final.zkey"
            if (isCircuitArtifact) continue
            val isWorkArtifact = (child.isDirectory && name.startsWith("proof-work-")) ||
                name.endsWith(".json") ||
                name.endsWith(".wtns")
            if (!isWorkArtifact) continue
            runCatching { overwriteAndDelete(child) }
        }
    }

    private fun overwriteAndDelete(target: File) {
        if (target.isDirectory) {
            target.listFiles()?.forEach { overwriteAndDelete(it) }
            target.delete()
            return
        }
        runCatching {
            val len = target.length()
            if (len in 1..(8L * 1024 * 1024)) {
                // Single-pass zero overwrite. Flash wear-levelling means this
                // is not a guaranteed secure erase, but it removes the
                // plaintext from the most obvious recovery path. Capped so a
                // pathological size can't stall the UI thread's cleanup.
                target.outputStream().use { out ->
                    val zeros = ByteArray(4096)
                    var written = 0L
                    while (written < len) {
                        val n = minOf(zeros.size.toLong(), len - written).toInt()
                        out.write(zeros, 0, n)
                        written += n
                    }
                    out.flush()
                }
            }
        }
        target.delete()
    }

    internal fun validateProofOutput(json: JSONObject): JSONObject =
        validateProofOutput(json, witness = null)

    internal fun validateProofOutput(json: JSONObject, witness: JSONObject?): JSONObject {
        val proofBundle = json.optJSONObject("proof_bundle")
            ?: throw IllegalStateException("Solana shielded proof output is missing proof_bundle")
        requireHex(proofBundle, "proof_bundle.a", "a", 64)
        requireHex(proofBundle, "proof_bundle.b", "b", 128)
        requireHex(proofBundle, "proof_bundle.c", "c", 64)
        requireHex(proofBundle, "proof_bundle.root", "root", 32)
        requireHex(proofBundle, "proof_bundle.asset_id", "asset_id", 32)
        requireHex(proofBundle, "proof_bundle.ext_data_hash", "ext_data_hash", 32)
        requireHexArray(proofBundle, "proof_bundle.input_nullifiers", "input_nullifiers", min = 1)
        requireHexArray(proofBundle, "proof_bundle.output_commitments", "output_commitments", min = 0)
        if (!proofBundle.has("public_amount")) {
            throw IllegalStateException("Solana shielded proof_bundle is missing public_amount")
        }
        proofBundle.opt("public_amount")
            ?: throw IllegalStateException("Solana shielded proof_bundle public_amount is null")

        json.optString("proof_b64").takeIf { it.isNotBlank() }?.let { proofB64 ->
            runCatching { Base64.getDecoder().decode(proofB64) }
                .getOrElse { throw IllegalStateException("Solana shielded proof_b64 is not valid base64") }
        }

        if (!proofBundle.has("input_nullifiers") || !proofBundle.has("output_commitments")) {
            throw IllegalStateException("Solana shielded proof_bundle is missing public inputs")
        }
        requireHex(json, "nullifier_hex", "nullifier_hex", 32)
        val instruction = json.optJSONObject("withdraw_instruction")
            ?: throw IllegalStateException("Solana shielded proof output is missing withdraw_instruction")
        requireEvenHex(instruction, "withdraw_instruction.data_hex", "data_hex", minBytes = 16)
        val accounts = instruction.optJSONArray("accounts")
        if (accounts == null || accounts.length() == 0) {
            throw IllegalStateException("Solana shielded withdraw instruction is missing accounts")
        }
        if (accounts.length() > 64) {
            throw IllegalStateException("Solana shielded withdraw instruction has too many accounts")
        }
        for (i in 0 until accounts.length()) {
            val account = accounts.optJSONObject(i)
                ?: throw IllegalStateException("Solana shielded withdraw account[$i] is not an object")
            val pubkey = account.optString("pubkey")
            val decoded = runCatching { Base58.decode(pubkey) }.getOrNull()
            if (decoded?.size != 32) {
                throw IllegalStateException("Solana shielded withdraw account[$i].pubkey is not a 32-byte Solana pubkey")
            }
            if (!account.has("is_signer")) {
                throw IllegalStateException("Solana shielded withdraw account[$i] is missing is_signer")
            }
            if (!account.has("is_writable")) {
                throw IllegalStateException("Solana shielded withdraw account[$i] is missing is_writable")
            }
            account.optBoolean("is_signer")
            account.optBoolean("is_writable")
        }
        validateWithdrawAccountsAgainstWitness(accounts, witness)
        return json
    }

    private fun validateWithdrawAccountsAgainstWitness(accounts: org.json.JSONArray, witness: JSONObject?) {
        val meta = witness
            ?.optJSONObject("_ghola_meta")
            ?: return
        val context = meta.optJSONObject("solana_context") ?: return
        val order = context.optJSONArray("account_order") ?: return
        if (accounts.length() < order.length()) {
            throw IllegalStateException("Solana shielded withdraw instruction has fewer accounts than the pool account order")
        }

        for (i in 0 until order.length()) {
            val name = order.optString(i)
            val expected = expectedPubkeyForAccount(name, meta, context) ?: continue
            val actual = accounts.getJSONObject(i).optString("pubkey")
            if (actual != expected) {
                throw IllegalStateException("Solana shielded withdraw account[$i] $name does not match the approved pool context")
            }
        }
    }

    private fun expectedPubkeyForAccount(name: String, meta: JSONObject, context: JSONObject): String? =
        when (name) {
            "payer" -> context.optString("relayer_payer").takeIf { isBase58Pubkey(it) }
                ?: meta.optString("wallet_address").takeIf { isBase58Pubkey(it) }
            "pool_config",
            "verifier_key",
            "mint",
            "merkle_tree",
            "escrow",
            "token_program",
            "system_program",
            "relayer_token_account" -> context.optString(name).takeIf { isBase58Pubkey(it) }
            "recipient_token_account" -> meta.optString("recipient")
                .takeIf { meta.optString("recipient_kind") == "solana_token_account" && isBase58Pubkey(it) }
            else -> null
        }

    private fun requireHex(obj: JSONObject, label: String, key: String, bytes: Int) {
        val value = obj.optString(key)
        if (!isHex(value) || value.length != bytes * 2) {
            throw IllegalStateException("Solana shielded $label must be ${bytes} bytes of hex")
        }
    }

    private fun requireEvenHex(obj: JSONObject, label: String, key: String, minBytes: Int) {
        val value = obj.optString(key)
        if (!isHex(value) || value.length % 2 != 0 || value.length < minBytes * 2) {
            throw IllegalStateException("Solana shielded $label must be at least ${minBytes} bytes of even-length hex")
        }
    }

    private fun requireHexArray(obj: JSONObject, label: String, key: String, min: Int) {
        val array = obj.optJSONArray(key)
            ?: throw IllegalStateException("Solana shielded $label is missing")
        if (array.length() < min) {
            throw IllegalStateException("Solana shielded $label must contain at least $min item(s)")
        }
        for (i in 0 until array.length()) {
            val value = array.optString(i)
            if (!isHex(value) || value.length != 64) {
                throw IllegalStateException("Solana shielded $label[$i] must be 32 bytes of hex")
            }
        }
    }

    private fun isHex(value: String): Boolean =
        value.isNotBlank() && value.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }

    private fun isBase58Pubkey(value: String): Boolean =
        runCatching { Base58.decode(value).size == 32 }.getOrDefault(false)

    private fun loadNative(): Boolean {
        if (loaded) return true
        if (loadAttempted) return false
        loadAttempted = true
        val candidates = listOf("ghola_shielded_pool", "shielded_pool_prover")
        for (name in candidates) {
            val ok = runCatching {
                System.loadLibrary(name)
            }.isSuccess
            if (ok) {
                loaded = true
                return true
            }
        }
        return false
    }

    private var loadAttempted = false
    private var loaded = false
}
