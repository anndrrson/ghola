package xyz.ghola.app.ui

import android.content.res.ColorStateList
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.google.android.material.button.MaterialButtonToggleGroup
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import okhttp3.sse.EventSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.market.AgentContextKind
import xyz.ghola.app.market.MarketDataClient
import xyz.ghola.app.market.MarketSnapshot
import xyz.ghola.app.market.MarketStreamStatus
import xyz.ghola.app.market.TradingSessionStore
import java.util.Locale

class MarketChartActivity : AppCompatActivity(), TradeSenderHost {

    companion object {
        const val EXTRA_PRODUCT_ID = "product_id"
        const val EXTRA_ACTION = "market_action"
    }

    // Registered before STARTED so the arming sheet can drive the MWA wallet
    // round-trip without owning its own activity-result launcher.
    override val tradeResultSender = ActivityResultSender(this)

    private lateinit var marketDataClient: MarketDataClient
    private lateinit var chartView: MarketChartView
    private lateinit var marketTitle: TextView
    private lateinit var priceText: TextView
    private lateinit var changeText: TextView
    private lateinit var bookText: TextView
    private lateinit var spreadText: TextView
    private lateinit var liveStatusText: TextView
    private lateinit var phoenixText: TextView
    private lateinit var jupiterText: TextView
    private lateinit var dexPanel: View
    private lateinit var refreshButton: ImageButton
    private lateinit var productToggle: MaterialButtonToggleGroup
    private lateinit var timeframeToggle: MaterialButtonToggleGroup

    private var productId: String = "BTC-USD"
    private var interval: String = "5m"
    private var currentSnapshot: MarketSnapshot? = null
    private var eventSource: EventSource? = null
    private var loadSequence = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_market_chart)

        productId = normalizeProduct(intent.getStringExtra(EXTRA_PRODUCT_ID))
        marketDataClient = MarketDataClient(cloudBaseUrl = SecureStorage(this).getCloudBaseUrl())
        chartView = findViewById(R.id.chartView)
        marketTitle = findViewById(R.id.marketTitle)
        priceText = findViewById(R.id.priceText)
        changeText = findViewById(R.id.changeText)
        bookText = findViewById(R.id.bookText)
        spreadText = findViewById(R.id.spreadText)
        liveStatusText = findViewById(R.id.liveStatusText)
        phoenixText = findViewById(R.id.phoenixText)
        jupiterText = findViewById(R.id.jupiterText)
        dexPanel = findViewById(R.id.dexPanel)
        refreshButton = findViewById(R.id.refreshButton)
        productToggle = findViewById(R.id.productToggle)
        timeframeToggle = findViewById(R.id.timeframeToggle)

        findViewById<View>(R.id.backButton).setOnClickListener { finish() }
        refreshButton.setOnClickListener { restartFeed() }
        findViewById<View>(R.id.askAgentButton).setOnClickListener {
            openAgent(AgentContextKind.MarketBrief)
        }
        findViewById<View>(R.id.tradePlanButton).setOnClickListener {
            openTradingSession()
        }

        productToggle.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            val nextProduct = when (checkedId) {
                R.id.productEth -> "ETH-USD"
                R.id.productSol -> "SOL-USD"
                else -> "BTC-USD"
            }
            if (nextProduct != productId) {
                productId = nextProduct
                restartFeed()
            }
            renderToggleStates()
        }
        timeframeToggle.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            val nextInterval = when (checkedId) {
                R.id.timeframe1m -> "1m"
                R.id.timeframe15m -> "15m"
                R.id.timeframe1h -> "1h"
                else -> "5m"
            }
            if (nextInterval != interval) {
                interval = nextInterval
                restartFeed()
            }
            renderToggleStates()
        }
        productToggle.check(
            when (productId) {
                "ETH-USD" -> R.id.productEth
                "SOL-USD" -> R.id.productSol
                else -> R.id.productBtc
            },
        )
        renderToggleStates()

        BottomNavHelper.attach(this, R.id.tab_markets, findViewById<BottomNavigationView>(R.id.bottomNav))

        // Opened from the Agents tab tapping an armed agent → jump straight to its
        // live session controls (the Arm sheet renders the active session).
        if (intent.getStringExtra(EXTRA_ACTION) == "arm") {
            productToggle.post { openTradingSession() }
        }

        renderLoading()
        restartFeed()
    }

    override fun onStart() {
        super.onStart()
        if (this::marketDataClient.isInitialized && eventSource == null && currentSnapshot != null) {
            restartFeed()
        }
    }

    override fun onStop() {
        loadSequence++
        eventSource?.cancel()
        eventSource = null
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        renderActiveAgents()
    }

    private fun restartFeed() {
        val seq = ++loadSequence
        eventSource?.cancel()
        eventSource = null
        renderLoading()
        val stream = marketDataClient.openStream(
            productId = productId,
            interval = interval,
            listener = object : MarketDataClient.MarketStreamListener {
                override fun onSnapshot(snapshot: MarketSnapshot) {
                    runOnUiThread {
                        if (seq != loadSequence) return@runOnUiThread
                        currentSnapshot = snapshot
                        renderSnapshot(snapshot)
                    }
                }

                override fun onStatus(status: MarketStreamStatus) {
                    runOnUiThread {
                        if (seq != loadSequence) return@runOnUiThread
                        renderStreamStatus(status)
                    }
                }

                override fun onFailure(message: String) {
                    runOnUiThread {
                        if (seq != loadSequence) return@runOnUiThread
                        eventSource?.cancel()
                        eventSource = null
                        liveStatusText.text = "› STREAM FALLBACK / $message"
                        liveStatusText.setTextColor(Color.rgb(255, 191, 95))
                        loadSnapshot(seq)
                    }
                }
            },
        )
        if (stream == null) {
            loadSnapshot(seq)
        } else {
            eventSource = stream
        }
    }

    private fun loadSnapshot(seq: Int = ++loadSequence) {
        lifecycleScope.launch {
            val snapshot = withContext(Dispatchers.IO) {
                marketDataClient.getSnapshot(productId = productId, interval = interval)
            }
            if (seq != loadSequence) return@launch
            currentSnapshot = snapshot
            renderSnapshot(snapshot)
        }
    }

    private fun renderLoading() {
        marketTitle.text = displayContract(productId)
        priceText.text = "\$--"
        changeText.text = "--"
        changeText.setTextColor(Color.rgb(139, 149, 168))
        liveStatusText.text = "› CONNECTING / ${interval.uppercase(Locale.US)}"
        liveStatusText.setTextColor(Color.rgb(139, 149, 168))
        bookText.text = "bid -- / ask --"
        spreadText.text = "-- bps"
        dexPanel.visibility = View.GONE
        chartView.setLoading("Loading $productId")
    }

    private fun renderSnapshot(snapshot: MarketSnapshot) {
        marketTitle.text = displayContract(snapshot.productId)
        priceText.text = snapshot.price?.let { "\$${it.formatPrice()}" } ?: "\$--"
        val change = snapshot.change24h
        changeText.text = change?.let {
            val prefix = if (it >= 0.0) "+" else ""
            "$prefix${it.formatPercent()}%"
        } ?: "--"
        changeText.setTextColor(
            when {
                change == null -> Color.rgb(139, 149, 168)
                change >= 0.0 -> Color.rgb(49, 211, 145)
                else -> Color.rgb(255, 90, 100)
            },
        )
        bookText.text = "bid ${snapshot.bestBid?.formatPrice() ?: "--"} / ask ${snapshot.bestAsk?.formatPrice() ?: "--"}"
        spreadText.text = "${snapshot.spreadBps?.formatBps() ?: "--"} bps"
        chartView.setSnapshot(snapshot)
        renderSnapshotStatus(snapshot)
        renderDexPanel(snapshot)
        if (snapshot.stale && snapshot.error != null) {
            Toast.makeText(this, snapshot.error, Toast.LENGTH_SHORT).show()
        }
    }

    private fun renderSnapshotStatus(snapshot: MarketSnapshot) {
        val warnings = snapshot.warnings.joinToString(",").takeIf { it.isNotBlank() }
        liveStatusText.text = "› ${snapshot.liveStatus.uppercase(Locale.US)} / ${snapshot.interval.uppercase(Locale.US)}" +
            (warnings?.let { " / $it" } ?: "")
        liveStatusText.setTextColor(
            when (snapshot.liveStatus) {
                "live" -> Color.rgb(49, 211, 145)
                "degraded", "fallback" -> Color.rgb(255, 191, 95)
                else -> Color.rgb(255, 90, 100)
            },
        )
    }

    private fun renderStreamStatus(status: MarketStreamStatus) {
        liveStatusText.text = "› ${status.liveStatus.uppercase(Locale.US)} / ${interval.uppercase(Locale.US)}" +
            (status.error?.let { " / $it" } ?: "")
        liveStatusText.setTextColor(
            when (status.liveStatus) {
                "live" -> Color.rgb(49, 211, 145)
                "connecting" -> Color.rgb(139, 149, 168)
                else -> Color.rgb(255, 191, 95)
            },
        )
    }

    private fun renderDexPanel(snapshot: MarketSnapshot) {
        val dex = snapshot.solanaDex
        if (dex == null) {
            dexPanel.visibility = View.GONE
            return
        }
        dexPanel.visibility = View.VISIBLE
        val phoenix = dex.phoenix
        phoenixText.text = if (phoenix == null) {
            "phoenix limited"
        } else {
            "phoenix bid ${phoenix.bestBid?.formatPrice() ?: "--"} / ask ${phoenix.bestAsk?.formatPrice() ?: "--"} / " +
                "fund ${phoenix.fundingRate?.formatPercent() ?: "--"}% / oi ${phoenix.openInterest?.compact() ?: "--"}"
        }
        val jupiter = dex.jupiter
        jupiterText.text = if (jupiter == null) {
            "jupiter limited"
        } else {
            "jupiter SOL/USDC ${jupiter.price?.formatPrice() ?: "--"} / impact ${jupiter.priceImpactPct?.formatPercent() ?: "--"}% / " +
                jupiter.routeSummary.joinToString(" > ").ifBlank { "route unknown" }
        }
    }

    private fun renderToggleStates() {
        paintSegment(R.id.productBtc, productId == "BTC-USD")
        paintSegment(R.id.productEth, productId == "ETH-USD")
        paintSegment(R.id.productSol, productId == "SOL-USD")
        paintSegment(R.id.timeframe1m, interval == "1m")
        paintSegment(R.id.timeframe5m, interval == "5m")
        paintSegment(R.id.timeframe15m, interval == "15m")
        paintSegment(R.id.timeframe1h, interval == "1h")
    }

    private fun paintSegment(buttonId: Int, selected: Boolean) {
        val button = findViewById<MaterialButton>(buttonId)
        button.backgroundTintList = ColorStateList.valueOf(
            if (selected) Color.rgb(61, 168, 255) else Color.rgb(0, 0, 0),
        )
        button.strokeColor = ColorStateList.valueOf(Color.rgb(30, 42, 58))
        button.setTextColor(if (selected) Color.rgb(5, 19, 29) else Color.rgb(139, 149, 168))
    }

    private fun openAgent(kind: AgentContextKind) {
        val snapshot = currentSnapshot
        if (snapshot == null || snapshot.candles.isEmpty()) {
            Toast.makeText(this, "Load market data first", Toast.LENGTH_SHORT).show()
            return
        }
        val quickAction = when (kind) {
            AgentContextKind.MarketBrief -> "markets"
            AgentContextKind.TradePlan -> "trade"
        }
        val intent = Intent(this, ChatActivity::class.java).apply {
            putExtra("prefill_message", snapshot.toAgentContext(kind))
            putExtra("quick_action", quickAction)
        }
        startActivity(intent)
    }

    private fun openTradingSession() {
        // Rise the arming flow as a sheet over the chart instead of swapping to
        // a full page — set limits, arm, and watch the session in one surface.
        AgentTradingSheet.newInstance(productId)
            .show(supportFragmentManager, AgentTradingSheet.TAG)
    }

    /**
     * Lists the user's armed agents (one per market) on the Trade surface. The
     * Agents tab was merged here, so this is now the single place to see and
     * manage running sessions. Tapping a row reopens that agent's live sheet.
     */
    private fun renderActiveAgents() {
        val label = findViewById<TextView>(R.id.activeAgentsLabel)
        val list = findViewById<LinearLayout>(R.id.activeAgentsList)
        val store = TradingSessionStore(this)
        val active = listOf("BTC-USD", "ETH-USD", "SOL-USD")
            .mapNotNull { p -> store.activeSession(p)?.let { p to it } }

        list.removeAllViews()
        if (active.isEmpty()) {
            label.visibility = View.GONE
            list.visibility = View.GONE
            return
        }
        label.visibility = View.VISIBLE
        list.visibility = View.VISIBLE

        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        for ((product, session) in active) {
            val policy = session.optJSONObject("session_policy")
            val maxOrder = policy?.optString("max_notional_bucket", "--") ?: "--"
            val maxDaily = policy?.optString("max_daily_notional_bucket", "--") ?: "--"
            val (statusLabel, statusColor) = agentStatusDisplay(session.optString("status"))

            val card = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                background = ContextCompat.getDrawable(this@MarketChartActivity, R.drawable.bubble_assistant)
                setPadding(dp(14), dp(12), dp(14), dp(12))
                isClickable = true
                isFocusable = true
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = dp(8) }
                setOnClickListener {
                    AgentTradingSheet.newInstance(product)
                        .show(supportFragmentManager, AgentTradingSheet.TAG)
                }
            }
            val texts = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            texts.addView(TextView(this).apply {
                text = "${displayContract(product)} agent"
                setTextColor(Color.parseColor("#eef1f8"))
                textSize = 15f
                typeface = resources.getFont(R.font.geist)
            })
            texts.addView(TextView(this).apply {
                text = "\$$maxOrder/order · \$$maxDaily/day"
                setTextColor(Color.parseColor("#8b95a8"))
                textSize = 12f
                typeface = resources.getFont(R.font.geist_mono)
                setPadding(0, dp(3), 0, 0)
            })
            card.addView(texts)
            card.addView(TextView(this).apply {
                text = statusLabel
                setTextColor(statusColor)
                textSize = 12f
                typeface = resources.getFont(R.font.geist_mono)
            })
            list.addView(card)
        }
    }

    private fun agentStatusDisplay(status: String): Pair<String, Int> = when (status) {
        "watching", "running", "pending_worker", "pending_funding" ->
            "ARMED" to Color.parseColor("#34d399")
        "paused" -> "PAUSED" to Color.parseColor("#fbbf24")
        else -> (status.takeIf { it.isNotBlank() }?.uppercase(Locale.US) ?: "ACTIVE") to Color.parseColor("#8b95a8")
    }

    private fun normalizeProduct(raw: String?): String {
        val value = raw.orEmpty().trim().uppercase(Locale.US)
        val product = if (value.contains("-")) value else "$value-USD"
        return when (product) {
            "ETH-USD", "SOL-USD" -> product
            else -> "BTC-USD"
        }
    }

    private fun displayContract(product: String): String = when (product.uppercase(Locale.US)) {
        "ETH-USD" -> "ETH"
        "SOL-USD" -> "SOL"
        else -> "BTC"
    }
}

private fun Double.formatPrice(): String {
    val decimals = when {
        this >= 1000.0 -> 2
        this >= 10.0 -> 4
        else -> 6
    }
    return "%.${decimals}f".format(Locale.US, this)
        .trimEnd('0')
        .trimEnd('.')
}

private fun Double.formatPercent(): String =
    "%.2f".format(Locale.US, this)

private fun Double.formatBps(): String =
    "%.2f".format(Locale.US, this)

private fun Double.compact(): String =
    when {
        this >= 1_000_000.0 -> "${(this / 1_000_000.0).formatBps()}M"
        this >= 1_000.0 -> "${(this / 1_000.0).formatBps()}K"
        else -> formatPrice()
    }
