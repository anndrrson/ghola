package xyz.ghola.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.bottomnavigation.BottomNavigationView
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.cloud.SaidCloudClient
import xyz.ghola.app.demo.DemoSeed
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
        loading.visibility = View.VISIBLE
        emptyState.visibility = View.GONE
        recycler.visibility = View.GONE

        if (!storage.hasSaidAuth()) {
            if (BuildConfig.ENABLE_DEMO_MODE) showSeedFeed() else showEmptyState()
            return
        }

        executor.execute {
            val items = buildLiveFeed()
            runOnUiThread {
                if (items.isNotEmpty()) {
                    showFeed(items)
                } else if (BuildConfig.ENABLE_DEMO_MODE) {
                    showSeedFeed()
                } else {
                    showEmptyState()
                }
            }
        }
    }

    private fun showSeedFeed() {
        val seed = DemoSeed.activity()
        val items = mutableListOf<FeedItem>()
        val timeFmt = java.text.SimpleDateFormat("HH:mm", java.util.Locale.US)
        for (i in 0 until seed.length()) {
            val row = seed.getJSONObject(i)
            val verb = when (row.optString("kind")) {
                "paid_by" -> "earned"
                "paid" -> "spent"
                else -> "—"
            }
            val time = timeFmt.format(java.util.Date(row.optLong("timestamp_ms")))
            val note = row.optString("note", "")
            items.add(
                FeedItem(
                    agentName = row.optString("agent_name", "Agent"),
                    verb = verb,
                    amountMicroUsdc = row.optLong("amount_micro_usdc", 0L),
                    subtext = "$time · $note",
                )
            )
        }
        showFeed(items)
    }

    private fun buildLiveFeed(): List<FeedItem> {
        return try {
            val client = SaidCloudClient(storage.getSaidBaseUrl(), storage.getSaidToken())
            val agents = client.listAgents() ?: return emptyList()
            val items = mutableListOf<FeedItem>()
            for (i in 0 until agents.length()) {
                val agent = agents.getJSONObject(i)
                val agentId = agent.optString("id", "")
                if (agentId.isEmpty()) continue
                val agentName = agent.optString("display_name", "Agent")
                val earnings = client.getAgentEarnings(agentId) ?: continue
                val received = earnings.optLong("total_received_micro_usdc", 0L)
                val spent = earnings.optLong("total_spent_micro_usdc", 0L)
                val net = earnings.optLong("net_micro_usdc", 0L)

                if (received > 0) {
                    items.add(
                        FeedItem(
                            agentName = agentName,
                            verb = "earned",
                            amountMicroUsdc = received,
                            subtext = "lifetime received"
                        )
                    )
                }
                if (spent > 0) {
                    items.add(
                        FeedItem(
                            agentName = agentName,
                            verb = "spent",
                            amountMicroUsdc = spent,
                            subtext = "lifetime spent"
                        )
                    )
                }
                if (received == 0L && spent == 0L && net > 0L) {
                    items.add(
                        FeedItem(
                            agentName = agentName,
                            verb = "holds",
                            amountMicroUsdc = net,
                            subtext = "current net"
                        )
                    )
                }
            }
            items.sortedByDescending { it.amountMicroUsdc }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun showFeed(items: List<FeedItem>) {
        loading.visibility = View.GONE
        adapter?.setItems(items)
        emptyState.visibility = View.GONE
        recycler.visibility = View.VISIBLE
    }

    private fun showEmptyState() {
        loading.visibility = View.GONE
        adapter?.setItems(emptyList())
        recycler.visibility = View.GONE
        emptyState.visibility = View.VISIBLE
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
