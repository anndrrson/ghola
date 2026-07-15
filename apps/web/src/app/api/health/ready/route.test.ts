import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/consumer-production-store", () => ({
  consumerProductionStoreReady: vi.fn(async () => true),
  getConsumerCircuitState: vi.fn(async () => ({ status: "open" })),
  getConsumerReconciliationHealth: vi.fn(async () => ({
    ready: true,
    overdue_order_count: 0,
    oldest_unreconciled_age_ms: 0,
  })),
}));

vi.mock("@/lib/private-agent-runtime-server", () => ({
  getPrivateAgentRuntimeStatus: vi.fn(async () => ({
    remote_execution_ready: true,
    selected_provider: "phala",
    providers: [{ id: "phala", configured: true, evidence: { cvm_status: "running" } }],
  })),
}));

vi.mock("@/lib/private-account-verifier", () => ({
  customShieldedVerifierHealth: vi.fn(async () => ({ status: "red" })),
}));

vi.mock("@/lib/private-account-shielded-pool", () => ({
  shieldedPoolHealth: vi.fn(async () => ({ status: "red" })),
}));

import { GET } from "./route";

const ORIGINAL_ENV = { ...process.env };
const TEST_KEYS = [
  "GHOLA_CONSUMER_LAUNCH_PROFILE",
  "GHOLA_OBSERVABILITY_PROVIDER",
  "GHOLA_HYPERLIQUID_LIVE_MODE",
  "GHOLA_HYPERLIQUID_ALLOW_MAINNET",
  "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL",
  "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN",
  "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
  "GHOLA_TRADING_CONTROL_TOKEN",
  "GHOLA_RECONCILIATION_INGEST_TOKEN",
  "GHOLA_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT",
  "GHOLA_CONSUMER_SOLANA_RPC_URL",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "VERCEL_ENV",
] as const;

afterEach(() => {
  for (const key of TEST_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

describe("consumer production readiness", () => {
  it("allows the explicit BYO Hyperliquid profile without pooled custody rails", async () => {
    Object.assign(process.env, {
      GHOLA_CONSUMER_LAUNCH_PROFILE: "byo_hyperliquid",
      GHOLA_OBSERVABILITY_PROVIDER: "vercel",
      GHOLA_HYPERLIQUID_LIVE_MODE: "full_ticket",
      GHOLA_HYPERLIQUID_ALLOW_MAINNET: "true",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.example",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "connector-token",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_TRADING_CONTROL_TOKEN: "control-token",
      GHOLA_RECONCILIATION_INGEST_TOKEN: "reconciliation-token",
      VERCEL_ENV: "production",
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.launch_profile).toBe("byo_hyperliquid");
    expect(body.checks.byo_hyperliquid).toBe("ready");
    expect(body.checks.public_usdc).toBe("not_required");
    expect(body.checks.withdrawal_dispatch).toBe("not_required");
  });

  it("keeps pooled consumer launch blocked when custody rails are absent", async () => {
    Object.assign(process.env, {
      GHOLA_CONSUMER_LAUNCH_PROFILE: "pooled_consumer",
      GHOLA_OBSERVABILITY_PROVIDER: "vercel",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_TRADING_CONTROL_TOKEN: "control-token",
      GHOLA_RECONCILIATION_INGEST_TOKEN: "reconciliation-token",
      VERCEL_ENV: "production",
    });
    delete process.env.GHOLA_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.checks.public_usdc).toBe("blocked");
    expect(body.reason_codes).toContain("public_usdc:blocked");
  });
});
