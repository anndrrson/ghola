import { describe, expect, it, vi } from "vitest";
import {
  buildTriVenueAutopilotPolicy,
  buildTriVenueOpportunities,
  getTriVenueStatus,
  type TriVenueQuote,
} from "./private-account-tri-venue-arb";
import type { PooledWorkerReadiness } from "./private-account-pooled-readiness";

describe("tri-venue SOL arb policy", () => {
  it("finds a delta-neutral preflight opportunity after buffers", () => {
    const opportunities = buildTriVenueOpportunities({
      quotes: [
        quote("phoenix", "149.90", "150.00"),
        quote("hyperliquid", "150.80", "150.90"),
        quote("backpack", "150.10", "150.20"),
      ],
      now: new Date("2026-06-15T12:00:00.000Z"),
      minNetEdgeBps: 25,
      maxSlippageBps: 10,
    });

    const best = opportunities[0];
    expect(best?.status).toBe("preflight_pass");
    expect(best?.buy_venue).toBe("phoenix");
    expect(best?.sell_venue).toBe("hyperliquid");
    expect(best?.leg_plan).toHaveLength(2);
  });

  it("reports tri-venue live green only when all venue and policy gates are green", async () => {
    const status = await getTriVenueStatus({
      env: {
        GHOLA_LIVE_TRADING_PUBLIC_ENABLED: "true",
        GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
        GHOLA_VENUE_PHOENIX_PILOT_ENABLED: "true",
        GHOLA_VENUE_BACKPACK_PILOT_ENABLED: "true",
        PRIVATE_AGENT_TRI_VENUE_ARB_LIVE_SUBMIT: "true",
        PRIVATE_AGENT_MARKET_MAKER_LIVE_SUBMIT: "true",
        PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD: "5",
        PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD: "25",
        PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS: "25",
        PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS: "2000",
        PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS: "2000",
        PRIVATE_AGENT_MM_MAX_RESTING_ORDERS: "2",
        PRIVATE_AGENT_MM_QUOTE_TTL_MS: "10000",
        GHOLA_BACKPACK_POOLED_ENABLED: "true",
        GHOLA_BACKPACK_API_KEY: "pub",
        GHOLA_BACKPACK_API_SECRET: Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
        GHOLA_BACKPACK_ALLOWED_SYMBOLS: "SOL_USDC_PERP",
        GHOLA_BACKPACK_MAX_ORDER_NOTIONAL_USD: "5",
        GHOLA_BACKPACK_DAILY_NOTIONAL_CAP_USD: "25",
        GHOLA_BACKPACK_POST_ONLY_MM: "true",
      },
      workerReadiness: readyWorker(),
    });

    expect(status.can_live_submit).toBe(true);
    expect(status.gates.map((gate) => gate.status)).not.toContain("red");
  });

  it("builds SOL-only autopilot policies for arb and maker modes", () => {
    expect(buildTriVenueAutopilotPolicy("arb")).toMatchObject({
      strategy_id: "hedged_spread_arbitrage_v1",
      venue_allowlist: ["phoenix", "hyperliquid", "backpack"],
      market_allowlist: ["SOL-USD"],
      max_notional_bucket: "5",
    });
    expect(buildTriVenueAutopilotPolicy("maker").strategy_id).toBe("tri_venue_market_maker_v1");
  });

  it("does not probe the worker from public status unless explicitly requested", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;

    const status = await getTriVenueStatus({
      env: {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      },
      fetchImpl: fetchSpy,
      now: new Date("2026-06-15T12:00:00.000Z"),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(status.worker_readiness.endpoint_configured).toBe(true);
    expect(status.worker_readiness.reason_codes).toContain("worker_probe_not_requested");
    expect(status.can_live_submit).toBe(false);
  });
});

function quote(venue_id: TriVenueQuote["venue_id"], best_bid: string, best_ask: string): TriVenueQuote {
  return {
    venue_id,
    label: venue_id,
    market: "SOL-USD",
    venue_symbol: venue_id === "backpack" ? "SOL_USDC_PERP" : venue_id === "phoenix" ? "SOL-PERP" : "SOL",
    best_bid,
    best_ask,
    mid: String((Number(best_bid) + Number(best_ask)) / 2),
    mark_price: null,
    funding_rate: null,
    open_interest: null,
    spread_bps: 6,
    data_age_ms: 250,
    stale: false,
    status: "live",
    reason_codes: [],
  };
}

function readyWorker(): PooledWorkerReadiness {
  return {
    status: "ready",
    ready: true,
    endpoint_configured: true,
    reason_codes: [],
    checked_at: "2026-06-15T12:00:00.000Z",
    venues: {
      phoenix: { venue_id: "phoenix", status: "ready", ready: true, reason_codes: [] },
      hyperliquid: { venue_id: "hyperliquid", status: "ready", ready: true, reason_codes: [] },
      backpack: { venue_id: "backpack", status: "ready", ready: true, reason_codes: [] },
      jupiter: { venue_id: "jupiter", status: "ready", ready: true, reason_codes: [] },
      coinbase: { venue_id: "coinbase", status: "ready", ready: true, reason_codes: [] },
    },
  };
}
