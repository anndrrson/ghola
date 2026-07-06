import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory store path (no DATABASE_URL) so countActivePrivateAutopilotSessions
// exercises the fallback branch deterministically.
const OLD_ENV = { ...process.env };

async function freshModules() {
  vi.resetModules();
  const store = await import("./private-account-store");
  const phala = await import("./private-agent-phala");
  return { store, phala };
}

function sessionRecord(id: string, status: string) {
  return {
    version: 1 as const,
    owner_commitment: `owner_${id}`,
    autopilot_session_id: id,
    status,
    session: {},
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    expires_at: new Date(0).toISOString(),
  };
}

describe("countActivePrivateAutopilotSessions", () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.DATABASE_URL;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL;
    delete process.env.POSTGRES_URL;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("counts only sessions in an active status", async () => {
    const { store } = await freshModules();
    await store.putPrivateAutopilotSession(sessionRecord("a", "watching"));
    await store.putPrivateAutopilotSession(sessionRecord("b", "running"));
    await store.putPrivateAutopilotSession(sessionRecord("c", "pending_worker"));
    await store.putPrivateAutopilotSession(sessionRecord("d", "killed"));
    await store.putPrivateAutopilotSession(sessionRecord("e", "done"));
    await store.putPrivateAutopilotSession(sessionRecord("f", "expired"));
    expect(await store.countActivePrivateAutopilotSessions()).toBe(3);
  });

  it("returns zero when every session is terminal", async () => {
    const { store } = await freshModules();
    await store.putPrivateAutopilotSession(sessionRecord("x", "killed"));
    await store.putPrivateAutopilotSession(sessionRecord("y", "failed"));
    expect(await store.countActivePrivateAutopilotSessions()).toBe(0);
  });
});

describe("keepPrivateAgentWarmForActiveSessions", () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.DATABASE_URL;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL;
    delete process.env.POSTGRES_URL;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.restoreAllMocks();
  });

  it("no-ops when no agent is armed", async () => {
    const { phala } = await freshModules();
    const result = await phala.keepPrivateAgentWarmForActiveSessions();
    expect(result).toMatchObject({ attempted: false, active_sessions: 0, status: "no_active_sessions" });
  });

  it("reports remote_execution_disabled without waking when the spend lock is on", async () => {
    process.env.GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED = "true";
    const { store, phala } = await freshModules();
    await store.putPrivateAutopilotSession(sessionRecord("a", "watching"));
    const result = await phala.keepPrivateAgentWarmForActiveSessions();
    expect(result).toMatchObject({
      attempted: false,
      active_sessions: 1,
      status: "remote_execution_disabled",
    });
  });
});

describe("stopIdlePhalaPrivateAgent guards active sessions", () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.DATABASE_URL;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL;
    delete process.env.POSTGRES_URL;
    process.env.GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN = "true";
    process.env.PHALA_CLOUD_API_KEY = "test-key";
    delete process.env.GHOLA_PRIVATE_AGENT_LEASE_STORE;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("refuses to stop while an agent session is active", async () => {
    const { store, phala } = await freshModules();
    await store.putPrivateAutopilotSession(sessionRecord("a", "watching"));
    const result = await phala.stopIdlePhalaPrivateAgent();
    expect(result).toMatchObject({ attempted: false, stopped: false, status: "sessions_active" });
  });
});
