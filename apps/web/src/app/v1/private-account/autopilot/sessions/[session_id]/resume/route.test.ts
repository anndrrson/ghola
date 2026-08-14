import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutopilotSessionFromBody,
  getAutopilotSessionForOwner,
  resetAutopilotSessionsForTests,
} from "@/lib/private-account-autopilot";
import { POST } from "./route";

const owner = { owner_commitment: "owner_resume_policy" };

beforeEach(() => {
  resetAutopilotSessionsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAutopilotSessionsForTests();
});

describe("autopilot resume route spend boundary", () => {
  it("denies test/local resume before transport or session mutation", async () => {
    const now = new Date("2026-08-12T12:00:00.000Z");
    const created = await createAutopilotSessionFromBody({}, owner, now);
    const before = await getAutopilotSessionForOwner(created.session.autopilot_session_id, owner, now);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not run"));

    const response = await POST(
      new Request("https://ghola.test/v1/private-account/autopilot/sessions/session/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ session_id: created.session.autopilot_session_id }) },
    );
    const after = await getAutopilotSessionForOwner(created.session.autopilot_session_id, owner, now);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      version: 1,
      error: "private_agent_test_environment",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(after).toEqual(before);
  });
});
