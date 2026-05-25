package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import org.json.JSONObject
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.CloudAuthManager
import xyz.ghola.app.cloud.SaidCloudClient
import java.util.concurrent.Executors

/**
 * Top-level screen for the user's owned AI agents (Phase M5).
 *
 * Lists every agent owned by the authenticated user. Each row is a JSONObject
 * straight from said-cloud's GET /v1/agents response — no DTO mapping. Tap
 * to drill into [AgentDetailActivity], or tap the FAB to create a new one
 * via [CreateAgentActivity].
 */
class AgentsActivity : AppCompatActivity() {

    private lateinit var storage: SecureStorage
    private lateinit var recycler: RecyclerView
    private lateinit var emptyState: View
    private lateinit var createButton: MaterialButton
    private lateinit var inlineNewButton: TextView
    private val executor = Executors.newSingleThreadExecutor()
    private var adapter: AgentAdapter? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_agents)

        storage = SecureStorage(this)

        recycler = findViewById(R.id.agentsRecycler)
        emptyState = findViewById(R.id.emptyState)
        createButton = findViewById(R.id.createAgentFab)
        inlineNewButton = findViewById(R.id.createInlineButton)

        recycler.layoutManager = LinearLayoutManager(this)
        adapter = AgentAdapter(emptyList()) { agent ->
            val intent = Intent(this, AgentDetailActivity::class.java)
            intent.putExtra(AgentDetailActivity.EXTRA_AGENT_ID, agent.optString("id"))
            intent.putExtra(AgentDetailActivity.EXTRA_AGENT_JSON, agent.toString())
            startActivity(intent)
        }
        recycler.adapter = adapter

        val openCreate = View.OnClickListener {
            startActivity(Intent(this, CreateAgentActivity::class.java))
        }
        createButton.setOnClickListener(openCreate)
        inlineNewButton.setOnClickListener(openCreate)

        // Phase M6: Bottom navigation
        val bottomNav = findViewById<com.google.android.material.bottomnavigation.BottomNavigationView>(R.id.bottomNav)
        BottomNavHelper.attach(this, R.id.tab_agents, bottomNav)
    }

    override fun onResume() {
        super.onResume()
        loadAgents()
    }

    private fun loadAgents() {
        if (!storage.hasSaidAuth()) {
            if (storage.hasSaidRefreshToken()) {
                executor.execute {
                    val refreshed = CloudAuthManager(this).refreshSaidToken()
                    runOnUiThread {
                        if (refreshed) loadAgents() else showEmpty()
                    }
                }
                return
            }
            showEmpty()
            return
        }

        executor.execute {
            try {
                val authManager = CloudAuthManager(this)
                val client = SaidCloudClient.withRefresh(
                    baseUrl = storage.getSaidBaseUrl(),
                    tokenProvider = { storage.getSaidToken() },
                    tokenRefresher = { authManager.refreshSaidToken() },
                    onAuthExhausted = { storage.clearSaidAuth() },
                )
                val rows = client.listAgents()
                val list = mutableListOf<JSONObject>()
                if (rows != null) {
                    for (i in 0 until rows.length()) {
                        list.add(rows.getJSONObject(i))
                    }
                }
                runOnUiThread {
                    adapter?.setAgents(list)
                    emptyState.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
                    recycler.visibility = if (list.isEmpty()) View.GONE else View.VISIBLE
                }
            } catch (_: Exception) {
                runOnUiThread { showEmpty() }
            }
        }
    }

    private fun showEmpty() {
            adapter?.setAgents(emptyList())
            emptyState.visibility = View.VISIBLE
            recycler.visibility = View.GONE
    }
}
