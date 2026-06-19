import { afterEach, describe, expect, it } from "vitest";
import {
  buildPhalaWorkerCompose,
  expectedRecipientReportDataHex,
  markPhalaPrivateAgentActivity,
  phalaIdleLeaseMs,
  phalaIdleShutdownEnabled,
  phalaJitProvisioningConfigIssue,
  phalaJitProvisioningConfigured,
  phalaJitProvisioningEnabled,
  phalaWakeOnUseEnabled,
  privateAgentRemoteExecutionDisabled,
  privateAgentSpendArmed,
  phalaWorkerImageConfiguredForRequestedMode,
  stopIdlePhalaPrivateAgent,
} from "./private-agent-phala";
import { resetPrivateAgentRuntimeLeaseStoreForTests } from "./private-agent-runtime-lease";

const ORIGINAL_ENV = { ...process.env };
const TEST_ENV_KEYS = [
  "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
  "GHOLA_PRIVATE_AGENT_IDLE_AFTER_MINUTES",
  "GHOLA_PRIVATE_AGENT_IDLE_AFTER_MS",
  "GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN",
  "GHOLA_PRIVATE_AGENT_IMAGE_DIGEST",
  "GHOLA_PRIVATE_AGENT_JIT_PROVISIONING",
  "GHOLA_PRIVATE_AGENT_LEASE_STORE",
  "GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED",
  "GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN",
  "GHOLA_PRIVATE_AGENT_SPEND_ARMED",
  "GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED",
  "GHOLA_PRIVATE_AGENT_STATE_STORE",
  "GHOLA_PRIVATE_AGENT_STATE_POSTGRES_URL",
  "GHOLA_PRIVATE_AGENT_FUNDING_SIGNING_KEY",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
  "GHOLA_PRIVATE_ACCOUNT_DATABASE_URL",
  "GHOLA_HYPERLIQUID_LIVE_MODE",
  "GHOLA_HYPERLIQUID_LIVE_DAILY_NOTIONAL_CAP_USD",
  "GHOLA_HYPERLIQUID_LIVE_MAX_SLIPPAGE_BPS",
  "GHOLA_JUPITER_API_KEY",
  "GHOLA_WORKER_CAPABILITY_SECRET",
  "DATABASE_URL",
  "JUPITER_API_KEY",
  "PHALA_API_KEY",
  "PHALA_CLOUD_API_KEY",
  "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
  "PRIVATE_AGENT_EXECUTION_TOKEN",
  "PRIVATE_AGENT_FUNDING_SIGNING_KEY",
  "PRIVATE_AGENT_STATE_STORE",
  "PRIVATE_AGENT_STATE_POSTGRES_URL",
  "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON",
  "PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_JUPITER_API_KEY",
  "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON",
  "VERCEL_ENV",
];

afterEach(() => {
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
      'PRIVATE_AGENT_EXECUTION_TOKEN: "${PRIVATE_AGENT_EXECUTION_TOKEN}"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "${PRIVATE_AGENT_WORKER_CAPABILITY_SECRET}"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_FUNDING_SIGNING_KEY: "${PRIVATE_AGENT_FUNDING_SIGNING_KEY:-}"',
    );
    expect(compose).toContain('PRIVATE_AGENT_STATE_STORE: "json"');
    expect(compose).toContain(
      'PRIVATE_AGENT_STATE_POSTGRES_URL: "${PRIVATE_AGENT_STATE_POSTGRES_URL:-}"',
    );
    expect(compose).toContain('PRIVATE_AGENT_VENUE_DRY_RUN: "false"');
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
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON: "${PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON:-}"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON: "${PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON:-}"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_JUPITER_API_KEY: "${PRIVATE_AGENT_JUPITER_API_KEY:-}"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON: "${PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON:-}"',
    );
    expect(compose).not.toMatch(/PHALA_CLOUD_API_KEY|PHALA_API_KEY/);
    expect(compose).not.toMatch(/prompt|strategy_text|messages|policy:/i);
  });

  it("uses shared Postgres state when the private-account database URL is available", () => {
    setTestEnv({
      GHOLA_PRIVATE_ACCOUNT_DATABASE_URL: "postgresql://user:pass@example.neon.tech/db",
    });

    const compose = buildPhalaWorkerCompose({
      image: "ghcr.io/example/worker@sha256:abc",
      imageDigest: "sha256:abc",
    });

    expect(compose).toContain('PRIVATE_AGENT_STATE_STORE: "postgres"');
    expect(compose).toContain(
      'PRIVATE_AGENT_STATE_POSTGRES_URL: "${PRIVATE_AGENT_STATE_POSTGRES_URL:-}"',
    );
    expect(compose).not.toContain("postgresql://user:pass@example.neon.tech/db");
  });

  it("pins a tag-only worker image to the configured digest", () => {
    const compose = buildPhalaWorkerCompose({
      image: "ghcr.io/example/worker:private-agent-worker-c8d4eca",
      imageDigest: "sha256:def",
    });

    expect(compose).toContain(
      "image: ghcr.io/example/worker:private-agent-worker-c8d4eca@sha256:def",
    );
    expect(compose).toContain('PHALA_CVM_IMAGE_DIGEST: "sha256:def"');
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

  it("auto-arms production wake-on-use when Phala credentials are configured", () => {
    setTestEnv({
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
      GHOLA_PRIVATE_AGENT_JIT_PROVISIONING: "false",
      PHALA_CLOUD_API_KEY: "phala-key",
      VERCEL_ENV: "production",
    });

    expect(privateAgentSpendArmed()).toBe(true);
    expect(privateAgentRemoteExecutionDisabled()).toBe(false);
    expect(phalaWakeOnUseEnabled()).toBe(true);
    expect(phalaJitProvisioningEnabled()).toBe(true);
    expect(phalaIdleShutdownEnabled()).toBe(true);

    process.env.GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED = "false";
    expect(privateAgentSpendArmed()).toBe(false);
    expect(privateAgentRemoteExecutionDisabled()).toBe(true);
    expect(phalaWakeOnUseEnabled()).toBe(false);
    expect(phalaJitProvisioningEnabled()).toBe(false);
  });

  it("keeps explicit production spend locks authoritative", () => {
    setTestEnv({
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
      PHALA_CLOUD_API_KEY: "phala-key",
      GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN: "true",
      VERCEL_ENV: "production",
    });

    expect(privateAgentSpendArmed()).toBe(true);
    expect(privateAgentRemoteExecutionDisabled()).toBe(true);
    expect(phalaWakeOnUseEnabled()).toBe(false);
    expect(phalaJitProvisioningEnabled()).toBe(false);
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
