package xyz.ghola.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.ColorStateList
import android.os.Bundle
import android.view.View
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.cloud.SaidCloudClient
import java.util.concurrent.Executors

/**
 * Detail screen for a single owned agent.
 *
 * Shows an integrated profile view with private identity state, balances, and
 * copyable cryptographic identifiers. Data is loaded from /v1/agents/{id},
 * /v1/agents/{id}/earnings, and /v1/agents/{id}/reputation.
 */
class AgentDetailActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_AGENT_ID = "agent_id"
        const val EXTRA_AGENT_JSON = "agent_json"
    }

    private lateinit var storage: SecureStorage
    private val executor = Executors.newFixedThreadPool(3)

    private lateinit var displayNameView: TextView
    private lateinit var slugView: TextView
    private lateinit var bioView: TextView
    private lateinit var agentInitialView: TextView
    private lateinit var identityModeIcon: ImageView
    private lateinit var identityModeView: TextView
    private lateinit var identityModeDetailView: TextView
    private lateinit var privateConfigStateView: TextView
    private lateinit var didView: TextView
    private lateinit var solanaAddressView: TextView
    private lateinit var balanceView: TextView
    private lateinit var serviceCountView: TextView
    private lateinit var reputationView: TextView
    private lateinit var earnedView: TextView
    private lateinit var loading: ProgressBar

    private var agentId: String = ""
    private var privateIdentityKnown: Boolean = false
    private var privateConfigSynced: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_agent_detail)

        storage = SecureStorage(this)

        findViewById<View?>(R.id.backButton)?.setOnClickListener { finish() }
        findViewById<TextView?>(R.id.crumbAgents)?.setOnClickListener { finish() }

        displayNameView = findViewById(R.id.displayName)
        slugView = findViewById(R.id.slug)
        bioView = findViewById(R.id.bio)
        agentInitialView = findViewById(R.id.agentInitial)
        identityModeIcon = findViewById(R.id.identityModeIcon)
        identityModeView = findViewById(R.id.identityMode)
        identityModeDetailView = findViewById(R.id.identityModeDetail)
        privateConfigStateView = findViewById(R.id.privateConfigState)
        didView = findViewById(R.id.did)
        solanaAddressView = findViewById(R.id.solanaAddress)
        balanceView = findViewById(R.id.balance)
        serviceCountView = findViewById(R.id.serviceCount)
        reputationView = findViewById(R.id.reputation)
        earnedView = findViewById(R.id.earned)
        loading = findViewById(R.id.loading)

        findViewById<com.google.android.material.bottomnavigation.BottomNavigationView?>(R.id.bottomNav)
            ?.let { BottomNavHelper.attach(this, R.id.tab_agents, it) }

        val copyDid = View.OnClickListener { copy("DID", didView.text?.toString().orEmpty()) }
        didView.setOnClickListener(copyDid)
        findViewById<View?>(R.id.didRow)?.setOnClickListener(copyDid)
        findViewById<View?>(R.id.didCopy)?.setOnClickListener(copyDid)

        val copyAddress = View.OnClickListener {
            copy("Address", solanaAddressView.text?.toString().orEmpty())
        }
        solanaAddressView.setOnClickListener(copyAddress)
        findViewById<View?>(R.id.addressRow)?.setOnClickListener(copyAddress)
        findViewById<View?>(R.id.addressCopy)?.setOnClickListener(copyAddress)

        agentId = intent.getStringExtra(EXTRA_AGENT_ID).orEmpty()
        if (agentId.isEmpty()) {
            Toast.makeText(this, "Missing agent ID", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        // Hydrate from the JSON snapshot passed via intent so the screen
        // shows something instantly. Then refresh from the network.
        val initialJson = intent.getStringExtra(EXTRA_AGENT_JSON)
        if (initialJson != null) {
            try {
                bind(JSONObject(initialJson))
            } catch (_: Exception) { /* ignore */ }
        }

        loadFresh()
    }

    private fun bind(agent: JSONObject) {
        val displayName = agent.optString("display_name", "Agent")
        val slug = agent.optString("slug", "agent")
        displayNameView.text = displayName
        agentInitialView.text = displayName.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "A"
        slugView.text = "@$slug"

        val bio = agent.optString("bio", "")
        if (bio.isNotEmpty() && bio != "null") {
            bioView.text = bio
            bioView.visibility = View.VISIBLE
        } else {
            bioView.visibility = View.GONE
        }
        didView.text = agent.optString("did", "—")
        solanaAddressView.text = agent.optString("solana_address", "—")

        if (
            agent.optString("identity_mode") == "mwa_wallet_derived" ||
            agent.optBoolean("private_config_synced", false)
        ) {
            privateIdentityKnown = true
        }
        if (agent.has("private_config_synced")) {
            privateConfigSynced = agent.optBoolean("private_config_synced", false)
        }
        renderPrivacyState()

        val serviceCount = agent.optInt("service_count", -1)
        if (serviceCount >= 0) serviceCountView.text = serviceCount.toString()

        val rep = agent.optDouble("reputation_score", -1.0)
        if (rep >= 0.0) reputationView.text = String.format("%.2f", rep)
    }

    private fun loadFresh() {
        if (!storage.hasSaidAuth()) return
        loading.visibility = View.VISIBLE

        executor.execute {
            try {
                val authManager = CloudAuthManager(this)
                val client = SaidCloudClient.withRefresh(
                    baseUrl = storage.getSaidBaseUrl(),
                    tokenProvider = { storage.getSaidToken() },
                    tokenRefresher = { authManager.refreshSaidToken() },
                    onAuthExhausted = { storage.clearSaidAuth() },
                )
                val agent = client.getAgent(agentId)
                val earnings = client.getAgentEarnings(agentId)
                val reputation = client.getAgentReputation(agentId)

                runOnUiThread {
                    loading.visibility = View.GONE
                    if (agent != null) bind(agent)
                    if (earnings != null) {
                        val net = earnings.optLong("net_micro_usdc", 0L)
                        val received = earnings.optLong("total_received_micro_usdc", 0L)
                        balanceView.text = formatUsdc(net)
                        earnedView.text = formatUsdc(received)
                    }
                    if (reputation != null) {
                        val score = reputation.optDouble("overall_score", 0.0)
                        reputationView.text = if (score > 0) String.format("%.2f", score) else "—"
                    }
                }
            } catch (_: Exception) {
                runOnUiThread { loading.visibility = View.GONE }
            }
        }
    }

    private fun copy(label: String, value: String) {
        if (value.isEmpty() || value == "—") return
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, value))
        Toast.makeText(this, "$label copied", Toast.LENGTH_SHORT).show()
    }

    private fun renderPrivacyState() {
        val success = ContextCompat.getColor(this, R.color.ghola_success)
        val muted = ContextCompat.getColor(this, R.color.ghola_text_tertiary)
        val secondary = ContextCompat.getColor(this, R.color.ghola_text_secondary)

        if (privateIdentityKnown) {
            identityModeIcon.imageTintList = ColorStateList.valueOf(success)
            identityModeView.setTextColor(success)
            identityModeView.text = "Private"
            identityModeDetailView.text = "Wallet-derived key"
            privateConfigStateView.text = if (privateConfigSynced) {
                "Encrypted config synced"
            } else {
                "Encrypted config pending"
            }
            privateConfigStateView.setTextColor(secondary)
        } else {
            identityModeIcon.imageTintList = ColorStateList.valueOf(muted)
            identityModeView.setTextColor(secondary)
            identityModeView.text = "Active"
            identityModeDetailView.text = "Server-issued identity"
            privateConfigStateView.text = "No private config attached"
            privateConfigStateView.setTextColor(muted)
        }
    }

    private fun formatUsdc(microUsdc: Long): String {
        val usdc = microUsdc / 1_000_000.0
        return if (usdc < 0.01 && usdc > 0) {
            String.format("$%.4f", usdc)
        } else {
            String.format("$%.2f", usdc)
        }
    }
}
