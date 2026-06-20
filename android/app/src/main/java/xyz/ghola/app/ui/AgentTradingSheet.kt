package xyz.ghola.app.ui

import android.content.DialogInterface
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.widget.addTextChangedListener
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.launch
import okhttp3.sse.EventSource
import org.json.JSONArray
import org.json.JSONObject
import xyz.ghola.app.BuildConfig
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.market.AutopilotReadiness
import xyz.ghola.app.market.AutopilotSessionDraft
import xyz.ghola.app.market.MobileLiveProof
import xyz.ghola.app.market.PrivateAccountClient
import xyz.ghola.app.market.TradingSessionStore
import java.util.Locale
import java.util.TimeZone

/**
 * Host activity must expose the Mobile Wallet Adapter result sender. The sender
 * registers an activity-result launcher and therefore must be created by the
 * host before it reaches STARTED — so it lives on the Activity, not here.
 */
interface TradeSenderHost {
    val tradeResultSender: ActivityResultSender
}

/**
 * The set-limits → arm-agent → live-status flow, presented as a bottom sheet so
 * it rises in-context over the market chart instead of swapping to a full page.
 * After arming, the same sheet morphs in place to show live controls and the
 * event log. This is the single source of truth for the arming pipeline; both
 * [MarketChartActivity] and [AgentTradingSessionActivity] present it.
 */
class AgentTradingSheet : BottomSheetDialogFragment() {

    companion object {
        const val TAG = "AgentTradingSheet"
        private const val ARG_PRODUCT_ID = "product_id"

        fun newInstance(productId: String?): AgentTradingSheet =
            AgentTradingSheet().apply {
                arguments = Bundle().apply { putString(ARG_PRODUCT_ID, productId) }
            }
    }

    override fun getTheme(): Int = R.style.Ghola_BottomSheetDialog

    private lateinit var storage: SecureStorage
    private lateinit var sessionStore: TradingSessionStore
    private lateinit var client: PrivateAccountClient
    private var sender: ActivityResultSender? = null

    private lateinit var marketLine: TextView
    private lateinit var allowlistLine: TextView
    private lateinit var venueLine: TextView
    private lateinit var statusText: TextView
    private lateinit var eventLogText: TextView
    private lateinit var maxNotionalInput: EditText
    private lateinit var maxDailyInput: EditText
    private lateinit var maxOrdersInput: EditText
    private lateinit var slippageInput: EditText
    private lateinit var ttlInput: EditText
    private lateinit var presetSmallButton: MaterialButton
    private lateinit var presetStandardButton: MaterialButton
    private lateinit var presetActiveButton: MaterialButton
    private lateinit var approveSessionButton: MaterialButton
    private lateinit var pauseResumeButton: MaterialButton
    private lateinit var killSwitchButton: MaterialButton
    private lateinit var mandateSentence: TextView
    private lateinit var sideRow: FlowLayout
    private lateinit var ideaRow: FlowLayout
    private lateinit var entryRow: FlowLayout
    private lateinit var horizonRow: FlowLayout
    private lateinit var exitRow: FlowLayout
    private lateinit var strategyHeader: View
    private lateinit var strategyContent: View
    private lateinit var strategyChevron: View
    private lateinit var limitsHeader: View
    private lateinit var limitsContent: View
    private lateinit var limitsChevron: View
    private lateinit var liveSection: View

    private var productId: String = "BTC-USD"
    private var currentSession: JSONObject? = null
    private var eventSource: EventSource? = null
    private var readiness: AutopilotReadiness? = null

    // Mandate selections — worker-canonical values, web-style labels.
    private var mandateSide = "auto"
    private var strategyProfile = "momentum_continuation"
    private var entryTrigger = "preview_now"
    private var exitRule = "manual_approval"
    private var timeHorizon = "scalp"

    private val sideOptions = listOf("auto" to "Auto", "buy" to "Buy", "sell" to "Sell")
    private val ideaOptions = listOf(
        "momentum_continuation" to "Trend / momentum",
        "breakout_retest" to "Breakout",
        "sweep_reclaim" to "Reversal",
        "mean_reversion" to "Mean reversion",
        "funding_mark_divergence" to "Funding basis",
        "venue_route_edge" to "Route edge",
        "custom" to "Custom",
    )
    private val entryOptions = listOf(
        "preview_now" to "Enter now",
        "break_level" to "Breaks level",
        "retest_level" to "Retests level",
        "sweep_reclaim" to "Reclaims level",
        "book_imbalance" to "Book shifts",
        "funding_mark_divergence" to "Funding edge",
        "route_edge_threshold" to "Route improves",
        "custom" to "Custom rule",
    )
    private val horizonOptions = listOf(
        "scalp" to "Scalp",
        "session_trade" to "Session",
        "intraday" to "Intraday",
        "until_invalidated" to "Until invalidated",
        "custom_window" to "Custom window",
    )
    private val exitOptions = listOf(
        "manual_approval" to "Manual approval",
        "take_profit_stop" to "TP / stop",
        "trail_after_profit" to "Trail profit",
        "exit_on_invalidation" to "Invalidation exit",
        "time_stop" to "Time stop",
        "reduce_on_risk_flip" to "Reduce on risk flip",
    )

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View = inflater.inflate(R.layout.sheet_agent_trading, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        productId = normalizeProduct(arguments?.getString(ARG_PRODUCT_ID))
        storage = SecureStorage(requireContext())
        sessionStore = TradingSessionStore(requireContext())
        sender = (activity as? TradeSenderHost)?.tradeResultSender
        client = PrivateAccountClient(
            baseUrl = storage.getCloudBaseUrl(),
            tokenProvider = { storage.getCloudAuthToken() },
            liveProofProvider = { method, path, body ->
                val activeSender = sender ?: error("Wallet signer unavailable")
                MobileLiveProof.signHeaders(activeSender, storage, method, path, body)
            },
        )

        marketLine = view.findViewById(R.id.marketLine)
        allowlistLine = view.findViewById(R.id.allowlistLine)
        venueLine = view.findViewById(R.id.venueLine)
        statusText = view.findViewById(R.id.statusText)
        eventLogText = view.findViewById(R.id.eventLogText)
        maxNotionalInput = view.findViewById(R.id.maxNotionalInput)
        maxDailyInput = view.findViewById(R.id.maxDailyInput)
        maxOrdersInput = view.findViewById(R.id.maxOrdersInput)
        slippageInput = view.findViewById(R.id.slippageInput)
        ttlInput = view.findViewById(R.id.ttlInput)
        presetSmallButton = view.findViewById(R.id.presetSmallButton)
        presetStandardButton = view.findViewById(R.id.presetStandardButton)
        presetActiveButton = view.findViewById(R.id.presetActiveButton)
        approveSessionButton = view.findViewById(R.id.approveSessionButton)
        pauseResumeButton = view.findViewById(R.id.pauseResumeButton)
        killSwitchButton = view.findViewById(R.id.killSwitchButton)
        mandateSentence = view.findViewById(R.id.mandateSentence)
        sideRow = view.findViewById(R.id.sideRow)
        ideaRow = view.findViewById(R.id.ideaRow)
        entryRow = view.findViewById(R.id.entryRow)
        horizonRow = view.findViewById(R.id.horizonRow)
        exitRow = view.findViewById(R.id.exitRow)
        strategyHeader = view.findViewById(R.id.strategyHeader)
        strategyContent = view.findViewById(R.id.strategyContent)
        strategyChevron = view.findViewById(R.id.strategyChevron)
        limitsHeader = view.findViewById(R.id.limitsHeader)
        limitsContent = view.findViewById(R.id.limitsContent)
        limitsChevron = view.findViewById(R.id.limitsChevron)
        liveSection = view.findViewById(R.id.liveSection)

        setupCollapsible(strategyHeader, strategyContent, strategyChevron)
        setupCollapsible(limitsHeader, limitsContent, limitsChevron)

        presetSmallButton.setOnClickListener {
            applyLimitPreset("10", "50", "5", "50", "60", presetSmallButton)
        }
        presetStandardButton.setOnClickListener {
            applyLimitPreset("50", "250", "10", "50", "120", presetStandardButton)
        }
        presetActiveButton.setOnClickListener {
            applyLimitPreset("100", "250", "15", "75", "120", presetActiveButton)
        }
        approveSessionButton.setOnClickListener { approveSession() }
        pauseResumeButton.setOnClickListener { pauseOrResume() }
        killSwitchButton.setOnClickListener { confirmKillSession() }

        marketLine.text = displayMarket(productId)
        allowlistLine.text = marketAccess(productId)
        venueLine.text = venueAccess(getString(R.string.autopilot_default_venues))
        paintPreset(presetStandardButton)
        setupMandate()
        renderStoredSession()
        refreshReadiness()
    }

    // ── Mandate chips ────────────────────────────────────────────────────

    private fun setupMandate() {
        renderChips(sideRow, sideOptions, { mandateSide }) { mandateSide = it }
        renderChips(ideaRow, ideaOptions, { strategyProfile }) { strategyProfile = it }
        renderChips(entryRow, entryOptions, { entryTrigger }) { entryTrigger = it }
        renderChips(horizonRow, horizonOptions, { timeHorizon }) { timeHorizon = it }
        renderChips(exitRow, exitOptions, { exitRule }) { exitRule = it }
        maxNotionalInput.addTextChangedListener { updateMandateSentence() }
        slippageInput.addTextChangedListener { updateMandateSentence() }
        updateMandateSentence()
    }

    /** Accordion: tapping the header reveals/hides the content + rotates the chevron. */
    private fun setupCollapsible(header: View, content: View, chevron: View) {
        header.setOnClickListener {
            val expand = content.visibility != View.VISIBLE
            content.visibility = if (expand) View.VISIBLE else View.GONE
            chevron.animate().rotation(if (expand) 90f else 0f).setDuration(150).start()
        }
    }

    private fun renderChips(
        row: FlowLayout,
        options: List<Pair<String, String>>,
        selected: () -> String,
        onSelect: (String) -> Unit,
    ) {
        row.removeAllViews()
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()
        options.forEach { (value, label) ->
            val isOn = value == selected()
            val chip = TextView(requireContext()).apply {
                text = label
                textSize = 13f
                setPadding(dp(15), dp(9), dp(15), dp(9))
                setBackgroundResource(if (isOn) R.drawable.bg_chip_on else R.drawable.bg_chip)
                setTextColor(
                    ContextCompat.getColor(
                        requireContext(),
                        if (isOn) R.color.ghola_cta_ink else R.color.ghola_text_secondary,
                    ),
                )
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    onSelect(value)
                    renderChips(row, options, selected, onSelect)
                    updateMandateSentence()
                }
            }
            chip.layoutParams = ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                marginEnd = dp(8)
                bottomMargin = dp(8)
            }
            row.addView(chip)
        }
    }

    private fun labelFor(options: List<Pair<String, String>>, value: String): String =
        options.firstOrNull { it.first == value }?.second ?: value

    private fun updateMandateSentence() {
        val sideWord = when (mandateSide) {
            "buy" -> "Buy"
            "sell" -> "Sell"
            else -> "Auto"
        }
        val notional = maxNotionalInput.text?.toString()?.takeIf { it.isNotBlank() } ?: "—"
        val slip = slippageInput.text?.toString()?.takeIf { it.isNotBlank() } ?: "—"
        mandateSentence.text = buildString {
            append("$sideWord \$$notional of ${displayMarket(productId)}")
            append(" · ${labelFor(ideaOptions, strategyProfile)}")
            append(" · ${labelFor(entryOptions, entryTrigger)}")
            append(" · ${labelFor(horizonOptions, timeHorizon)}")
            append(" · ${labelFor(exitOptions, exitRule)} exit")
            append(" · ≤ $slip bps")
        }
    }

    override fun onStart() {
        super.onStart()
        val bottomSheetDialog = dialog as? BottomSheetDialog ?: return
        val bottomSheet = bottomSheetDialog.findViewById<View>(
            com.google.android.material.R.id.design_bottom_sheet,
        ) ?: return
        BottomSheetBehavior.from(bottomSheet).apply {
            isFitToContents = true
            skipCollapsed = true
            maxHeight = (resources.displayMetrics.heightPixels * 0.92).toInt()
            state = BottomSheetBehavior.STATE_EXPANDED
        }
    }

    override fun onResume() {
        super.onResume()
        if (this::client.isInitialized) refreshReadiness()
    }

    override fun onStop() {
        eventSource?.cancel()
        eventSource = null
        super.onStop()
    }

    override fun onDismiss(dialog: DialogInterface) {
        eventSource?.cancel()
        eventSource = null
        super.onDismiss(dialog)
        // When presented as a standalone page, dismissing the sheet ends the host.
        (activity as? AgentTradingSessionActivity)?.finish()
    }

    private fun applyLimitPreset(
        maxOrder: String,
        daily: String,
        orders: String,
        slippage: String,
        ttl: String,
        selected: MaterialButton,
    ) {
        maxNotionalInput.setText(maxOrder)
        maxDailyInput.setText(daily)
        maxOrdersInput.setText(orders)
        slippageInput.setText(slippage)
        ttlInput.setText(ttl)
        paintPreset(selected)
    }

    private fun paintPreset(selected: MaterialButton) {
        listOf(presetSmallButton, presetStandardButton, presetActiveButton).forEach { button ->
            val isSelected = button == selected
            button.backgroundTintList = ColorStateList.valueOf(
                if (isSelected) Color.rgb(61, 168, 255) else Color.rgb(14, 19, 32),
            )
            button.strokeColor = ColorStateList.valueOf(Color.rgb(30, 42, 58))
            button.setTextColor(if (isSelected) Color.rgb(4, 18, 29) else Color.rgb(238, 241, 248))
        }
    }

    private fun approveSession() {
        if (sender == null) {
            setStatus("Reopen to arm — wallet signer unavailable.", error = true)
            return
        }
        localReadinessBlocker()?.let {
            setStatus(it, error = true)
            return
        }
        eventSource?.cancel()
        eventSource = null
        val draft = AutopilotSessionDraft(
            productId = productId,
            maxNotionalBucket = notionalBucket(),
            maxDailyNotionalBucket = dailyNotionalBucket(),
            maxOrderCount = maxOrdersInput.text.toString().toIntOrNull()?.coerceIn(1, 100) ?: 10,
            ttlMinutes = ttlInput.text.toString().toIntOrNull()?.coerceIn(1, 240) ?: 120,
            maxSlippageBps = slippageInput.text.toString().toIntOrNull()?.coerceIn(1, 100) ?: 50,
            localeHint = localeHint(),
            timezone = TimeZone.getDefault().id,
            mandateSide = mandateSide,
            strategyProfile = strategyProfile,
            entryTrigger = entryTrigger,
            exitRule = exitRule,
            timeHorizon = timeHorizon,
        )
        approveSessionButton.isEnabled = false
        setStatus("Checking Seeker live-agent readiness...")
        viewLifecycleOwner.lifecycleScope.launch {
            val ready = client.fetchAutopilotReadiness(productId, storage.getSolanaAddress()).getOrElse {
                approveSessionButton.isEnabled = true
                if (isLiveTradingUnavailable(it)) {
                    // Backend not deployed to this network yet — keep the sheet
                    // unarmed but present it calmly, not as a red failure.
                    setStatus(PrivateAccountClient.LIVE_TRADING_UNAVAILABLE)
                } else {
                    setStatus("Not armed: ${it.message ?: "readiness unavailable"}", error = true)
                }
                return@launch
            }
            readiness = ready
            if (!ready.canArm || !ready.canLiveSubmit) {
                approveSessionButton.isEnabled = true
                setStatus("Agent blocked: ${readinessSummary(ready)}", error = true)
                return@launch
            }
            setStatus(getString(R.string.autopilot_requesting))
            val result = ApprovalGate.request(
                context = requireContext(),
                reason = ApprovalGate.Reason.APPROVE_AGENT_SESSION,
                caller = "AgentTradingSheet.approveSession",
            ) {
                client.createAutopilotSession(draft)
            }
            approveSessionButton.isEnabled = true
            if (result.ok && result.body != null) {
                val session = result.body.optJSONObject("session") ?: result.body
                sessionStore.save(productId, session)
                renderActiveSession(session)
                appendEvent(getString(R.string.autopilot_event_armed))
                openEventStream(session)
            } else {
                val message = result.error ?: "Session request failed."
                setStatus("Not armed: $message", error = true)
                Toast.makeText(requireContext(), message, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun refreshReadiness() {
        if (!storage.hasCloudAuth()) return
        viewLifecycleOwner.lifecycleScope.launch {
            client.fetchAutopilotReadiness(productId, storage.getSolanaAddress())
                .onSuccess { ready ->
                    readiness = ready
                    if (currentSession == null) {
                        val message = if (ready.canLiveSubmit) {
                            "Live agent ready. Wallet approval required to arm sealed limits."
                        } else {
                            "Live agent blocked: ${readinessSummary(ready)}"
                        }
                        setStatus(message, error = !ready.canLiveSubmit)
                    }
                }
                .onFailure {
                    if (currentSession == null) {
                        if (isLiveTradingUnavailable(it)) {
                            // Prod cloud hasn't shipped the live-trading backend
                            // yet. Markets, charts, wallet, and chat still work —
                            // so this is informational, not an error.
                            setStatus(PrivateAccountClient.LIVE_TRADING_UNAVAILABLE)
                        } else {
                            setStatus("Readiness unavailable: ${it.message ?: "unknown"}", error = true)
                        }
                    }
                }
        }
    }

    private fun localReadinessBlocker(): String? {
        if (!storage.hasCloudAuth()) return getString(R.string.autopilot_cloud_required)
        if (BuildConfig.GHOLA_SEEKER_BUILD && !storage.hasSolanaAddress()) {
            return "Connect Seeker Wallet before arming the agent."
        }
        if (BuildConfig.GHOLA_SEEKER_BUILD && !storage.hasVerifiedSeekerWallet()) {
            return "Verify the Seeker wallet before arming the live agent."
        }
        return null
    }

    /**
     * True when readiness failed only because the live-trading backend isn't
     * deployed to this network (cloud 404). Markets/charts/wallet/chat stay
     * usable, so the sheet shows this calmly rather than as a red error.
     */
    private fun isLiveTradingUnavailable(error: Throwable): Boolean =
        error.message == PrivateAccountClient.LIVE_TRADING_UNAVAILABLE

    private fun readinessSummary(ready: AutopilotReadiness): String {
        if (ready.blockers.isEmpty()) return "worker or venue readiness unavailable"
        return ready.blockers.take(4).joinToString(" / ")
    }

    private fun renderStoredSession() {
        val session = sessionStore.activeSession(productId)
        if (session == null) {
            currentSession = null
            liveSection.visibility = View.GONE
            pauseResumeButton.isEnabled = false
            pauseResumeButton.alpha = 0.45f
            setStatus(getString(R.string.autopilot_no_session))
        } else {
            renderActiveSession(session)
            openEventStream(session)
        }
    }

    private fun renderActiveSession(session: JSONObject) {
        currentSession = session
        liveSection.visibility = View.VISIBLE
        val policy = session.optJSONObject("session_policy")
        val commitment = session.optString("autopilot_session_id", session.optString("agent_session_commitment")).takeLast(12)
        val maxNotional = policy?.optString("max_notional_bucket") ?: "--"
        val maxDaily = policy?.optString("max_daily_notional_bucket") ?: "--"
        val maxOrders = policy?.optInt("max_order_count", 0) ?: 0
        val slippage = policy?.optInt("max_slippage_bps", 0) ?: 0
        val aiDirect = policy?.optBoolean("ai_direct_enabled", false) == true
        val mode = if (aiDirect) "AI-direct" else "guarded"
        val expires = session.optString("expires_at", policy?.optString("expires_at") ?: "unknown")
        val status = session.optString("status", "watching")
        allowlistLine.text = marketAccess(policy?.optJSONArray("market_allowlist")?.toCompactList() ?: productId)
        venueLine.text = venueAccess(
            policy?.optJSONArray("venue_allowlist")?.toCompactList()
                ?: "jupiter / phoenix / hyperliquid / coinbase",
        )
        pauseResumeButton.isEnabled = status == "watching" ||
            status == "running" ||
            status == "pending_worker" ||
            status == "pending_funding" ||
            status == "paused"
        pauseResumeButton.alpha = if (pauseResumeButton.isEnabled) 1.0f else 0.45f
        pauseResumeButton.text = if (status == "paused") getString(R.string.autopilot_resume) else getString(R.string.autopilot_pause)
        setStatus(
            "${status.toDisplayStatus()} #$commitment / $mode / max $$maxNotional per order / $$maxDaily daily / " +
                "$maxOrders orders / ${slippage.toSlippagePercent()} max slippage / expires $expires",
            error = status == "killed" || status == "blocked" || status == "expired",
        )
    }

    private fun pauseOrResume() {
        val session = currentSession ?: return
        val sessionId = session.optString("autopilot_session_id")
        if (sessionId.isBlank()) return
        val action = if (session.optString("status") == "paused") "resume" else "pause"
        pauseResumeButton.isEnabled = false
        viewLifecycleOwner.lifecycleScope.launch {
            val result = client.controlAutopilotSession(sessionId, action)
            pauseResumeButton.isEnabled = true
            if (result.ok && result.body != null) {
                val updated = result.body.optJSONObject("session") ?: result.body
                sessionStore.save(productId, updated)
                renderActiveSession(updated)
                appendEvent(result.body.optJSONObject("event")?.optString("message") ?: "Autopilot $action")
            } else {
                setStatus(result.error ?: "Autopilot control failed", error = true)
            }
        }
    }

    private fun confirmKillSession() {
        if (currentSession == null) return
        MaterialAlertDialogBuilder(requireContext())
            .setTitle("Stop agent?")
            .setMessage("This ends the current local session for $productId. New agent actions will need approval again.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Stop agent") { _, _ -> killSession() }
            .show()
    }

    private fun killSession() {
        val session = currentSession
        val sessionId = session?.optString("autopilot_session_id").orEmpty()
        sessionStore.kill(productId)
        ApprovalGate.recordLocalApproval(
            reason = ApprovalGate.Reason.APPROVE_AGENT_SESSION,
            caller = "AgentTradingSheet.killSession",
        )
        if (sessionId.isNotBlank()) {
            viewLifecycleOwner.lifecycleScope.launch {
                client.controlAutopilotSession(sessionId, "kill")
            }
        }
        eventSource?.cancel()
        eventSource = null
        currentSession = null
        liveSection.visibility = View.GONE
        pauseResumeButton.isEnabled = false
        pauseResumeButton.alpha = 0.45f
        appendEvent(getString(R.string.autopilot_event_killed))
        setStatus(getString(R.string.autopilot_killed, productId), error = true)
    }

    private fun notionalBucket(): String {
        val value = maxNotionalInput.text.toString().toIntOrNull() ?: 50
        return when {
            value <= 5 -> "5"
            value <= 10 -> "10"
            value <= 25 -> "25"
            value <= 50 -> "50"
            else -> "100"
        }
    }

    private fun dailyNotionalBucket(): String {
        val value = maxDailyInput.text.toString().toIntOrNull() ?: 250
        return when {
            value <= 25 -> "25"
            value <= 50 -> "50"
            value <= 100 -> "100"
            else -> "250"
        }
    }

    private fun openEventStream(session: JSONObject) {
        val sessionId = session.optString("autopilot_session_id")
        if (sessionId.isBlank() || eventSource != null) return
        eventSource = client.openAutopilotEvents(
            sessionId,
            object : PrivateAccountClient.AutopilotEventListener {
                override fun onSession(session: JSONObject) {
                    ui {
                        sessionStore.save(productId, session)
                        renderActiveSession(session)
                    }
                }

                override fun onEvent(type: String, event: JSONObject) {
                    ui { appendEvent(event.optString("message", type)) }
                }

                override fun onStatus(status: JSONObject) {
                    ui {
                        if (status.optString("stream_status") != "live") {
                            appendEvent(status.optString("error", "stream ${status.optString("stream_status")}"))
                        }
                    }
                }

                override fun onFailure(message: String) {
                    ui {
                        appendEvent("stream fallback / $message")
                        eventSource?.cancel()
                        eventSource = null
                    }
                }
            },
        )
    }

    private fun appendEvent(message: String) {
        val existing = eventLogText.text?.toString().orEmpty()
            .takeIf { it != getString(R.string.autopilot_event_empty) }
            .orEmpty()
        val next = (existing.lines().filter { it.isNotBlank() } + "› $message").takeLast(6)
        eventLogText.text = next.joinToString("\n")
    }

    private fun localeHint(): String {
        val language = Locale.getDefault().language.lowercase(Locale.US)
        return when (language) {
            "zh" -> "zh-CN"
            "id", "in" -> "id"
            else -> "en"
        }
    }

    private fun setStatus(message: String, error: Boolean = false) {
        statusText.text = message
        statusText.setTextColor(if (error) Color.rgb(255, 90, 100) else Color.rgb(139, 149, 168))
    }

    /** Post to the main thread only if the sheet is still attached with a view. */
    private fun ui(block: () -> Unit) {
        view?.post { if (isAdded) block() }
    }

    private fun normalizeProduct(raw: String?): String {
        val value = raw.orEmpty().trim().uppercase(Locale.US)
        val product = if (value.contains("-")) value else "$value-USD"
        return when (product) {
            "ETH-USD", "SOL-USD" -> product
            else -> "BTC-USD"
        }
    }

    private fun displayMarket(product: String): String = when (product.uppercase(Locale.US)) {
        "ETH-USD" -> "ETH"
        "SOL-USD" -> "SOL"
        else -> "BTC"
    }

    private fun marketAccess(value: String): String = "Market: $value"

    private fun venueAccess(value: String): String = "Venues: $value"
}

private fun JSONArray.toCompactList(): String {
    val values = mutableListOf<String>()
    for (i in 0 until length()) {
        optString(i).takeIf { it.isNotBlank() }?.let { values += it }
    }
    return values.joinToString(" / ")
}

private fun String.toDisplayStatus(): String =
    replace('_', ' ').uppercase(Locale.US)

private fun Int.toSlippagePercent(): String =
    "%.2f%%".format(Locale.US, this / 100.0)
