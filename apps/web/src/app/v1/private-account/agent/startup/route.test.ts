import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import {
  putPrivateVenueCapability,
  resetPrivateAccountStoreForTests,
} from "@/lib/private-account-store";
import {
  createOrGetStoredPrivateAccount,
  privateAccountOwnerFromRequest,
} from "../../_lib";

const ENV_KEYS = [
  "GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER",
  "GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS",
  "GHOLA_PRIVATE_AGENT_PROVIDER",
  "GHOLA_PRIVATE_AGENT_SPEND_ARMED",
  "GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN",
  "GHOLA_LIVE_TRADING_PUBLIC_ENABLED",
  "GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET",
  "GHOLA_PRIVATE_RUNTIME_URL",
  "GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN",
  "GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD",
  "GHOLA_LIVE_TRADING_DAILY_CAP_USD",
  "GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS",
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
  "GHOLA_JUPITER_ALLOWED_INPUT_MINTS",
  "GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS",
  "PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD",
  "GHOLA_V6_COINBASE_PILOT_ENABLED",
  "GHOLA_COINBASE_LIVE_MODE",
  "PRIVATE_AGENT_COINBASE_LIVE_MODE",
  "PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS",
  "PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD",
] as const;

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function request(authHeader?: string) {
  return new Request("https://ghola.test/v1/private-account/agent/startup", {
    headers: authHeader ? { authorization: authHeader } : undefined,
  });
}

describe("public agent startup route", () => {
  beforeEach(async () => {
    clearEnv();
    await resetPrivateAccountStoreForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearEnv();
    await resetPrivateAccountStoreForTests();
  });

  it("returns a signed-out, fail-closed startup model by default", async () => {
    process.env.GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN = "true";

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.authenticated).toBe(false);
    expect(body.runtime).toMatchObject({
      status: "blocked",
      ready: false,
    });
    expect(body.primary_action).toMatchObject({
      label: "Sign in to connect a venue",
      enabled: true,
    });
    expect(body.venues).toHaveLength(4);
    expect(body.venues.every((venue: { user_access: string; can_start_live: boolean }) => (
      venue.user_access === "sign_in_required" && venue.can_start_live === false
    ))).toBe(true);
    expect(JSON.stringify(body)).not.toContain("pooled_worker_probe_failed");
  });

  it("shows authenticated venue choices without marking missing credentials green", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN = "true";
    enableGreenByoEnv();

    const res = await GET(request(auth("agent_startup_user_1")));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.authenticated).toBe(true);
    expect(body.live_trading.byo_live_trading_enabled).toBe(true);
    expect(body.agent_passport.status).toBe("blocked");
    expect(body.venues.map((venue: { id: string; live_gate: string }) => [venue.id, venue.live_gate])).toEqual([
      ["coinbase", "green"],
      ["jupiter", "green"],
      ["phoenix", "green"],
      ["hyperliquid", "green"],
    ]);
    expect(body.venues.find((venue: { id: string }) => venue.id === "coinbase")).toMatchObject({
      user_access: "connect_required",
      can_prepare: false,
      can_start_live: false,
    });
    expect(body.venues.find((venue: { id: string }) => venue.id === "phoenix")).toMatchObject({
      user_access: "wallet_required",
      can_prepare: true,
      can_start_live: false,
    });
  });

  it("marks a venue live only when runtime, live gate, and access are ready", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_AGENT_SPEND_ARMED = "true";
    process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER = "true";
    process.env.GHOLA_PRIVATE_AGENT_PROVIDER = "mock_attested";
    enableGreenByoEnv();
    mockPrivatePaymentRailReady();
    const authHeader = auth("agent_startup_user_2");
    await storeReadyCoinbaseCapability(authHeader);

    const res = await GET(request(authHeader));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.runtime).toMatchObject({
      status: "ready",
      ready: true,
      selected_provider: "mock_attested",
    });
    expect(body.venues.find((venue: { id: string }) => venue.id === "coinbase")).toMatchObject({
      live_gate: "green",
      user_access: "ready",
      can_prepare: true,
      can_start_live: true,
      status_label: "Agent ready",
    });
    expect(body.venues.find((venue: { id: string }) => venue.id === "phoenix")).toMatchObject({
      user_access: "wallet_required",
      can_prepare: true,
      can_start_live: false,
    });
    expect(body.primary_action.label).toBe("Start Coinbase agent");
  });
});

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function enableGreenByoEnv() {
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
  process.env.GHOLA_COINBASE_LIVE_MODE = "full";
  process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
  process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = "BTC-USD,ETH-USD,SOL-USD";
  process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD = "1000";
}

function mockPrivatePaymentRailReady() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/health/payments")) {
      return new Response(JSON.stringify({
        rails: {
          aleo_usdcx_shielded: {
            configured: true,
            ready: true,
            fallback_allowed: false,
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
}

async function storeReadyCoinbaseCapability(authHeader: string) {
  const owner = await privateAccountOwnerFromRequest(request(authHeader));
  if (!owner) throw new Error("missing test owner");
  const account = await createOrGetStoredPrivateAccount(owner);
  const now = new Date().toISOString();
  await putPrivateVenueCapability({
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: "coinbase_advanced",
    capability_commitment: "capability_coinbase_ready_test",
    status: "ready",
    capability: {
      version: 1,
      venue_id: "coinbase_advanced",
      platform_class: "coinbase_style_provider",
      execution_mode: "byo_api_key",
      source: "user_provided_credentials",
      can_read: true,
      can_trade: true,
      can_withdraw: false,
      allowed_operations: ["read", "preview_order", "spot_limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw"],
      vault_commitment: "vault_coinbase_ready_test",
      encrypted_vault_commitment: "encrypted_vault_coinbase_ready_test",
      permission_commitment: "capability_coinbase_ready_test",
      status: "ready",
      reason_codes: [],
      created_at: now,
      updated_at: now,
    },
    created_at: now,
    updated_at: now,
  });
}
