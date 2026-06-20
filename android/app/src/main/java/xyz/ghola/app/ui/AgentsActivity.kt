package xyz.ghola.app.ui

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.bottomnavigation.BottomNavigationView
import org.json.JSONObject
import xyz.ghola.app.R
import xyz.ghola.app.market.TradingSessionStore

/**
 * Agents tab — trading-first.
 *
 * In the trading repositioning, "an agent" is an armed trading session, not a
 * named DID identity. This screen lists the user's active sessions (one per
 * market, from [TradingSessionStore]) and routes creation to the real flow:
 * Markets → Set limits → Arm. The old name/slug/bio creation form
 * ([CreateAgentActivity]) and said-cloud DID agents are no longer surfaced here.
 */
class AgentsActivity : AppCompatActivity() {

    private lateinit var sessionStore: TradingSessionStore
    private lateinit var recycler: RecyclerView
    private lateinit var emptyState: View
    private var adapter: TradingAgentAdapter? = null

    /** Markets the trading flow supports; mirrors MarketChartActivity. */
    private val products = listOf("BTC-USD", "ETH-USD", "SOL-USD")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_agents)

        sessionStore = TradingSessionStore(this)

        recycler = findViewById(R.id.agentsRecycler)
        emptyState = findViewById(R.id.emptyState)

        recycler.layoutManager = LinearLayoutManager(this)
        adapter = TradingAgentAdapter(emptyList()) { row -> openMarket(row.productId, arm = true) }
        recycler.adapter = adapter

        // Both "+ New" and the empty-state CTA go to the real creation flow:
        // View markets → Set limits → Arm.
        val openMarkets = View.OnClickListener { openMarket(productId = null, arm = false) }
        findViewById<View>(R.id.createAgentFab).setOnClickListener(openMarkets)
        findViewById<View>(R.id.createInlineButton).setOnClickListener(openMarkets)

        val bottomNav = findViewById<BottomNavigationView>(R.id.bottomNav)
        BottomNavHelper.attach(this, R.id.tab_agents, bottomNav)
    }

    override fun onResume() {
        super.onResume()
        loadSessions()
    }

    private fun loadSessions() {
        val rows = products.mapNotNull { p ->
            sessionStore.activeSession(p)?.let { AgentRow(p, it) }
        }
        adapter?.setItems(rows)
        emptyState.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        recycler.visibility = if (rows.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun openMarket(productId: String?, arm: Boolean) {
        val intent = Intent(this, MarketChartActivity::class.java)
        if (productId != null) intent.putExtra(MarketChartActivity.EXTRA_PRODUCT_ID, productId)
        if (arm) intent.putExtra(MarketChartActivity.EXTRA_ACTION, "arm")
        startActivity(intent)
    }

    data class AgentRow(val productId: String, val session: JSONObject)

    private class TradingAgentAdapter(
        private var items: List<AgentRow>,
        private val onClick: (AgentRow) -> Unit,
    ) : RecyclerView.Adapter<TradingAgentAdapter.VH>() {

        fun setItems(newItems: List<AgentRow>) {
            items = newItems
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val view = LayoutInflater.from(parent.context)
                .inflate(R.layout.item_agent_card, parent, false)
            return VH(view)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val row = items[position]
            val ctx = holder.itemView.context
            val policy = row.session.optJSONObject("session_policy")

            holder.title.text = "${marketLabel(row.productId)} agent"

            val (statusLabel, statusColor) = statusDisplay(row.session.optString("status"))
            holder.status.text = statusLabel
            holder.status.setTextColor(ContextCompat.getColor(ctx, statusColor))
            holder.status.visibility = View.VISIBLE

            val maxOrder = policy?.optString("max_notional_bucket", "--") ?: "--"
            val maxDaily = policy?.optString("max_daily_notional_bucket", "--") ?: "--"
            val maxOrders = policy?.optInt("max_order_count", 0) ?: 0
            holder.slug.text = "$$maxOrder/order · $$maxDaily/day · $maxOrders orders"

            holder.bio.visibility = View.GONE
            holder.did.visibility = View.GONE
            holder.itemView.setOnClickListener { onClick(row) }
        }

        override fun getItemCount(): Int = items.size

        private fun marketLabel(productId: String): String = when (productId.uppercase()) {
            "ETH-USD" -> "ETH"
            "SOL-USD" -> "SOL"
            else -> "BTC"
        }

        /** Maps a session status to a short badge + colour token. */
        private fun statusDisplay(status: String): Pair<String, Int> = when (status) {
            "watching", "running", "pending_worker", "pending_funding" ->
                "ARMED" to R.color.ghola_success
            "paused" -> "PAUSED" to R.color.ghola_warning
            else -> (status.takeIf { it.isNotBlank() }?.uppercase() ?: "ACTIVE") to R.color.ghola_text_secondary
        }

        class VH(itemView: View) : RecyclerView.ViewHolder(itemView) {
            val title: TextView = itemView.findViewById(R.id.cardDisplayName)
            val slug: TextView = itemView.findViewById(R.id.cardSlug)
            val bio: TextView = itemView.findViewById(R.id.cardBio)
            val did: TextView = itemView.findViewById(R.id.cardDid)
            val status: TextView = itemView.findViewById(R.id.cardStatus)
        }
    }
}
