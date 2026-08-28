import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { CORE_PERP_VENUES, venueAdapterCapability } from "@ghola/execution-core";
import {
  createPrivateAgentWorkerServer,
  loadRecipient,
  recipientReportDataHex,
} from "../src/server.js";
import {
  bytesToBase64,
  didKeyFromVerifying,
  hexToBytes,
  sealForTest,
} from "../src/crypto/envelope.js";
import { bodyHash } from "../src/auth/capability.js";
import { createWorkerState } from "../src/state/private-state.js";
import { authenticateCarryCreationOpportunity } from "../src/execution/carry-opportunity-authentication.js";
import {
  asterPreparationId,
  asterRegistrationParameters,
  asterRegistrationTypedData,
} from "../src/venues/aster-provisioning.js";
import { signedCarryPositionInput } from "./carry-mandate-fixture.js";

const OLD_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...OLD_ENV };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const senderSecret = ed25519.utils.randomPrivateKey();
const senderPublic = ed25519.getPublicKey(senderSecret);
const senderDid = didKeyFromVerifying(senderPublic);
const JUPITER_SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPITER_FEE_OWNER = "Fbw73e5YfhivsTeFud97CFBZc5bZ2PbdDVgcgfYRSgwJ";
const LIGHTER_PRIVATE_KEY = "11".repeat(32);
const LIGHTER_PUBLIC_KEY = "22".repeat(40);

function shadowSnapshot(venueId, asset, observedAt) {
  return {
    version: 1,
    venue_id: venueId,
    adapter_mode: "shadow_read_only",
    source_schema: venueAdapterCapability(venueId, "perp_shadow").source_schema,
    trading_api_available: true,
    contract_id: `${venueId}:${asset}`,
    economic_equivalence_id: `carry:${asset}-usd-linear`,
    asset,
    market: `${asset}-USD`,
    quote_asset: venueId === "hyperliquid" || venueId === "aster" ? "USDT" : "USD",
    collateral_asset: venueId === "aster" ? "USDT" : "USDC",
    contract_type: "linear_perp",
    mark_price_e8: 10_000_000_000,
    index_price_e8: 10_000_000_000,
    best_bid_e8: 9_999_000_000,
    best_ask_e8: 10_001_000_000,
    depth_bids: [{ price_e8: 9_999_000_000, size_e8: 100_000_000 }],
    depth_asks: [{ price_e8: 10_001_000_000, size_e8: 100_000_000 }],
    funding_rate_e12_per_interval: 10_000,
    funding_interval_ms: 3_600_000,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    minimum_notional_micro_usdc: 1_000_000,
    quantity_step_e8: 1_000,
    price_tick_e8: 1_000,
    initial_margin_bps: 500,
    maintenance_margin_bps: 250,
    liquidation_fee_bps: 0,
    liquidation_model: "test_margin_liquidation",
    as_of_ms: observedAt,
    source_observed_at_ms: { market: observedAt, funding: observedAt, orderbook: observedAt },
    source_max_age_ms: {
      market: 60_000,
      funding: venueId === "edgex" ? 120_000 : 60_000,
      orderbook: 60_000,
    },
    stale_sources: [],
    status: "ready",
    stale: false,
    missing_fields: [],
    quality_flags: [],
    executable: false,
  };
}

async function recipient(baseUrl) {
  const response = await fetch(`${baseUrl}/.well-known/private-agent-recipient`);
  return response.json();
}

async function sealedBundle(baseUrl, plaintext, aad) {
  const target = await recipient(baseUrl);
  const sealed = await sealForTest({
    senderDid,
    recipientId: target.recipient_id,
    recipientX25519: hexToBytes(target.x25519_pub_hex),
    associatedData: aad,
    plaintext,
    signBody: async (digest) => ed25519.sign(digest, senderSecret),
  });
  return {
    alg: "sealed-provider-v1",
    ciphertext: bytesToBase64(sealed),
    recipient: target.recipient_id,
    aad,
  };
}

async function encryptedRequest(baseUrl, overrides = {}) {
  const target = await recipient(baseUrl);
  return {
    version: 1,
    strategy_id: "strategy_123",
    policy_hash: "policy_hash_123",
    owner_did: senderDid,
    mode: "capped_session_key",
    encrypted_strategy_bundle: await sealedBundle(baseUrl, {
      version: 1,
      kind: "ghola_private_agent_strategy",
      strategy_id: "strategy_123",
      source: "Buy no more than a capped amount.",
      policy: {
        version: 1,
        strategy_id: "strategy_123",
        allowed_assets: ["BTC"],
        max_trade_micro_usdc: 25_000_000,
        daily_cap_micro_usdc: 25_000_000,
        max_actions_per_day: 1,
      },
    }, [
      "ghola-private-agent-session-v1",
      "strategy:strategy_123",
      "policy:policy_hash_123",
      "provider:phala",
      `recipient:${target.recipient_id}`,
    ].join("|")),
    ...overrides,
  };
}

async function encryptedHyperliquidVault(baseUrl, overrides = {}) {
  const target = await recipient(baseUrl);
  return {
    version: 1,
    account_commitment: "acct_commitment_123",
    vault_commitment: "hyperliquid_vault_commitment_123",
    policy_commitment: "hyperliquid_policy_commitment_123",
    encrypted_execution_vault: await sealedBundle(baseUrl, {
      version: 1,
      kind: "ghola_hyperliquid_execution_vault",
      network: "testnet",
      hyperliquid_account_address: "0x0000000000000000000000000000000000000001",
      api_wallet_private_key: "0x1111111111111111111111111111111111111111111111111111111111111111",
      allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
    }, [
      "ghola/hyperliquid-execution-vault-v1",
      "account:acct_commitment_123",
      `recipient:${target.recipient_id}`,
      "network:testnet",
    ].join("|")),
    session_policy: {
      market_allowlist: ["BTC", "ETH"],
      max_notional_bucket: "25",
      max_order_count: 5,
      kill_switch: false,
    },
    ...overrides,
  };
}

async function encryptedHyperliquidExecutionVaultForNetwork(baseUrl, network) {
  const target = await recipient(baseUrl);
  return sealedBundle(baseUrl, {
    version: 1,
    kind: "ghola_hyperliquid_execution_vault",
    network,
    hyperliquid_account_address: "0x0000000000000000000000000000000000000001",
    api_wallet_private_key: "0x1111111111111111111111111111111111111111111111111111111111111111",
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
  }, [
    "ghola/hyperliquid-execution-vault-v1",
    "account:acct_commitment_123",
    `recipient:${target.recipient_id}`,
    `network:${network}`,
  ].join("|"));
}

async function encryptedAsterVault(baseUrl) {
  const target = await recipient(baseUrl);
  const apiWalletPrivateKey = `0x${"31".repeat(32)}`;
  return sealedBundle(baseUrl, {
    version: 1,
    kind: "ghola_aster_execution_vault",
    network: "mainnet",
    user_address: "0x2222222222222222222222222222222222222222",
    signer_address: privateKeyToAccount(apiWalletPrivateKey).address,
    api_wallet_private_key: apiWalletPrivateKey,
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
  }, [
    "ghola/aster-execution-vault-v1",
    "account:acct_commitment_aster_123",
    `recipient:${target.recipient_id}`,
    "network:mainnet",
  ].join("|"));
}

async function encryptedCoinbaseVault(baseUrl) {
  const target = await recipient(baseUrl);
  return sealedBundle(baseUrl, {
    version: 1,
    kind: "ghola_coinbase_advanced_execution_vault",
    network: "sandbox",
    base_url: "https://api-sandbox.coinbase.com/api/v3/brokerage",
    execution_mode: "byo_api_key",
    api_key_name: "organizations/test/apiKeys/test",
    api_private_key_pem: "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIGvY6aoo2dGd5dbwG7Hz3Tj8MwbD0QuR4APs8dP8s91BoAoGCCqGSM49\nAwEHoUQDQgAEUxJ3vyaSbfNuLS9wEVxAIUlA7PAwHFrs4zSj34tpf8jEABERLQzt\nBmg+ObHTkW0HnqRyx5m8lxbvqD8AqXjp3w==\n-----END EC PRIVATE KEY-----",
    portfolio_id: null,
    allowed_operations: ["read", "preview_order", "spot_limit_order", "spot_market_order", "cancel", "fills", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
  }, [
    "ghola/coinbase-advanced-execution-vault-v1",
    "account:acct_commitment_123",
    `recipient:${target.recipient_id}`,
    "mode:byo_api_key",
    "network:sandbox",
  ].join("|"));
}

async function encryptedSolanaPerpsVault(baseUrl) {
  const target = await recipient(baseUrl);
  const keypair = Keypair.generate();
  return sealedBundle(baseUrl, {
    version: 1,
    kind: "ghola_solana_perps_execution_vault",
    venue_id: "phoenix",
    network: "mainnet",
    authority: keypair.publicKey.toBase58(),
    wallet_private_key: Array.from(keypair.secretKey),
    api_url: "https://perp-api.phoenix.trade",
    rpc_url: "https://api.mainnet-beta.solana.com",
    trader_pda_index: 0,
    trader_subaccount_index: 0,
  }, [
    "ghola/solana-perps-execution-vault-v1",
    "account:acct_commitment_123",
    `recipient:${target.recipient_id}`,
    "mode:user_stealth",
    "network:mainnet",
    "venue:phoenix",
  ].join("|"));
}

async function encryptedJupiterVault(baseUrl) {
  const target = await recipient(baseUrl);
  const keypair = Keypair.generate();
  return sealedBundle(baseUrl, {
    version: 1,
    kind: "ghola_solana_swap_execution_vault",
    venue_id: "jupiter",
    network: "mainnet",
    execution_mode: "user_stealth",
    authority: keypair.publicKey.toBase58(),
    wallet_private_key: Array.from(keypair.secretKey),
    swap_api_url: "https://api.jup.ag/swap/v2",
    tx_api_url: "https://api.jup.ag/tx/v1",
    allowed_operations: ["read", "preview_order", "swap", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
  }, [
    "ghola/solana-swap-execution-vault-v1",
    "account:acct_commitment_123",
    `recipient:${target.recipient_id}`,
    "mode:user_stealth",
    "network:mainnet",
    "venue:jupiter",
  ].join("|"));
}

async function encryptedInstruction(
  baseUrl,
  { venue_id, work_order_commitment, preview_commitment, operation_class, order, cancel, reconcile },
) {
  const target = await recipient(baseUrl);
  return sealedBundle(baseUrl, {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id,
    operation_class,
    order,
    cancel,
    reconcile,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }, [
    "ghola/private-execution-instruction-v1",
    work_order_commitment ? `work_order:${work_order_commitment}` : `preview:${preview_commitment}`,
    `venue:${venue_id}`,
    `recipient:${target.recipient_id}`,
  ].join("|"));
}

async function recipientId(baseUrl) {
  return (await recipient(baseUrl)).recipient_id;
}

async function readSseEvent(response, eventName) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const event = block
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim();
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (event === eventName && data) return JSON.parse(data);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`SSE event ${eventName} not found`);
}

function capabilityToken({
  secret = "capability-secret",
  method = "POST",
  path,
  scope,
  body = {},
  expected = {},
}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    version: 1,
    issuer: "test",
    method,
    path,
    scope,
    body_hash: bodyHash(body),
    jti: randomUUID(),
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    ...expected,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `ghcap_v1.${payloadB64}.${signature}`;
}

function enablePooledReadinessEnv() {
  process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "full_ticket";
  process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD = "1000";
  process.env.PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD = "5000";
  process.env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS = "100";
  process.env.PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE = "full_ticket";
  process.env.PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD = "1000";
  process.env.PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS = "100";
  process.env.PRIVATE_AGENT_BACKPACK_POOLED_ENABLED = "true";
  process.env.PRIVATE_AGENT_BACKPACK_LIVE_MODE = "tiny_live";
  process.env.PRIVATE_AGENT_BACKPACK_API_KEY = "test-backpack-api-key";
  process.env.PRIVATE_AGENT_BACKPACK_API_SECRET = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
  process.env.PRIVATE_AGENT_BACKPACK_ALLOWED_SYMBOLS = "SOL_USDC_PERP";
  process.env.PRIVATE_AGENT_BACKPACK_MAX_ORDER_NOTIONAL_USD = "5";
  process.env.PRIVATE_AGENT_BACKPACK_DAILY_NOTIONAL_CAP_USD = "25";
  process.env.PRIVATE_AGENT_BACKPACK_POST_ONLY_MM = "true";
  process.env.PRIVATE_AGENT_BACKPACK_NO_SUBMIT_LOCAL_CHECKS = "true";
  process.env.PRIVATE_AGENT_JUPITER_LIVE_MODE = "full";
  process.env.PRIVATE_AGENT_JUPITER_API_KEY = "test-jupiter-api-key";
  process.env.PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS = JUPITER_SOL_MINT;
  process.env.PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS = JUPITER_USDC_MINT;
  process.env.PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS = "100";
  process.env.PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD = "1000";
  process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
  process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = "BTC-USD,ETH-USD,SOL-USD";
  process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD = "1000";
}

describe("private agent worker", () => {
  let dir;
  let server;
  let baseUrl;

  beforeEach(async () => {
    resetEnv();
    dir = mkdtempSync(join(tmpdir(), "ghola-private-agent-worker-"));
    process.env.PRIVATE_AGENT_DATA_DIR = dir;
    process.env.PRIVATE_AGENT_EXECUTION_TOKEN = "secret";
    process.env.PRIVATE_AGENT_ALLOW_UNATTESTED_DEV = "true";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    server = createPrivateAgentWorkerServer({
      lighterGenerateApiKey: async () => [LIGHTER_PRIVATE_KEY, LIGHTER_PUBLIC_KEY, null],
    });
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
    resetEnv();
  });

  it("publishes a stable recipient key", async () => {
    const first = await fetch(`${baseUrl}/.well-known/private-agent-recipient`);
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.match(body.recipient_id, /^phala:cvm:/);
    assert.match(body.x25519_pub_hex, /^[0-9a-f]{64}$/);
    assert.ok(body.funding_signer_public_key_b64.length > 0);
    assert.equal(body.attested_ready, false);

    const loaded = loadRecipient();
    assert.equal(loaded.recipient_id, body.recipient_id);
    assert.equal(loaded.x25519_pub_hex, body.x25519_pub_hex);
    assert.equal(
      body.report_data_hex,
      recipientReportDataHex({
        recipient_id: body.recipient_id,
        x25519_pub_hex: body.x25519_pub_hex,
      }, body.funding_signer_public_key_b64),
    );
  });

  it("reports degraded Carry supervision without pretending the worker stopped", async () => {
    await close(server);
    process.env.PRIVATE_AGENT_ATTESTED_READY = "true";
    process.env.PHALA_CVM_IMAGE_DIGEST = "sha256:carry-supervision-test";
    process.env.PRIVATE_AGENT_MEASUREMENT_HEX = "carry-supervision-measurement";
    process.env.PRIVATE_AGENT_ATTESTATION_HASH = "carry-supervision-attestation";
    const health = (name, status, error = null) => ({
      health: () => ({
        name,
        status,
        running: false,
        run_count: 4,
        consecutive_failures: error ? 2 : 0,
        last_started_at: "2027-01-15T08:00:00.000Z",
        last_completed_at: "2027-01-15T08:00:00.025Z",
        last_success_at: error ? null : "2027-01-15T08:00:00.025Z",
        last_error_code: error,
      }),
      stop() {},
    });
    server = createPrivateAgentWorkerServer({
      carryMonitoringLoop: health("carry_monitor", "healthy"),
      carryExecutionLoop: health("carry_execution", "degraded", "carry_exit_preflight_not_ready"),
      startAutopilotDueLoop: false,
      startMultiLegRecoveryLoop: false,
      startCarryFundingObservationLoop: false,
      startKrakenV2Heartbeat: false,
    });
    baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "green");
    assert.equal(body.carry_supervision.status, "degraded");
    assert.equal(body.carry_supervision.ready, false);
    assert.equal(body.carry_supervision.monitoring.status, "healthy");
    assert.equal(body.carry_supervision.execution.last_error_code, "carry_exit_preflight_not_ready");
    assert.equal(body.carry_supervision.recovery.status, "disabled");
    assert.equal(body.carry_supervision.observation.status, "disabled");

    const readyResponse = await fetch(`${baseUrl}/ready`);
    const ready = await readyResponse.json();
    assert.equal(ready.carry_supervision.status, "degraded");

    const entryResponse = await fetch(`${baseUrl}/carry/positions/execute-entry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-live-order-confirmed": "true",
      },
      body: "{}",
    });
    const entry = await entryResponse.json();
    assert.equal(entryResponse.status, 503);
    assert.equal(entry.error, "carry_supervision_not_ready");
  });

  it("publishes redacted proposal-model status with readiness", async () => {
    process.env.PRIVATE_AGENT_AI_PROVIDER_KIND = "ollama";
    process.env.PRIVATE_AGENT_AI_MODEL = "local-proposal-model";
    process.env.PRIVATE_AGENT_AI_API_KEY = "must-not-leak";
    const response = await fetch(`${baseUrl}/ready`);
    const body = await response.json();
    assert.equal(body.decision_provider.configured, true);
    assert.equal(body.decision_provider.provider_kind, "ollama");
    assert.equal(body.decision_provider.local, true);
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
  });

  it("publishes a deterministic five-venue shadow verdict and coalesces concurrent cold reads", async () => {
    await close(server);
    let requested;
    let fetchCount = 0;
    server = createPrivateAgentWorkerServer({
      fetchPerpShadowSet: async (options) => {
        fetchCount += 1;
        requested = options;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return CORE_PERP_VENUES.map((venueId) => ({
          venue_id: venueId,
          ok: true,
          snapshots: [shadowSnapshot(venueId, "BTC", options.now_ms)],
        }));
      },
    });
    baseUrl = await listen(server);

    const [response, joinedResponse] = await Promise.all([
      fetch(`${baseUrl}/carry/shadow?assets=BTC`),
      fetch(`${baseUrl}/carry/shadow?assets=BTC`),
    ]);
    const [body, joinedBody] = await Promise.all([response.json(), joinedResponse.json()]);

    assert.equal(response.status, 200);
    assert.equal(body.executable, false);
    assert.equal(body.readiness.ok, true);
    assert.equal(body.readiness.venues, 5);
    assert.equal(body.readiness.expected_snapshots, 5);
    assert.deepEqual(body.readiness.failures, []);
    assert.equal(body.shadow_qualification.ready, false);
    assert.equal(body.shadow_qualification.completed_samples, 1);
    assert.equal(body.shadow_qualification.transaction_broadcast, false);
    assert.equal(body.funding_persistence.transaction_broadcast, false);
    assert.equal(body.funding_persistence.observed_route_count, 6);
    assert.equal(body.routing_advantage.transaction_broadcast, false);
    assert.equal(body.routing_advantage.realized, false);
    assert.equal(body.routing_advantage.execution_ready, false);
    assert.equal(Date.parse(body.observed_at), body.readiness.checked_at_ms);
    assert.equal(requested.now_ms, body.readiness.checked_at_ms);
    assert.deepEqual(requested.assets, ["BTC"]);
    assert.equal(body.served_from, "live_fetch");
    assert.equal(joinedResponse.status, 200);
    assert.equal(joinedBody.served_from, "live_fetch");
    assert.equal(joinedBody.evidence_commitment, body.evidence_commitment);
    assert.equal(fetchCount, 1);

    const cachedResponse = await fetch(`${baseUrl}/carry/shadow?assets=BTC`);
    const cachedBody = await cachedResponse.json();
    assert.equal(cachedResponse.status, 200);
    assert.equal(cachedBody.served_from, "durable_observer");
    assert.equal(cachedBody.readiness.ok, true);
    assert.equal(fetchCount, 1);
  });

  it("proves the three-venue no-submit matrix and durable exact account state over HTTP", async () => {
    await close(server);
    process.env.PHALA_CVM_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
    const account = {
      can_trade: true,
      available_balance: 500,
      margin_balance: 500,
      initial_margin: 0,
      maintenance_margin: 0,
      maker_fee_bps: 0,
      taker_fee_bps: 1,
      fee_source: "test_account_fee_schedule",
      fees_exact_for_account: true,
      fees_conservative_upper_bound: false,
      position_count: 0,
      open_order_count: 0,
    };
    let verificationCount = 0;
    server = createPrivateAgentWorkerServer({
      carryFetchVenue: async ({ venue_id, assets, now_ms }) => assets.map((asset) => ({
        ...shadowSnapshot(venue_id, asset, now_ms),
        price_tick_e8: 1_000,
        depth_bids: [{ price_e8: 9_999_000_000, size_e8: 100_000_000 }],
        depth_asks: [{ price_e8: 10_001_000_000, size_e8: 100_000_000 }],
      })),
      carryVerifyOrder: async ({ venue_id, work_order_commitment, execution }) => {
        verificationCount += 1;
        return {
          status: "verified_ready",
          work_order_commitment,
          account_commitment: execution.account_commitment,
          verification_commitment: `verification_http_${venue_id}_${verificationCount}`,
          checks: { order_request_checked: true, transaction_broadcast: false },
          order_shape: { notional_micro_usdc: 11_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000 },
          account,
          authority_boundary: venue_id === "lighter" ? {
            venue_native_trade_only: false,
            withdrawal_request_permitted: false,
            secure_withdrawal_destination: "owner_l1_only",
            owner_wallet_key_present: false,
            non_owner_fund_movement_possible: false,
          } : { venue_native_trade_only: true },
        };
      },
      carryReadHyperliquidSnapshot: async () => ({
        status: "ready_to_trade",
        trading_enabled: true,
        position_count: 0,
        open_order_count: 0,
      }),
      carryReadHyperliquidMetrics: async () => account,
      probeCarryTransferRoute: async (request) => ({
        valuation_asset: "USD",
        source_collateral_asset: request.source_collateral_asset,
        destination_collateral_asset: request.destination_collateral_asset,
        conversion_required: request.conversion_required,
        status: "available",
        quote_verified: true,
        all_in_fee_verified: true,
        valuation_basis_verified: true,
        conversion_quote_verified: true,
        conversion_rate_e8: request.conversion_required ? 99_950_000 : 100_000_000,
        minimum_transfer_micro_usdc: 3_000_000,
        maximum_transfer_micro_usdc: 100_000_000,
        withdrawal_fee_micro_usdc: 10_000,
        deposit_fee_micro_usdc: 0,
        conversion_fee_micro_usdc: request.conversion_required ? 2_000 : 0,
        conversion_slippage_micro_usdc: request.conversion_required ? 3_000 : 0,
        fee_micro_usdc: request.conversion_required ? 15_000 : 10_000,
        estimated_latency_ms: 60_000,
        as_of_ms: request.checked_at_ms,
        owner_approval_required: true,
        fund_movement_authorized: false,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
      }),
      startAutopilotDueLoop: false,
      startMultiLegRecoveryLoop: false,
      startCarryMonitoringLoop: false,
      startCarryExecutionLoop: false,
      startKrakenV2Heartbeat: false,
    });
    baseUrl = await listen(server);

    const ownerCommitment = "owner_commitment_http_matrix_0001";
    const venueAccess = {};
    for (const venueId of ["hyperliquid", "lighter", "aster"]) {
      venueAccess[venueId] = {
        status: "ready",
        owner_commitment: ownerCommitment,
        account_commitment: `account_commitment_http_${venueId}`,
        vault_commitment: `vault_commitment_http_${venueId}`,
        policy_commitment: `policy_commitment_http_${venueId}`,
        encrypted_execution_vault: await sealedBundle(
          baseUrl,
          { version: 1, kind: `test_${venueId}_vault` },
          `carry-http-matrix:${venueId}`,
        ),
      };
    }
    const common = {
      version: 1,
      owner_commitment: ownerCommitment,
      asset: "BTC",
      notional_usd: "11",
      horizon_days: "1",
      venue_access: venueAccess,
    };
    const matrixResponse = await fetch(`${baseUrl}/carry/preflight-matrix`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({
        ...common,
        operation_class: "matrix_no_submit",
        work_order_commitment: "carry_matrix_http_0001",
      }),
    });
    const matrix = await matrixResponse.json();
    assert.equal(matrixResponse.status, 200, JSON.stringify(matrix));
    assert.equal(matrix.no_submit_ready, true, JSON.stringify(matrix));
    assert.equal(matrix.transaction_broadcast, false);
    assert.equal(matrix.pairs.length, 3);
    assert.equal(matrix.carry_supervision.status, "disabled");
    assert.equal(matrix.collateral_route_observation.ok, true, JSON.stringify(matrix));
    assert.equal(matrix.collateral_route_observation.observed_route_count, 6);
    assert.equal(matrix.collateral_route_observation.available_route_count, 6);
    assert.equal(matrix.collateral_route_observation.fund_movement_authorized, false);
    assert.equal(matrix.collateral_route_observation.transaction_broadcast, false);
    assert.equal(matrix.private_prime_readiness.ready, false);
    assert.equal(matrix.private_prime_readiness.collateral_route_observation.configured, true);
    assert.equal(matrix.private_prime_readiness.collateral_route_observation.verified, true);
    assert.equal(matrix.private_prime_readiness.collateral_route_observation.available_route_count, 6);
    assert.equal(matrix.private_prime_readiness.reasons.includes("collateral_route_evidence_unverified"), false);
    assert.equal(matrix.private_prime_authentication.version, 1);
    assert.equal(matrix.private_prime_authentication.algorithm, "hmac-sha256");
    assert.equal(matrix.private_prime_authentication.request_bound, true);
    assert.match(matrix.private_prime_authentication.mac_hex, /^[0-9a-f]{64}$/);
    assert.equal(matrix.private_prime_authentication.signature_algorithm, "ed25519");
    assert.equal(matrix.private_prime_authentication.attestation_bound, true);
    assert.ok(matrix.private_prime_authentication.signature_b64.length > 0);
    assert.ok(matrix.private_prime_authentication.signer_public_key_b64.length > 0);
    assert.equal(matrix.pairs.every((pair) => pair.leg_evidence.every((leg) =>
      leg.account_state.position_count === 0
      && leg.account_state.open_order_count === 0
      && leg.account_state.account_state_commitment.startsWith("carry:account-state:")
    )), true);

    const readinessResponse = await fetch(`${baseUrl}/carry/readiness`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({
        ...common,
        operation_class: "readiness_read",
        work_order_commitment: "carry_readiness_http_0001",
      }),
    });
    const readiness = await readinessResponse.json();
    assert.equal(readinessResponse.status, 200, JSON.stringify(readiness));
    assert.equal(readiness.ready, true);
    assert.equal(readiness.carry_supervision.status, "disabled");
    assert.equal(readiness.private_prime_readiness.ready, false);
    assert.equal(readiness.private_prime_readiness.collateral_route_observation.verified, true);
    assert.equal(readiness.private_prime_readiness.reasons.includes("collateral_route_evidence_unverified"), false);
    assert.equal(readiness.private_prime_authentication.request_bound, true);
    assert.match(readiness.private_prime_authentication.mac_hex, /^[0-9a-f]{64}$/);
    assert.equal(readiness.capital_plan.every((item) =>
      item.position_count === 0
      && item.open_order_count === 0
      && item.account_state_commitment.startsWith("carry:account-state:")
    ), true);
    assert.equal(verificationCount, 6);
  });

  it("returns ready-pair evidence when a matrix venue has a sanitized not-ready marker", async () => {
    await close(server);
    process.env.PHALA_CVM_IMAGE_DIGEST = "sha256:abcdef123456";
    const account = {
      can_trade: true,
      available_balance: 500,
      margin_balance: 500,
      initial_margin: 0,
      maintenance_margin: 0,
      maker_fee_bps: 0,
      taker_fee_bps: 1,
      fee_source: "test_account_fee_schedule",
      fees_exact_for_account: true,
      fees_conservative_upper_bound: false,
      position_count: 0,
      open_order_count: 0,
    };
    server = createPrivateAgentWorkerServer({
      carryFetchVenue: async ({ venue_id, assets, now_ms }) => assets.map((asset) => ({
        ...shadowSnapshot(venue_id, asset, now_ms),
        price_tick_e8: 1_000,
        depth_bids: [{ price_e8: 9_999_000_000, size_e8: 100_000_000 }],
        depth_asks: [{ price_e8: 10_001_000_000, size_e8: 100_000_000 }],
      })),
      carryVerifyOrder: async ({ venue_id, work_order_commitment, execution }) => ({
        status: "verified_ready",
        work_order_commitment,
        account_commitment: execution.account_commitment,
        verification_commitment: `verification_http_partial_${venue_id}`,
        checks: { order_request_checked: true, transaction_broadcast: false },
        order_shape: { notional_micro_usdc: 11_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000 },
        account,
        authority_boundary: venue_id === "lighter" ? {
          venue_native_trade_only: false,
          withdrawal_request_permitted: false,
          secure_withdrawal_destination: "owner_l1_only",
          owner_wallet_key_present: false,
          non_owner_fund_movement_possible: false,
        } : { venue_native_trade_only: true },
      }),
      carryReadHyperliquidSnapshot: async () => ({
        status: "ready_to_trade",
        trading_enabled: true,
        position_count: 0,
        open_order_count: 0,
      }),
      carryReadHyperliquidMetrics: async () => account,
      startAutopilotDueLoop: false,
      startMultiLegRecoveryLoop: false,
      startCarryMonitoringLoop: false,
      startCarryExecutionLoop: false,
      startKrakenV2Heartbeat: false,
    });
    baseUrl = await listen(server);

    const ownerCommitment = "owner_commitment_http_partial_matrix_0001";
    const venueAccess = {
      aster: { status: "not_ready", owner_commitment: ownerCommitment },
    };
    for (const venueId of ["hyperliquid", "lighter"]) {
      venueAccess[venueId] = {
        status: "ready",
        owner_commitment: ownerCommitment,
        account_commitment: `account_commitment_http_${venueId}`,
        vault_commitment: `vault_commitment_http_${venueId}`,
        policy_commitment: `policy_commitment_http_${venueId}`,
        encrypted_execution_vault: await sealedBundle(
          baseUrl,
          { version: 1, kind: `test_${venueId}_vault` },
          `carry-http-partial-matrix:${venueId}`,
        ),
      };
    }
    const response = await fetch(`${baseUrl}/carry/preflight-matrix`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({
        version: 1,
        owner_commitment: ownerCommitment,
        operation_class: "matrix_no_submit",
        work_order_commitment: "carry_matrix_http_partial_0001",
        asset: "BTC",
        notional_usd: "11",
        horizon_days: "1",
        venue_access: venueAccess,
      }),
    });
    const matrix = await response.json();
    assert.equal(response.status, 200, JSON.stringify(matrix));
    assert.equal(matrix.no_submit_ready, false);
    assert.equal(matrix.transaction_broadcast, false);
    assert.equal(matrix.readiness, undefined);
    assert.equal(matrix.pairs.filter((pair) => pair.no_submit_ready).length, 1);
    assert.equal(matrix.pairs.find((pair) => pair.no_submit_ready).leg_evidence.length, 2);
    assert.equal(matrix.pairs.filter((pair) => pair.error_code === "carry_account_not_ready:aster").length, 2);

    const diagnosticResponse = await fetch(`${baseUrl}/carry/readiness`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({
        version: 1,
        owner_commitment: ownerCommitment,
        operation_class: "readiness_read",
        work_order_commitment: "carry_diagnostic_http_partial_0001",
        asset: "BTC",
        notional_usd: "11",
        horizon_days: "1",
        venue_access: venueAccess,
      }),
    });
    const restored = await diagnosticResponse.json();
    assert.equal(diagnosticResponse.status, 200, JSON.stringify(restored));
    assert.equal(restored.ready, false);
    assert.equal(restored.diagnostic.available, true);
    assert.equal(restored.diagnostic.diagnostic_only, true);
    assert.equal(restored.diagnostic.reusable_for_readiness, false);
    assert.equal(restored.diagnostic.pairs.filter((pair) => pair.no_submit_ready).length, 1);
  });

  it("can require dstack quote evidence before accepting production sessions", async () => {
    await close(server);
    process.env.PRIVATE_AGENT_ALLOW_UNATTESTED_DEV = "false";
    process.env.PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE = "true";
    process.env.PHALA_CVM_IMAGE_DIGEST = "sha256:test";
    process.env.PRIVATE_AGENT_DSTACK_QUOTE_JSON = JSON.stringify({
      mr_aggregated: "measurement-test",
      quote: "quote-test",
    });
    server = createPrivateAgentWorkerServer();
    baseUrl = await listen(server);

    const recipient = await fetch(`${baseUrl}/.well-known/private-agent-recipient`);
    assert.equal(recipient.status, 200);
    const recipientBody = await recipient.json();
    assert.equal(recipientBody.attested_ready, true);
    assert.equal(recipientBody.measurement_hex, "measurement-test");
    assert.match(recipientBody.attestation_hash, /^[0-9a-f]{64}$/);

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, "green");
    assert.equal(healthBody.attested_ready, true);
    assert.equal(healthBody.runtime_measurement, "measurement-test");
    assert.match(healthBody.runtime_attestation_commitment, /^runtime_attestation_[0-9a-f]{48}$/);
    assert.match(healthBody.runtime_measurement_commitment, /^runtime_measurement_[0-9a-f]{48}$/);
    assert.match(healthBody.runtime_policy_commitment, /^runtime_policy_[0-9a-f]{48}$/);
    assert.match(healthBody.runtime_health_commitment, /^runtime_health_[0-9a-f]{48}$/);

    const evidence = await fetch(`${baseUrl}/.well-known/private-agent-evidence`);
    assert.equal(evidence.status, 200);
    const evidenceBody = await evidence.json();
    assert.equal(evidenceBody.version, 1);
    assert.equal(evidenceBody.recipient.recipient_id, recipientBody.recipient_id);
    assert.equal(evidenceBody.health.status, "green");
    assert.equal(
      evidenceBody.recipient.report_data_hex,
      evidenceBody.health.report_data_hex,
    );

    const response = await fetch(`${baseUrl}/private-agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(await encryptedRequest(baseUrl)),
    });

    assert.equal(response.status, 201);
  });

  it("rejects missing provider bearer tokens", async () => {
    const response = await fetch(`${baseUrl}/private-agent/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(await encryptedRequest(baseUrl)),
    });

    assert.equal(response.status, 401);
  });

  it("requires scoped worker capabilities when enabled", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    const response = await fetch(`${baseUrl}/private-agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(await encryptedRequest(baseUrl)),
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error_code, "worker_capability_required");
  });

  it("accepts scoped worker capabilities once and rejects replays", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    const body = await encryptedRequest(baseUrl);
    const token = capabilityToken({
      path: "/private-agent/sessions",
      scope: "session:create",
      body,
      expected: {
        owner_commitment: body.owner_commitment,
        session_commitment: body.session_commitment,
      },
    });
    const init = {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    };

    const accepted = await fetch(`${baseUrl}/private-agent/sessions`, init);
    assert.equal(accepted.status, 201);

    const replayed = await fetch(`${baseUrl}/private-agent/sessions`, init);
    assert.equal(replayed.status, 403);
    const replayBody = await replayed.json();
    assert.equal(replayBody.error_code, "worker_capability_replayed");
  });

  it("stores Carry Positions only with owner-scoped capability and ready venue accounts", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    const ownerCommitment = "owner:carry:server:0001";
    const checkedAt = Date.now();
    const longVault = await encryptedHyperliquidVault(baseUrl);
    const shortVault = await encryptedHyperliquidVault(baseUrl);
    const monitoringAccess = (venueId, vault) => ({
      status: "ready",
      owner_commitment: ownerCommitment,
      account_commitment: `${venueId}_account_commitment_123`,
      vault_commitment: `${venueId}_vault_commitment_123`,
      encrypted_vault_commitment: `${venueId}_encrypted_vault_commitment_123`,
      policy_commitment: `${venueId}_policy_commitment_123`,
      encrypted_execution_vault: vault.encrypted_execution_vault,
    });
    const body = {
      owner_commitment: ownerCommitment,
      monitoring_context: {
        version: 1,
        venue_access: {
          hyperliquid: monitoringAccess("hyperliquid", longVault),
          lighter: monitoringAccess("lighter", shortVault),
        },
      },
      position_input: {
        version: 1,
        position_id: "carry:position:server:0001",
        mandate_id: "carry:mandate:server:0001",
        asset: "BTC",
        long_venue_id: "hyperliquid",
        short_venue_id: "lighter",
        target_notional_micro_usdc: 10_000_000,
        risk_mandate: {
          min_expected_net_benefit_bps: 1,
          exit_net_value_bps: 0,
          exit_after_consecutive_observations: 2,
          min_margin_runway_ms: 3_600_000,
          max_hedge_error_micro_usdc: 0,
          max_data_age_ms: 30_000,
          max_contract_data_skew_ms: 2_000,
          max_index_price_divergence_bps: 25,
          max_mark_price_divergence_bps: 50,
          allow_migration: false,
        },
      },
      opportunity: {
        version: 1,
        eligible: true,
        reasons: [],
        all_venues_ready: false,
        live_creation_ready: true,
        asset: "BTC",
        long_venue_id: "hyperliquid",
        short_venue_id: "lighter",
        notional_micro_usdc: 10_000_000,
        capital_committed_micro_usdc: 4_000_000,
        horizon_ms: 86_400_000,
        projected_gross_funding_micro_usdc: 25_000,
        projected_trading_cost_micro_usdc: 3_000,
        projected_capital_cost_micro_usdc: 1_000,
        risk_buffer_micro_usdc: 1_000,
        projected_net_value_micro_usdc: 20_000,
        projected_net_value_bps: 20,
        break_even_ms: 3_600_000,
        contract_data_skew_ms: 0,
        max_contract_data_skew_ms: 2_000,
        index_price_divergence_bps: 0,
        mark_price_divergence_bps: 0,
        max_index_price_divergence_bps: 25,
        max_mark_price_divergence_bps: 50,
        economic_equivalence_id: "carry:BTC-usd-linear",
        contract_type: "linear_perp",
        long_quote_asset: "USD",
        short_quote_asset: "USD",
        checked_at_ms: checkedAt,
        long_margin_runway_ms: 7_200_000,
        short_margin_runway_ms: 7_200_000,
      },
    };
    body.opportunity.worker_authentication = authenticateCarryCreationOpportunity({
      owner_commitment: ownerCommitment,
      opportunity: body.opportunity,
    });
    body.position_input = await signedCarryPositionInput({
      ...body.position_input,
      opportunity_evidence_commitment: body.opportunity.worker_authentication.evidence_commitment,
    }, {
      ownerCommitment,
      nowMs: checkedAt,
    });
    const notReadyToken = capabilityToken({
      path: "/carry/positions",
      scope: "carry:write",
      body,
      expected: { owner_commitment: ownerCommitment, operation_class: "create" },
    });
    const notReady = await fetch(`${baseUrl}/carry/positions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${notReadyToken}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    });
    assert.equal(notReady.status, 400);
    assert.equal((await notReady.json()).error, "carry_venue_accounts_not_ready");

    const readyOpportunity = { ...body.opportunity, all_venues_ready: true };
    readyOpportunity.worker_authentication = authenticateCarryCreationOpportunity({
      owner_commitment: ownerCommitment,
      opportunity: readyOpportunity,
    });
    const { mandate_authorization: _authorization, ...readyPositionInput } = body.position_input;
    const readyBody = {
      ...body,
      position_input: await signedCarryPositionInput({
        ...readyPositionInput,
        opportunity_evidence_commitment: readyOpportunity.worker_authentication.evidence_commitment,
      }, { ownerCommitment, nowMs: checkedAt }),
      opportunity: readyOpportunity,
    };
    const readyToken = capabilityToken({
      path: "/carry/positions",
      scope: "carry:write",
      body: readyBody,
      expected: { owner_commitment: ownerCommitment, operation_class: "create" },
    });
    const created = await fetch(`${baseUrl}/carry/positions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readyToken}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(readyBody),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.record.owner_commitment, ownerCommitment);
    assert.equal(createdBody.record.opportunity.all_venues_ready, true);
    assert.equal("monitoring_context" in createdBody.record, false);

    const exitBody = {
      owner_commitment: ownerCommitment,
      position_id: "carry:position:server:0001",
      event_id: "carry:owner-exit:server:0001",
      sequence: 1,
    };
    const exitToken = capabilityToken({
      path: "/carry/positions/exit-request",
      scope: "carry:write",
      body: exitBody,
      expected: { owner_commitment: ownerCommitment, operation_class: "/exit-request" },
    });
    const exit = await fetch(`${baseUrl}/carry/positions/exit-request`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${exitToken}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(exitBody),
    });
    assert.equal(exit.status, 400);
    assert.equal((await exit.json()).error, "carry_event_not_allowed_in_state");

    for (const retiredPath of [
      "/carry/positions/events",
      "/carry/positions/value-entries",
      "/carry/positions/finalize",
    ]) {
      const retired = await fetch(`${baseUrl}${retiredPath}`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-ghola-sealed-execution-required": "true",
        },
        body: JSON.stringify({ owner_commitment: ownerCommitment }),
      });
      assert.equal(retired.status, 404, retiredPath);
    }

    const readBody = { owner_commitment: ownerCommitment, position_id: "carry:position:server:0001" };
    const readToken = capabilityToken({
      path: "/carry/positions/read",
      scope: "carry:read",
      body: readBody,
      expected: { owner_commitment: ownerCommitment, operation_class: "/read" },
    });
    const read = await fetch(`${baseUrl}/carry/positions/read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readToken}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(readBody),
    });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).record.position.status, "draft");

    const valueBody = {
      owner_commitment: ownerCommitment,
      owner_capital_budget_micro_usdc: 0,
      max_data_age_ms: 30_000,
    };
    const valueToken = capabilityToken({
      path: "/carry/positions/value-report",
      scope: "carry:read",
      body: valueBody,
      expected: { owner_commitment: ownerCommitment, operation_class: "/value-report" },
    });
    const value = await fetch(`${baseUrl}/carry/positions/value-report`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${valueToken}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(valueBody),
    });
    assert.equal(value.status, 200);
    const valueReport = await value.json();
    assert.equal(valueReport.ok, true);
    assert.equal(valueReport.report.value_proof_status, "accruing");
    assert.equal(valueReport.report.position_count, 1);
    assert.equal(valueReport.report.transaction_broadcast, false);

    const reviewToken = capabilityToken({
      path: "/carry/positions/collateral-review",
      scope: "carry:read",
      body: valueBody,
      expected: { owner_commitment: ownerCommitment, operation_class: "/collateral-review" },
    });
    const review = await fetch(`${baseUrl}/carry/positions/collateral-review`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${reviewToken}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify(valueBody),
    });
    assert.equal(review.status, 200);
    const reviewBody = await review.json();
    assert.equal(reviewBody.ok, true);
    assert.equal(reviewBody.review.status, "no_action");
    assert.equal(reviewBody.review.review_only, true);
    assert.equal(reviewBody.review.execution_authorized, false);
    assert.equal(reviewBody.review.transaction_broadcast, false);

    const approvalBody = { owner_commitment: ownerCommitment, authorization: {} };
    const approvalToken = capabilityToken({
      path: "/carry/positions/collateral-review/approve",
      scope: "carry:write",
      body: approvalBody,
      expected: { owner_commitment: ownerCommitment, operation_class: "/collateral-review/approve" },
    });
    const approvalWithoutNoSubmit = await fetch(`${baseUrl}/carry/positions/collateral-review/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${approvalToken}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(approvalBody),
    });
    assert.equal(approvalWithoutNoSubmit.status, 400);
    assert.equal((await approvalWithoutNoSubmit.json()).error, "no-submit verification header is required");

    const releaseToken = capabilityToken({
      path: "/carry/positions/release-evidence",
      scope: "carry:read",
      body: readBody,
      expected: { owner_commitment: ownerCommitment, operation_class: "/release-evidence" },
    });
    const release = await fetch(`${baseUrl}/carry/positions/release-evidence`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${releaseToken}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(readBody),
    });
    assert.equal(release.status, 400);
    assert.deepEqual(await release.json(), {
      ok: false,
      error: "carry_release_position_not_reconciled",
    });
  });

  it("requires scoped worker capabilities for pooled readiness probes", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    const response = await fetch(`${baseUrl}/venues/pools/readiness`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        operation_class: "pooled_readiness",
        venues: ["hyperliquid"],
      }),
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error_code, "worker_capability_required");
  });

  it("reports redacted pooled readiness through a scoped worker capability", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    enablePooledReadinessEnv();
    const body = {
      version: 1,
      operation_class: "pooled_readiness",
      venues: ["hyperliquid", "phoenix", "backpack", "jupiter", "coinbase"],
    };
    const token = capabilityToken({
      path: "/venues/pools/readiness",
      scope: "credential:verify",
      body,
      expected: { operation_class: "pooled_readiness" },
    });
    const response = await fetch(`${baseUrl}/venues/pools/readiness`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    const readiness = await response.json();
    assert.equal(readiness.status, "ready");
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.reason_codes, []);
    assert.deepEqual(
      readiness.venues.map((venue) => [venue.venue_id, venue.status]),
      [
        ["hyperliquid", "ready"],
        ["phoenix", "ready"],
        ["backpack", "ready"],
        ["jupiter", "ready"],
        ["coinbase", "ready"],
      ],
    );
    const serialized = JSON.stringify(readiness).toLowerCase();
    assert.equal(serialized.includes("api_wallet_private_key"), false);
    assert.equal(serialized.includes("wallet_private_key"), false);
    assert.equal(serialized.includes("api_private_key_pem"), false);
    assert.equal(serialized.includes("test-backpack-api-key"), false);
    assert.equal(serialized.includes("credential_ref"), false);
  });

  it("reports Backpack pooled readiness blockers without rejecting the venue", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    const body = {
      version: 1,
      operation_class: "pooled_readiness",
      venues: ["backpack"],
    };
    const token = capabilityToken({
      path: "/venues/pools/readiness",
      scope: "credential:verify",
      body,
      expected: { operation_class: "pooled_readiness" },
    });
    const response = await fetch(`${baseUrl}/venues/pools/readiness`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    const readiness = await response.json();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.venues[0].venue_id, "backpack");
    assert.ok(readiness.venues[0].reason_codes.includes("backpack_api_key_missing"));
    assert.ok(readiness.venues[0].reason_codes.includes("backpack_symbol_allowlist_missing"));
  });

  it("requires scoped worker capabilities for autopilot execution readiness", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    const response = await fetch(`${baseUrl}/autopilot/readiness`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        operation_class: "autopilot_execution_readiness",
        venues: ["jupiter"],
      }),
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error_code, "worker_capability_required");
  });

  it("reports setup progress when live execution is not yet enabled", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    const body = {
      version: 1,
      operation_class: "autopilot_execution_readiness",
      venues: ["jupiter"],
    };
    const token = capabilityToken({
      path: "/autopilot/readiness",
      scope: "autopilot:read",
      body,
      expected: { operation_class: "autopilot_execution_readiness" },
    });
    const response = await fetch(`${baseUrl}/autopilot/readiness`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    const readiness = await response.json();
    assert.equal(readiness.status, "setup_required");
    assert.equal(readiness.ready, false);
    assert.equal(readiness.blocking, false);
    assert.equal(readiness.safe_to_recommend, "dry_run_or_setup_only");
    assert.equal(readiness.recommended_strategy.strategy_id, "bounded_intent_executor_v1");
    assert.equal(readiness.recommended_strategy.default_order_source, "deterministic_bounded_intent_executor");
    assert.equal(readiness.enabled_capabilities.create_autopilot_sessions, true);
    assert.equal(readiness.enabled_capabilities.dry_run_orders, true);
    assert.equal(readiness.first_available_path.mode, "dry_run_autopilot");
    assert.equal(readiness.first_available_path.strategy_id, "bounded_intent_executor_v1");
    assert.ok(readiness.reason_codes.includes("venue_dry_run_enabled"));
    assert.ok(readiness.reason_codes.includes("autopilot_live_submit_disabled"));
    assert.ok(!readiness.reason_codes.includes("shared_state_store_required"));
    assert.ok(readiness.reason_codes.includes("live_canary_missing"));
    assert.ok(readiness.next_actions.some((action) => action.code === "autopilot_live_submit_disabled"));
  });

  it("honors single-CVM persistent state for autopilot readiness", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    process.env.PRIVATE_AGENT_STATE_STORE = "json";
    process.env.PRIVATE_AGENT_STATE_SINGLE_CVM_OK = "true";
    const body = {
      version: 1,
      operation_class: "autopilot_execution_readiness",
      venues: ["jupiter"],
    };
    const token = capabilityToken({
      path: "/autopilot/readiness",
      scope: "autopilot:read",
      body,
      expected: { operation_class: "autopilot_execution_readiness" },
    });
    const response = await fetch(`${baseUrl}/autopilot/readiness`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    const readiness = await response.json();
    assert.equal(readiness.checks.state_store.mode, "json");
    assert.equal(readiness.checks.state_store.shared, true);
    assert.ok(!readiness.reason_codes.includes("shared_state_store_required"));
    assert.ok(!readiness.next_actions.some((action) => action.code === "shared_state_store_required"));
  });

  it("reports public live readiness with per-session proofs when funded canary is unavailable", async () => {
    await close(server);
    const fundingKey = generateKeyPairSync("ed25519").privateKey;
    process.env.PRIVATE_AGENT_ALLOW_UNATTESTED_DEV = "false";
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    process.env.PRIVATE_AGENT_STATE_STORE = "postgres";
    process.env.PRIVATE_AGENT_ATTESTED_READY = "true";
    process.env.PRIVATE_AGENT_ATTESTATION_HASH = "a".repeat(64);
    process.env.PRIVATE_AGENT_MEASUREMENT_HEX = "b".repeat(64);
    process.env.PHALA_CVM_IMAGE_DIGEST = "sha256:test";
    process.env.PRIVATE_AGENT_FUNDING_SIGNING_KEY = fundingKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "true";
    process.env.PRIVATE_AGENT_AUTOPILOT_SWEEP_ENABLED = "true";
    process.env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE = "live";
    process.env.PRIVATE_AGENT_JUPITER_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_JUPITER_API_KEY = "test-jupiter-api-key";
    process.env.PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS = JUPITER_USDC_MINT;
    process.env.PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS = JUPITER_SOL_MINT;
    process.env.PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS = "100";
    process.env.PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD = "5000";
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "10";
    process.env.PRIVATE_AGENT_JUPITER_FEE_ACCOUNT = "11111111111111111111111111111111";
    process.env.PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON = JSON.stringify({
      wallet_private_key: Array.from(Keypair.generate().secretKey),
    });
    server = createPrivateAgentWorkerServer({
      startAutopilotDueLoop: false,
      state: createWorkerState(dir),
    });
    baseUrl = await listen(server);
    const body = {
      version: 1,
      operation_class: "autopilot_execution_readiness",
      venues: ["jupiter"],
    };
    const token = capabilityToken({
      path: "/autopilot/readiness",
      scope: "autopilot:read",
      body,
      expected: { operation_class: "autopilot_execution_readiness" },
    });
    const response = await fetch(`${baseUrl}/autopilot/readiness`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    const readiness = await response.json();
    assert.equal(readiness.status, "public_live_ready");
    assert.equal(readiness.ready, true);
    assert.equal(readiness.blocking, false);
    assert.equal(readiness.safe_to_recommend, "public_live_with_per_session_proofs");
    assert.deepEqual(readiness.critical_reason_codes, []);
    assert.deepEqual(readiness.advisory_reason_codes, ["live_canary_missing"]);
    assert.equal(readiness.enabled_capabilities.live_autopilot_orders, true);
    assert.equal(readiness.enabled_capabilities.per_session_live_proofs, true);
    assert.equal(readiness.proof_model.mode, "per_session_live_proofs");
    assert.equal(readiness.proof_model.funded_operator_canary_required, false);
    assert.equal(readiness.proof_model.funded_operator_canary_status, "advisory_missing_or_stale");
    assert.deepEqual(readiness.proof_model.funded_operator_canary_advisory_reason_codes, ["live_canary_missing"]);
    assert.equal(readiness.proof_model.per_session_requirements.scoped_worker_capability, true);
    assert.equal(readiness.proof_model.per_session_requirements.receipt_commitment, true);
    assert.equal(readiness.proof_model.first_order_policy.max_notional_usd, 5);
    assert.equal(readiness.proof_model.evidence_endpoints.revenue, "/revenue/evidence");
    assert.equal(readiness.first_available_path.mode, "live_autopilot");
    assert.equal(readiness.first_available_path.venue_id, "jupiter");
    assert.equal(readiness.checks.canary.ready, false);
    assert.equal(readiness.venues[0].ready, true);
  });

  it("blocks autopilot readiness when derived Jupiter revenue setup payer lacks SOL", async () => {
    await close(server);
    const oldFetch = globalThis.fetch;
    const fundingKey = generateKeyPairSync("ed25519").privateKey;
    const jupiterPayer = Keypair.generate();
    process.env.PRIVATE_AGENT_ALLOW_UNATTESTED_DEV = "false";
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    process.env.PRIVATE_AGENT_STATE_STORE = "postgres";
    process.env.PRIVATE_AGENT_ATTESTED_READY = "true";
    process.env.PRIVATE_AGENT_ATTESTATION_HASH = "a".repeat(64);
    process.env.PRIVATE_AGENT_MEASUREMENT_HEX = "b".repeat(64);
    process.env.PHALA_CVM_IMAGE_DIGEST = "sha256:test";
    process.env.PRIVATE_AGENT_FUNDING_SIGNING_KEY = fundingKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "true";
    process.env.PRIVATE_AGENT_AUTOPILOT_SWEEP_ENABLED = "true";
    process.env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE = "live";
    process.env.PRIVATE_AGENT_JUPITER_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_JUPITER_API_KEY = "test-jupiter-api-key";
    process.env.PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS = JUPITER_USDC_MINT;
    process.env.PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS = JUPITER_SOL_MINT;
    process.env.PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS = "100";
    process.env.PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD = "5000";
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "10";
    process.env.PRIVATE_AGENT_JUPITER_FEE_OWNER = JUPITER_FEE_OWNER;
    process.env.PRIVATE_AGENT_JUPITER_FEE_MINT = JUPITER_USDC_MINT;
    process.env.PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON = JSON.stringify({
      wallet_private_key: Array.from(jupiterPayer.secretKey),
    });
    globalThis.fetch = async (url, init) => {
      if (String(url) === "https://api.mainnet-beta.solana.com") {
        const rpc = JSON.parse(String(init?.body || "{}"));
        if (rpc.method === "getAccountInfo") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: { value: null },
            id: rpc.id,
          }), { status: 200 });
        }
        if (rpc.method === "getMinimumBalanceForRentExemption") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: 2_039_280,
            id: rpc.id,
          }), { status: 200 });
        }
        if (rpc.method === "getBalance") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            result: { value: 1_000 },
            id: rpc.id,
          }), { status: 200 });
        }
      }
      return oldFetch(url, init);
    };
    try {
      server = createPrivateAgentWorkerServer({
        startAutopilotDueLoop: false,
        state: createWorkerState(dir),
      });
      baseUrl = await listen(server);
      const body = {
        version: 1,
        operation_class: "autopilot_execution_readiness",
        venues: ["jupiter"],
      };
      const token = capabilityToken({
        path: "/autopilot/readiness",
        scope: "autopilot:read",
        body,
        expected: { operation_class: "autopilot_execution_readiness" },
      });
      const response = await fetch(`${baseUrl}/autopilot/readiness`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-ghola-sealed-execution-required": "true",
        },
        body: JSON.stringify(body),
      });

      assert.equal(response.status, 200);
      const readiness = await response.json();
      assert.equal(readiness.status, "setup_required");
      assert.equal(readiness.ready, false);
      assert.equal(readiness.revenue.status, "needs_funds");
      assert.equal(readiness.revenue.live_fee_collection_enabled, false);
      assert.equal(readiness.revenue.fee_account_readiness.status, "needs_funds");
      assert.ok(readiness.critical_reason_codes.includes(
        "autopilot_revenue_jupiter_fee_account_setup_payer_needs_sol",
      ));
      assert.ok(readiness.next_actions.some((action) =>
        action.code === "autopilot_revenue_jupiter_fee_account_setup_payer_needs_sol"
      ));
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("reports production autopilot readiness when all live gates and venue checks pass", async () => {
    await close(server);
    const fundingKey = generateKeyPairSync("ed25519").privateKey;
    process.env.PRIVATE_AGENT_ALLOW_UNATTESTED_DEV = "false";
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    process.env.PRIVATE_AGENT_STATE_STORE = "postgres";
    process.env.PRIVATE_AGENT_ATTESTED_READY = "true";
    process.env.PRIVATE_AGENT_ATTESTATION_HASH = "a".repeat(64);
    process.env.PRIVATE_AGENT_MEASUREMENT_HEX = "b".repeat(64);
    process.env.PHALA_CVM_IMAGE_DIGEST = "sha256:test";
    process.env.PRIVATE_AGENT_FUNDING_SIGNING_KEY = fundingKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "true";
    process.env.PRIVATE_AGENT_AUTOPILOT_SWEEP_ENABLED = "true";
    process.env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE = "live";
    process.env.PRIVATE_AGENT_LAST_LIVE_CANARY_AT = new Date().toISOString();
    process.env.PRIVATE_AGENT_JUPITER_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_JUPITER_API_KEY = "test-jupiter-api-key";
    process.env.PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS = JUPITER_USDC_MINT;
    process.env.PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS = JUPITER_SOL_MINT;
    process.env.PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS = "100";
    process.env.PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD = "5000";
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "10";
    process.env.PRIVATE_AGENT_JUPITER_FEE_ACCOUNT = "11111111111111111111111111111111";
    process.env.PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON = JSON.stringify({
      wallet_private_key: Array.from(Keypair.generate().secretKey),
    });
    server = createPrivateAgentWorkerServer({
      startAutopilotDueLoop: false,
      state: createWorkerState(dir),
    });
    baseUrl = await listen(server);
    const body = {
      version: 1,
      operation_class: "autopilot_execution_readiness",
      venues: ["jupiter"],
    };
    const token = capabilityToken({
      path: "/autopilot/readiness",
      scope: "autopilot:read",
      body,
      expected: { operation_class: "autopilot_execution_readiness" },
    });
    const response = await fetch(`${baseUrl}/autopilot/readiness`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    const readiness = await response.json();
    assert.equal(readiness.status, "live_ready");
    assert.equal(readiness.ready, true);
    assert.equal(readiness.blocking, false);
    assert.equal(readiness.safe_to_recommend, "production_live");
    assert.deepEqual(readiness.reason_codes, []);
    assert.equal(readiness.enabled_capabilities.live_autopilot_orders, true);
    assert.equal(readiness.enabled_capabilities.revenue_collection, true);
    assert.equal(readiness.revenue.status, "configured");
    assert.equal(readiness.revenue.model, "jupiter_integrator_fee");
    assert.equal(readiness.revenue.fee_bps, 10);
    assert.equal(readiness.revenue.fee_recipient, "jupiter_fee_account");
    assert.match(readiness.revenue.fee_recipient_commitment, /^jupiter_fee_account_/);
    assert.equal(readiness.recommended_strategy.strategy_id, "bounded_intent_executor_v1");
    assert.equal(readiness.recommended_strategy.default_order_source, "deterministic_bounded_intent_executor");
    assert.equal(readiness.first_available_path.mode, "live_autopilot");
    assert.equal(readiness.first_available_path.strategy_id, "bounded_intent_executor_v1");
    assert.equal(readiness.first_available_path.venue_id, "jupiter");
    assert.equal(readiness.checks.state_store.shared, true);
    assert.equal(readiness.checks.execution_gates.autopilot_live_submit, true);
    assert.equal(readiness.checks.canary.ready, true);
    assert.equal(readiness.venues[0].venue_id, "jupiter");
    assert.equal(readiness.venues[0].ready, true);
    const serialized = JSON.stringify(readiness).toLowerCase();
    assert.equal(serialized.includes("wallet_private_key"), false);
    assert.equal(serialized.includes("test-jupiter-api-key"), false);
  });

  it("exports sanitized revenue evidence through scoped worker capability", async () => {
    await close(server);
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    const state = createWorkerState(dir);
    const stored = await state.appendRevenueEvidence({
      version: 1,
      evidence_kind: "autopilot_order_revenue_v1",
      revenue_status: "expected",
      collection_status: "routed_in_jupiter_order",
      revenue_model: "jupiter_integrator_fee",
      venue_id: "jupiter",
      operation_class: "swap",
      market: "SOL-USD",
      fee_bps: 10,
      notional_bucket: "50",
      expected_fee_bucket: "0.05",
      fee_currency: "USD",
      fee_recipient: "jupiter_fee_account",
      fee_recipient_commitment: "jupiter_fee_account_commitment",
      work_order_commitment: "autopilot_work_order_revenue_export",
      autopilot_session_id: "autopilot_revenue_export",
      agent_controller_id: "agentctl_revenue_export",
      policy_commitment: "policy_revenue_export",
      tick_id: "tick_revenue_export",
      executor_id: "executor_revenue_export",
      provider_ref_commitment: "provider_ref_revenue_export",
      result_commitment: "jupiter_result_revenue_export",
      final_proof_commitment: "final_proof_revenue_export",
      venue_signature_commitment: "jupiter_signature_revenue_export",
      onchain_collection_proof: true,
      created_at: new Date().toISOString(),
    });
    server = createPrivateAgentWorkerServer({
      startAutopilotDueLoop: false,
      state,
    });
    baseUrl = await listen(server);

    const body = {
      version: 1,
      operation_class: "revenue_evidence_export",
      venue_id: "jupiter",
      limit: 50,
    };
    const token = capabilityToken({
      path: "/revenue/evidence",
      scope: "revenue:read",
      body,
      expected: {
        operation_class: "revenue_evidence_export",
        venue_id: body.venue_id,
      },
    });
    const response = await fetch(`${baseUrl}/revenue/evidence`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.operation_class, "revenue_evidence_export");
    assert.equal(result.statement.statement_kind, "ghola_revenue_evidence_statement_v1");
    assert.equal(result.statement.totals.expected_fee_bucket, "0.05");
    assert.equal(result.statement.hash_chain.valid, true);
    assert.equal(result.statement.hash_chain.head_event_hash, stored.event_hash);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].event_hash, stored.event_hash);
    assert.equal(result.events[0].expected_fee_bucket, "0.05");
    const serialized = JSON.stringify(result).toLowerCase();
    assert.equal(serialized.includes("wallet_private_key"), false);
    assert.equal(serialized.includes("api_key"), false);
  });

  it("accepts a tri-venue arb run command through scoped worker capability", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_NO_SUBMIT_LOCAL_CHECKS = "true";
    process.env.PRIVATE_AGENT_ARB_SIGNAL_MODE = "force";
    process.env.PRIVATE_AGENT_ARB_FORCE_BUY_PRICE = "100";
    process.env.PRIVATE_AGENT_ARB_FORCE_SELL_PRICE = "104";
    process.env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD = "5";
    process.env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD = "25";
    process.env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS = "25";
    process.env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS = "2000";
    process.env.PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS = "2000";
    process.env.PRIVATE_AGENT_ARB_LIVE_SUBMIT = "true";
    enablePooledReadinessEnv();
    const body = {
      version: 1,
      owner_commitment: "owner_tri_venue_123",
      market: "SOL-USD",
      venue_allowlist: ["phoenix", "hyperliquid", "backpack"],
      caps: {
        max_leg_notional_usd: "5",
        daily_notional_cap_usd: "25",
        max_slippage_bps: 25,
        max_execution_skew_ms: 2000,
        max_market_data_skew_ms: 2000,
      },
    };
    const token = capabilityToken({
      path: "/autopilot/tri-venue/run",
      scope: "order:submit",
      body,
      expected: {
        operation_class: "tri_venue_live",
        owner_commitment: body.owner_commitment,
      },
    });
    const response = await fetch(`${baseUrl}/autopilot/tri-venue/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.action, "run");
    assert.match(result.session.autopilot_session_id, /^autopilot_/);
    assert.equal(result.tick.ok, true);
    assert.equal(result.tick.receipts.length, 2);
    assert.equal(JSON.stringify(result).includes("test-backpack-api-key"), false);
  });

  it("runs due autopilot sessions through a scoped worker capability", async () => {
    await close(server);
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    process.env.PRIVATE_AGENT_AUTOPILOT_SWEEP_ENABLED = "false";
    process.env.PRIVATE_AGENT_AUTOPILOT_INITIAL_DELAY_MS = "60000";
    process.env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE = "force";
    process.env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE = "100";
    process.env.PRIVATE_AGENT_AUTOPILOT_FORCE_CHANGE_PCT = "1";
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "true";
    server = createPrivateAgentWorkerServer();
    baseUrl = await listen(server);

    const sessionBody = {
      version: 1,
      owner_commitment: "owner_autopilot_run_due_123",
      session_policy: {
        venue_allowlist: ["jupiter"],
        market_allowlist: ["SOL-USD"],
        max_notional_bucket: "50",
        max_daily_notional_bucket: "250",
        max_order_count: 10,
        ttl_ms: 2 * 60 * 60_000,
        max_slippage_bps: 50,
      },
    };
    const createToken = capabilityToken({
      path: "/autopilot/sessions",
      scope: "autopilot:control",
      body: sessionBody,
      expected: { owner_commitment: sessionBody.owner_commitment },
    });
    const created = await fetch(`${baseUrl}/autopilot/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createToken}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(sessionBody),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.session.status, "running");

    const runDueBody = {
      version: 1,
      operation_class: "autopilot_run_due",
      max_sessions: 5,
    };
    const runDueToken = capabilityToken({
      path: "/autopilot/run-due",
      scope: "autopilot:control",
      body: runDueBody,
      expected: { operation_class: "autopilot_run_due" },
    });
    const response = await fetch(`${baseUrl}/autopilot/run-due`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runDueToken}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(runDueBody),
    });

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.checked_count, 1);
    assert.equal(result.due_count, 1);
    assert.equal(result.ran_count, 1);
    assert.equal(result.results[0].autopilot_session_id, createdBody.session.autopilot_session_id);
    assert.equal(result.results[0].ok, true);
    assert.match(result.results[0].receipt_commitment, /^jupiter_result_/);
  });

  it("blocks live pooled readiness when worker state is not shared", async () => {
    process.env.PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    process.env.PRIVATE_AGENT_STATE_STORE = "json";
    enablePooledReadinessEnv();
    process.env.PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON = JSON.stringify({
      accounts: [{
        network: "mainnet",
        account_address: "0x0000000000000000000000000000000000000001",
        api_wallet_private_key: "0x1111111111111111111111111111111111111111111111111111111111111111",
      }],
    });
    const body = {
      version: 1,
      operation_class: "pooled_readiness",
      venues: ["hyperliquid"],
    };
    const token = capabilityToken({
      path: "/venues/pools/readiness",
      scope: "credential:verify",
      body,
      expected: { operation_class: "pooled_readiness" },
    });
    const response = await fetch(`${baseUrl}/venues/pools/readiness`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    const readiness = await response.json();
    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.ready, false);
    assert.equal(readiness.state_store.mode, "json");
    assert.equal(readiness.state_store.shared, false);
    assert.ok(readiness.reason_codes.includes("worker_state_store_not_shared"));
  });

  it("does not submit Hyperliquid orders from reconcile requests", async () => {
    const vault = await encryptedHyperliquidVault(baseUrl);
    const workOrderCommitment = "connector_work_order_hl_reconcile_read_only_123";
    const response = await fetch(`${baseUrl}/hyperliquid/reconcile`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: vault.account_commitment,
        work_order_commitment: workOrderCommitment,
        vault_commitment: vault.vault_commitment,
        policy_commitment: vault.policy_commitment,
        encrypted_execution_vault: vault.encrypted_execution_vault,
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          work_order_commitment: workOrderCommitment,
          operation_class: "limit_order",
          order: {
            market: "BTC",
            side: "buy",
            base_size: "0.001",
            limit_price: "10000",
            tif: "Gtc",
          },
        }),
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "outcome_unknown");
    assert.equal(body.final_proof.broadcast_performed, false);
    assert.equal(body.final_proof.final_venue_execution_proven, false);
    assert.notEqual(body.status, "submitted");
  });

  it("persists an ambiguous Hyperliquid attempt before refusing any retry", async () => {
    await close(server);
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    process.env.PRIVATE_AGENT_PYTHON = "/definitely-missing-ghola-python";
    const state = createWorkerState(dir);
    server = createPrivateAgentWorkerServer({ state });
    baseUrl = await listen(server);
    const vault = await encryptedHyperliquidVault(baseUrl);
    const workOrderCommitment = "connector_work_order_hl_ambiguous_123";
    const requestBody = {
      version: 1,
      account_commitment: vault.account_commitment,
      work_order_commitment: workOrderCommitment,
      vault_commitment: vault.vault_commitment,
      policy_commitment: vault.policy_commitment,
      operation_class: "limit_order",
      encrypted_execution_vault: vault.encrypted_execution_vault,
      encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
        venue_id: "hyperliquid",
        work_order_commitment: workOrderCommitment,
        operation_class: "limit_order",
        order: {
          market: "HYPE",
          side: "buy",
          quote_size: "11",
          tif: "Ioc",
          live_order_mode: "tiny_fill",
        },
      }),
      session_policy: {
        market_allowlist: ["HYPE"],
        max_notional_bucket: "25",
        max_order_count: 1,
        kill_switch: false,
      },
    };
    const submit = () => fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(requestBody),
    });

    const first = await submit();
    assert.equal(first.status, 502);
    const attempt = await state.getExecutionAttempt(workOrderCommitment);
    assert.equal(attempt.status, "ambiguous");
    assert.match(attempt.provider_ref_seed.cloid, /^0x[0-9a-f]{32}$/);

    const second = await submit();
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /reconcile it instead of retrying/);
  });

  it("rejects plaintext strategy fields recursively", async () => {
    const response = await fetch(`${baseUrl}/private-agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(
        await encryptedRequest(baseUrl, {
          nested: {
            prompt: "buy ETH every Friday",
          },
        }),
      ),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.details.join(" "), /plaintext/);
  });

  it("rejects bundles sealed to a different recipient", async () => {
    const response = await fetch(`${baseUrl}/private-agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        ...(await encryptedRequest(baseUrl)),
        encrypted_strategy_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-ciphertext",
          recipient: "phala:cvm:wrong",
          aad: "ghola/private-agent-session-v1",
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.details.join(" "), /worker recipient/);
  });

  it("accepts encrypted sessions in explicit unattested dev mode only", async () => {
    const response = await fetch(`${baseUrl}/private-agent/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(await encryptedRequest(baseUrl)),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.version, 1);
    assert.equal(body.provider, "phala");
    assert.equal(body.strategy_id, "strategy_123");
    assert.equal(body.sealed_execution_required, true);
  });

  it("rejects the unattested development override in production", async () => {
    await close(server);
    process.env.NODE_ENV = "production";
    process.env.PRIVATE_AGENT_ALLOW_UNATTESTED_DEV = "true";
    process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET = "capability-secret";
    server = createPrivateAgentWorkerServer();
    baseUrl = await listen(server);

    const requestBody = await encryptedRequest(baseUrl);
    const token = capabilityToken({
      path: "/private-agent/sessions",
      scope: "session:create",
      body: requestBody,
      expected: {
        owner_commitment: requestBody.owner_commitment,
        session_commitment: requestBody.session_commitment,
      },
    });
    const response = await fetch(`${baseUrl}/private-agent/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(requestBody),
    });

    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "attested sealed execution is unavailable");
  });

  it("arms Hyperliquid sessions with only encrypted vault material", async () => {
    const response = await fetch(`${baseUrl}/hyperliquid/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(await encryptedHyperliquidVault(baseUrl)),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.status, "armed");
    assert.equal(body.platform_class, "hyperliquid_style_market");
    assert.match(body.hyperliquid_session_commitment, /^hyperliquid_session_/);
    assert.equal(JSON.stringify(body).includes("sealed-hyperliquid-vault"), false);
  });

  it("submits Hyperliquid orders through commitment and ciphertext ingress", async () => {
    const workOrderCommitment = "connector_work_order_123";
    const previewCommitment = "preview_commitment_123";
    const vault = await encryptedHyperliquidVault(baseUrl);
    const response = await fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: vault.account_commitment,
        work_order_commitment: workOrderCommitment,
        preview_commitment: previewCommitment,
        vault_commitment: "hyperliquid_vault_commitment_123",
        policy_commitment: "hyperliquid_policy_commitment_123",
        operation_class: "limit_order",
        encrypted_execution_vault: vault.encrypted_execution_vault,
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          preview_commitment: previewCommitment,
          operation_class: "limit_order",
          order: {
            market: "BTC",
            side: "buy",
            base_size: "0.001",
            limit_price: "10000",
            tif: "Gtc",
          },
        }),
        session_policy: {
          market_allowlist: ["BTC"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.status, "submitted");
    assert.match(body.provider_ref_commitment, /^hyperliquid_provider_ref_/);
    assert.equal(body.visibility_summary.main_wallet_exposed, false);
    assert.equal(body.visibility_summary.venue_access_source, "user_provided_credentials");
    assert.equal(body.visibility_summary.venue_gate, "venue_accepts_or_rejects_credentials");
    assert.equal(JSON.stringify(body).includes("sealed-hyperliquid-vault"), false);

    const cancelResponse = await fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: vault.account_commitment,
        work_order_commitment: "connector_work_order_cancel_123",
        vault_commitment: "hyperliquid_vault_commitment_123",
        policy_commitment: "hyperliquid_policy_commitment_123",
        operation_class: "cancel",
        encrypted_execution_vault: vault.encrypted_execution_vault,
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          work_order_commitment: "connector_work_order_cancel_123",
          operation_class: "cancel",
          cancel: {
            market: "BTC",
            target_work_order_commitment: workOrderCommitment,
          },
        }),
        session_policy: {
          market_allowlist: ["BTC"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(cancelResponse.status, 202);
    const cancelBody = await cancelResponse.json();
    assert.equal(cancelBody.status, "cancelled");
    assert.equal(JSON.stringify(cancelBody).includes("connector_work_order_123"), false);
  });

  it("reads Hyperliquid account readiness through sealed credentials only", async () => {
    const vault = await encryptedHyperliquidVault(baseUrl);
    const response = await fetch(`${baseUrl}/hyperliquid/account-snapshot`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: "acct_commitment_123",
        vault_commitment: "hyperliquid_vault_commitment_123",
        encrypted_execution_vault: vault.encrypted_execution_vault,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ready_to_trade");
    assert.equal(body.account_source, "sealed_byo");
    assert.equal(body.trading_enabled, true);
    assert.equal(JSON.stringify(body).includes("api_wallet_private_key"), false);
    assert.equal(JSON.stringify(body).includes("hyperliquid_account_id"), false);
  });

  it("verifies venue credentials server-side without exposing sealed vault material", async () => {
    const vault = await encryptedCoinbaseVault(baseUrl);
    const response = await fetch(`${baseUrl}/venues/credentials/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "coinbase_advanced",
        account_commitment: "acct_commitment_123",
        encrypted_execution_vault: vault,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "verified");
    assert.equal(body.can_read, true);
    assert.equal(body.can_trade, true);
    assert.equal(body.can_withdraw, false);
    assert.match(body.verification_commitment, /^venue_credential_verification_/);
    assert.equal(JSON.stringify(body).includes("api_private_key_pem"), false);
    assert.equal(JSON.stringify(body).includes("sealed-provider-v1"), false);
  });

  it("prepares an Aster signer inside the worker without authorizing or broadcasting", async () => {
    const response = await fetch(`${baseUrl}/venues/aster/credentials/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "aster",
        platform_class: "hyperliquid_style_market",
        execution_mode: "worker_generated_agent",
        operation_class: "credential_provision",
        owner_commitment: "owner_commitment_aster_provision_123",
        account_commitment: "acct_commitment_aster_provision_123",
        owner_address: "0x2222222222222222222222222222222222222222",
        agent_name: "ghola-perps",
      }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.venue_id, "aster");
    assert.equal(body.owner_authorization.status, "signature_required");
    assert.equal(body.setup.may_place_trade, false);
    assert.equal(body.setup.transaction_broadcast, false);
    assert.equal(body.permissions.can_withdraw, false);
    assert.match(body.signer_address, /^0x[0-9a-f]{40}$/);
    assert.equal(JSON.stringify(body).includes("api_wallet_private_key"), false);
    assert.equal(body.encrypted_execution_vault.recipient, (await recipient(baseUrl)).recipient_id);
  });

  it("prepares a canonical Lighter key inside the worker without owner signing or broadcasting", async () => {
    const response = await fetch(`${baseUrl}/venues/lighter/credentials/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "lighter",
        platform_class: "hyperliquid_style_market",
        execution_mode: "worker_generated_api_key",
        operation_class: "credential_provision",
        owner_commitment: "owner_commitment_lighter_provision_123",
        account_commitment: "acct_commitment_lighter_provision_123",
        owner_address: "0x3333333333333333333333333333333333333333",
        account_index: 123,
        api_key_index: 4,
      }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.venue_id, "lighter");
    assert.equal(body.public_key, LIGHTER_PUBLIC_KEY);
    assert.equal(body.owner_association.status, "pending");
    assert.equal(body.authority_boundary.venue_native_trade_only, false);
    assert.equal(body.setup.may_place_trade, false);
    assert.equal(body.setup.transaction_signed, false);
    assert.equal(body.setup.transaction_broadcast, false);
    assert.equal(body.setup.credential_ready, false);
    assert.equal(JSON.stringify(body).includes(LIGHTER_PRIVATE_KEY), false);
    assert.equal(body.encrypted_execution_vault.recipient, (await recipient(baseUrl)).recipient_id);
  });

  it("rejects reserved Lighter wallet slots before generating a credential", async () => {
    const response = await fetch(`${baseUrl}/venues/lighter/credentials/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "lighter",
        platform_class: "hyperliquid_style_market",
        execution_mode: "worker_generated_api_key",
        operation_class: "credential_provision",
        owner_commitment: "owner_commitment_lighter_provision_123",
        account_commitment: "acct_commitment_lighter_provision_123",
        owner_address: "0x3333333333333333333333333333333333333333",
        account_index: 123,
        api_key_index: 1,
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.details.includes("api_key_index must be an integer from 2 through 254"), true);
  });

  it("rejects Aster credential preparation with missing explicit setup bounds", async () => {
    const response = await fetch(`${baseUrl}/venues/aster/credentials/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "aster",
        owner_address: "0x2222222222222222222222222222222222222222",
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.details.includes("operation_class must be credential_provision"), true);
    assert.equal(body.details.includes("account_commitment is required"), true);
  });

  it("authorizes one Aster registration request under concurrent completion", async () => {
    await close(server);
    const state = createWorkerState(dir);
    let providerCalls = 0;
    let markProviderStarted;
    let releaseProvider;
    const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
    const providerReleased = new Promise((resolve) => { releaseProvider = resolve; });
    server = createPrivateAgentWorkerServer({
      state,
      startAutopilotDueLoop: false,
      startMultiLegRecoveryLoop: false,
      startCarryMonitoringLoop: false,
      startCarryExecutionLoop: false,
      startKrakenV2Heartbeat: false,
      asterRegistrationFetch: async () => {
        providerCalls += 1;
        markProviderStarted();
        await providerReleased;
        return Response.json({ code: 200, msg: "success" });
      },
    });
    baseUrl = await listen(server);

    try {
      const owner = privateKeyToAccount(`0x${"42".repeat(32)}`);
      const accountCommitment = "acct_commitment_aster_authorize_route";
      const preparedResponse = await fetch(`${baseUrl}/venues/aster/credentials/prepare`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-ghola-sealed-execution-required": "true",
        },
        body: JSON.stringify({
          version: 1,
          venue_id: "aster",
          platform_class: "hyperliquid_style_market",
          execution_mode: "worker_generated_agent",
          operation_class: "credential_provision",
          owner_commitment: "owner_commitment_aster_authorize_route",
          account_commitment: accountCommitment,
          owner_address: owner.address,
          agent_name: "ghola-perps",
        }),
      });
      assert.equal(preparedResponse.status, 201);
      const prepared = await preparedResponse.json();
      const now = Date.now();
      const nonce = now * 1_000;
      const expired = now + 3_600_000;
      const parameters = asterRegistrationParameters({
        owner: owner.address,
        nonce,
        agentName: "ghola-perps",
        signer: prepared.signer_address,
        expired,
        ipWhitelist: [],
      });
      const typedData = asterRegistrationTypedData(parameters);
      const signature = await owner.signTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });
      const authorizationBody = {
        version: 1,
        venue_id: "aster",
        platform_class: "hyperliquid_style_market",
        execution_mode: "worker_generated_agent",
        operation_class: "credential_authorize",
        owner_commitment: "owner_commitment_aster_authorize_route",
        account_commitment: accountCommitment,
        owner_address: owner.address,
        signer_address: prepared.signer_address,
        preparation_id: asterPreparationId({
          accountCommitment,
          ownerAddress: owner.address,
          signerAddress: prepared.signer_address,
          nonce,
        }),
        agent_name: "ghola-perps",
        nonce,
        expired,
        ip_whitelist: [],
        signature,
        encrypted_execution_vault: prepared.encrypted_execution_vault,
      };
      const submit = () => fetch(`${baseUrl}/venues/aster/credentials/authorize`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-ghola-credential-authorization-required": "true",
          "x-ghola-sealed-execution-required": "true",
        },
        body: JSON.stringify(authorizationBody),
      });
      const firstResponse = submit();
      await providerStarted;
      const concurrentResponse = await submit();
      assert.equal(concurrentResponse.status, 409);
      assert.equal((await concurrentResponse.json()).error_code, "aster_registration_not_retryable");
      releaseProvider();
      const completedResponse = await firstResponse;
      assert.equal(completedResponse.status, 201);
      assert.equal((await completedResponse.json()).status, "registered");
      assert.equal(providerCalls, 1);
    } finally {
      releaseProvider();
    }
  });

  it("verifies Coinbase no-submit readiness without broadcasting", async () => {
    const vault = await encryptedCoinbaseVault(baseUrl);
    const response = await fetch(`${baseUrl}/venues/coinbase/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "coinbase_advanced",
        platform_class: "coinbase_style_provider",
        execution_mode: "byo_api_key",
        work_order_commitment: "connector_work_order_coinbase_verify_123",
        vault_commitment: "coinbase_vault_commitment_123",
        policy_commitment: "coinbase_policy_commitment_123",
        operation_class: "spot_market_order",
        encrypted_execution_vault: vault,
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "coinbase_advanced",
          work_order_commitment: "connector_work_order_coinbase_verify_123",
          operation_class: "spot_market_order",
          order: {
            market: "BTC-USD",
            side: "buy",
            quote_size: "5",
            order_type: "market",
            size_mode: "quote",
            tif: "ioc",
          },
        }),
        session_policy: {
          market_allowlist: ["BTC-USD"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "verified_no_funds");
    assert.equal(body.checks.transaction_broadcast, false);
    assert.equal(body.checks.coinbase_order_request_built, true);
    assert.equal(JSON.stringify(body).includes("api_private_key_pem"), false);
  });

  it("streams sanitized Hyperliquid account state through sealed credentials only", async () => {
    const vault = await encryptedHyperliquidVault(baseUrl);
    const response = await fetch(`${baseUrl}/hyperliquid/account-stream`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: "acct_commitment_123",
        vault_commitment: "hyperliquid_vault_commitment_123",
        encrypted_execution_vault: vault.encrypted_execution_vault,
        coin: "BTC",
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    const body = await readSseEvent(response, "account_state");
    assert.equal(body.status, "ready_to_trade");
    assert.equal(body.stream_status, "live");
    assert.equal(body.visibility_summary.main_wallet_exposed, false);
    assert.equal(body.visibility_summary.hyperliquid_sees, "execution_account_and_order_activity");
    assert.equal(JSON.stringify(body).includes("api_wallet_private_key"), false);
    assert.equal(JSON.stringify(body).includes("hyperliquid_account_id"), false);
    assert.equal(JSON.stringify(body).includes("0x0000000000000000000000000000000000000001"), false);
  });

  it("reports missing BYO Hyperliquid credentials as venue access required", async () => {
    const response = await fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        work_order_commitment: "connector_work_order_missing_access_123",
        policy_commitment: "hyperliquid_policy_commitment_123",
        operation_class: "limit_order",
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error_code, "venue_access_required");
    assert.match(body.details.join(" "), /vault_commitment|encrypted_execution_vault/);
  });

  it("allocates and submits Hyperliquid managed testnet work without raw credentials", async () => {
    const allocationResponse = await fetch(`${baseUrl}/hyperliquid/managed/allocations`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: "acct_commitment_managed_123",
        policy_commitment: "hyperliquid_policy_commitment_managed_123",
        network: "testnet",
        session_policy: {
          market_allowlist: ["BTC"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(allocationResponse.status, 201);
    const allocation = await allocationResponse.json();
    assert.equal(allocation.execution_mode, "managed_testnet");
    assert.equal(allocation.network, "testnet");
    assert.match(allocation.allocation_commitment, /^hyperliquid_managed_allocation_/);
    assert.equal(JSON.stringify(allocation).includes("credential_ref"), false);
    assert.equal(JSON.stringify(allocation).includes("api_wallet_private_key"), false);

    const sessionResponse = await fetch(`${baseUrl}/hyperliquid/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        execution_mode: "managed_testnet",
        account_commitment: allocation.account_commitment,
        managed_allocation_commitment: allocation.allocation_commitment,
        policy_commitment: allocation.policy_commitment,
        session_policy: allocation.session_policy,
      }),
    });

    assert.equal(sessionResponse.status, 201);
    const session = await sessionResponse.json();
    assert.equal(session.execution_mode, "managed_testnet");
    assert.equal(session.allocation_commitment, allocation.allocation_commitment);

    const workOrderCommitment = "connector_work_order_managed_123";
    const orderResponse = await fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        execution_mode: "managed_testnet",
        work_order_commitment: workOrderCommitment,
        managed_allocation_commitment: allocation.allocation_commitment,
        policy_commitment: allocation.policy_commitment,
        operation_class: "limit_order",
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          work_order_commitment: workOrderCommitment,
          operation_class: "limit_order",
          order: {
            market: "BTC",
            side: "buy",
            base_size: "0.001",
            limit_price: "10000",
            tif: "Gtc",
          },
        }),
        session_policy: allocation.session_policy,
      }),
    });

    assert.equal(orderResponse.status, 202);
    const body = await orderResponse.json();
    assert.equal(body.execution_mode, "managed_testnet");
    assert.equal(body.account_commitment, allocation.account_commitment);
    assert.equal(body.allocation_commitment, allocation.allocation_commitment);
    assert.equal(body.visibility_summary.hyperliquid_sees, "execution_account_and_order_activity");
    assert.equal(JSON.stringify(body).includes("api_wallet_private_key"), false);
  });

  it("allocates Hyperliquid Vault Mode and verifies no-submit without raw user credentials", async () => {
    process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    const allocationResponse = await fetch(`${baseUrl}/hyperliquid/managed/allocations`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        execution_mode: "ghola_pooled",
        network: "mainnet",
        account_commitment: "acct_commitment_hl_pooled_123",
        policy_commitment: "hyperliquid_policy_commitment_pooled_123",
        eligibility_commitment: "venue_eligibility_hyperliquid_123",
        session_policy: {
          market_allowlist: ["BTC"],
          max_notional_bucket: "5",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(allocationResponse.status, 201);
    const allocation = await allocationResponse.json();
    assert.equal(allocation.execution_mode, "ghola_pooled");
    assert.equal(allocation.network, "mainnet");
    assert.match(allocation.pool_share_commitment, /^hyperliquid_pool_share_/);
    assert.equal(JSON.stringify(allocation).includes("credential_ref"), false);
    assert.equal(JSON.stringify(allocation).includes("api_wallet_private_key"), false);

    const workOrderCommitment = "connector_work_order_hl_pooled_verify_123";
    const response = await fetch(`${baseUrl}/hyperliquid/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({
        version: 1,
        execution_mode: "ghola_pooled",
        work_order_commitment: workOrderCommitment,
        managed_allocation_commitment: allocation.allocation_commitment,
        allocation_commitment: allocation.allocation_commitment,
        policy_commitment: allocation.policy_commitment,
        operation_class: "limit_order",
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          work_order_commitment: workOrderCommitment,
          operation_class: "limit_order",
          order: {
            market: "BTC",
            side: "buy",
            quote_size: "5",
            max_slippage_bps: "50",
            live_order_mode: "tiny_fill",
            tif: "Ioc",
          },
        }),
        session_policy: allocation.session_policy,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.execution_mode, "ghola_pooled");
    assert.equal(body.visibility_summary.venue_access_source, "ghola_pooled_venue_account");
    assert.equal(body.checks.transaction_broadcast, false);
    assert.equal(JSON.stringify(body).includes("api_wallet_private_key"), false);
  });

  it("routes sealed Aster orders and requires an explicit no-submit verification header", async () => {
    process.env.PRIVATE_AGENT_ASTER_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_ASTER_LIVE_MODE = "full_ticket";
    const workOrderCommitment = "connector_work_order_aster_dry_run_123";
    const requestBody = {
      version: 1,
      venue_id: "aster",
      account_commitment: "acct_commitment_aster_123",
      platform_class: "hyperliquid_style_market",
      execution_mode: "byo_api_key",
      work_order_commitment: workOrderCommitment,
      vault_commitment: "aster_vault_commitment_123",
      policy_commitment: "aster_policy_commitment_123",
      operation_class: "limit_order",
      encrypted_execution_vault: await encryptedAsterVault(baseUrl),
      encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
        venue_id: "aster",
        work_order_commitment: workOrderCommitment,
        operation_class: "limit_order",
        order: {
          market: "BTC",
          side: "buy",
          base_size: "0.001",
          quote_size: "5",
          limit_price: "50000",
          reduce_only: false,
          tif: "Ioc",
        },
      }),
      session_policy: {
        market_allowlist: ["BTC"],
        max_notional_bucket: "25",
        max_order_count: 5,
        kill_switch: false,
      },
    };
    const submitted = await fetch(`${baseUrl}/venues/aster/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(submitted.status, 202);
    const receipt = await submitted.json();
    assert.equal(receipt.venue_id, "aster");
    assert.equal(receipt.platform_class, "hyperliquid_style_market");
    assert.equal(JSON.stringify(receipt).includes("api_wallet_private_key"), false);

    const mismatchedAccount = await fetch(`${baseUrl}/venues/aster/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({ ...requestBody, account_commitment: "acct_commitment_wrong_123" }),
    });
    assert.equal(mismatchedAccount.status, 403);
    assert.match((await mismatchedAccount.json()).error, /account binding mismatch/);

    const missingHeader = await fetch(`${baseUrl}/venues/aster/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(missingHeader.status, 400);
    assert.equal((await missingHeader.json()).error, "no-submit verification header is required");

    const invalidPreflight = await fetch(`${baseUrl}/venues/aster/preflight`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(invalidPreflight.status, 400);
    assert.equal((await invalidPreflight.json()).error, "invalid aster preflight request");

    const invalidLighterPreflight = await fetch(`${baseUrl}/venues/lighter/preflight`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(invalidLighterPreflight.status, 400);
    assert.equal((await invalidLighterPreflight.json()).error, "invalid lighter preflight request");

    const invalidPair = await fetch(`${baseUrl}/carry/preflight`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(invalidPair.status, 400);
    assert.equal((await invalidPair.json()).error, "invalid carry preflight request");

    const invalidMatrix = await fetch(`${baseUrl}/carry/preflight-matrix`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(invalidMatrix.status, 400);
    assert.equal((await invalidMatrix.json()).error, "invalid carry execution matrix request");

    const invalidReadiness = await fetch(`${baseUrl}/carry/readiness`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(invalidReadiness.status, 400);
    assert.equal((await invalidReadiness.json()).error, "invalid carry readiness request");
  });

  it("rejects Hyperliquid mainnet credentials during the testnet pilot", async () => {
    const mainnetVault = await encryptedHyperliquidExecutionVaultForNetwork(baseUrl, "mainnet");

    const response = await fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: "acct_commitment_123",
        work_order_commitment: "connector_work_order_mainnet_123",
        vault_commitment: "hyperliquid_vault_commitment_123",
        policy_commitment: "hyperliquid_policy_commitment_123",
        operation_class: "limit_order",
        encrypted_execution_vault: mainnetVault,
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          work_order_commitment: "connector_work_order_mainnet_123",
          operation_class: "limit_order",
          order: {
            market: "BTC",
            side: "buy",
            base_size: "0.001",
            limit_price: "10000",
          },
        }),
        session_policy: {
          market_allowlist: ["BTC"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /testnet-only/);
  });

  it("rejects Hyperliquid mainnet orders unless they use tiny-fill live mode", async () => {
    process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    const mainnetVault = await encryptedHyperliquidExecutionVaultForNetwork(baseUrl, "mainnet");

    const response = await fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: "acct_commitment_123",
        work_order_commitment: "connector_work_order_mainnet_non_tiny_123",
        vault_commitment: "hyperliquid_vault_commitment_123",
        policy_commitment: "hyperliquid_policy_commitment_123",
        operation_class: "limit_order",
        encrypted_execution_vault: mainnetVault,
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          work_order_commitment: "connector_work_order_mainnet_non_tiny_123",
          operation_class: "limit_order",
          order: {
            market: "BTC",
            side: "buy",
            base_size: "0.001",
            limit_price: "10000",
            tif: "Gtc",
          },
        }),
        session_policy: {
          market_allowlist: ["BTC"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /tiny_fill/);
  });

  it("accepts capped Hyperliquid mainnet tiny-fill orders in explicit live mode", async () => {
    process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD = "5";
    process.env.PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD = "25";
    const mainnetVault = await encryptedHyperliquidExecutionVaultForNetwork(baseUrl, "mainnet");

    const response = await fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: "acct_commitment_123",
        work_order_commitment: "connector_work_order_mainnet_tiny_123",
        vault_commitment: "hyperliquid_vault_commitment_123",
        policy_commitment: "hyperliquid_policy_commitment_123",
        operation_class: "limit_order",
        encrypted_execution_vault: mainnetVault,
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          work_order_commitment: "connector_work_order_mainnet_tiny_123",
          operation_class: "limit_order",
          order: {
            market: "BTC",
            side: "buy",
            quote_size: "5",
            max_slippage_bps: "50",
            live_order_mode: "tiny_fill",
            tif: "Ioc",
          },
        }),
        session_policy: {
          market_allowlist: ["BTC"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.status, "submitted");
    assert.equal(body.visibility_summary.main_wallet_exposed, false);
    assert.equal(body.visibility_summary.public_chain_sees, "no_ghola_public_settlement");
    assert.equal(JSON.stringify(body).includes("api_wallet_private_key"), false);
  });

  it("verifies Hyperliquid mainnet tiny-fill readiness without broadcasting", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    process.env.PRIVATE_AGENT_HYPERLIQUID_NO_SUBMIT_LOCAL_CHECKS = "true";
    process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD = "5";
    process.env.PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD = "25";
    const workOrderCommitment = "connector_work_order_hyperliquid_verify_123";
    const mainnetVault = await encryptedHyperliquidExecutionVaultForNetwork(baseUrl, "mainnet");
    const requestBody = {
      version: 1,
      account_commitment: "acct_commitment_123",
      work_order_commitment: workOrderCommitment,
      vault_commitment: "hyperliquid_vault_commitment_123",
      policy_commitment: "hyperliquid_policy_commitment_123",
      operation_class: "limit_order",
      encrypted_execution_vault: mainnetVault,
      encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
        venue_id: "hyperliquid",
        work_order_commitment: workOrderCommitment,
        operation_class: "limit_order",
        order: {
          market: "BTC",
          side: "buy",
          quote_size: "5",
          max_slippage_bps: "50",
          live_order_mode: "tiny_fill",
          tif: "Ioc",
        },
      }),
      session_policy: {
        market_allowlist: ["BTC"],
        max_notional_bucket: "25",
        max_order_count: 5,
        kill_switch: false,
      },
    };
    const response = await fetch(`${baseUrl}/hyperliquid/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify(requestBody),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "verified_no_funds");
    assert.match(body.provider_ref_commitment, /^hyperliquid_provider_ref_/);
    assert.match(body.verification_commitment, /^hyperliquid_no_submit_verification_/);
    assert.equal(body.checks.transaction_broadcast, false);
    assert.equal(body.checks.sealed_vault_opened, true);
    assert.equal(body.checks.sealed_instruction_opened, true);
    assert.equal(body.checks.policy_enforced, true);
    assert.equal(body.checks.live_gate_enforced, true);
    assert.equal(body.checks.hyperliquid_sdk_ready, true);
    assert.equal(body.checks.hyperliquid_api_reachable, true);
    assert.equal(body.checks.account_read_checked, true);
    assert.equal(body.checks.order_request_built, true);
    assert.equal(body.visibility_summary.public_chain_sees, "no_transaction_sent");
    assert.equal(body.visibility_summary.venue_gate, "not_tested_without_submit");
    assert.equal(JSON.stringify(body).includes("api_wallet_private_key"), false);
    assert.equal(JSON.stringify(body).includes("0x1111111111111111111111111111111111111111111111111111111111111111"), false);

    const mismatchedAccount = await fetch(`${baseUrl}/hyperliquid/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({ ...requestBody, account_commitment: "acct_commitment_wrong_123" }),
    });
    assert.equal(mismatchedAccount.status, 403);
    assert.match((await mismatchedAccount.json()).error, /account binding mismatch/);
  });

  it("requires the no-submit header for Hyperliquid verification", async () => {
    const vault = await encryptedHyperliquidVault(baseUrl);
    const response = await fetch(`${baseUrl}/hyperliquid/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        work_order_commitment: "connector_work_order_hyperliquid_missing_header_123",
        vault_commitment: "hyperliquid_vault_commitment_123",
        policy_commitment: "hyperliquid_policy_commitment_123",
        operation_class: "limit_order",
        encrypted_execution_vault: vault.encrypted_execution_vault,
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          work_order_commitment: "connector_work_order_hyperliquid_missing_header_123",
          operation_class: "limit_order",
          order: {
            market: "BTC",
            side: "buy",
            base_size: "0.001",
            limit_price: "10000",
            tif: "Gtc",
          },
        }),
        session_policy: {
          market_allowlist: ["BTC"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "no-submit verification header is required");
  });

  it("rejects Hyperliquid mainnet tiny-fill orders above the live cap", async () => {
    process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD = "25";
    const mainnetVault = await encryptedHyperliquidExecutionVaultForNetwork(baseUrl, "mainnet");

    const response = await fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: "acct_commitment_123",
        work_order_commitment: "connector_work_order_mainnet_tiny_over_cap_123",
        vault_commitment: "hyperliquid_vault_commitment_123",
        policy_commitment: "hyperliquid_policy_commitment_123",
        operation_class: "limit_order",
        encrypted_execution_vault: mainnetVault,
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          work_order_commitment: "connector_work_order_mainnet_tiny_over_cap_123",
          operation_class: "limit_order",
          order: {
            market: "BTC",
            side: "buy",
            quote_size: "26",
            max_slippage_bps: "50",
            live_order_mode: "tiny_fill",
            tif: "Ioc",
          },
        }),
        session_policy: {
          market_allowlist: ["BTC"],
          max_notional_bucket: "100",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /live notional cap/);
  });

  it("rejects Hyperliquid cancel requests without a known Ghola work order", async () => {
    const vault = await encryptedHyperliquidVault(baseUrl);
    const response = await fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: vault.account_commitment,
        work_order_commitment: "connector_work_order_cancel_unknown_123",
        vault_commitment: "hyperliquid_vault_commitment_123",
        policy_commitment: "hyperliquid_policy_commitment_123",
        operation_class: "cancel",
        encrypted_execution_vault: vault.encrypted_execution_vault,
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "hyperliquid",
          work_order_commitment: "connector_work_order_cancel_unknown_123",
          operation_class: "cancel",
          cancel: {
            market: "BTC",
            target_work_order_commitment: "connector_work_order_missing_123",
          },
        }),
        session_policy: {
          market_allowlist: ["BTC"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /cancel target work order/);
  });

  it("rejects plaintext Hyperliquid strategy, prompt, credentials, or orders", async () => {
    const response = await fetch(`${baseUrl}/hyperliquid/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        work_order_commitment: "connector_work_order_123",
        vault_commitment: "hyperliquid_vault_commitment_123",
        policy_commitment: "hyperliquid_policy_commitment_123",
        operation_class: "limit_order",
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-hyperliquid-vault",
          recipient: await recipientId(baseUrl),
          aad: "ghola/hyperliquid-execution-vault-v1",
        },
        nested: {
          order_payload: { market: "ETH", size: "raw" },
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.details.join(" "), /plaintext Hyperliquid/);
  });

  it("submits Coinbase partner omnibus orders without raw API-key material", async () => {
    const workOrderCommitment = "connector_work_order_coinbase_123";
    const response = await fetch(`${baseUrl}/venues/coinbase/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "coinbase_advanced",
        platform_class: "coinbase_style_provider",
        execution_mode: "partner_omnibus",
        work_order_commitment: workOrderCommitment,
        operation_class: "spot_limit_order",
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "coinbase_advanced",
          work_order_commitment: workOrderCommitment,
          operation_class: "spot_limit_order",
          order: {
            product_id: "BTC-USD",
            side: "buy",
            base_size: "0.001",
            limit_price: "10000",
            tif: "gtc",
          },
        }),
        omnibus_allocation: {
          allocation_commitment: "omnibus_allocation_123",
          pool_commitment: "omnibus_pool_123",
          partner_commitment: "omnibus_partner_123",
          subledger_account_commitment: "omnibus_subledger_123",
          settlement_funding_commitment: "funding_import_123",
          status: "allocated",
        },
      }),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.status, "submitted");
    assert.equal(body.execution_mode, "partner_omnibus");
    assert.equal(body.allocation_commitment, "omnibus_allocation_123");
    assert.equal(JSON.stringify(body).includes("api_key"), false);
  });

  it("rejects plaintext Coinbase credentials or orders", async () => {
    const response = await fetch(`${baseUrl}/venues/coinbase/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "coinbase_advanced",
        platform_class: "coinbase_style_provider",
        execution_mode: "byo_api_key",
        work_order_commitment: "connector_work_order_coinbase_123",
        vault_commitment: "coinbase_vault_123",
        policy_commitment: "coinbase_policy_123",
        operation_class: "spot_limit_order",
        encrypted_execution_vault: {
          alg: "sealed-provider-v1",
          ciphertext: "sealed-coinbase-vault",
          recipient: await recipientId(baseUrl),
          aad: "ghola/coinbase-advanced-execution-vault-v1",
        },
        nested: {
          api_key_name: "organizations/raw/apiKeys/raw",
          order_payload: { product_id: "BTC-USD", size: "raw" },
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.details.join(" "), /plaintext Coinbase/);
  });

  it("submits Solana perps orders through sealed instructions only", async () => {
    const workOrderCommitment = "connector_work_order_phoenix_123";
    const response = await fetch(`${baseUrl}/venues/solana-perps/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "phoenix",
        platform_class: "solana_perps_market",
        execution_mode: "user_stealth",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_vault: await encryptedSolanaPerpsVault(baseUrl),
        policy_commitment: "phoenix_policy_commitment_123",
        operation_class: "perp_limit_order",
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "phoenix",
          work_order_commitment: workOrderCommitment,
          operation_class: "perp_limit_order",
          order: {
            market: "SOL-PERP",
            side: "buy",
            base_size: "0.1",
            limit_price: "100",
            tif: "Gtc",
          },
        }),
        session_policy: {
          market_allowlist: ["SOL-PERP"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.venue_id, "phoenix");
    assert.equal(body.platform_class, "solana_perps_market");
    assert.equal(body.execution_mode, "user_stealth");
    assert.equal(body.status, "submitted");
    assert.equal(body.visibility_summary.main_wallet_exposed, false);
    assert.equal(body.visibility_summary.solana_perps_sees, "stealth_venue_account_and_order_activity");
    assert.equal(JSON.stringify(body).includes("SOL-PERP"), false);
    assert.equal(JSON.stringify(body).includes("wallet_private_key"), false);
  });

  it("reconciles Solana perps work orders without exposing raw venue details", async () => {
    const response = await fetch(`${baseUrl}/venues/solana-perps/reconcile`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "phoenix",
        work_order_commitment: "connector_work_order_phoenix_reconcile_123",
        provider_ref_commitment: "phoenix_provider_ref_123",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "reconciled");
    assert.equal(body.platform_class, "solana_perps_market");
    assert.equal(body.visibility_summary.main_wallet_exposed, false);
  });

  it("verifies Solana perps no-submit readiness without broadcasting", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE = "sdk_runner";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD = "5";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_NO_SUBMIT_LOCAL_CHECKS = "true";
    const workOrderCommitment = "connector_work_order_phoenix_verify_123";
    const response = await fetch(`${baseUrl}/venues/solana-perps/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "phoenix",
        platform_class: "solana_perps_market",
        execution_mode: "user_stealth",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_vault: await encryptedSolanaPerpsVault(baseUrl),
        policy_commitment: "phoenix_policy_commitment_123",
        operation_class: "perp_limit_order",
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "phoenix",
          work_order_commitment: workOrderCommitment,
          operation_class: "perp_limit_order",
          order: {
            market: "SOL",
            side: "buy",
            quote_size: "5",
            limit_price: "250",
            tif: "Ioc",
            live_order_mode: "tiny_fill",
          },
        }),
        session_policy: {
          market_allowlist: ["SOL"],
          max_notional_bucket: "5",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "verified_no_funds");
    assert.equal(body.checks.transaction_broadcast, false);
    assert.equal(body.checks.order_packet_built, true);
    assert.equal(body.visibility_summary.public_chain_sees, "no_transaction_sent");
    assert.equal(JSON.stringify(body).includes("wallet_private_key"), false);
  });

  it("verifies Jupiter no-submit readiness without broadcasting", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    process.env.PRIVATE_AGENT_JUPITER_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_JUPITER_API_KEY = "test-jupiter-key";
    process.env.PRIVATE_AGENT_JUPITER_NO_SUBMIT_LOCAL_CHECKS = "true";
    process.env.PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS = JUPITER_SOL_MINT;
    process.env.PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS = JUPITER_USDC_MINT;
    const workOrderCommitment = "connector_work_order_jupiter_verify_123";
    const response = await fetch(`${baseUrl}/venues/solana-swap/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "jupiter",
        platform_class: "solana_swap_aggregator",
        execution_mode: "user_stealth",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_vault: await encryptedJupiterVault(baseUrl),
        policy_commitment: "jupiter_policy_commitment_123",
        operation_class: "swap",
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "jupiter",
          work_order_commitment: workOrderCommitment,
          operation_class: "swap",
          order: {
            market: "SOL/USDC",
            side: "buy",
            input_mint: JUPITER_SOL_MINT,
            output_mint: JUPITER_USDC_MINT,
            amount: "1000000",
            quote_size: "5",
            max_slippage_bps: "50",
            routing_mode: "meta_aggregator",
          },
        }),
        session_policy: {
          market_allowlist: [],
          max_notional_bucket: "5",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "verified_no_funds");
    assert.equal(body.venue_id, "jupiter");
    assert.equal(body.platform_class, "solana_swap_aggregator");
    assert.equal(body.checks.transaction_broadcast, false);
    assert.equal(body.checks.jupiter_api_reachable, true);
    assert.equal(body.checks.jupiter_token_allowlist_passed, true);
    assert.equal(body.checks.jupiter_order_built, true);
    assert.equal(body.checks.jupiter_transaction_built, true);
    assert.equal(body.final_proof.proof_kind, "jupiter_swap_execution_proof_v1");
    assert.equal(body.final_proof.broadcast_performed, false);
    assert.equal(JSON.stringify(body).includes("wallet_private_key"), false);
    assert.equal(JSON.stringify(body).includes(JUPITER_SOL_MINT), false);
  });

  it("submits and reconciles Jupiter dry-run swaps through sealed instructions only", async () => {
    const workOrderCommitment = "connector_work_order_jupiter_dry_run_123";
    const orderBody = {
      version: 1,
      venue_id: "jupiter",
      platform_class: "solana_swap_aggregator",
      execution_mode: "user_stealth",
      work_order_commitment: workOrderCommitment,
      policy_commitment: "jupiter_policy_commitment_123",
      operation_class: "swap",
      encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
        venue_id: "jupiter",
        work_order_commitment: workOrderCommitment,
        operation_class: "swap",
        order: {
          market: "SOL/USDC",
          side: "buy",
          input_mint: JUPITER_SOL_MINT,
          output_mint: JUPITER_USDC_MINT,
          amount: "1000000",
          quote_size: "5",
          max_slippage_bps: "50",
          routing_mode: "router",
        },
      }),
      session_policy: {
        market_allowlist: [],
        max_notional_bucket: "5",
        max_order_count: 5,
        kill_switch: false,
      },
    };
    const submitResponse = await fetch(`${baseUrl}/venues/solana-swap/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(orderBody),
    });

    assert.equal(submitResponse.status, 202);
    const submitted = await submitResponse.json();
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.venue_id, "jupiter");
    assert.equal(submitted.execution_mode, "user_stealth");
    assert.equal(submitted.visibility_summary.jupiter_sees, "stealth_swap_authority_and_route");
    assert.equal(submitted.final_proof.proof_kind, "jupiter_swap_execution_proof_v1");
    assert.equal(JSON.stringify(submitted).includes("wallet_private_key"), false);
    assert.equal(JSON.stringify(submitted).includes(JUPITER_USDC_MINT), false);

    const reconcileResponse = await fetch(`${baseUrl}/venues/solana-swap/reconcile`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "jupiter",
        work_order_commitment: workOrderCommitment,
        provider_ref_commitment: submitted.provider_ref_commitment,
      }),
    });

    assert.equal(reconcileResponse.status, 200);
    const reconciled = await reconcileResponse.json();
    assert.equal(reconciled.status, "reconciled");
    assert.equal(reconciled.platform_class, "solana_swap_aggregator");
    assert.equal(reconciled.visibility_summary.main_wallet_exposed, false);
    assert.equal(reconciled.final_proof.proof_kind, "jupiter_swap_execution_proof_v1");
  });

  it("verifies pooled Phoenix no-submit readiness without a user execution vault", async () => {
    process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE = "sdk_runner";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD = "5";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_NO_SUBMIT_LOCAL_CHECKS = "true";
    const workOrderCommitment = "connector_work_order_phoenix_pooled_verify_123";
    const response = await fetch(`${baseUrl}/venues/solana-perps/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "phoenix",
        platform_class: "solana_perps_market",
        execution_mode: "ghola_pooled",
        allocation_commitment: "pooled_venue_allocation_phoenix_123",
        work_order_commitment: workOrderCommitment,
        policy_commitment: "phoenix_policy_commitment_pooled_123",
        operation_class: "perp_limit_order",
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "phoenix",
          work_order_commitment: workOrderCommitment,
          operation_class: "perp_limit_order",
          order: {
            market: "SOL",
            side: "buy",
            quote_size: "5",
            limit_price: "250",
            tif: "Ioc",
            live_order_mode: "tiny_fill",
          },
        }),
        session_policy: {
          market_allowlist: ["SOL"],
          max_notional_bucket: "5",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.execution_mode, "ghola_pooled");
    assert.equal(body.visibility_summary.venue_access_source, "ghola_pooled");
    assert.equal(body.checks.transaction_broadcast, false);
    assert.equal(JSON.stringify(body).includes("wallet_private_key"), false);
  });

  it("requires an explicit no-submit header for Solana perps verification", async () => {
    const response = await fetch(`${baseUrl}/venues/solana-perps/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "phoenix",
        platform_class: "solana_perps_market",
        execution_mode: "user_stealth",
        work_order_commitment: "connector_work_order_phoenix_verify_missing_header",
        operation_class: "perp_limit_order",
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /no-submit verification header/);
  });

  it("rejects plaintext Solana perps secrets or orders", async () => {
    const response = await fetch(`${baseUrl}/venues/solana-perps/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "phoenix",
        platform_class: "solana_perps_market",
        execution_mode: "user_stealth",
        work_order_commitment: "connector_work_order_phoenix_plaintext_123",
        operation_class: "perp_limit_order",
        nested: {
          wallet_private_key: "raw-solana-key",
          order_params: { market: "SOL-PERP", size: "raw" },
        },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.details.join(" "), /plaintext Solana perps/);
  });

  it("fails closed for live Solana perps submit until the SDK runner is configured", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const workOrderCommitment = "connector_work_order_phoenix_live_disabled_123";
    const response = await fetch(`${baseUrl}/venues/solana-perps/orders`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        version: 1,
        venue_id: "phoenix",
        platform_class: "solana_perps_market",
        execution_mode: "user_stealth",
        work_order_commitment: workOrderCommitment,
        encrypted_execution_vault: await encryptedSolanaPerpsVault(baseUrl),
        policy_commitment: "phoenix_policy_commitment_123",
        operation_class: "perp_limit_order",
        encrypted_execution_instruction_bundle: await encryptedInstruction(baseUrl, {
          venue_id: "phoenix",
          work_order_commitment: workOrderCommitment,
          operation_class: "perp_limit_order",
          order: {
            market: "SOL-PERP",
            side: "buy",
            base_size: "0.1",
            limit_price: "100",
          },
        }),
        session_policy: {
          market_allowlist: ["SOL-PERP"],
          max_notional_bucket: "25",
          max_order_count: 5,
          kill_switch: false,
        },
      }),
    });

    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error_code, "connector_submit_failed");
    assert.match(body.error, /live submit is disabled/);
  });

  it("rejects shielded-funding attestation without a bearer token", async () => {
    const response = await fetch(`${baseUrl}/venues/shielded-funding/attest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        withdraw_bundle: { instruction_data_hex: "ab", accounts: [] },
        destination_commitment: "dest-1",
        amount_bucket: "25",
      }),
    });
    assert.equal(response.status, 401);
  });

  it("requires the sealed-execution header for shielded-funding attestation", async () => {
    const response = await fetch(`${baseUrl}/venues/shielded-funding/attest`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        withdraw_bundle: { instruction_data_hex: "ab", accounts: [] },
        destination_commitment: "dest-1",
        amount_bucket: "25",
      }),
    });
    assert.equal(response.status, 400);
  });

  it("validates the shielded-funding attestation request shape", async () => {
    const response = await fetch(`${baseUrl}/venues/shielded-funding/attest`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({ destination_commitment: "dest-1" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(body.details.some((d) => d.includes("withdraw_bundle")));
    assert.ok(body.details.some((d) => d.includes("amount_bucket")));
  });

  it("returns a signed shielded-funding attestation in dry-run mode", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    const response = await fetch(`${baseUrl}/venues/shielded-funding/attest`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify({
        // Short destination so the dry-run relayer echo (slice 0,16) round-trips.
        withdraw_bundle: { instruction_data_hex: "ab", accounts: [] },
        destination_commitment: "dest-1",
        amount_bucket: "25",
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.attestation.rail, "ghola_shielded_pool");
    assert.equal(body.attestation.destination_commitment, "dest-1");
    assert.equal(body.attestation.amount_bucket, "25");
    assert.ok(body.signature_b64.length > 0);
    assert.ok(body.signer_public_key_b64.length > 0);
  });
});
