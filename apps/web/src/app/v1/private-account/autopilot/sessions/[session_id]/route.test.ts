import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  sync: vi.fn(),
}));

vi.mock("../../../_lib", () => ({
  json: (body: unknown, status = 200) => Response.json(body, { status }),
  privateAccountOwnerFromRequest: mocks.owner,
  unauthorized: () => Response.json({ error: "unauthorized" }, { status: 401 }),
}));

vi.mock("@/lib/private-account-autopilot", () => ({
  syncWorkerAutopilotSession: mocks.sync,
}));

import { GET } from "./route";

describe("autopilot session route", () => {
  beforeEach(() => {
    mocks.owner.mockReset().mockResolvedValue({ owner_commitment: "owner_1" });
    mocks.sync.mockReset().mockResolvedValue({
      session: { autopilot_session_id: "session_1", status: "running" },
      events: [{ event_id: "event_1", type: "live_order_submitted" }],
    });
  });

  it("returns synchronized worker events with the session", async () => {
    const response = await GET(new Request("https://ghola.test/v1/private-account/autopilot/sessions/session_1"), {
      params: Promise.resolve({ session_id: "session_1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 1,
      session: { autopilot_session_id: "session_1", status: "running" },
      events: [{ event_id: "event_1", type: "live_order_submitted" }],
    });
  });
});
