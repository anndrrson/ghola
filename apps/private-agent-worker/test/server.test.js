import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair } from "@solana/web3.js";
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
    server = createPrivateAgentWorkerServer();
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
    assert.equal(body.status, "reconciled");
    assert.equal(body.final_proof.broadcast_performed, false);
    assert.equal(body.final_proof.final_venue_execution_proven, false);
    assert.notEqual(body.status, "submitted");
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
      }),
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
