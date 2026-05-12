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
import com.google.android.material.button.MaterialButton
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.SaidCloudClient
import java.util.concurrent.Executors

/**
 * Agent creation wizard (Phase M5).
 *
 * Two inputs: display_name (auto-derives slug) and optional bio. POSTs to
 * said-cloud's /v1/agents which generates a fresh ed25519 keypair, derives
 * the DID + Solana address, and provisions a dedicated agent_wallets row in
 * one transaction. On success, redirects to [AgentDetailActivity].
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
            showError("Wallet session missing for agents. Reconnect wallet in onboarding.")
            return
        }

        loading.visibility = View.VISIBLE
        createButton.isEnabled = false

        executor.execute {
            val client = SaidCloudClient(storage.getSaidBaseUrl(), storage.getSaidToken())
            val result = client.createAgent(
                slug = slug,
                displayName = displayName,
                bio = if (bio.isNotEmpty()) bio else null
            )
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
