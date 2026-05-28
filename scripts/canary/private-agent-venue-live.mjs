#!/usr/bin/env node
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadEnvFile(process.env.GHOLA_PRIVATE_AGENT_STAGING_ENV || `${ROOT}/.dev/private-agent-staging.env`);

const {
  bytesToBase64,
  didKeyFromVerifying,
  hexToBytes,
  sealForTest,
} = await import(pathToFileURL(`${ROOT}/apps/private-agent-worker/src/crypto/envelope.js`).href);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const senderPublic = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const senderDid = didKeyFromVerifying(senderPublic);

const workerUrl = env("PRIVATE_AGENT_WORKER_URL") ||
  env("GHOLA_PRIVATE_AGENT_EXECUTION_URL") ||
  env("PHALA_AGENT_ENDPOINT");
const token = env("PRIVATE_AGENT_EXECUTION_TOKEN") ||
  env("GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN");
const venue = env("GHOLA_CANARY_VENUE", "hyperliquid");
const live = boolEnv("GHOLA_RUN_LIVE_VENUE_CANARY");
const submitOrder = boolEnv("GHOLA_CANARY_SUBMIT_ORDER");
const riskAck = boolEnv("GHOLA_CANARY_ACK_TINY_ORDER_RISK");
const canaryId = `canary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const DUMMY_COINBASE_PRIVATE_KEY = [
  "-----BEGIN EC PRIVATE KEY-----",
  "MHcCAQEEIGvY6aoo2dGd5dbwG7Hz3Tj8MwbD0QuR4APs8dP8s91BoAoGCCqGSM49",
  "AwEHoUQDQgAEUxJ3vyaSbfNuLS9wEVxAIUlA7PAwHFrs4zSj34tpf8jEABERLQzt",
  "Bmg+ObHTkW0HnqRyx5m8lxbvqD8AqXjp3w==",
  "-----END EC PRIVATE KEY-----",
].join("\n");

if (!workerUrl) fail("PRIVATE_AGENT_WORKER_URL or GHOLA_PRIVATE_AGENT_EXECUTION_URL is required");
if (!token) fail("PRIVATE_AGENT_EXECUTION_TOKEN or GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN is required");
if (submitOrder && !riskAck) {
  fail("set GHOLA_CANARY_ACK_TINY_ORDER_RISK=1 before submitting a live canary order");
}

if (!live) {
  console.log("[venue-canary] local dry-run credential mode; worker should have PRIVATE_AGENT_VENUE_DRY_RUN=true");
}

const recipient = await getRecipient();
console.log(`[venue-canary] worker=${trimUrl(workerUrl)} recipient=${recipient.recipient_id}`);

if (venue === "hyperliquid") {
  await runHyperliquid();
} else if (venue === "coinbase_byo") {
  await runCoinbaseByo();
} else if (venue === "coinbase_omnibus") {
  await runCoinbaseOmnibus();
} else {
  fail(`unsupported GHOLA_CANARY_VENUE: ${venue}`);
}

console.log(`[venue-canary] ${venue} canary passed`);

async function runHyperliquid() {
  const network = env("GHOLA_CANARY_HYPERLIQUID_NETWORK", "testnet");
  const accountAddress = live
    ? required("GHOLA_CANARY_HYPERLIQUID_ACCOUNT_ADDRESS")
    : "0x0000000000000000000000000000000000000001";
  const apiWalletPrivateKey = live
    ? required("GHOLA_CANARY_HYPERLIQUID_API_WALLET_PRIVATE_KEY")
    : "0x1111111111111111111111111111111111111111111111111111111111111111";
  const market = env("GHOLA_CANARY_HYPERLIQUID_MARKET", "BTC").toUpperCase();
  const side = env("GHOLA_CANARY_HYPERLIQUID_SIDE", "buy").toLowerCase();
  const quoteSize = env("GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE", "5");
  const maxSlippageBps = env("GHOLA_CANARY_HYPERLIQUID_MAX_SLIPPAGE_BPS", "50");
  if (submitOrder) {
    assertTinyFillCanarySize(quoteSize);
  }
  const accountCommitment = commitment("hyperliquid_account", { canaryId, network });
  const vaultCommitment = commitment("hyperliquid_vault", { accountCommitment, network });
  const policyCommitment = commitment("hyperliquid_policy", { canaryId, market });
  const sessionPolicy = {
    market_allowlist: [market],
    max_notional_bucket: env("GHOLA_CANARY_MAX_NOTIONAL_BUCKET", "25"),
    max_order_count: 10,
    kill_switch: false,
  };
  const encryptedVault = await sealedBundle({
    version: 1,
    kind: "ghola_hyperliquid_execution_vault",
    network,
    hyperliquid_account_address: accountAddress,
    api_wallet_private_key: apiWalletPrivateKey,
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
  }, [
    "ghola/hyperliquid-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    `network:${network}`,
  ].join("|"));

  await expect("hyperliquid session", "/hyperliquid/sessions", 201, {
    version: 1,
    account_commitment: accountCommitment,
    vault_commitment: vaultCommitment,
    policy_commitment: policyCommitment,
    encrypted_execution_vault: encryptedVault,
    session_policy: sessionPolicy,
  });

  if (submitOrder) {
    const orderWork = commitment("work_order", { canaryId, venue, op: "order" });
    await expect("hyperliquid tiny-fill IOC order", "/hyperliquid/orders", 202, {
      version: 1,
      work_order_commitment: orderWork,
      vault_commitment: vaultCommitment,
      policy_commitment: policyCommitment,
      operation_class: "limit_order",
      encrypted_execution_vault: encryptedVault,
      encrypted_execution_instruction_bundle: await instructionBundle({
        workOrderCommitment: orderWork,
        venueId: "hyperliquid",
        operationClass: "limit_order",
        order: {
          market,
          side,
          quote_size: quoteSize,
          max_slippage_bps: maxSlippageBps,
          live_order_mode: "tiny_fill",
          tif: "Ioc",
        },
      }),
      session_policy: sessionPolicy,
    });
  }

  const reconcileWork = commitment("work_order", { canaryId, venue, op: "reconcile" });
  await expect("hyperliquid reconcile", "/hyperliquid/reconcile", 200, {
    version: 1,
    work_order_commitment: reconcileWork,
    vault_commitment: vaultCommitment,
    policy_commitment: policyCommitment,
    encrypted_execution_vault: encryptedVault,
    encrypted_execution_instruction_bundle: await instructionBundle({
      workOrderCommitment: reconcileWork,
      venueId: "hyperliquid",
      operationClass: "reconcile",
      reconcile: { market },
    }),
    session_policy: sessionPolicy,
  });
}

async function runCoinbaseByo() {
  const network = env("GHOLA_CANARY_COINBASE_NETWORK", "sandbox");
  const apiKeyName = live
    ? required("GHOLA_CANARY_COINBASE_API_KEY_NAME")
    : "organizations/dry-run/apiKeys/dry-run";
  const apiPrivateKeyPem = live ? coinbasePrivateKeyPem() : DUMMY_COINBASE_PRIVATE_KEY;
  const productId = env("GHOLA_CANARY_COINBASE_PRODUCT_ID", "BTC-USD").toUpperCase();
  const side = env("GHOLA_CANARY_COINBASE_SIDE", "buy").toLowerCase();
  const baseSize = env("GHOLA_CANARY_COINBASE_BASE_SIZE", "0.001");
  const limitPrice = env("GHOLA_CANARY_COINBASE_LIMIT_PRICE", "10000");
  const accountCommitment = commitment("coinbase_account", { canaryId, network, mode: "byo" });
  const vaultCommitment = commitment("coinbase_vault", { accountCommitment, network });
  const policyCommitment = commitment("coinbase_policy", { canaryId, productId });
  const sessionPolicy = coinbaseSessionPolicy(productId);
  const encryptedVault = await sealedBundle({
    version: 1,
    kind: "ghola_coinbase_advanced_execution_vault",
    network,
    base_url: env("GHOLA_CANARY_COINBASE_BASE_URL", coinbaseBaseUrl(network)),
    execution_mode: "byo_api_key",
    api_key_name: apiKeyName,
    api_private_key_pem: apiPrivateKeyPem,
    portfolio_id: env("GHOLA_CANARY_COINBASE_PORTFOLIO_ID") || null,
    allowed_operations: ["read", "preview_order", "spot_limit_order", "spot_market_order", "cancel", "fills", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
  }, [
    "ghola/coinbase-advanced-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    "mode:byo_api_key",
    `network:${network}`,
  ].join("|"));

  await expect("coinbase byo session", "/venues/coinbase/sessions", 201, {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: "byo_api_key",
    account_commitment: accountCommitment,
    vault_commitment: vaultCommitment,
    policy_commitment: policyCommitment,
    encrypted_execution_vault: encryptedVault,
    session_policy: sessionPolicy,
  });

  await runCoinbaseOrderFlow({
    executionMode: "byo_api_key",
    productId,
    side,
    baseSize,
    limitPrice,
    vaultCommitment,
    policyCommitment,
    encryptedVault,
    sessionPolicy,
  });
}

async function runCoinbaseOmnibus() {
  const productId = env("GHOLA_CANARY_COINBASE_PRODUCT_ID", "BTC-USD").toUpperCase();
  const side = env("GHOLA_CANARY_COINBASE_SIDE", "buy").toLowerCase();
  const baseSize = env("GHOLA_CANARY_COINBASE_BASE_SIZE", "0.001");
  const limitPrice = env("GHOLA_CANARY_COINBASE_LIMIT_PRICE", "10000");
  const accountCommitment = commitment("coinbase_omnibus_account", { canaryId });
  const policyCommitment = commitment("coinbase_omnibus_policy", { canaryId, productId });
  const omnibusAllocation = {
    allocation_commitment: commitment("omnibus_allocation", { canaryId }),
    pool_commitment: commitment("omnibus_pool", { canaryId }),
    partner_commitment: commitment("omnibus_partner", { canaryId }),
    subledger_account_commitment: commitment("omnibus_subledger", { canaryId }),
    settlement_funding_commitment: commitment("funding_import", { canaryId }),
    status: "allocated",
  };
  const sessionPolicy = coinbaseSessionPolicy(productId);

  await expect("coinbase omnibus allocation", "/omnibus/allocations", 201, {
    version: 1,
    omnibus_allocation: omnibusAllocation,
  });
  await expect("coinbase omnibus session", "/venues/coinbase/sessions", 201, {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: "partner_omnibus",
    account_commitment: accountCommitment,
    policy_commitment: policyCommitment,
    omnibus_allocation: omnibusAllocation,
    session_policy: sessionPolicy,
  });

  await runCoinbaseOrderFlow({
    executionMode: "partner_omnibus",
    productId,
    side,
    baseSize,
    limitPrice,
    policyCommitment,
    omnibusAllocation,
    sessionPolicy,
  });
}

async function runCoinbaseOrderFlow(input) {
  const orderOperation = submitOrder ? "spot_limit_order" : "preview_order";
  const orderWork = commitment("work_order", { canaryId, venue, op: orderOperation });
  await expect(`coinbase ${orderOperation}`, "/venues/coinbase/orders", 202, {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: input.executionMode,
    work_order_commitment: orderWork,
    vault_commitment: input.vaultCommitment,
    policy_commitment: input.policyCommitment,
    operation_class: orderOperation,
    encrypted_execution_vault: input.encryptedVault,
    encrypted_execution_instruction_bundle: await instructionBundle({
      workOrderCommitment: orderWork,
      venueId: "coinbase_advanced",
      operationClass: orderOperation,
      order: {
        product_id: input.productId,
        side: input.side,
        base_size: input.baseSize,
        limit_price: input.limitPrice,
        tif: env("GHOLA_CANARY_COINBASE_TIF", "gtc"),
      },
    }),
    omnibus_allocation: input.omnibusAllocation,
    session_policy: input.sessionPolicy,
  });

  if (submitOrder) {
    const cancelWork = commitment("work_order", { canaryId, venue, op: "cancel" });
    await expect("coinbase cancel", "/venues/coinbase/orders", 202, {
      version: 1,
      venue_id: "coinbase_advanced",
      platform_class: "coinbase_style_provider",
      execution_mode: input.executionMode,
      work_order_commitment: cancelWork,
      vault_commitment: input.vaultCommitment,
      policy_commitment: input.policyCommitment,
      operation_class: "cancel",
      encrypted_execution_vault: input.encryptedVault,
      encrypted_execution_instruction_bundle: await instructionBundle({
        workOrderCommitment: cancelWork,
        venueId: "coinbase_advanced",
        operationClass: "cancel",
        cancel: {
          product_id: input.productId,
          target_work_order_commitment: orderWork,
        },
      }),
      omnibus_allocation: input.omnibusAllocation,
      session_policy: input.sessionPolicy,
    });
  }

  const reconcileWork = commitment("work_order", { canaryId, venue, op: "reconcile" });
  await expect("coinbase reconcile", "/venues/coinbase/reconcile", 200, {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: input.executionMode,
    work_order_commitment: reconcileWork,
    vault_commitment: input.vaultCommitment,
    policy_commitment: input.policyCommitment,
    encrypted_execution_vault: input.encryptedVault,
    encrypted_execution_instruction_bundle: await instructionBundle({
      workOrderCommitment: reconcileWork,
      venueId: "coinbase_advanced",
      operationClass: "reconcile",
      reconcile: { product_id: input.productId },
    }),
    omnibus_allocation: input.omnibusAllocation,
    session_policy: input.sessionPolicy,
  });
}

async function getRecipient() {
  const result = await request("/.well-known/private-agent-recipient");
  if (!result.response.ok) {
    fail(`recipient endpoint returned ${result.response.status}`, result.text);
  }
  if (!result.body?.recipient_id || !result.body?.x25519_pub_hex) {
    fail("recipient endpoint did not publish recipient_id and x25519_pub_hex", result.text);
  }
  return result.body;
}

async function expect(label, path, expectedStatus, body) {
  const result = await request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
    },
    body: JSON.stringify(stripUndefined(body)),
  });
  if (result.response.status !== expectedStatus) {
    fail(`${label} expected HTTP ${expectedStatus}, got ${result.response.status}`, result.text);
  }
  const status = result.body?.status || result.body?.ready || "ok";
  const resultCommitment = result.body?.result_commitment || result.body?.provider_ref_commitment || "";
  console.log(`[venue-canary] ${label} ok status=${status}${resultCommitment ? ` ref=${resultCommitment}` : ""}`);
  return result.body;
}

async function request(path, init = {}) {
  const response = await fetch(`${trimUrl(workerUrl)}${path}`, {
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

async function sealedBundle(plaintext, aad) {
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

async function instructionBundle({
  workOrderCommitment,
  venueId,
  operationClass,
  order,
  cancel,
  reconcile,
}) {
  return sealedBundle(stripUndefined({
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: venueId,
    operation_class: operationClass,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    order,
    cancel,
    reconcile,
  }), [
    "ghola/private-execution-instruction-v1",
    `work_order:${workOrderCommitment}`,
    `venue:${venueId}`,
    `recipient:${recipient.recipient_id}`,
  ].join("|"));
}

function coinbaseSessionPolicy(productId) {
  return {
    market_allowlist: [productId],
    max_notional_bucket: env("GHOLA_CANARY_MAX_NOTIONAL_BUCKET", "25"),
    max_order_count: 10,
    kill_switch: false,
  };
}

function coinbasePrivateKeyPem() {
  const b64 = env("GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM_B64");
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  const path = env("GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM_PATH");
  if (path) return readFileSync(path, "utf8");
  const raw = env("GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM");
  if (raw) return raw.replace(/\\n/g, "\n");
  fail("GHOLA_CANARY_COINBASE_API_PRIVATE_KEY_PEM_B64 or _PEM_PATH is required");
}

function coinbaseBaseUrl(network) {
  return network === "sandbox"
    ? "https://api-sandbox.coinbase.com/api/v3/brokerage"
    : "https://api.coinbase.com/api/v3/brokerage";
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, stripUndefined(child)]),
  );
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = unquoteEnv(rawValue.trim());
  }
}

function unquoteEnv(value) {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  return value;
}

function commitment(prefix, value) {
  return `${prefix}_${createHash("sha256")
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest("hex")
    .slice(0, 48)}`;
}

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function required(name) {
  const value = env(name);
  if (!value) fail(`${name} is required`);
  return value;
}

function boolEnv(name) {
  return env(name).toLowerCase() === "1" || env(name).toLowerCase() === "true";
}

function assertTinyFillCanarySize(value) {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    fail("GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE must be a decimal dollar amount");
  }
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) {
    fail("GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE must be greater than zero");
  }
  if (size > 25) {
    fail("GHOLA_CANARY_HYPERLIQUID_QUOTE_SIZE must stay at or below $25 for the live canary");
  }
}

function trimUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function fail(message, detail) {
  console.error(`[venue-canary] ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}
