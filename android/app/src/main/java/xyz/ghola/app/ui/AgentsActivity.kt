package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.floatingactionbutton.ExtendedFloatingActionButton
import org.json.JSONObject
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
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
    private lateinit var fab: ExtendedFloatingActionButton
    private val executor = Executors.newSingleThreadExecutor()
    private var adapter: AgentAdapter? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_agents)

        storage = SecureStorage(this)

        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)

        recycler = findViewById(R.id.agentsRecycler)
        emptyState = findViewById(R.id.emptyState)
        fab = findViewById(R.id.createAgentFab)

        recycler.layoutManager = LinearLayoutManager(this)
        adapter = AgentAdapter(emptyList()) { agent ->
            val intent = Intent(this, AgentDetailActivity::class.java)
            intent.putExtra(AgentDetailActivity.EXTRA_AGENT_ID, agent.optString("id"))
            intent.putExtra(AgentDetailActivity.EXTRA_AGENT_JSON, agent.toString())
            startActivity(intent)
        }
        recycler.adapter = adapter

        fab.setOnClickListener {
            startActivity(Intent(this, CreateAgentActivity::class.java))
        }

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
            // Not signed in to said-cloud yet — show empty state with explanation.
            // Onboarding handles the actual sign-in.
            adapter?.setAgents(emptyList())
            emptyState.visibility = View.VISIBLE
            recycler.visibility = View.GONE
            return
        }

        executor.execute {
            val client = SaidCloudClient(storage.getSaidBaseUrl(), storage.getSaidToken())
            val rows = client.listAgents()
            runOnUiThread {
                if (rows == null) {
                    // Network error — keep showing whatever was already there.
                    return@runOnUiThread
                }
                val list = mutableListOf<JSONObject>()
                for (i in 0 until rows.length()) {
                    list.add(rows.getJSONObject(i))
                }
                adapter?.setAgents(list)
                if (list.isEmpty()) {
                    emptyState.visibility = View.VISIBLE
                    recycler.visibility = View.GONE
                } else {
                    emptyState.visibility = View.GONE
                    recycler.visibility = View.VISIBLE
                }
            }
        }
    }
}
