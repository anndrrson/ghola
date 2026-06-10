#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${PRIVATE_AGENT_WORKER_URL:-http://127.0.0.1:8787}"
TOKEN="${PRIVATE_AGENT_EXECUTION_TOKEN:-dev}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

node --input-type=module - "$ROOT" "$BASE_URL" "$TOKEN" <<'NODE'
import { generateKeyPairSync, sign } from "node:crypto";

const [root, baseUrlRaw, token] = process.argv.slice(2);
const baseUrl = baseUrlRaw.replace(/\/$/, "");

const {
  bytesToBase64,
  didKeyFromVerifying,
  hexToBytes,
  sealForTest,
} = await import(`${root}/apps/private-agent-worker/src/crypto/envelope.js`);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const senderPublic = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const senderDid = didKeyFromVerifying(senderPublic);

function fail(message, detail) {
  console.error(`[private-agent-worker-canary] ${message}`);
  if (detail) console.error(typeof detail === "string" ? detail : JSON.stringify(detail));
  process.exit(1);
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  }).catch((error) => fail(`request failed: ${path}`, String(error)));
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      fail(`non-JSON response from ${path}`, text.slice(0, 500));
    }
  }
  return { response, body, text };
}

async function authed(path, body) {
  return request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
    },
    body: JSON.stringify(body),
  });
}

async function sealedBundle(recipient, plaintext, aad) {
  const wire = await sealForTest({
    senderDid,
    recipientId: recipient.recipient_id,
    recipientX25519: hexToBytes(recipient.x25519_pub_hex),
    associatedData: aad,
    plaintext,
    signBody: async (digest) => new Uint8Array(sign(null, Buffer.from(digest), privateKey)),
  });
  return {
    alg: "sealed-provider-v1",
    ciphertext: bytesToBase64(wire),
    recipient: recipient.recipient_id,
    aad,
  };
}

async function expectStatus(label, promise, expected) {
  const result = await promise;
  if (result.response.status !== expected) {
    fail(`${label} expected HTTP ${expected}, got ${result.response.status}`, result.text);
  }
  console.log(`[private-agent-worker-canary] ${label} ok`);
  return result.body;
}

const health = await request("/health");
if (!health.response.ok) fail(`health returned ${health.response.status}`, health.text);
console.log(
  `[private-agent-worker-canary] health ready=${health.body.ready} attested=${health.body.attested} provider=${health.body.provider}`,
);

const recipientResult = await request("/.well-known/private-agent-recipient");
if (!recipientResult.response.ok) {
  fail(`recipient returned ${recipientResult.response.status}`, recipientResult.text);
}
const recipient = recipientResult.body;
console.log(`[private-agent-worker-canary] recipient=${recipient.recipient_id}`);

await expectStatus(
  "plaintext rejection",
  authed("/private-agent/sessions", {
    version: 1,
    strategy_id: "strategy_canary_plaintext",
    policy_hash: "policy_canary",
    owner_did: senderDid,
    mode: "capped_session_key",
    encrypted_strategy_bundle: {
      alg: "sealed-provider-v1",
      ciphertext: "ciphertext",
      recipient: recipient.recipient_id,
      aad: "ghola/private-agent-session-v1",
    },
    prompt: "buy eth",
  }),
  400,
);

const strategyAad = [
  "ghola-private-agent-session-v1",
  "strategy:strategy_canary",
  "policy:policy_canary",
  "provider:phala",
  `recipient:${recipient.recipient_id}`,
].join("|");
await expectStatus(
  "encrypted session acceptance",
  authed("/private-agent/sessions", {
    version: 1,
    strategy_id: "strategy_canary",
    policy_hash: "policy_canary",
    owner_did: senderDid,
    mode: "capped_session_key",
    encrypted_strategy_bundle: await sealedBundle(recipient, {
      version: 1,
      kind: "ghola_private_agent_strategy",
      strategy_id: "strategy_canary",
      source: "Local canary sealed strategy.",
      policy: {
        version: 1,
        strategy_id: "strategy_canary",
        allowed_assets: ["BTC"],
        max_trade_micro_usdc: 10_000_000,
        daily_cap_micro_usdc: 10_000_000,
        max_actions_per_day: 2,
      },
    }, strategyAad),
  }),
  201,
);

const hyperliquidVault = {
  version: 1,
  account_commitment: "acct_commitment_canary_hyperliquid",
  vault_commitment: "hyperliquid_vault_commitment_canary",
  policy_commitment: "hyperliquid_policy_commitment_canary",
  encrypted_execution_vault: await sealedBundle(recipient, {
    version: 1,
    kind: "ghola_hyperliquid_execution_vault",
    network: "testnet",
    hyperliquid_account_address: "0x0000000000000000000000000000000000000001",
    api_wallet_private_key: "0x1111111111111111111111111111111111111111111111111111111111111111",
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
  }, [
    "ghola/hyperliquid-execution-vault-v1",
    "account:acct_commitment_canary_hyperliquid",
    `recipient:${recipient.recipient_id}`,
    "network:testnet",
  ].join("|")),
  session_policy: {
    market_allowlist: ["BTC"],
    max_notional_bucket: "25",
    max_order_count: 5,
    kill_switch: false,
  },
};
await expectStatus("hyperliquid session", authed("/hyperliquid/sessions", hyperliquidVault), 201);

const hyperliquidWorkOrder = "connector_work_order_canary_hyperliquid";
const hyperliquidPreview = "preview_commitment_canary_hyperliquid";
await expectStatus(
  "hyperliquid order",
  authed("/hyperliquid/orders", {
    version: 1,
    work_order_commitment: hyperliquidWorkOrder,
    preview_commitment: hyperliquidPreview,
    vault_commitment: hyperliquidVault.vault_commitment,
    policy_commitment: hyperliquidVault.policy_commitment,
    operation_class: "limit_order",
    encrypted_execution_vault: hyperliquidVault.encrypted_execution_vault,
    encrypted_execution_instruction_bundle: await sealedBundle(recipient, {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "hyperliquid",
      operation_class: "limit_order",
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      order: {
        market: "BTC",
        side: "buy",
        base_size: "0.001",
        limit_price: "10000",
        tif: "Gtc",
      },
    }, [
      "ghola/private-execution-instruction-v1",
      `preview:${hyperliquidPreview}`,
      "venue:hyperliquid",
      `recipient:${recipient.recipient_id}`,
    ].join("|")),
    session_policy: hyperliquidVault.session_policy,
  }),
  202,
);

await expectStatus(
  "hyperliquid reconcile",
  authed("/hyperliquid/reconcile", {
    version: 1,
    work_order_commitment: hyperliquidWorkOrder,
  }),
  200,
);

const omnibusAllocation = {
  allocation_commitment: "omnibus_allocation_canary_coinbase",
  pool_commitment: "omnibus_pool_canary_coinbase",
  partner_commitment: "omnibus_partner_canary_coinbase",
  subledger_account_commitment: "omnibus_subledger_canary_coinbase",
  settlement_funding_commitment: "funding_import_canary_coinbase",
  status: "allocated",
};
await expectStatus(
  "coinbase omnibus allocation",
  authed("/omnibus/allocations", { version: 1, omnibus_allocation: omnibusAllocation }),
  201,
);

const coinbaseWorkOrder = "connector_work_order_canary_coinbase";
await expectStatus(
  "coinbase partner omnibus order",
  authed("/venues/coinbase/orders", {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: "partner_omnibus",
    work_order_commitment: coinbaseWorkOrder,
    operation_class: "spot_limit_order",
    encrypted_execution_instruction_bundle: await sealedBundle(recipient, {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "coinbase_advanced",
      operation_class: "spot_limit_order",
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      order: {
        product_id: "BTC-USD",
        side: "buy",
        base_size: "0.001",
        limit_price: "10000",
        tif: "gtc",
      },
    }, [
      "ghola/private-execution-instruction-v1",
      `work_order:${coinbaseWorkOrder}`,
      "venue:coinbase_advanced",
      `recipient:${recipient.recipient_id}`,
    ].join("|")),
    omnibus_allocation: omnibusAllocation,
    session_policy: {
      market_allowlist: ["BTC-USD"],
      max_notional_bucket: "25",
      max_order_count: 5,
      kill_switch: false,
    },
  }),
  202,
);

await expectStatus(
  "coinbase omnibus reconcile",
  authed("/omnibus/reconcile", { version: 1, omnibus_allocation: omnibusAllocation }),
  200,
);

console.log("[private-agent-worker-canary] private execution worker canary passed");
NODE
