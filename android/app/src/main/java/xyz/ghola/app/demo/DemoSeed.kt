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
 * ## Three agents
 *
 * - **Alpha** — the flagship. Highest balance, highest reputation, recent
 *   high activity. The one the presenter taps into.
 * - **Scout** — a scraper / search agent. Middle everything.
 * - **Courier** — a messenger / delivery agent. Lowest balance, highest rep.
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

    /** Activity-feed entries in reverse chronological order. */
    fun activity(): JSONArray {
        val arr = JSONArray()
        val now = System.currentTimeMillis()
        val min = 60_000L
        arr.put(feedRow(at = now - 3 * min,   agent = "Alpha",   kind = "paid_by",  amount = 3_000,  counterparty = "did:key:z6Mk8f…9rQ",   note = "answered question"))
        arr.put(feedRow(at = now - 14 * min,  agent = "Scout",   kind = "paid",     amount = 1_000,  counterparty = "did:key:z6MkXm…2Lt",   note = "lookup call"))
        arr.put(feedRow(at = now - 37 * min,  agent = "Alpha",   kind = "paid_by",  amount = 2_000,  counterparty = "did:key:z6MkrK…4Fx",   note = "summary request"))
        arr.put(feedRow(at = now - 58 * min,  agent = "Courier", kind = "paid_by",  amount = 4_000,  counterparty = "did:key:z6MkPn…9Sv",   note = "delivered message"))
        arr.put(feedRow(at = now - 92 * min,  agent = "Alpha",   kind = "paid",     amount = 500,    counterparty = "did:key:z6MkQc…1Bn",   note = "translation"))
        arr.put(feedRow(at = now - 141 * min, agent = "Scout",   kind = "paid_by",  amount = 6_000,  counterparty = "did:key:z6Mk2p…7Jh",   note = "market data pull"))
        arr.put(feedRow(at = now - 186 * min, agent = "Alpha",   kind = "paid_by",  amount = 1_500,  counterparty = "did:key:z6Mk9e…3Vr",   note = "schedule check"))
        arr.put(feedRow(at = now - 234 * min, agent = "Courier", kind = "paid",     amount = 250,    counterparty = "did:key:z6Mk4a…8Nc",   note = "push notification"))
        return arr
    }

    /** Aggregate wallet balance shown on the Wallet tab. Non-zero, believable. */
    fun walletBalanceMicroUsdc(): Long = 177_000L // $0.177

    // ── private builders ────────────────────────────────────────────────

    private const val ALPHA_ID = "00000000-0000-4000-8000-000000000001"
    private const val SCOUT_ID = "00000000-0000-4000-8000-000000000002"
    private const val COURIER_ID = "00000000-0000-4000-8000-000000000003"

    private fun agentAlpha(): JSONObject = JSONObject().apply {
        put("id", ALPHA_ID)
        put("slug", "alpha")
        put("display_name", "Alpha")
        put("bio", "Flagship agent. Answers questions, pays for research, holds the highest reputation.")
        put("did", "did:key:z6MkfQ8rKv3n5Lm2pR7xW4eT1bG6hJ9yDc0aNs2uYqHvZ9x2")
        put("solana_address", "7WzKfC8oR3pLmN4eXq9vBtY2sJ6hG1uD5aHs8gNpKpQr")
        put("service_count", 3)
        put("reputation_score", 4.2)
        put("status", "active")
        put("created_at", "2026-03-14T10:22:31Z")
    }

    private fun agentScout(): JSONObject = JSONObject().apply {
        put("id", SCOUT_ID)
        put("slug", "scout")
        put("display_name", "Scout")
        put("bio", "Scraper and lookup specialist. Pulls market data, enriches contacts, answers facts.")
        put("did", "did:key:z6MkA4bN1pR3sT5uV8wX2yZ6cD9eF0gH1iJ3kL5mOnBq7ErS")
        put("solana_address", "3FmjLxVe9nK2pR5hS8wT4yZ1cQ6uX0eB7aHmJvDgNpLxVe")
        put("service_count", 7)
        put("reputation_score", 3.9)
        put("status", "active")
        put("created_at", "2026-03-20T16:04:08Z")
    }

    private fun agentCourier(): JSONObject = JSONObject().apply {
        put("id", COURIER_ID)
        put("slug", "courier")
        put("display_name", "Courier")
        put("bio", "Delivers messages across channels. SMS, email, push, on-chain. High reliability.")
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
        kind: String,
        amount: Long,
        counterparty: String,
        note: String,
    ): JSONObject = JSONObject().apply {
        put("timestamp_ms", at)
        put("agent_name", agent)
        put("kind", kind) // "paid" (outgoing) or "paid_by" (incoming)
        put("amount_micro_usdc", amount)
        put("counterparty_did", counterparty)
        put("note", note)
    }
}
