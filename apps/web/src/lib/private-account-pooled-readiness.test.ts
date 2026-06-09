import { describe, expect, it } from "vitest";
import { getPooledWorkerVenueBalance } from "./private-account-pooled-readiness";

const ENV = {
  GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.ghola.test",
  GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "test-worker-token",
};

function fetchJson(body: unknown, status = 200): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("getPooledWorkerVenueBalance", () => {
  it("normalizes a verified balance", async () => {
    const balance = await getPooledWorkerVenueBalance("hyperliquid", ENV, fetchJson({
      version: 1,
      operation_class: "pooled_balance",
      venues: [{
        venue_id: "hyperliquid",
        status: "verified",
        verified: true,
        equity_micro_usdc: 123_456_789.9,
        dry_run: false,
        account_commitment: "hyperliquid_pooled_account_abc",
        reason_codes: [],
        observed_at: "2026-06-09T00:00:00.000Z",
      }],
    }));
    expect(balance.status).toBe("verified");
    expect(balance.verified).toBe(true);
    expect(balance.equity_micro_usdc).toBe(123_456_789);
    expect(balance.account_commitment).toBe("hyperliquid_pooled_account_abc");
    expect(balance.observed_at).toBe("2026-06-09T00:00:00.000Z");
  });

  it("passes through an unsupported venue", async () => {
    const balance = await getPooledWorkerVenueBalance("phoenix", ENV, fetchJson({
      version: 1,
      venues: [{
        venue_id: "phoenix",
        status: "unsupported",
        verified: false,
        reason_codes: ["balance_probe_unsupported"],
      }],
    }));
    expect(balance.status).toBe("unsupported");
    expect(balance.verified).toBe(false);
    expect(balance.equity_micro_usdc).toBeNull();
    expect(balance.reason_codes).toContain("balance_probe_unsupported");
  });

  it("treats a verified status without a numeric equity as unavailable", async () => {
    const balance = await getPooledWorkerVenueBalance("hyperliquid", ENV, fetchJson({
      version: 1,
      venues: [{ venue_id: "hyperliquid", status: "verified", equity_micro_usdc: "not-a-number" }],
    }));
    expect(balance.status).toBe("unavailable");
    expect(balance.verified).toBe(false);
  });

  it("reports a missing endpoint without calling the worker", async () => {
    const balance = await getPooledWorkerVenueBalance("hyperliquid", {}, async () => {
      throw new Error("must not be called");
    });
    expect(balance.status).toBe("unavailable");
    expect(balance.reason_codes).toContain("pooled_worker_endpoint_missing");
  });

  it("rejects responses containing forbidden public fields", async () => {
    const balance = await getPooledWorkerVenueBalance("hyperliquid", ENV, fetchJson({
      version: 1,
      venues: [{
        venue_id: "hyperliquid",
        status: "verified",
        equity_micro_usdc: 1,
        api_key: "leaked",
      }],
    }));
    expect(balance.status).toBe("unavailable");
    expect(balance.reason_codes).toContain("pooled_worker_forbidden_public_field");
  });

  it("reports probe failures on non-2xx responses", async () => {
    const balance = await getPooledWorkerVenueBalance("hyperliquid", ENV, fetchJson({ error: "boom" }, 503));
    expect(balance.status).toBe("unavailable");
    expect(balance.reason_codes).toContain("pooled_worker_probe_failed");
  });
});
