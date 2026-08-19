import { describe, expect, it, vi } from "vitest";
import * as route from "./route";
import {
  createLiveTradingReconciliationPost,
  type LiveTradingReconciliationDependencies,
} from "./_handler";

const PLAN = `sha256:${"a".repeat(64)}`;

describe("authenticated live work-order reconciliation", () => {
  it("does not expose GET", () => {
    expect(route).not.toHaveProperty("GET");
    expect(route.POST).toBeTypeOf("function");
  });
  it("rejects unauthenticated and malformed requests before reconciliation", async () => {
    const reconcile = vi.fn();
    const unauthenticated = createLiveTradingReconciliationPost(dependencies({
      ownerFromRequest: vi.fn(async () => null),
      reconcile,
    }));
    expect((await unauthenticated(request(PLAN))).status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();

    const authenticated = createLiveTradingReconciliationPost(dependencies({ reconcile }));
    expect((await authenticated(request("bad"))).status).toBe(400);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("passes only the authenticated owner and exact plan to no-broadcast reconciliation", async () => {
    const reconcile = vi.fn<LiveTradingReconciliationDependencies["reconcile"]>(
      async () => Response.json({ version: 1, status: "pending", planDigest: PLAN }, { status: 202 }),
    );
    const post = createLiveTradingReconciliationPost(dependencies({ reconcile }));
    const response = await post(request(PLAN));

    expect(response.status).toBe(202);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      owner_commitment: "owner_reconciliation_test",
      plan_digest: PLAN,
    }));
    expect(reconcile.mock.calls[0]?.[0]).not.toHaveProperty("account_commitment");
    expect(reconcile.mock.calls[0]?.[0]).not.toHaveProperty("work_order_commitment");
  });

  it("rejects cross-origin, non-JSON, and extra-field requests before authentication", async () => {
    const ownerFromRequest = vi.fn();
    const post = createLiveTradingReconciliationPost(dependencies({ ownerFromRequest }));
    expect((await post(request(PLAN, "https://evil.test"))).status).toBe(403);
    expect((await post(new Request("https://ghola.test/v1/private-account/live-trading/reconciliation", {
      method: "POST",
      headers: { origin: "https://ghola.test", "content-type": "text/plain" },
      body: JSON.stringify({ plan_digest: PLAN }),
    }))).status).toBe(403);
    expect(ownerFromRequest).not.toHaveBeenCalled();

    const authenticated = createLiveTradingReconciliationPost(dependencies());
    expect((await authenticated(new Request("https://ghola.test/v1/private-account/live-trading/reconciliation", {
      method: "POST",
      headers: { origin: "https://ghola.test", "content-type": "application/json" },
      body: JSON.stringify({ plan_digest: PLAN, work_order_commitment: "caller_controlled" }),
    }))).status).toBe(400);
  });
});

function dependencies(
  overrides: Partial<Record<keyof LiveTradingReconciliationDependencies, unknown>> = {},
): LiveTradingReconciliationDependencies {
  return {
    ownerFromRequest: vi.fn(async () => ({
      user: { id: "user_reconciliation_test", email: "investor@example.com" },
      owner_commitment: "owner_reconciliation_test",
    })),
    reconcile: vi.fn(async () => Response.json({ error: "not_configured" }, { status: 503 })),
    ...overrides,
  } as unknown as LiveTradingReconciliationDependencies;
}

function request(planDigest: string, origin = "https://ghola.test") {
  return new Request("https://ghola.test/v1/private-account/live-trading/reconciliation", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ plan_digest: planDigest }),
  });
}
