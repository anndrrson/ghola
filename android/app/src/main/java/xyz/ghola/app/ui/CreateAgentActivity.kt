package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.launch
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.cloud.DeviceSignerProvider
import xyz.ghola.app.cloud.SaidCloudClient
import xyz.ghola.app.crypto.PrivateAgentIdentity
import xyz.ghola.app.solana.SeedVaultNative
import java.util.concurrent.Executors

/**
 * Agent creation wizard (Phase M5).
 *
 * Two inputs: display_name (auto-derives slug) and optional bio. On Seeker,
 * the agent identity is derived locally from a Seed Vault signature and only
 * the public DID/address plus signature proof are sent to said-cloud. Legacy
 * clients keep the server-generated identity path.
 */
class CreateAgentActivity : AppCompatActivity() {

    private lateinit var storage: SecureStorage
    private lateinit var displayNameInput: EditText
    private lateinit var slugInput: EditText
    private lateinit var bioInput: EditText
    private lateinit var createButton: MaterialButton
    private lateinit var errorText: TextView
    private lateinit var loading: ProgressBar
    private val executor = Executors.newSingleThreadExecutor()
    private val activityResultSender = ActivityResultSender(this)
    private val seedVaultNative = SeedVaultNative(this)

    private var slugTouched = false

    private data class AgentForm(
        val displayName: String,
        val slug: String,
        val bio: String?,
    )

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
            signInForAgents()
            return
        }

        val form = AgentForm(
            displayName = displayName,
            slug = slug,
            bio = bio.takeIf { it.isNotEmpty() },
        )

        loading.visibility = View.VISIBLE
        createButton.isEnabled = false

        lifecycleScope.launch {
            val privateIdentity = if (BuildConfig.GHOLA_SEEKER_BUILD) {
                val session = ensureSeedVaultSession().getOrElse { err ->
                    loading.visibility = View.GONE
                    createButton.isEnabled = true
                    showError(err.message ?: "Seed Vault connection failed")
                    return@launch
                }
                PrivateAgentIdentity.derive(
                    signer = seedVaultNative.signer(session),
                    slug = form.slug,
                    displayName = form.displayName,
                    bio = form.bio,
                ).getOrElse { err ->
                    loading.visibility = View.GONE
                    createButton.isEnabled = true
                    showError(err.message ?: "Private agent identity derivation failed")
                    return@launch
                }
            } else {
                null
            }

            createAgent(form, privateIdentity)
        }
    }

    private fun createAgent(
        form: AgentForm,
        privateIdentity: PrivateAgentIdentity.Derived?,
    ) {
        executor.execute {
            val authManager = CloudAuthManager(this@CreateAgentActivity)
            val client = SaidCloudClient.withRefresh(
                baseUrl = storage.getSaidBaseUrl(),
                tokenProvider = { storage.getSaidToken() },
                tokenRefresher = { authManager.refreshSaidToken() },
                onAuthExhausted = { storage.clearSaidAuth() },
            )
            val result = client.createAgent(
                slug = form.slug,
                displayName = form.displayName,
                bio = form.bio,
                clientPubkey = privateIdentity?.publicKeyBase58,
                clientDid = privateIdentity?.did,
                clientIdentityMessage = privateIdentity?.identityMessage,
                clientIdentitySignature = privateIdentity?.identitySignatureBase64,
            )
            if (result != null && privateIdentity != null && result.optString("id", "").isNotEmpty()) {
                val privateConfig = client.createEncryptedChatAgent(
                    encryptedConfig = privateIdentity.encryptedConfig,
                    publicAgentId = result.optString("id", ""),
                )
                result.put("identity_mode", "seed_vault_derived")
                result.put("private_config_synced", privateConfig != null)
                if (privateConfig != null) {
                    result.put("private_chat_agent_id", privateConfig.optString("id", ""))
                }
            }
            runOnUiThread {
                loading.visibility = View.GONE
                createButton.isEnabled = true

                if (result == null) {
                    showError("Failed to create agent. Check your connection and try again.")
                    return@runOnUiThread
                }

                val agentId: String = result.optString("id", "")
                if (agentId.isEmpty()) {
                    val err: String = result.optString("error", "Unknown error from server")
                    showError(err)
                    return@runOnUiThread
                }

                // Set as primary agent if it's the first one (best-effort).
                if (storage.getPrimaryAgentId() == null) {
                    storage.setPrimaryAgentId(agentId)
                }

                val intent = Intent(this, AgentDetailActivity::class.java)
                intent.putExtra(AgentDetailActivity.EXTRA_AGENT_ID, agentId)
                intent.putExtra(AgentDetailActivity.EXTRA_AGENT_JSON, result.toString())
                intent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP
                startActivity(intent)
                finish()
            }
        }
    }

    private fun signInForAgents() {
        errorText.visibility = View.GONE
        loading.visibility = View.VISIBLE
        createButton.isEnabled = false

        lifecycleScope.launch {
            val result = when {
                BuildConfig.GHOLA_SEEKER_BUILD -> {
                    val session = ensureSeedVaultSession().getOrElse {
                        loading.visibility = View.GONE
                        createButton.isEnabled = true
                        showError(it.message ?: "Seed Vault connection failed")
                        return@launch
                    }
                    CloudAuthManager(this@CreateAgentActivity)
                        .signInSaidWithDeviceSigner(seedVaultNative.signer(session))
                }
                BuildConfig.GHOLA_PLAY_STORE_BUILD -> {
                    val signer = DeviceSignerProvider.cached(this@CreateAgentActivity)
                        ?: DeviceSignerProvider.signIn(this@CreateAgentActivity).getOrElse {
                            loading.visibility = View.GONE
                            createButton.isEnabled = true
                            showError(it.message ?: "Turnkey sign-in failed")
                            return@launch
                        }
                    CloudAuthManager(this@CreateAgentActivity).signInSaidWithDeviceSigner(signer)
                }
                else -> {
                    val walletAddress = storage.getSolanaAddress()
                    if (walletAddress.isNullOrBlank()) {
                        loading.visibility = View.GONE
                        createButton.isEnabled = true
                        showError("Connect your wallet first.")
                        return@launch
                    }
                    CloudAuthManager(this@CreateAgentActivity)
                        .signInSaidWithWallet(activityResultSender, walletAddress)
                }
            }

            loading.visibility = View.GONE
            createButton.isEnabled = true

            when (result) {
                is CloudAuthManager.AuthResult.Success -> submit()
                is CloudAuthManager.AuthResult.Error -> showError(result.message)
            }
        }
    }

    private suspend fun ensureSeedVaultSession(): Result<SeedVaultNative.Session> {
        currentSeedVaultSession()?.let { return Result.success(it) }
        return seedVaultNative.authorizeSession().map { session ->
            storage.setSeedVaultSession(
                address = session.address,
                authToken = session.authToken,
                derivationPathUri = session.derivationPathUri,
            )
            session
        }
    }

    private fun currentSeedVaultSession(): SeedVaultNative.Session? {
        val address = storage.getSeedVaultAddress() ?: return null
        val token = storage.getSeedVaultAuthToken() ?: return null
        val path = storage.getSeedVaultDerivationPathUri() ?: return null
        return SeedVaultNative.Session(address, token, path)
    }

    private fun showError(msg: String) {
        errorText.text = msg
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
