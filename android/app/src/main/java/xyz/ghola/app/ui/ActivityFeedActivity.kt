package xyz.ghola.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.bottomnavigation.BottomNavigationView
import org.json.JSONObject
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
        // Demo-first: show the seeded activity feed immediately. The backend
        // might eventually come back with real rows, but we never want the
        // presenter staring at an empty state on stage.
        showSeedFeed()
    }

    private fun showSeedFeed() {
        val seed = DemoSeed.activity()
        val items = mutableListOf<FeedItem>()
        val timeFmt = java.text.SimpleDateFormat("HH:mm", java.util.Locale.US)
        for (i in 0 until seed.length()) {
            val row = seed.getJSONObject(i)
            val time = timeFmt.format(java.util.Date(row.optLong("timestamp_ms")))
            val detail = row.optString("detail", "")
            items.add(
                FeedItem(
                    agentName = row.optString("agent_name", "Agent"),
                    action = row.optString("action", ""),
                    amountMicroUsdc = row.optLong("amount_micro_usdc", 0L),
                    tone = row.optString("tone", "neutral"),
                    subtext = "$time · $detail",
                )
            )
        }
        loading.visibility = View.GONE
        adapter?.setItems(items)
        emptyState.visibility = View.GONE
        recycler.visibility = View.VISIBLE
    }

    data class FeedItem(
        val agentName: String,
        val action: String,
        val amountMicroUsdc: Long,
        val tone: String,
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
            holder.title.text = "${item.agentName} · ${item.action}"
            holder.slug.text = item.subtext

            // Right-aligned realized P&L, coloured by tone. Hidden when the
            // event has no settlement (armed / filled / skipped / expired).
            if (item.amountMicroUsdc != 0L) {
                val usdc = item.amountMicroUsdc / 1_000_000.0
                val sign = if (usdc >= 0) "+" else "−"
                holder.status.text = String.format("%s$%.2f", sign, kotlin.math.abs(usdc))
                val colorRes = when (item.tone) {
                    "gain" -> R.color.ghola_success
                    "loss" -> R.color.ghola_error
                    else -> R.color.ghola_text_secondary
                }
                holder.status.setTextColor(ContextCompat.getColor(holder.itemView.context, colorRes))
                holder.status.visibility = View.VISIBLE
            } else {
                holder.status.visibility = View.GONE
            }

            holder.bio.visibility = View.GONE
            holder.did.visibility = View.GONE
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
