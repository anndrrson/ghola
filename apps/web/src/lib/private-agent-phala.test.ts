import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPhalaWorkerCompose,
  discoverPhalaPrivateAgentProvider,
  expectedRecipientReportDataHex,
  markPhalaPrivateAgentActivity,
  phalaIdleLeaseMs,
  phalaIdleShutdownEnabled,
  phalaJitProvisioningConfigIssue,
  phalaJitProvisioningConfigured,
  phalaWorkerImageConfiguredForRequestedMode,
  phalaWorkerComposeMatchesDesired,
  phalaWorkerComposeUsesImage,
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
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
  "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
  "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL",
  "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64",
  "GHOLA_HYPERLIQUID_LIVE_MODE",
  "GHOLA_HYPERLIQUID_LIVE_DAILY_NOTIONAL_CAP_USD",
  "GHOLA_HYPERLIQUID_LIVE_MAX_SLIPPAGE_BPS",
  "PHALA_API_KEY",
  "PHALA_CLOUD_API_KEY",
  "PRIVATE_AGENT_EXECUTION_TOKEN",
  "PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS",
];

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "disabled"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "15"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: "25"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "50"',
    );
    expect(compose).toContain(
      'PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS: "30000"',
    );
    expect(compose).not.toMatch(/PHALA_CLOUD_API_KEY|PHALA_API_KEY/);
    expect(compose).not.toMatch(/prompt|strategy_text|messages|policy:/i);
  });

  it("detects whether an existing CVM compose uses the configured worker image", () => {
    const currentCompose = buildPhalaWorkerCompose({
      image: "ghcr.io/example/worker@sha256:fresh",
      imageDigest: "sha256:fresh",
    });

    expect(
      phalaWorkerComposeUsesImage({
        currentCompose,
        image: "ghcr.io/example/worker@sha256:fresh",
        imageDigest: "sha256:fresh",
      }),
    ).toBe(true);
    expect(
      phalaWorkerComposeUsesImage({
        currentCompose,
        image: "ghcr.io/example/worker@sha256:new",
        imageDigest: "sha256:new",
      }),
    ).toBe(false);
    expect(
      phalaWorkerComposeUsesImage({
        currentCompose,
        image: "ghcr.io/example/worker@sha256:fresh",
        imageDigest: "sha256:different",
      }),
    ).toBe(false);
  });

  it("reconciles worker policy changes even when the image is unchanged", () => {
    setTestEnv({ PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "5" });
    const oldCompose = buildPhalaWorkerCompose({
      image: "ghcr.io/example/worker@sha256:fresh",
      imageDigest: "sha256:fresh",
    });
    setTestEnv({ PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "10" });
    const desiredCompose = buildPhalaWorkerCompose({
      image: "ghcr.io/example/worker@sha256:fresh",
      imageDigest: "sha256:fresh",
    });

    expect(phalaWorkerComposeUsesImage({
      currentCompose: oldCompose,
      image: "ghcr.io/example/worker@sha256:fresh",
      imageDigest: "sha256:fresh",
    })).toBe(true);
    expect(phalaWorkerComposeMatchesDesired({ currentCompose: oldCompose, desiredCompose })).toBe(false);
    expect(phalaWorkerComposeMatchesDesired({ currentCompose: desiredCompose, desiredCompose })).toBe(true);
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

  it("requires an explicit worker image for full-ticket Hyperliquid mode", () => {
    setTestEnv({
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
      GHOLA_PRIVATE_AGENT_JIT_PROVISIONING: "true",
      GHOLA_HYPERLIQUID_LIVE_MODE: "full_ticket",
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

  it("discovers an attested configured worker without a Phala management key", async () => {
    const recipientId = "phala:cvm:direct-test";
    const x25519PubHex = "11".repeat(32);
    const fundingSignerPublicKeyB64 = "MCowBQYDK2VwAyEAdirect-worker-public-key=";
    const imageDigest = `sha256:${"22".repeat(32)}`;
    const reportDataHex = expectedRecipientReportDataHex({
      recipientId,
      x25519PubHex,
      fundingSignerPublicKeyB64,
    });
    setTestEnv({
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: imageDigest,
      GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: fundingSignerPublicKeyB64,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/.well-known/private-agent-recipient")) {
        return Response.json({
          recipient_id: recipientId,
          x25519_pub_hex: x25519PubHex,
          funding_signer_public_key_b64: fundingSignerPublicKeyB64,
          tee_kind: "phala",
          image_digest: imageDigest,
          report_data_hex: reportDataHex,
          attestation_hash: "aa".repeat(32),
          quote_hash: "aa".repeat(32),
          attested_ready: true,
        });
      }
      if (url.endsWith("/health")) {
        return Response.json({
          service: "ghola-private-agent-worker",
          status: "green",
          ok: true,
          ready: true,
          attested: true,
          attested_ready: true,
          image_digest: imageDigest,
          runtime_attestation_commitment: "runtime_attestation_test",
          runtime_measurement_commitment: "runtime_measurement_test",
        });
      }
      return Response.json({}, { status: 404 });
    }));

    const provider = await discoverPhalaPrivateAgentProvider();

    expect(provider?.available).toBe(true);
    expect(provider?.attested).toBe(true);
    expect(provider?.execution_url).toBe("https://worker.example");
    expect(provider?.sealed_recipient?.recipient_id).toBe(recipientId);
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
