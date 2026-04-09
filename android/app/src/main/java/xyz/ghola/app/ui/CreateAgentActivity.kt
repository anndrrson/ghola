package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.util.Base64
import android.view.View
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.SaidCloudClient
import xyz.ghola.app.solana.Base58
import xyz.ghola.app.solana.SeederKeyStore
import kotlin.coroutines.resume

/**
 * Agent creation wizard (Phase M5 → hardened in Phase M4c).
 *
 * Two inputs: display_name (auto-derives slug) and optional bio. Drives the
 * 4-phase high-security agent-creation flow:
 *
 *   1. DERIVE — `seederKeyStore.deriveAgentPubkey(N)` walks the user
 *      through a Seed Vault authorize + requestPublicKeys handshake and
 *      returns the raw 32-byte pubkey. N is the user's current agent count
 *      so the BIP-44 path is unique per agent.
 *   2. CHALLENGE — `POST /v1/agents/challenge` with the base58 pubkey
 *      returns a fresh nonce (32 random bytes, base64-encoded) tied to
 *      that pubkey with a short TTL.
 *   3. SIGN — `seederKeyStore.signAgentMessage(N, nonceBytes)` walks the
 *      user through a second Seed Vault authorize + signMessages handshake
 *      and returns the raw 64-byte ed25519 signature over the decoded
 *      nonce bytes (NOT over the base64 string).
 *   4. CREATE — `POST /v1/agents` with the pubkey + base64 nonce + base64
 *      signature causes the server to verify the signature via
 *      ed25519 `verify_strict`, consume the challenge, and bind a new
 *      agent to that pubkey.
 *
 * On success, redirects to [AgentDetailActivity]. On any failure, shows the
 * appropriate error text and keeps the user on this screen so they can
 * retry without losing their form inputs.
 *
 * The flow is driven from a single [lifecycleScope] coroutine. The old
 * executor-based background plumbing was removed because the new flow
 * interleaves main-thread Intent launcher hops with background HTTP calls
 * four times, which is easier to read as a straight-line suspend function
 * than as nested callbacks.
 */
class CreateAgentActivity : AppCompatActivity() {

    private lateinit var storage: SecureStorage
    private lateinit var displayNameInput: EditText
    private lateinit var slugInput: EditText
    private lateinit var bioInput: EditText
    private lateinit var createButton: MaterialButton
    private lateinit var errorText: TextView
    private lateinit var loading: ProgressBar

    // Phase M4b — Seed Vault hardware key store. MUST be a field initializer
    // (not `lateinit` or `by lazy`) so its internal ActivityResultLauncher
    // registrations fire during ComponentActivity construction, BEFORE the
    // Activity reaches CREATED state. Same rule as WalletActivity's
    // `activityResultSender`. On non-Seeker devices SeederKeyStore is still
    // safe to construct — the Intent launchers are registered unconditionally
    // and only fire when deriveAgentPubkey() / signAgentMessage() are called.
    private val seederKeyStore = SeederKeyStore(this)

    private var slugTouched = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_create_agent)

        storage = SecureStorage(this)

        // Crumb header: tapping "ghola" or "agents" acts as a back button.
        findViewById<TextView?>(R.id.crumbBack)?.setOnClickListener { finish() }
        findViewById<TextView?>(R.id.crumbAgents)?.setOnClickListener { finish() }

        displayNameInput = findViewById(R.id.displayNameInput)
        slugInput = findViewById(R.id.slugInput)
        bioInput = findViewById(R.id.bioInput)
        createButton = findViewById(R.id.createButton)
        errorText = findViewById(R.id.errorText)
        loading = findViewById(R.id.loading)

        // Auto-derive slug from display name unless the user has touched the slug field
        displayNameInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (!slugTouched) {
                    slugInput.setText(slugify(s?.toString().orEmpty()))
                }
            }
        })
        slugInput.setOnFocusChangeListener { _, focused ->
            if (focused) slugTouched = true
        }

        createButton.setOnClickListener { submit() }
    }

    /**
     * Drive the 4-phase high-security agent-creation flow. Validates form
     * inputs, then launches a single coroutine that walks derive → challenge
     * → sign → create with user-visible status updates between each phase.
     *
     * All UI mutations happen on the main dispatcher; all HTTP calls happen
     * on [Dispatchers.IO]; the Seed Vault launcher hops run on the main
     * thread by contract and are wrapped in suspendCancellableCoroutine
     * helpers that bridge the callback-based API into suspend-land.
     */
    private fun submit() {
        errorText.visibility = View.GONE

        val displayName = displayNameInput.text?.toString().orEmpty().trim()
        val slug = slugInput.text?.toString().orEmpty().trim()
        val bio = bioInput.text?.toString().orEmpty().trim()

        if (displayName.isEmpty()) {
            showError("Display name is required")
            return
        }
        if (slug.isEmpty()) {
            showError("Slug is required")
            return
        }
        if (!slug.matches(Regex("^[a-zA-Z0-9_-]+\$"))) {
            showError("Slug can only contain letters, digits, '-', and '_'")
            return
        }

        if (!storage.hasSaidAuth()) {
            showError("Not signed in to said-cloud. Re-run onboarding.")
            return
        }

        // Hard gate: the new backend requires a real signed challenge, so
        // we cannot silently fall back to a server-generated keypair on
        // devices without Seed Vault. Tell the user why and stop.
        if (!SeederKeyStore.isSupported(this)) {
            showError(
                "Agent creation requires a Solana Seeker with Seed Vault. " +
                    "Connect a wallet on the Wallet tab first."
            )
            return
        }

        loading.visibility = View.VISIBLE
        createButton.isEnabled = false

        val client = SaidCloudClient(storage.getSaidBaseUrl(), storage.getSaidToken())

        lifecycleScope.launch {
            try {
                // ---- 0. Fetch current agent count for BIP-44 index ----
                setStatus("Preparing…")
                val nextIndex: Int = withContext(Dispatchers.IO) {
                    try {
                        client.listAgents()?.length() ?: 0
                    } catch (_: Exception) {
                        0
                    }
                }

                // ---- 1. DERIVE pubkey from Seed Vault ----
                setStatus("Deriving hardware key…")
                val pubkeyBytes: ByteArray = try {
                    awaitDerive(nextIndex)
                } catch (e: IllegalStateException) {
                    // Single-shot guard tripped — the user must have
                    // mashed the button while a previous flow was still in
                    // flight. Surface a benign toast and reset the UI.
                    toast("Seed Vault busy — try again in a moment")
                    finishErrorState()
                    return@launch
                } catch (e: Throwable) {
                    toast("Seed Vault authorization declined")
                    finishErrorState()
                    return@launch
                }
                val pubkeyBase58 = Base58.encode(pubkeyBytes)

                // ---- 2. CHALLENGE the backend for a nonce ----
                setStatus("Requesting challenge…")
                val challenge: SaidCloudClient.AgentChallenge? = withContext(Dispatchers.IO) {
                    client.requestAgentChallenge(pubkeyBase58)
                }
                if (challenge == null) {
                    showError("Could not fetch agent challenge. Check your connection or sign in again.")
                    finishErrorState()
                    return@launch
                }

                // ---- 3. SIGN the raw nonce bytes ----
                // Backend expects the signature over the raw decoded bytes,
                // NOT over the base64 string. Decoding errors are treated as
                // malformed responses (the server should never issue a bad
                // nonce but we defend in depth).
                val nonceBytes: ByteArray = try {
                    Base64.decode(challenge.nonceBase64, Base64.NO_WRAP)
                } catch (e: IllegalArgumentException) {
                    showError("Malformed challenge from server.")
                    finishErrorState()
                    return@launch
                }

                setStatus("Signing with Seed Vault…")
                val signatureBytes: ByteArray = try {
                    awaitSign(nextIndex, nonceBytes)
                } catch (e: IllegalStateException) {
                    toast("Seed Vault busy — try again in a moment")
                    finishErrorState()
                    return@launch
                } catch (e: Throwable) {
                    toast("Signature declined")
                    finishErrorState()
                    return@launch
                }
                val signatureBase64 =
                    Base64.encodeToString(signatureBytes, Base64.NO_WRAP)

                // ---- 4. CREATE the agent with the signed proof ----
                setStatus("Creating agent…")
                val result: JSONObject? = withContext(Dispatchers.IO) {
                    client.createAgentSigned(
                        slug = slug,
                        displayName = displayName,
                        bio = if (bio.isNotEmpty()) bio else null,
                        masterPubkeyBase58 = pubkeyBase58,
                        challengeNonceBase64 = challenge.nonceBase64,
                        signatureBase64 = signatureBase64,
                    )
                }

                if (result == null) {
                    showError("Failed to create agent. The signed challenge was rejected or the slug is taken.")
                    finishErrorState()
                    return@launch
                }

                val agentId = result.optString("id", "")
                if (agentId.isEmpty()) {
                    val err = result.optString("error", "Unknown error from server")
                    showError(err)
                    finishErrorState()
                    return@launch
                }

                // Set as primary agent if it's the first one (best-effort).
                if (storage.getPrimaryAgentId() == null) {
                    storage.setPrimaryAgentId(agentId)
                }

                val intent = Intent(this@CreateAgentActivity, AgentDetailActivity::class.java)
                intent.putExtra(AgentDetailActivity.EXTRA_AGENT_ID, agentId)
                intent.putExtra(AgentDetailActivity.EXTRA_AGENT_JSON, result.toString())
                intent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP
                startActivity(intent)
                finish()
            } catch (e: Throwable) {
                // Any unexpected throwable in the chain — surface a generic
                // error and reset the UI so the user can retry.
                showError("Unexpected error: ${e.message ?: e.javaClass.simpleName}")
                finishErrorState()
            }
        }
    }

    /**
     * Suspend wrapper around [SeederKeyStore.deriveAgentPubkey]. Resumes
     * with the raw 32-byte pubkey on success or throws on failure. The
     * underlying callback always fires on the main thread so no thread
     * marshalling is needed inside the continuation.
     */
    private suspend fun awaitDerive(agentIndex: Int): ByteArray =
        suspendCancellableCoroutine { cont ->
            seederKeyStore.deriveAgentPubkey(agentIndex) { result ->
                result.fold(
                    onSuccess = { cont.resume(it) },
                    onFailure = { cont.resumeWith(Result.failure(it)) },
                )
            }
        }

    /**
     * Suspend wrapper around [SeederKeyStore.signAgentMessage]. Resumes
     * with the raw 64-byte ed25519 signature on success or throws on
     * failure. Same threading contract as [awaitDerive].
     */
    private suspend fun awaitSign(agentIndex: Int, message: ByteArray): ByteArray =
        suspendCancellableCoroutine { cont ->
            seederKeyStore.signAgentMessage(agentIndex, message) { result ->
                result.fold(
                    onSuccess = { cont.resume(it) },
                    onFailure = { cont.resumeWith(Result.failure(it)) },
                )
            }
        }

    /**
     * Status banner for the four-phase flow. Reuses [errorText] so we don't
     * need to add a new layout element — we just swap the tint for info
     * blue while a step is in progress and let [showError] restore the red
     * tint on failure.
     */
    private fun setStatus(msg: String) {
        errorText.text = msg
        errorText.setTextColor(0xFF3DA8FF.toInt())
        errorText.visibility = View.VISIBLE
    }

    private fun finishErrorState() {
        loading.visibility = View.GONE
        createButton.isEnabled = true
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
    }

    private fun showError(msg: String) {
        errorText.text = msg
        errorText.setTextColor(0xFFEF4444.toInt())
        errorText.visibility = View.VISIBLE
    }

    private fun slugify(input: String): String {
        return input.lowercase()
            .trim()
            .replace(Regex("[^a-z0-9 _-]"), "")
            .replace(Regex("\\s+"), "-")
            .take(64)
    }
}
