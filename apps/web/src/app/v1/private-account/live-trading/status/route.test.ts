import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { POST as POSTCanaryReport } from "../canary-report/route";
import { resetPrivateAccountStoreForTests } from "@/lib/private-account-store";

const ENV_KEYS = [
  "GHOLA_LIVE_TRADING_PUBLIC_ENABLED",
  "PRIVATE_AGENT_VENUE_DRY_RUN",
  "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET",
  "GHOLA_PRIVATE_RUNTIME_URL",
  "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
  "GHOLA_PRIVATE_AGENT_WORKER_URL",
  "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
  "PRIVATE_AGENT_EXECUTION_TOKEN",
  "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
  "GHOLA_WORKER_CAPABILITY_SECRET",
  "GHOLA_POOLED_WORKER_READINESS_TIMEOUT_MS",
  "GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN",
  "GHOLA_HYPERLIQUID_POOLED_ACCOUNT_POOL_READY",
  "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON",
  "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_PATH",
  "GHOLA_PHOENIX_POOLED_AUTHORITY_READY",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_SOLANA_PERPS_POOL_VAULT_JSON",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_PATH",
  "PRIVATE_AGENT_SOLANA_PERPS_POOL_VAULT_PATH",
  "GHOLA_JUPITER_POOLED_AUTHORITY_READY",
  "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_SOLANA_SWAP_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_JUPITER_POOLED_VAULT_PATH",
  "PRIVATE_AGENT_SOLANA_SWAP_POOLED_VAULT_PATH",
  "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON",
  "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_PATH",
  "GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD",
  "GHOLA_LIVE_TRADING_DAILY_CAP_USD",
  "GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS",
  "GHOLA_LIVE_TRADING_CANARY_MAX_STALE_MS",
  "GHOLA_V6_HYPERLIQUID_PILOT_ENABLED",
  "GHOLA_HYPERLIQUID_LIVE_MODE",
  "PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE",
  "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS",
  "GHOLA_VENUE_PHOENIX_PILOT_ENABLED",
  "GHOLA_SOLANA_PERPS_LIVE_MODE",
  "PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET",
  "PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE",
  "PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS",
  "GHOLA_VENUE_JUPITER_PILOT_ENABLED",
  "GHOLA_JUPITER_LIVE_MODE",
  "PRIVATE_AGENT_JUPITER_LIVE_MODE",
  "GHOLA_JUPITER_API_KEY",
  "GHOLA_JUPITER_API_KEY_READY",
  "PRIVATE_AGENT_JUPITER_API_KEY",
  "JUPITER_API_KEY",
  "GHOLA_JUPITER_ALLOWED_INPUT_MINTS",
  "PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS",
  "GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS",
  "PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS",
  "PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD",
  "GHOLA_V6_COINBASE_PILOT_ENABLED",
  "GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED",
  "GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY",
  "GHOLA_COINBASE_LIVE_MODE",
  "PRIVATE_AGENT_COINBASE_LIVE_MODE",
  "PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS",
  "PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD",
] as const;

describe("private account live trading launch gate", () => {
  beforeEach(async () => {
    clearGateEnv();
    await resetPrivateAccountStoreForTests();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    clearGateEnv();
    await resetPrivateAccountStoreForTests();
  });

  it("keeps public live trading red by default", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "red",
      live_trading_enabled: false,
      live_submit_mode: "disabled",
      byo_live_trading_enabled: false,
      pooled_live_trading_enabled: false,
      public_live_copy_allowed: false,
      public_market_data_enabled: false,
      default_access_mode: "ghola_auto_access",
    });
    expect(body.reason_codes).toContain("live_trading_public_flag_disabled");
    expect(body.required_venues).toHaveLength(4);
    expect(body.required_venues.every((venue: { status: string }) => venue.status === "red")).toBe(true);
  });

  it("enables BYO mainnet live submit with ready env before pooled pools are configured", async () => {
    enableGreenGateEnv();

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("green");
    expect(body.live_trading_enabled).toBe(true);
    expect(body.live_submit_mode).toBe("byo_mainnet");
    expect(body.byo_live_trading_enabled).toBe(true);
    expect(body.pooled_live_trading_enabled).toBe(false);
    expect(body.public_live_copy_allowed).toBe(true);
    expect(body.public_market_data_enabled).toBe(true);
    expect(body.reason_codes).toEqual([]);
    expect(body.pooled_reason_codes).toContain("pooled_worker_endpoint_missing");
    expect(body.byo_live_venues.filter((venue: { status: string }) => venue.status === "green").map((venue: { id: string }) => venue.id)).toEqual([
      "hyperliquid",
      "phoenix",
      "jupiter",
      "coinbase",
    ]);
    expect(body.required_venues.map((venue: { id: string; canary_status: string }) => ({
      id: venue.id,
      canary_status: venue.canary_status,
    }))).toEqual([
      { id: "hyperliquid", canary_status: "missing" },
      { id: "phoenix", canary_status: "missing" },
      { id: "jupiter", canary_status: "missing" },
      { id: "coinbase", canary_status: "missing" },
    ]);
  });

  it("does not require sealed runtime health for BYO scoped-account live submit", async () => {
    enableGreenGateEnv();
    delete process.env.GHOLA_PRIVATE_RUNTIME_URL;

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("green");
    expect(body.live_trading_enabled).toBe(true);
    expect(body.live_submit_mode).toBe("byo_mainnet");
    expect(body.byo_live_trading_enabled).toBe(true);
    expect(body.pooled_live_trading_enabled).toBe(false);
    expect(body.reason_codes).toEqual([]);
    expect(body.pooled_reason_codes).toContain("pooled_worker_endpoint_missing");
  });

  it("rejects unauthenticated canary reports", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = "internal_live_canary_token_32_bytes";
    const res = await POSTCanaryReport(new Request("https://ghola.example/v1/private-account/live-trading/canary-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(greenCanaryBody("hyperliquid")),
    }));
    expect(res.status).toBe(401);
  });

  it("does not turn pooled green from pool flags without a worker proof", async () => {
    enableGreenGateEnv();
    enablePooledPoolEnv();

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("green");
    expect(body.live_submit_mode).toBe("byo_mainnet");
    expect(body.pooled_live_trading_enabled).toBe(false);
    expect(body.pooled_reason_codes).toContain("pooled_worker_endpoint_missing");
  });

  it("turns pooled green only when the worker proves every venue pool is ready", async () => {
    enableGreenGateEnv();
    enablePooledPoolEnv();
    enablePooledWorkerEnv();
    const fetchSpy = mockPooledWorkerReady();

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "green",
      live_trading_enabled: true,
      live_submit_mode: "pooled_and_byo",
      byo_live_trading_enabled: true,
      pooled_live_trading_enabled: true,
      public_live_copy_allowed: true,
      public_market_data_enabled: true,
      default_access_mode: "ghola_auto_access",
      reason_codes: [],
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(body.pooled_worker_readiness).toMatchObject({
      status: "ready",
      ready: true,
      endpoint_configured: true,
      reason_codes: [],
    });
    expect(body.required_venues.map((venue: { id: string; status: string; canary_status: string; canary_required: boolean }) => ({
      id: venue.id,
      status: venue.status,
      canary_status: venue.canary_status,
      canary_required: venue.canary_required,
    }))).toEqual([
      { id: "hyperliquid", status: "green", canary_status: "missing", canary_required: false },
      { id: "phoenix", status: "green", canary_status: "missing", canary_required: false },
      { id: "jupiter", status: "green", canary_status: "missing", canary_required: false },
      { id: "coinbase", status: "green", canary_status: "missing", canary_required: false },
    ]);
  });

  it("turns pooled live for the ready venues without blocking on every pooled venue", async () => {
    enableGreenGateEnv();
    enablePooledWorkerEnv();
    const fetchSpy = mockPooledWorkerPartiallyReady();

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "green",
      live_trading_enabled: true,
      live_submit_mode: "pooled_and_byo",
      byo_live_trading_enabled: true,
      pooled_live_trading_enabled: true,
      pooled_live_venues: ["phoenix"],
      pooled_reason_codes: [],
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(body.pooled_unavailable_reason_codes).toEqual(expect.arrayContaining([
      "hyperliquid:hyperliquid_pooled_account_pool_missing",
      "jupiter:jupiter_api_key_missing",
      "coinbase:coinbase_omnibus_pool_not_ready",
    ]));
    expect(body.required_venues.map((venue: { id: string; status: string }) => ({
      id: venue.id,
      status: venue.status,
    }))).toEqual([
      { id: "hyperliquid", status: "red" },
      { id: "phoenix", status: "green" },
      { id: "jupiter", status: "red" },
      { id: "coinbase", status: "red" },
    ]);
  });
});

function clearGateEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function enableGreenGateEnv() {
  process.env.GHOLA_LIVE_TRADING_PUBLIC_ENABLED = "true";
  process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET = "secure_private_account_request_proof_secret_32bytes";
  process.env.GHOLA_PRIVATE_RUNTIME_URL = "https://runtime.ghola.example";
  process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN = "internal_live_canary_token_32_bytes";
  process.env.GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD = "1000";
  process.env.GHOLA_LIVE_TRADING_DAILY_CAP_USD = "5000";
  process.env.GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS = "100";
  process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
  process.env.GHOLA_HYPERLIQUID_LIVE_MODE = "full_ticket";
  process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "full_ticket";
  process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD = "1000";
  process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD = "5000";
  process.env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS = "100";
  process.env.GHOLA_VENUE_PHOENIX_PILOT_ENABLED = "true";
  process.env.GHOLA_SOLANA_PERPS_LIVE_MODE = "full_ticket";
  process.env.PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE = "full_ticket";
  process.env.PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD = "1000";
  process.env.PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS = "100";
  process.env.GHOLA_VENUE_JUPITER_PILOT_ENABLED = "true";
  process.env.GHOLA_JUPITER_LIVE_MODE = "full";
  process.env.PRIVATE_AGENT_JUPITER_LIVE_MODE = "full";
  process.env.GHOLA_JUPITER_API_KEY = "jupiter-api-key";
  process.env.GHOLA_JUPITER_ALLOWED_INPUT_MINTS = "So11111111111111111111111111111111111111112";
  process.env.GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  process.env.PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS = "100";
  process.env.PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD = "1000";
  process.env.GHOLA_V6_COINBASE_PILOT_ENABLED = "true";
  process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED = "true";
  process.env.GHOLA_COINBASE_LIVE_MODE = "full";
  process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
  process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = "BTC-USD,ETH-USD,SOL-USD";
  process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD = "1000";
}

function enablePooledPoolEnv() {
  process.env.GHOLA_HYPERLIQUID_POOLED_ACCOUNT_POOL_READY = "true";
  process.env.GHOLA_PHOENIX_POOLED_AUTHORITY_READY = "true";
  process.env.GHOLA_JUPITER_POOLED_AUTHORITY_READY = "true";
  process.env.GHOLA_JUPITER_API_KEY_READY = "true";
  process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY = "true";
}

function enablePooledWorkerEnv() {
  process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.ghola.example";
  process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "test-worker-capability-secret";
}

function mockPooledWorkerReady() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    version: 1,
    status: "ready",
    ready: true,
    operation_class: "pooled_readiness",
    state_store: { mode: "postgres", shared: true },
    venues: [
      { venue_id: "hyperliquid", status: "ready", ready: true, reason_codes: [], credential_count: 1 },
      { venue_id: "phoenix", status: "ready", ready: true, reason_codes: [], authority_commitment: "phoenix_authority_commitment" },
      { venue_id: "jupiter", status: "ready", ready: true, reason_codes: [], authority_commitment: "jupiter_authority_commitment" },
      { venue_id: "coinbase", status: "ready", ready: true, reason_codes: [], credential_commitment: "coinbase_credential_commitment" },
    ],
    reason_codes: [],
    checked_at: new Date().toISOString(),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

function mockPooledWorkerPartiallyReady() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    version: 1,
    status: "blocked",
    ready: false,
    operation_class: "pooled_readiness",
    state_store: { mode: "postgres", shared: true },
    venues: [
      { venue_id: "hyperliquid", status: "blocked", ready: false, reason_codes: ["hyperliquid_pooled_account_pool_missing"] },
      { venue_id: "phoenix", status: "ready", ready: true, reason_codes: [], authority_commitment: "phoenix_authority_commitment" },
      { venue_id: "jupiter", status: "blocked", ready: false, reason_codes: ["jupiter_api_key_missing", "jupiter_pooled_authority_missing"] },
      { venue_id: "coinbase", status: "blocked", ready: false, reason_codes: ["coinbase_omnibus_pool_not_ready"] },
    ],
    reason_codes: [],
    checked_at: new Date().toISOString(),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

function greenCanaryBody(venueId: "hyperliquid" | "phoenix" | "jupiter" | "coinbase") {
  return {
    report_id: `canary_${venueId}_full_ticket_green`,
    venue_id: venueId,
    network: "mainnet",
    status: "green",
    live_mode: "full_ticket",
    canary_kind: "full_ticket_broadcast",
    broadcast_performed: true,
    reconcile_status: "reconciled",
    order_notional_usd: 5,
    max_order_notional_usd: 1000,
    daily_cap_usd: 5000,
    max_slippage_bps: 100,
    receipt_commitment: `receipt_${venueId}_commitment`,
    result_commitment: `result_${venueId}_commitment`,
    observed_at: new Date().toISOString(),
  };
}
