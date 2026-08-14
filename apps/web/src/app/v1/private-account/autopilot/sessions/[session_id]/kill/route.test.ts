import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutonomousAutopilotSessionFromBody,
  getAutopilotSessionForOwner,
  resetAutopilotSessionsForTests,
} from "@/lib/private-account-autopilot";
import { gholaCommitment } from "@/lib/private-account";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";
import { brandPrivateAgentMockTransport } from "@/lib/private-agent-spend-policy";
import { POST } from "./route";
import { POST as pauseAutopilot } from "../pause/route";

const USER_ID = "autopilot_kill_ack_route_user";
const owner = { owner_commitment: gholaCommitment("owner", USER_ID) };

beforeEach(() => {
  process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
  process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
  resetAutopilotSessionsForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
  delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE;
  resetAutopilotSessionsForTests();
  await resetPrivateAccountStoreForTests();
});

describe("autopilot kill route worker acknowledgment", () => {
  it.each([
    ["kill", POST],
    ["pause", pauseAutopilot],
  ] as const)("returns non-2xx and no false %s state when worker control is unconfirmed", async (action, route) => {
    const now = new Date();
    const env = {
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
    };
    const createTransport = brandPrivateAgentMockTransport((async (input: URL | RequestInfo) => {
      if (String(input).endsWith("/ready")) {
        return Response.json({ ready: true, missing: [] });
      }
      return Response.json({
        session: {
          autopilot_session_id: "worker_route_kill_ack",
          status: "running",
          execution_enabled: true,
        },
        events: [],
      }, { status: 201 });
    }) as typeof fetch);
    const created = await createAutonomousAutopilotSessionFromBody(
      {},
      owner,
      now,
      env,
      createTransport,
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not run"));

    const response = await route(
      new Request(`https://ghola.test/v1/private-account/autopilot/sessions/${created.session.autopilot_session_id}/${action}`, {
        method: "POST",
        headers: {
          authorization: auth(USER_ID),
          "content-type": "application/json",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ session_id: created.session.autopilot_session_id }) },
    );
    const body = await response.json() as Record<string, unknown>;
    const stored = await getAutopilotSessionForOwner(created.session.autopilot_session_id, owner, now);

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      version: 1,
      error: "autopilot_worker_control_unconfirmed",
      action,
      reason: "worker_not_configured",
      retryable: true,
    });
    expect(body).not.toHaveProperty("session");
    expect(stored).toMatchObject({ status: "running", execution_enabled: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}
