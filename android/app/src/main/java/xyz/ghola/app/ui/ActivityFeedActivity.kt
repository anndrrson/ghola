package xyz.ghola.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.bottomnavigation.BottomNavigationView
import org.json.JSONObject
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.SaidCloudClient
import java.util.concurrent.Executors

/**
 * Phase M6 — Activity tab. Chronological feed of recent agent activity.
 *
 * For every agent owned by the signed-in user, this polls
 * /v1/agents/{id}/earnings and creates one synthetic feed row per
 * non-zero balance change. This is the "wake up and see your agent
 * earned $0.42" loop at its simplest form.
 *
 * Phase M8 will add real FCM push so this updates live instead of
 * only on screen-open. For now, pull-on-resume is fine.
 */
class ActivityFeedActivity : AppCompatActivity() {

    private lateinit var storage: SecureStorage
    private lateinit var recycler: RecyclerView
    private lateinit var emptyState: View
    private lateinit var loading: ProgressBar
    private val executor = Executors.newSingleThreadExecutor()
    private var adapter: FeedAdapter? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_activity_feed)

        storage = SecureStorage(this)

        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)

        recycler = findViewById(R.id.activityRecycler)
        emptyState = findViewById(R.id.activityEmptyState)
        loading = findViewById(R.id.activityLoading)

        recycler.layoutManager = LinearLayoutManager(this)
        adapter = FeedAdapter(emptyList())
        recycler.adapter = adapter

        val bottomNav = findViewById<BottomNavigationView>(R.id.bottomNav)
        BottomNavHelper.attach(this, R.id.tab_activity, bottomNav)
    }

    override fun onResume() {
        super.onResume()
        loadFeed()
    }

    private fun loadFeed() {
        if (!storage.hasSaidAuth()) {
            adapter?.setItems(emptyList())
            emptyState.visibility = View.VISIBLE
            recycler.visibility = View.GONE
            return
        }

        loading.visibility = View.VISIBLE
        executor.execute {
            val client = SaidCloudClient(storage.getSaidBaseUrl(), storage.getSaidToken())
            val agents = client.listAgents()
            val items = mutableListOf<FeedItem>()

            if (agents != null) {
                for (i in 0 until agents.length()) {
                    val agent = agents.getJSONObject(i)
                    val agentId = agent.optString("id")
                    val displayName = agent.optString("display_name", "Agent")
                    val earnings = client.getAgentEarnings(agentId)
                    if (earnings != null) {
                        val received = earnings.optLong("total_received_micro_usdc", 0)
                        val spent = earnings.optLong("total_spent_micro_usdc", 0)
                        val txCount = earnings.optLong("transaction_count", 0)
                        if (received > 0) {
                            items.add(FeedItem(displayName, "earned", received, "$txCount transactions"))
                        }
                        if (spent > 0) {
                            items.add(FeedItem(displayName, "spent", spent, "lifetime"))
                        }
                    }
                }
            }

            runOnUiThread {
                loading.visibility = View.GONE
                adapter?.setItems(items)
                if (items.isEmpty()) {
                    emptyState.visibility = View.VISIBLE
                    recycler.visibility = View.GONE
                } else {
                    emptyState.visibility = View.GONE
                    recycler.visibility = View.VISIBLE
                }
            }
        }
    }

    data class FeedItem(
        val agentName: String,
        val verb: String,
        val amountMicroUsdc: Long,
        val subtext: String
    )

    private class FeedAdapter(
        private var items: List<FeedItem>
    ) : RecyclerView.Adapter<FeedAdapter.VH>() {

        fun setItems(newItems: List<FeedItem>) {
            items = newItems
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val view = LayoutInflater.from(parent.context)
                .inflate(R.layout.item_agent_card, parent, false)
            return VH(view)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val item = items[position]
            val usdc = item.amountMicroUsdc / 1_000_000.0
            val amount = if (usdc < 0.01) String.format("$%.4f", usdc) else String.format("$%.2f", usdc)
            holder.title.text = "${item.agentName} ${item.verb} $amount"
            holder.slug.text = item.subtext
            holder.bio.visibility = View.GONE
            holder.did.visibility = View.GONE
            holder.status.visibility = View.GONE
        }

        override fun getItemCount(): Int = items.size

        class VH(itemView: View) : RecyclerView.ViewHolder(itemView) {
            val title: TextView = itemView.findViewById(R.id.cardDisplayName)
            val slug: TextView = itemView.findViewById(R.id.cardSlug)
            val bio: TextView = itemView.findViewById(R.id.cardBio)
            val did: TextView = itemView.findViewById(R.id.cardDid)
            val status: TextView = itemView.findViewById(R.id.cardStatus)
        }
    }
}
