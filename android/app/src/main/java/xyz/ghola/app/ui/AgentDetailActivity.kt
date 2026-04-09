package xyz.ghola.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import org.json.JSONObject
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.SaidCloudClient
import java.util.concurrent.Executors

/**
 * Drill-down detail screen for a single owned agent (Phase M5).
 *
 * Displays the agent's cryptographic identity (DID + Solana address) and four
 * stat tiles (balance, services, reputation, earnings). The DID and address
 * are tap-to-copy. Data is loaded from /v1/agents/{id}, /v1/agents/{id}/earnings,
 * and /v1/agents/{id}/reputation in parallel.
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
    private lateinit var didView: TextView
    private lateinit var solanaAddressView: TextView
    private lateinit var balanceView: TextView
    private lateinit var serviceCountView: TextView
    private lateinit var reputationView: TextView
    private lateinit var earnedView: TextView
    private lateinit var loading: ProgressBar

    private var agentId: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_agent_detail)

        storage = SecureStorage(this)

        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)
        toolbar.setNavigationOnClickListener { finish() }

        displayNameView = findViewById(R.id.displayName)
        slugView = findViewById(R.id.slug)
        bioView = findViewById(R.id.bio)
        didView = findViewById(R.id.did)
        solanaAddressView = findViewById(R.id.solanaAddress)
        balanceView = findViewById(R.id.balance)
        serviceCountView = findViewById(R.id.serviceCount)
        reputationView = findViewById(R.id.reputation)
        earnedView = findViewById(R.id.earned)
        loading = findViewById(R.id.loading)

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
        displayNameView.text = agent.optString("display_name", "Agent")
        slugView.text = "@${agent.optString("slug", "")}"
        val bio = agent.optString("bio", "")
        if (bio.isNotEmpty() && bio != "null") {
            bioView.text = bio
            bioView.visibility = View.VISIBLE
        }
        didView.text = agent.optString("did", "—")
        solanaAddressView.text = agent.optString("solana_address", "—")

        // Tap-to-copy
        didView.setOnClickListener { copy("DID", agent.optString("did", "")) }
        solanaAddressView.setOnClickListener { copy("Address", agent.optString("solana_address", "")) }

        val serviceCount = agent.optInt("service_count", -1)
        if (serviceCount >= 0) serviceCountView.text = serviceCount.toString()

        val rep = agent.optDouble("reputation_score", -1.0)
        if (rep >= 0.0) reputationView.text = String.format("%.2f", rep)
    }

    private fun loadFresh() {
        if (!storage.hasSaidAuth()) return
        loading.visibility = View.VISIBLE

        executor.execute {
            val client = SaidCloudClient(storage.getSaidBaseUrl(), storage.getSaidToken())
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
        }
    }

    private fun copy(label: String, value: String) {
        if (value.isEmpty()) return
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, value))
        Toast.makeText(this, "$label copied", Toast.LENGTH_SHORT).show()
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
