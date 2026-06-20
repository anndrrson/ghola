package xyz.ghola.app.demo

import org.json.JSONArray
import org.json.JSONObject

/**
 * # DemoSeed
 *
 * Hardcoded demo fixtures for the live demo. Everything here is shaped like
 * the real backend responses so the rendering code does not need to know
 * it's looking at seeded data. Each row is a valid [JSONObject] in the
 * same schema as `said-cloud`'s `/v1/agents/...` endpoints.
 *
 * Seeded data is the safest way to ensure the Agents / Activity / Wallet
 * tabs feel lived-in on stage. Backend calls stay in place and still try
 * the real API first; these fixtures are the graceful fallback when the
 * backend returns null, 404, or an error.
 *
 * ## Three trading agents
 *
 * - **Momentum** — the flagship. Trend/momentum scalper on BTC. Highest
 *   balance and reputation, most recent activity. The one the presenter
 *   taps into.
 * - **Range** — a mean-reversion agent that fades SOL swings. Middle
 *   everything.
 * - **Breakout** — a range-break agent on ETH. Lowest balance, highest rep.
 *
 * All three use deterministic fake DIDs and Solana addresses that look real
 * at a glance but could not be confused with actual on-chain accounts.
 */
object DemoSeed {

    /** The three demo agents, in presenter-friendly order. */
    fun agents(): JSONArray {
        val arr = JSONArray()
        arr.put(agentAlpha())
        arr.put(agentScout())
        arr.put(agentCourier())
        return arr
    }

    fun agentById(id: String): JSONObject? = when (id) {
        ALPHA_ID -> agentAlpha()
        SCOUT_ID -> agentScout()
        COURIER_ID -> agentCourier()
        else -> null
    }

    fun earningsById(id: String): JSONObject? = when (id) {
        ALPHA_ID -> earnings(net = 42_000L, received = 57_000L, spent = 15_000L)
        SCOUT_ID -> earnings(net = 127_000L, received = 150_000L, spent = 23_000L)
        COURIER_ID -> earnings(net = 8_000L, received = 11_000L, spent = 3_000L)
        else -> null
    }

    fun reputationById(id: String): JSONObject? = when (id) {
        ALPHA_ID -> reputation(score = 4.2, events = 18)
        SCOUT_ID -> reputation(score = 3.9, events = 42)
        COURIER_ID -> reputation(score = 4.7, events = 6)
        else -> null
    }

    /**
     * Activity-feed entries in reverse chronological order — a bounded trading
     * session as it would read on the phone: armed sessions, fills, take-profit
     * and stop-loss exits, guardrail skips, and session expiry. `amount` is a
     * signed realized P&L in micro-USDC (0 when the row has no settlement), and
     * `tone` drives the colour of that number.
     */
    fun activity(): JSONArray {
        val arr = JSONArray()
        val now = System.currentTimeMillis()
        val min = 60_000L
        arr.put(feedRow(at = now - 2 * min,   agent = "Momentum", action = "Take-profit hit", amount =  2_140_000, tone = "gain",    detail = "BTC scalp · +0.4% on $50"))
        arr.put(feedRow(at = now - 11 * min,  agent = "Momentum", action = "Filled buy",      amount =  0,         tone = "neutral", detail = "0.0008 BTC @ $63,540"))
        arr.put(feedRow(at = now - 26 * min,  agent = "Range",    action = "Stop-loss",       amount = -800_000,   tone = "loss",    detail = "SOL · −1.1% guardrail"))
        arr.put(feedRow(at = now - 44 * min,  agent = "Breakout", action = "Take-profit hit", amount =  3_600_000, tone = "gain",    detail = "ETH · +0.9% on $100"))
        arr.put(feedRow(at = now - 73 * min,  agent = "Range",    action = "Filled sell",     amount =  0,         tone = "neutral", detail = "12.5 SOL @ $182.40"))
        arr.put(feedRow(at = now - 118 * min, agent = "Momentum", action = "Skipped fill",    amount =  0,         tone = "neutral", detail = "slippage > 50 bps guard"))
        arr.put(feedRow(at = now - 167 * min, agent = "Breakout", action = "Armed session",   amount =  0,         tone = "neutral", detail = "ETH · $100 cap · 75 bps"))
        arr.put(feedRow(at = now - 221 * min, agent = "Momentum", action = "Session expired", amount =  0,         tone = "neutral", detail = "BTC · 120 min · flat"))
        return arr
    }

    /** Aggregate realized P&L shown on the Wallet tab. Non-zero, believable. */
    fun walletBalanceMicroUsdc(): Long = 4_940_000L // +$4.94 realized

    // ── private builders ────────────────────────────────────────────────

    private const val ALPHA_ID = "00000000-0000-4000-8000-000000000001"
    private const val SCOUT_ID = "00000000-0000-4000-8000-000000000002"
    private const val COURIER_ID = "00000000-0000-4000-8000-000000000003"

    private fun agentAlpha(): JSONObject = JSONObject().apply {
        put("id", ALPHA_ID)
        put("slug", "momentum")
        put("display_name", "Momentum")
        put("bio", "Flagship trend/momentum scalper on BTC. Bounded sessions, conservative caps, highest reputation.")
        put("did", "did:key:z6MkfQ8rKv3n5Lm2pR7xW4eT1bG6hJ9yDc0aNs2uYqHvZ9x2")
        put("solana_address", "7WzKfC8oR3pLmN4eXq9vBtY2sJ6hG1uD5aHs8gNpKpQr")
        put("service_count", 3)
        put("reputation_score", 4.2)
        put("status", "active")
        put("created_at", "2026-03-14T10:22:31Z")
    }

    private fun agentScout(): JSONObject = JSONObject().apply {
        put("id", SCOUT_ID)
        put("slug", "range")
        put("display_name", "Range")
        put("bio", "Mean-reversion agent. Fades SOL swings inside a band, tight stops, takes profit fast.")
        put("did", "did:key:z6MkA4bN1pR3sT5uV8wX2yZ6cD9eF0gH1iJ3kL5mOnBq7ErS")
        put("solana_address", "3FmjLxVe9nK2pR5hS8wT4yZ1cQ6uX0eB7aHmJvDgNpLxVe")
        put("service_count", 7)
        put("reputation_score", 3.9)
        put("status", "active")
        put("created_at", "2026-03-20T16:04:08Z")
    }

    private fun agentCourier(): JSONObject = JSONObject().apply {
        put("id", COURIER_ID)
        put("slug", "breakout")
        put("display_name", "Breakout")
        put("bio", "Range-break agent on ETH. Enters on confirmed breaks, scales out, high reliability.")
        put("did", "did:key:z6MkGn7eR2sT4uV6wX8yZ0bA3cD5eF7gH9iJ1kL3mNpOqBq")
        put("solana_address", "9HrxWqPa4mK8sT6uV0yZ3cQ5eF7gH9iJ2kL4nR6pSxHrxWq")
        put("service_count", 2)
        put("reputation_score", 4.7)
        put("status", "active")
        put("created_at", "2026-04-01T09:11:52Z")
    }

    private fun earnings(net: Long, received: Long, spent: Long): JSONObject = JSONObject().apply {
        put("net_micro_usdc", net)
        put("total_received_micro_usdc", received)
        put("total_spent_micro_usdc", spent)
    }

    private fun reputation(score: Double, events: Int): JSONObject = JSONObject().apply {
        put("overall_score", score)
        put("event_count", events)
    }

    private fun feedRow(
        at: Long,
        agent: String,
        action: String,
        amount: Long,
        tone: String,
        detail: String,
    ): JSONObject = JSONObject().apply {
        put("timestamp_ms", at)
        put("agent_name", agent)
        put("action", action) // human-readable trade event, e.g. "Take-profit hit"
        put("amount_micro_usdc", amount) // signed realized P&L; 0 when no settlement
        put("tone", tone) // "gain" | "loss" | "neutral" — colours the amount
        put("detail", detail)
    }
}
