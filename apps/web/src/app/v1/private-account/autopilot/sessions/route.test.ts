import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateAccountOwnerFromRequest } from "../../_lib";

const autopilotMocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@/lib/private-account-autopilot", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/private-account-autopilot")>(),
  createAutonomousAutopilotSessionFromBody: autopilotMocks.create,
}));

import {
  listAutopilotSessionsForOwner,
  resetAutopilotSessionsForTests,
} from "@/lib/private-account-autopilot";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import { POST } from "./route";

describe("autopilot level-trigger exact binding", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    autopilotMocks.create.mockReset();
    resetAutopilotSessionsForTests();
  });

  afterEach(async () => {
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    vi.restoreAllMocks();
    resetAutopilotSessionsForTests();
    await resetPrivateAccountStoreForTests();
  });

  it("rejects incomplete level-trigger plans before persistence or worker contact", async () => {
    const request = armRequest({
      session_policy: {
        strategy_id: "level_trigger_v1",
        venue_allowlist: ["hyperliquid"],
        market_allowlist: ["BTC-USD"],
      },
    });
    const owner = await privateAccountOwnerFromRequest(request);
    expect(owner).not.toBeNull();
    if (!owner) return;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("worker must not run"));

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "level_trigger_exact_plan_required" });
    expect(autopilotMocks.create).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(listAutopilotSessionsForOwner(owner)).resolves.toEqual([]);
  });

  it("passes an exact Hyperliquid plan to session creation", async () => {
    autopilotMocks.create.mockResolvedValue({ session: { autopilot_session_id: "worker_exact" }, events: [] });
    const response = await POST(armRequest({ session_policy: {
      strategy_id: "level_trigger_v1",
      venue_allowlist: ["hyperliquid"],
      market_allowlist: ["HYPE-USD"],
      execution_network: "testnet",
      exact_notional_usd: "26",
    } }));
    expect(response.status).toBe(201);
    expect(autopilotMocks.create).toHaveBeenCalledOnce();
  });
});

function armRequest(body: unknown) {
  return new Request("https://ghola.test/v1/private-account/autopilot/sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer local-level-trigger-containment",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
