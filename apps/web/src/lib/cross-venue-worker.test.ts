import { describe, expect, it, vi } from "vitest";
import { createCrossVenueExecutionPlan } from "./cross-venue-execution";
import { cancelCrossVenueExecution, crossVenueExecutionReadiness, submitCrossVenueExecution } from "./cross-venue-worker";

describe("cross-venue worker boundary", () => {
  it("fails closed until the explicit feature flag, worker URL, and auth are present", () => {
    expect(crossVenueExecutionReadiness({})).toMatchObject({
      enabled: false,
      ready: false,
      atomic: false,
      reason_codes: expect.arrayContaining(["cross_venue_byo_flag_disabled", "execution_worker_url_missing", "execution_worker_auth_missing"]),
    });
  });

  it("sends one idempotent sealed two-leg contract when enabled", async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      void _url;
      void init;
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const plan = execution();
    const result = await submitCrossVenueExecution({
      plan,
      env: {
        GHOLA_CROSS_VENUE_BYO_ENABLED: "true",
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "test-token",
      },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(plan.execution_id);
    expect(JSON.parse(String(init.body)).legs).toHaveLength(2);
  });

  it("keeps emergency cancellation available after the submit flag is disabled", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const result = await cancelCrossVenueExecution({
      plan: execution(),
      env: {
        GHOLA_CROSS_VENUE_BYO_ENABLED: "false",
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "test-token",
      },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
  });
});

function execution() {
  return createCrossVenueExecutionPlan({
    owner_commitment: "owner_worker_test",
    idempotency_key: "execution:worker:123",
    opportunity_commitment: "ghola_opportunity_worker",
    market: "SOL-USD",
    matched_notional_micro_usdc: 5_000_000,
    risk_budget: {
      max_unhedged_notional_micro_usdc: 5_000_000,
      max_hedge_slippage_bps: 25,
      max_hedge_duration_ms: 5_000,
      max_unwind_loss_micro_usdc: 250_000,
      max_daily_loss_micro_usdc: 5_000_000,
    },
    legs: [
      { venue_id: "hyperliquid", side: "buy", symbol: "SOL", limit_price: "150" },
      { venue_id: "phoenix", side: "sell", symbol: "SOL-PERP", limit_price: "151" },
    ],
  });
}
