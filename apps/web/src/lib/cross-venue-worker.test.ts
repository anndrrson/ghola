import { describe, expect, it, vi } from "vitest";
import { createCrossVenueExecutionPlan } from "./cross-venue-execution";
import {
  cancelCrossVenueExecution,
  closeCrossVenueExecution,
  crossVenueExecutionReadiness,
  probeCrossVenueExecutionReadiness,
  submitCrossVenueExecution,
} from "./cross-venue-worker";
import { brandPrivateAgentMockTransport } from "./private-agent-spend-policy";

describe("cross-venue worker boundary", () => {
  it("fails closed until the explicit live gate and worker transport are configured", () => {
    expect(crossVenueExecutionReadiness({})).toMatchObject({
      enabled: false,
      ready: false,
      atomic: false,
      reason_codes: expect.arrayContaining(["cross_venue_live_submit_disabled", "execution_worker_url_missing", "execution_worker_auth_missing"]),
    });
  });

  it("sends a configured plan only after the explicit live gate is enabled", async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      void _url;
      void init;
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    const fetchImpl = brandPrivateAgentMockTransport(fetchMock as unknown as typeof fetch);
    const plan = execution();
    const result = await submitCrossVenueExecution({
      plan,
      env: {
        GHOLA_CROSS_VENUE_LIVE_SUBMIT: "true",
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "test-token",
      },
      fetchImpl,
    });
    expect(result).toEqual({ ok: true, status: 202, worker_receipt: { accepted: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps emergency cancellation available after the submit flag is disabled", async () => {
    const fetchImpl = brandPrivateAgentMockTransport(vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch);
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
    const closed = await closeCrossVenueExecution({
      plan: execution(),
      env: {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "test-token",
      },
      fetchImpl,
    });
    expect(closed.ok).toBe(true);
  });

  it("blocks probe, submit, cancel, and close before an unbranded transport is called", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ ready: true, accepted: true }));
    }) as typeof fetch;
    const env = {
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
      GHOLA_CROSS_VENUE_BYO_ENABLED: "true",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "test-token",
    };
    const plan = execution();

    const readiness = await probeCrossVenueExecutionReadiness({ env, fetchImpl });
    const submitted = await submitCrossVenueExecution({ plan, env, fetchImpl });
    const cancelled = await cancelCrossVenueExecution({ plan, env, fetchImpl });
    const closed = await closeCrossVenueExecution({ plan, env, fetchImpl });

    expect(readiness).toMatchObject({ ready: false, reason_codes: expect.arrayContaining(["private_agent_transport_blocked"]) });
    expect(submitted).toEqual({ ok: false, status: 403, error: "private_agent_transport_blocked" });
    expect(cancelled).toEqual({ ok: false, status: 403, error: "private_agent_transport_blocked" });
    expect(closed).toEqual({ ok: false, status: 403, error: "private_agent_transport_blocked" });
    expect(fetchCalls).toBe(0);
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
