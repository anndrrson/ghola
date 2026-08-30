import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPhalaWorkerCompose,
  discoverPhalaPrivateAgentProvider,
  ensurePhalaPrivateAgentProvisioned,
  expectedRecipientReportDataHex,
  markPhalaPrivateAgentActivity,
  phalaIdleLeaseMs,
  phalaIdleShutdownEnabled,
  phalaJitProvisioningConfigIssue,
  phalaJitProvisioningConfigured,
  phalaRecipientFetchTimeoutMs,
  phalaWorkerImageConfiguredForRequestedMode,
  phalaWorkerReadyPollMs,
  resetPhalaWakeStateForTests,
  stopIdlePhalaPrivateAgent,
} from "./private-agent-phala";
import { resetPrivateAgentRuntimeLeaseStoreForTests } from "./private-agent-runtime-lease";

const ORIGINAL_ENV = { ...process.env };
const cloudClient = vi.hoisted(() => ({
  commitCvmProvision: vi.fn(),
  getCvmAttestation: vi.fn(),
  getCvmInfo: vi.fn(),
  getCvmNetwork: vi.fn(),
  getCvmState: vi.fn(),
  provisionCvm: vi.fn(),
  startCvm: vi.fn(),
  stopCvm: vi.fn(),
  watchCvmState: vi.fn(),
}));

vi.mock("@phala/cloud", () => ({
  createClient: vi.fn(() => cloudClient),
  encryptEnvVars: vi.fn(),
  watchCvmState: cloudClient.watchCvmState,
}));

const TEST_ENV_KEYS = [
  "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
  "GHOLA_PRIVATE_AGENT_FUNDING_SIGNING_KEY",
  "GHOLA_PRIVATE_AGENT_IDLE_AFTER_MINUTES",
  "GHOLA_PRIVATE_AGENT_IDLE_AFTER_MS",
  "GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN",
  "GHOLA_PRIVATE_AGENT_IMAGE_DIGEST",
  "GHOLA_PRIVATE_AGENT_JIT_PROVISIONING",
  "GHOLA_PRIVATE_AGENT_LEASE_STORE",
  "GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED",
  "GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
  "GHOLA_PHALA_WORKER_READY_POLL_MS",
  "GHOLA_PHALA_RECIPIENT_FETCH_TIMEOUT_MS",
  "GHOLA_HYPERLIQUID_LIVE_MODE",
  "GHOLA_HYPERLIQUID_LIVE_DAILY_NOTIONAL_CAP_USD",
  "GHOLA_HYPERLIQUID_LIVE_MAX_SLIPPAGE_BPS",
  "PHALA_API_KEY",
  "PHALA_CLOUD_API_KEY",
  "PRIVATE_AGENT_EXECUTION_TOKEN",
  "PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT",
  "PRIVATE_AGENT_FUNDING_SIGNING_KEY",
  "PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
  "GHOLA_WORKER_CAPABILITY_SECRET",
];

afterEach(() => {
  resetPhalaWakeStateForTests();
  vi.clearAllMocks();
  resetPrivateAgentRuntimeLeaseStoreForTests();
  for (const key of TEST_ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
});

function setTestEnv(values: Record<string, string>): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, values);
}

describe("private-agent Phala provisioning", () => {
  it("builds a no-plaintext worker compose with dstack quote binding", () => {
    const compose = buildPhalaWorkerCompose({
      image: "ghcr.io/example/worker@sha256:abc",
      imageDigest: "sha256:abc",
    });

    expect(compose).toContain("ghcr.io/example/worker@sha256:abc");
    expect(compose).toContain("/var/run/dstack.sock:/var/run/dstack.sock");
    expect(compose).toContain('PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true"');
    expect(compose).toContain(
      'PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "${PRIVATE_AGENT_WORKER_CAPABILITY_SECRET}"',
    );
    expect(compose).toContain('NODE_ENV: "production"');
    expect(compose).toContain('PRIVATE_AGENT_ALLOW_UNATTESTED_DEV: "false"');
    expect(compose).toContain(
      'PRIVATE_AGENT_EXECUTION_TOKEN: "${PRIVATE_AGENT_EXECUTION_TOKEN}"',
    );
    expect(compose).toContain('PRIVATE_AGENT_VENUE_DRY_RUN: "false"');
    expect(compose).toContain('PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT: "false"');
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "disabled"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "5"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: "25"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "50"',
    );
    expect(compose).not.toMatch(/PHALA_CLOUD_API_KEY|PHALA_API_KEY/);
    expect(compose).not.toMatch(/prompt|strategy_text|messages|policy:/i);
  });

  it("passes live tiny-fill controls into the worker compose", () => {
    setTestEnv({
      GHOLA_HYPERLIQUID_LIVE_MODE: "tiny_fill",
      GHOLA_HYPERLIQUID_LIVE_DAILY_NOTIONAL_CAP_USD: "20",
      GHOLA_HYPERLIQUID_LIVE_MAX_SLIPPAGE_BPS: "25",
      PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "5",
    });

    const compose = buildPhalaWorkerCompose({
      image: "ghcr.io/example/worker@sha256:def",
      imageDigest: "sha256:def",
    });

    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "tiny_fill"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "5"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: "20"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "25"',
    );
  });

  it("propagates explicit autopilot live-submit activation", () => {
    setTestEnv({
      PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT: "true",
    });

    const compose = buildPhalaWorkerCompose({
      image: "ghcr.io/example/worker@sha256:live",
      imageDigest: "sha256:live",
    });

    expect(compose).toContain('PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT: "true"');
  });

  it("refuses live JIT provisioning without an explicit fresh worker image", () => {
    setTestEnv({
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
      GHOLA_PRIVATE_AGENT_JIT_PROVISIONING: "true",
      GHOLA_HYPERLIQUID_LIVE_MODE: "tiny_fill",
      PHALA_CLOUD_API_KEY: "phala-key",
    });

    expect(phalaJitProvisioningConfigured()).toBe(false);
    expect(phalaWorkerImageConfiguredForRequestedMode()).toBe(false);
    expect(phalaJitProvisioningConfigIssue()).toContain(
      "GHOLA_PRIVATE_AGENT_WORKER_IMAGE",
    );
  });

  it("binds recipient evidence to recipient id and public key", () => {
    const first = expectedRecipientReportDataHex({
      recipientId: "phala:cvm:one",
      x25519PubHex: "11".repeat(32),
    });
    const second = expectedRecipientReportDataHex({
      recipientId: "phala:cvm:two",
      x25519PubHex: "11".repeat(32),
    });
    const withFundingSigner = expectedRecipientReportDataHex({
      recipientId: "phala:cvm:one",
      x25519PubHex: "11".repeat(32),
      fundingSignerPublicKeyB64: "MCowBQYDK2VwAyEA0000000000000000000000000000000000000000000=",
    });

    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(withFundingSigner).not.toBe(first);
  });

  it("uses a bounded idle lease and allows explicit idle shutdown disable", () => {
    setTestEnv({
      GHOLA_PRIVATE_AGENT_JIT_PROVISIONING: "true",
      GHOLA_PRIVATE_AGENT_IDLE_AFTER_MINUTES: "10",
    });

    expect(phalaIdleShutdownEnabled()).toBe(true);
    expect(phalaIdleLeaseMs()).toBe(10 * 60_000);

    process.env.GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN = "false";
    expect(phalaIdleShutdownEnabled()).toBe(false);
  });

  it("uses a short bounded worker-ready poll without allowing a busy loop", () => {
    setTestEnv({ GHOLA_PHALA_WORKER_READY_POLL_MS: "250" });
    expect(phalaWorkerReadyPollMs()).toBe(500);

    process.env.GHOLA_PHALA_WORKER_READY_POLL_MS = "1250";
    expect(phalaWorkerReadyPollMs()).toBe(1_250);
  });

  it("allows a bounded cross-region recipient attestation probe", () => {
    setTestEnv({ GHOLA_PHALA_RECIPIENT_FETCH_TIMEOUT_MS: "1000" });
    expect(phalaRecipientFetchTimeoutMs()).toBe(5_000);

    process.env.GHOLA_PHALA_RECIPIENT_FETCH_TIMEOUT_MS = "20000";
    expect(phalaRecipientFetchTimeoutMs()).toBe(20_000);
  });

  it("skips expensive attestation and recipient discovery until the CVM is running", async () => {
    setTestEnv({
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
      GHOLA_PRIVATE_AGENT_JIT_PROVISIONING: "true",
      PHALA_CLOUD_API_KEY: "phala-key",
    });
    cloudClient.getCvmInfo.mockResolvedValue({ id: "cvm-1", status: "starting" });

    const provider = await discoverPhalaPrivateAgentProvider();

    expect(provider).toMatchObject({
      configured: true,
      available: false,
      attested: false,
      evidence: { cvm_status: "starting" },
    });
    expect(cloudClient.getCvmNetwork).not.toHaveBeenCalled();
    expect(cloudClient.getCvmAttestation).not.toHaveBeenCalled();
  });

  it("keeps only a Hobby-compatible daily disaster-recovery sweep", () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as { crons?: Array<{ path?: string; schedule?: string }> };
    const idle = config.crons?.find((cron) => cron.path === "/api/private-agent/idle");

    expect(idle?.schedule).toBe("0 1 * * *");
  });

  it("coalesces concurrent wake requests and restarts a stopped CVM without full discovery", async () => {
    setTestEnv({
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
      GHOLA_PRIVATE_AGENT_FUNDING_SIGNING_KEY: "funding-key",
      GHOLA_PRIVATE_AGENT_JIT_PROVISIONING: "true",
      GHOLA_WORKER_CAPABILITY_SECRET: "capability-secret",
      PHALA_CLOUD_API_KEY: "phala-key",
    });

    let resolveInfo!: (value: unknown) => void;
    const infoPromise = new Promise((resolve) => { resolveInfo = resolve; });
    cloudClient.getCvmInfo.mockReturnValueOnce(infoPromise);
    cloudClient.getCvmState.mockResolvedValue({ status: "stopped" });
    cloudClient.startCvm.mockResolvedValue({ status: "starting" });

    const first = ensurePhalaPrivateAgentProvisioned();
    const second = ensurePhalaPrivateAgentProvisioned();
    resolveInfo({ id: "cvm-1", status: "stopped" });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(firstResult.status).toBe("provisioning");
    expect(cloudClient.getCvmInfo).toHaveBeenCalledTimes(1);
    expect(cloudClient.getCvmState).toHaveBeenCalledTimes(1);
    expect(cloudClient.startCvm).toHaveBeenCalledTimes(1);
    expect(cloudClient.getCvmNetwork).not.toHaveBeenCalled();
    expect(cloudClient.getCvmAttestation).not.toHaveBeenCalled();
  });

  it("refuses to provision duplicate paid capacity after a transient lookup failure", async () => {
    setTestEnv({
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
      GHOLA_PRIVATE_AGENT_FUNDING_SIGNING_KEY: "funding-key",
      GHOLA_PRIVATE_AGENT_JIT_PROVISIONING: "true",
      GHOLA_WORKER_CAPABILITY_SECRET: "capability-secret",
      PHALA_CLOUD_API_KEY: "phala-key",
    });
    cloudClient.getCvmInfo.mockRejectedValue({ status: 503 });

    const result = await ensurePhalaPrivateAgentProvisioned();

    expect(result.status).toBe("failed");
    expect(result.attempted).toBe(false);
    expect(result.reason).toContain("duplicate paid capacity");
    expect(cloudClient.provisionCvm).not.toHaveBeenCalled();
  });

  it("does not stop Phala while a private-agent lease is active", async () => {
    setTestEnv({
      GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN: "true",
      GHOLA_PRIVATE_AGENT_LEASE_STORE: "memory",
      PHALA_CLOUD_API_KEY: "phala-key",
    });
    const now = new Date("2026-06-06T12:00:00.000Z");
    await markPhalaPrivateAgentActivity({
      reason: "test_active_use",
      leaseMs: 30 * 60_000,
      now,
    });

    const result = await stopIdlePhalaPrivateAgent({ now });

    expect(result.status).toBe("lease_active");
    expect(result.attempted).toBe(false);
    expect(result.stopped).toBe(false);
    expect(result.lease_expires_at).toBe("2026-06-06T12:30:00.000Z");
  });
});
