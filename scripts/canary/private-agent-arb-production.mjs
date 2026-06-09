#!/usr/bin/env node
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const workerUrl = trimUrl(
  env("PRIVATE_AGENT_WORKER_URL") ||
    env("GHOLA_PRIVATE_AGENT_EXECUTION_URL") ||
    env("PHALA_AGENT_ENDPOINT"),
);
const token = env("PRIVATE_AGENT_EXECUTION_TOKEN") || env("GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN");
const capabilitySecret = env("PRIVATE_AGENT_WORKER_CAPABILITY_SECRET") || env("GHOLA_WORKER_CAPABILITY_SECRET");
const canaryId = `arb_canary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const reportPath = resolve(ROOT, env("GHOLA_ARB_CANARY_REPORT_PATH", ".dev/ghola-arb-production-canary.json"));
const reportUrl = canaryReportUrl();
const reportToken = env("GHOLA_ARB_CANARY_REPORT_TOKEN") || env("GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN");
const liveSubmit = boolEnv("GHOLA_ARB_CANARY_LIVE_SUBMIT");
const liveAck = env("GHOLA_ARB_CANARY_ACK_TINY_LIVE");
const market = normalizeMarket(env("GHOLA_ARB_CANARY_MARKET", "SOL-USD"));
const base = baseMarket(market);
const legNotionalUsd = finitePositive(env("GHOLA_ARB_CANARY_LEG_NOTIONAL_USD", "5"), "GHOLA_ARB_CANARY_LEG_NOTIONAL_USD");
const maxLegNotionalUsd = finitePositive(env("GHOLA_ARB_CANARY_MAX_LEG_NOTIONAL_USD", "25"), "GHOLA_ARB_CANARY_MAX_LEG_NOTIONAL_USD");
const minNetEdgeBps = Number.parseInt(env("GHOLA_ARB_CANARY_MIN_NET_EDGE_BPS", "0"), 10);
const maxMarketSkewMs = Number.parseInt(env("GHOLA_ARB_CANARY_MAX_MARKET_DATA_SKEW_MS", "2000"), 10);
const maxSlippageBps = Number.parseInt(env("GHOLA_ARB_CANARY_MAX_SLIPPAGE_BPS", "50"), 10);
const requireEdge = boolEnv("GHOLA_ARB_CANARY_REQUIRE_EDGE") || liveSubmit;
const startedAt = new Date().toISOString();

if (!workerUrl) fail("PRIVATE_AGENT_WORKER_URL or GHOLA_PRIVATE_AGENT_EXECUTION_URL is required");
if (!token && !capabilitySecret) fail("worker auth is required: set PRIVATE_AGENT_EXECUTION_TOKEN or PRIVATE_AGENT_WORKER_CAPABILITY_SECRET");
if (!Number.isInteger(minNetEdgeBps) || minNetEdgeBps < 0) fail("GHOLA_ARB_CANARY_MIN_NET_EDGE_BPS must be a non-negative integer");
if (!Number.isInteger(maxMarketSkewMs) || maxMarketSkewMs <= 0) fail("GHOLA_ARB_CANARY_MAX_MARKET_DATA_SKEW_MS must be positive");
if (!Number.isInteger(maxSlippageBps) || maxSlippageBps <= 0) fail("GHOLA_ARB_CANARY_MAX_SLIPPAGE_BPS must be positive");
if (legNotionalUsd > maxLegNotionalUsd) fail("canary leg notional exceeds GHOLA_ARB_CANARY_MAX_LEG_NOTIONAL_USD");
if (liveSubmit && liveAck !== "I_UNDERSTAND_THIS_BROADCASTS") {
  fail("set GHOLA_ARB_CANARY_ACK_TINY_LIVE=I_UNDERSTAND_THIS_BROADCASTS before live submit");
}
if (liveSubmit && legNotionalUsd > 25) fail("live arb canary is capped at $25 per leg");

const report = {
  version: 1,
  canary_id: canaryId,
  worker_url: redactUrl(workerUrl),
  started_at: startedAt,
  completed_at: null,
  status: "running",
  mode: liveSubmit ? "tiny_live" : "no_submit",
  market,
  leg_notional_usd: legNotionalUsd,
  checks: [],
};
let canaryRecipient = null;

try {
  canaryRecipient = await getRecipient();
  record("recipient", true, {
    recipient_id: canaryRecipient.recipient_id,
    attested_ready: canaryRecipient.attested_ready === true,
  });

  const coinbase = await buildCoinbaseAccess(canaryRecipient);
  const hyperliquid = await buildHyperliquidAccess(canaryRecipient);

  const [coinbaseCredential, hyperliquidCredential] = await Promise.all([
    postWorker("/venues/credentials/verify", "credential:verify", coinbase.credentialBody, 200, {
      label: "coinbase credential verify",
    }),
    postWorker("/venues/credentials/verify", "credential:verify", hyperliquid.credentialBody, 200, {
      label: "hyperliquid credential verify",
    }),
  ]);
  assertCredential("coinbase", coinbaseCredential);
  assertCredential("hyperliquid", hyperliquidCredential);

  await Promise.all([
    postWorker("/venues/coinbase/sessions", "session:create", coinbase.sessionBody, 201, {
      label: "coinbase session",
    }),
    postWorker("/hyperliquid/sessions", "session:create", hyperliquid.sessionBody, 201, {
      label: "hyperliquid session",
    }),
  ]);

  const quote = await pairedQuote();
  report.quote = quote.public;
  record("market_data", quote.ok, quote.public);
  if (!quote.ok) fail(`market data rejected: ${quote.reason}`);

  const pair = buildPair({ quote, coinbase, hyperliquid });
  await attachPairInstructions(pair);
  report.pair = pair.public;
  record("edge_screen", pair.edgeOk || !requireEdge, {
    net_edge_bps: pair.net_edge_bps,
    min_net_edge_bps: minNetEdgeBps,
    require_edge: requireEdge,
  });
  if (requireEdge && !pair.edgeOk) {
    fail(`net edge ${pair.net_edge_bps} bps is below required ${minNetEdgeBps} bps`);
  }

  const [coinbasePreflight, hyperliquidPreflight] = await Promise.all([
    postWorker("/venues/coinbase/verify", "order:verify", pair.coinbaseBody, 200, {
      label: "coinbase no-submit preflight",
      headers: { "x-ghola-no-submit-verify": "true" },
    }),
    postWorker("/hyperliquid/verify", "order:verify", pair.hyperliquidBody, 200, {
      label: "hyperliquid no-submit preflight",
      headers: { "x-ghola-no-submit-verify": "true" },
    }),
  ]);
  assertNoBroadcast("coinbase", coinbasePreflight);
  assertNoBroadcast("hyperliquid", hyperliquidPreflight);
  report.preflight = {
    coinbase: summarizeReceipt(coinbasePreflight),
    hyperliquid: summarizeReceipt(hyperliquidPreflight),
  };

  if (liveSubmit) {
    const [coinbaseReceipt, hyperliquidReceipt] = await Promise.all([
      postWorker("/venues/coinbase/orders", "order:submit", pair.coinbaseBody, 202, {
        label: "coinbase tiny-live order",
      }),
      postWorker("/hyperliquid/orders", "order:submit", pair.hyperliquidBody, 202, {
        label: "hyperliquid tiny-live order",
      }),
    ]);
    report.live_receipts = {
      coinbase: summarizeReceipt(coinbaseReceipt),
      hyperliquid: summarizeReceipt(hyperliquidReceipt),
    };
    await reconcilePair(pair);
  }

  report.status = liveSubmit ? "tiny_live_pair_verified" : "no_submit_pair_verified";
} catch (error) {
  report.status = "failed";
  record("fatal", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  report.completed_at = new Date().toISOString();
  const safeReport = stripSecrets(report);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(safeReport, null, 2)}\n`);
  const postOk = await postCanaryReport(safeReport);
  console.log(`[arb-canary] ${report.status}`);
  console.log(`[arb-canary] report=${reportPath}`);
  for (const check of report.checks) {
    console.log(`[arb-canary] ${check.ok ? "ok" : "fail"} ${check.name}`);
  }
  if (!postOk || report.status === "failed") process.exit(1);
}

async function buildCoinbaseAccess(recipient) {
  const network = env("GHOLA_ARB_CANARY_COINBASE_NETWORK", "mainnet");
  const accountCommitment = commitment("coinbase_account", { canaryId, network });
  const vaultCommitment = commitment("coinbase_vault", { accountCommitment, network });
  const policyCommitment = commitment("coinbase_policy", { canaryId, market });
  const encryptedVault = await sealedBundle(recipient, {
    version: 1,
    kind: "ghola_coinbase_advanced_execution_vault",
    network,
    base_url: env("GHOLA_ARB_CANARY_COINBASE_BASE_URL", coinbaseBaseUrl(network)),
    execution_mode: "byo_api_key",
    api_key_name: required("GHOLA_ARB_CANARY_COINBASE_API_KEY_NAME"),
    api_private_key_pem: coinbasePrivateKeyPem(),
    portfolio_id: env("GHOLA_ARB_CANARY_COINBASE_PORTFOLIO_ID") || null,
    allowed_operations: ["read", "preview_order", "spot_limit_order", "spot_market_order", "cancel", "fills", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
  }, [
    "ghola/coinbase-advanced-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    "mode:byo_api_key",
    `network:${network}`,
  ].join("|"));
  const sessionPolicy = sessionPolicyFor(market, policyCommitment);
  return {
    accountCommitment,
    vaultCommitment,
    policyCommitment,
    encryptedVault,
    sessionPolicy,
    credentialBody: {
      version: 1,
      venue_id: "coinbase_advanced",
      account_commitment: accountCommitment,
      encrypted_execution_vault: encryptedVault,
    },
    sessionBody: {
      version: 1,
      venue_id: "coinbase_advanced",
      platform_class: "coinbase_style_provider",
      execution_mode: "byo_api_key",
      account_commitment: accountCommitment,
      vault_commitment: vaultCommitment,
      policy_commitment: policyCommitment,
      encrypted_execution_vault: encryptedVault,
      session_policy: sessionPolicy,
    },
  };
}

async function buildHyperliquidAccess(recipient) {
  const network = env("GHOLA_ARB_CANARY_HYPERLIQUID_NETWORK", "mainnet");
  const accountCommitment = commitment("hyperliquid_account", { canaryId, network });
  const vaultCommitment = commitment("hyperliquid_vault", { accountCommitment, network });
  const policyCommitment = commitment("hyperliquid_policy", { canaryId, market: base });
  const encryptedVault = await sealedBundle(recipient, {
    version: 1,
    kind: "ghola_hyperliquid_execution_vault",
    network,
    hyperliquid_account_address: required("GHOLA_ARB_CANARY_HYPERLIQUID_ACCOUNT_ADDRESS"),
    api_wallet_private_key: required("GHOLA_ARB_CANARY_HYPERLIQUID_API_WALLET_PRIVATE_KEY"),
    allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation"],
  }, [
    "ghola/hyperliquid-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    `network:${network}`,
  ].join("|"));
  const sessionPolicy = sessionPolicyFor(base, policyCommitment);
  return {
    accountCommitment,
    vaultCommitment,
    policyCommitment,
    encryptedVault,
    sessionPolicy,
    credentialBody: {
      version: 1,
      venue_id: "hyperliquid",
      account_commitment: accountCommitment,
      encrypted_execution_vault: encryptedVault,
    },
    sessionBody: {
      version: 1,
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
      execution_mode: "byo_api_key",
      account_commitment: accountCommitment,
      vault_commitment: vaultCommitment,
      policy_commitment: policyCommitment,
      encrypted_execution_vault: encryptedVault,
      session_policy: sessionPolicy,
    },
  };
}

async function pairedQuote() {
  const started = Date.now();
  const [coinbase, hyperliquid] = await Promise.all([
    fetchCoinbasePrice(),
    fetchHyperliquidPrice(),
  ]);
  const skewMs = Math.abs(new Date(coinbase.fetched_at).getTime() - new Date(hyperliquid.fetched_at).getTime());
  const ok = skewMs <= maxMarketSkewMs;
  return {
    ok,
    reason: ok ? null : "market_data_skew_exceeded",
    coinbase,
    hyperliquid,
    public: {
      market,
      coinbase_price: coinbase.price,
      hyperliquid_price: hyperliquid.price,
      skew_ms: skewMs,
      max_skew_ms: maxMarketSkewMs,
      latency_ms: Date.now() - started,
    },
  };
}

async function fetchCoinbasePrice() {
  const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(market)}`;
  const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!response.ok) fail(`Coinbase market endpoint returned HTTP ${response.status}`);
  const body = await response.json();
  const price = numberValue(body.price || body.mid_market_price || body.pricebook?.best_bid);
  if (!price) fail("Coinbase market endpoint did not return a usable price");
  return { venue_id: "coinbase_advanced", market, price, fetched_at: new Date().toISOString() };
}

async function fetchHyperliquidPrice() {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  if (!response.ok) fail(`Hyperliquid market endpoint returned HTTP ${response.status}`);
  const body = await response.json();
  const price = numberValue(body[base]);
  if (!price) fail(`Hyperliquid mids did not include ${base}`);
  return { venue_id: "hyperliquid", market: base, price, fetched_at: new Date().toISOString() };
}

function buildPair({ quote, coinbase, hyperliquid }) {
  const coinbaseIsBuy = quote.coinbase.price <= quote.hyperliquid.price;
  const buyPrice = coinbaseIsBuy ? quote.coinbase.price : quote.hyperliquid.price;
  const sellPrice = coinbaseIsBuy ? quote.hyperliquid.price : quote.coinbase.price;
  const grossEdgeBps = Math.round(((sellPrice - buyPrice) / buyPrice) * 10_000);
  const feeBps = Number.parseInt(env("GHOLA_ARB_CANARY_COINBASE_FEE_BPS", "60"), 10) +
    Number.parseInt(env("GHOLA_ARB_CANARY_HYPERLIQUID_FEE_BPS", "5"), 10) +
    maxSlippageBps * 2;
  const netEdgeBps = grossEdgeBps - feeBps;
  const coinbaseSide = coinbaseIsBuy ? "buy" : "sell";
  const hyperliquidSide = coinbaseIsBuy ? "sell" : "buy";
  const pairCommitment = commitment("arb_canary_pair", {
    canaryId,
    market,
    coinbase_price: quote.coinbase.price,
    hyperliquid_price: quote.hyperliquid.price,
  });
  const coinbaseWorkOrder = `${pairCommitment}_coinbase`;
  const hyperliquidWorkOrder = `${pairCommitment}_hyperliquid`;
  const coinbaseOrder = coinbaseSide === "buy"
    ? {
        market,
        side: "buy",
        quote_size: String(legNotionalUsd),
        order_type: "market",
        size_mode: "quote",
        tif: "ioc",
      }
    : {
        market,
        side: "sell",
        base_size: trim(legNotionalUsd / quote.coinbase.price),
        order_type: "market",
        size_mode: "base",
        tif: "ioc",
      };
  const hyperliquidLimit = hyperliquidSide === "buy"
    ? quote.hyperliquid.price * (1 + maxSlippageBps / 10_000)
    : quote.hyperliquid.price * (1 - maxSlippageBps / 10_000);
  const hyperliquidOrder = {
    market: base,
    side: hyperliquidSide,
    quote_size: String(legNotionalUsd),
    limit_price: trim(hyperliquidLimit),
    order_type: "market",
    size_mode: "quote",
    live_order_mode: "tiny_fill",
    max_slippage_bps: String(maxSlippageBps),
    tif: "Ioc",
  };
  return {
    pairCommitment,
    net_edge_bps: netEdgeBps,
    edgeOk: netEdgeBps >= minNetEdgeBps,
    public: {
      pair_commitment: pairCommitment,
      coinbase_side: coinbaseSide,
      hyperliquid_side: hyperliquidSide,
      gross_edge_bps: grossEdgeBps,
      fee_bps: feeBps,
      net_edge_bps: netEdgeBps,
      min_net_edge_bps: minNetEdgeBps,
    },
    coinbaseBody: {
      version: 1,
      venue_id: "coinbase_advanced",
      platform_class: "coinbase_style_provider",
      execution_mode: "byo_api_key",
      work_order_commitment: coinbaseWorkOrder,
      vault_commitment: coinbase.vaultCommitment,
      policy_commitment: coinbase.policyCommitment,
      operation_class: "spot_market_order",
      encrypted_execution_vault: coinbase.encryptedVault,
      encrypted_execution_instruction_bundle: null,
      session_policy: coinbase.sessionPolicy,
    },
    hyperliquidBody: {
      version: 1,
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
      execution_mode: "byo_api_key",
      work_order_commitment: hyperliquidWorkOrder,
      vault_commitment: hyperliquid.vaultCommitment,
      policy_commitment: hyperliquid.policyCommitment,
      operation_class: "limit_order",
      encrypted_execution_vault: hyperliquid.encryptedVault,
      encrypted_execution_instruction_bundle: null,
      session_policy: hyperliquid.sessionPolicy,
    },
    coinbaseOrder,
    hyperliquidOrder,
  };
}

async function reconcilePair(pair) {
  const [coinbaseReconcile, hyperliquidReconcile] = await Promise.all([
    postWorker("/venues/coinbase/reconcile", "reconcile:read", {
      ...pair.coinbaseBody,
      work_order_commitment: `${pair.pairCommitment}_coinbase_reconcile`,
      operation_class: "reconcile",
      encrypted_execution_instruction_bundle: await instructionBundle(
        canaryRecipient,
        `${pair.pairCommitment}_coinbase_reconcile`,
        "coinbase_advanced",
        "reconcile",
        { reconcile: { product_id: market } },
      ),
    }, 200, { label: "coinbase reconcile" }),
    postWorker("/hyperliquid/reconcile", "reconcile:read", {
      ...pair.hyperliquidBody,
      work_order_commitment: `${pair.pairCommitment}_hyperliquid_reconcile`,
      operation_class: "reconcile",
      encrypted_execution_instruction_bundle: await instructionBundle(
        canaryRecipient,
        `${pair.pairCommitment}_hyperliquid_reconcile`,
        "hyperliquid",
        "reconcile",
        { reconcile: { market: base } },
      ),
    }, 200, { label: "hyperliquid reconcile" }),
  ]);
  report.reconciliation = {
    coinbase: summarizeReceipt(coinbaseReconcile),
    hyperliquid: summarizeReceipt(hyperliquidReconcile),
  };
}

async function attachPairInstructions(pair) {
  pair.coinbaseBody.encrypted_execution_instruction_bundle = await instructionBundle(
    canaryRecipient,
    pair.coinbaseBody.work_order_commitment,
    "coinbase_advanced",
    "spot_market_order",
    { order: pair.coinbaseOrder },
  );
  pair.hyperliquidBody.encrypted_execution_instruction_bundle = await instructionBundle(
    canaryRecipient,
    pair.hyperliquidBody.work_order_commitment,
    "hyperliquid",
    "limit_order",
    { order: pair.hyperliquidOrder },
  );
}

async function postWorker(path, scope, body, expectedStatus, options = {}) {
  const wireBody = stripUndefined(body);
  const headers = {
    authorization: authorizationHeader(path, scope, wireBody),
    "content-type": "application/json",
    "x-ghola-sealed-execution-required": "true",
    ...(options.headers || {}),
  };
  const started = Date.now();
  const response = await fetch(`${workerUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(wireBody),
  }).catch((error) => fail(`${options.label || path} request failed`, String(error)));
  const text = await response.text();
  const responseBody = text ? parseJson(text, path) : {};
  const ok = response.status === expectedStatus;
  record(options.label || path, ok, {
    status: response.status,
    expected_status: expectedStatus,
    latency_ms: Date.now() - started,
    result_commitment: responseBody.result_commitment || responseBody.verification_commitment || null,
    error: ok ? null : responseBody.error || text.slice(0, 300),
  });
  if (!ok) fail(`${options.label || path} expected HTTP ${expectedStatus}, got ${response.status}`, text);
  assertSafeArtifact(options.label || path, responseBody);
  return responseBody;
}

async function getRecipient() {
  const response = await fetch(`${workerUrl}/.well-known/private-agent-recipient`);
  const text = await response.text();
  if (!response.ok) fail(`recipient endpoint returned HTTP ${response.status}`, text);
  const body = parseJson(text, "/.well-known/private-agent-recipient");
  if (!body.recipient_id || !body.x25519_pub_hex) fail("recipient endpoint did not publish recipient_id and x25519_pub_hex");
  return body;
}

async function postCanaryReport(safeReport) {
  if (!reportUrl) return true;
  if (!reportToken) {
    console.error("[arb-canary] report post failed: GHOLA_ARB_CANARY_REPORT_TOKEN or GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN is required");
    return false;
  }
  const response = await fetch(reportUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${reportToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(safeReport),
  }).catch((error) => {
    console.error("[arb-canary] report post request failed", String(error?.message || error));
    return null;
  });
  if (!response) return false;
  const text = await response.text();
  if (response.status !== 202) {
    console.error(`[arb-canary] report post returned HTTP ${response.status}`, text.slice(0, 500));
    return false;
  }
  console.log(`[arb-canary] report posted ${reportUrl}`);
  return true;
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

async function instructionBundle(recipient, workOrderCommitment, venueId, operationClass, fields) {
  return sealedBundle(recipient, stripUndefined({
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: venueId,
    operation_class: operationClass,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    ...fields,
  }), [
    "ghola/private-execution-instruction-v1",
    `work_order:${workOrderCommitment}`,
    `venue:${venueId}`,
    `recipient:${recipient.recipient_id}`,
  ].join("|"));
}

function authorizationHeader(path, scope, body) {
  if (!capabilitySecret) return `Bearer ${token}`;
  const now = Math.floor(Date.now() / 1000);
  const expected = capabilityExpectedFromBody(body);
  const payload = {
    version: 1,
    issuer: "ghola-arb-canary",
    method: "POST",
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
  const signature = createHmac("sha256", capabilitySecret).update(payloadB64).digest("base64url");
  return `Bearer ghcap_v1.${payloadB64}.${signature}`;
}

function capabilityExpectedFromBody(body = {}) {
  return stripUndefined({
    owner_commitment: body.owner_commitment,
    account_commitment: body.account_commitment,
    session_commitment: body.session_commitment,
    autopilot_session_id: body.autopilot_session_id,
    venue_id: body.venue_id,
    platform_class: body.platform_class,
    execution_mode: body.execution_mode,
    operation_class: body.operation_class,
    work_order_commitment: body.work_order_commitment,
    policy_commitment: body.policy_commitment,
    allocation_commitment: body.allocation_commitment,
    vault_commitment: body.vault_commitment,
  });
}

function sessionPolicyFor(product, policyCommitment) {
  return {
    policy_commitment: policyCommitment,
    strategy_id: "hedged_spread_arbitrage_v1",
    venue_allowlist: ["coinbase_advanced", "hyperliquid"],
    market_allowlist: [product],
    max_notional_bucket: String(maxLegNotionalUsd),
    max_daily_notional_bucket: env("GHOLA_ARB_CANARY_DAILY_CAP_USD", String(maxLegNotionalUsd * 4)),
    max_order_count: 4,
    kill_switch: false,
    max_slippage_bps: maxSlippageBps,
    min_net_edge_bps: minNetEdgeBps,
  };
}

function assertCredential(label, result) {
  const ok = result.status === "verified" && result.can_read === true && result.can_trade === true && result.can_withdraw !== true;
  record(`${label}_credential_permissions`, ok, {
    status: result.status,
    can_read: result.can_read,
    can_trade: result.can_trade,
    can_withdraw: result.can_withdraw,
    verification_commitment: result.verification_commitment || null,
  });
  if (!ok) fail(`${label} credential is not read+trade/no-withdraw verified`);
}

function assertNoBroadcast(label, result) {
  const ok = result.status === "verified_no_funds" && result.checks?.transaction_broadcast === false;
  record(`${label}_no_broadcast`, ok, summarizeReceipt(result));
  if (!ok) fail(`${label} no-submit preflight did not prove no-broadcast behavior`);
}

function summarizeReceipt(result) {
  return {
    status: result.status || null,
    work_order_commitment: result.work_order_commitment || null,
    provider_ref_commitment: result.provider_ref_commitment || null,
    result_commitment: result.result_commitment || null,
    verification_commitment: result.verification_commitment || null,
    transaction_broadcast: result.checks?.transaction_broadcast ?? null,
  };
}

function assertSafeArtifact(label, artifact) {
  const text = JSON.stringify(artifact);
  const forbidden = [
    "api_private_key_pem",
    "api_wallet_private_key",
    "wallet_private_key",
    "private_key",
    "sealed-provider-v1",
  ];
  const leaked = forbidden.find((item) => text.includes(item));
  if (leaked) fail(`${label} response leaked ${leaked}`);
}

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["encryptedVault", "encrypted_execution_vault", "encrypted_execution_instruction_bundle"].includes(key))
    .map(([key, child]) => [key, stripSecrets(child)]));
}

function parseJson(text, label) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    fail(`non-JSON response from ${label}`, text.slice(0, 500));
  }
}

function bodyHash(body) {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function record(name, ok, data = {}) {
  report.checks.push({ name, ok, ...stripUndefined(data), checked_at: new Date().toISOString() });
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

function coinbasePrivateKeyPem() {
  const b64 = env("GHOLA_ARB_CANARY_COINBASE_API_PRIVATE_KEY_PEM_B64");
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  const path = env("GHOLA_ARB_CANARY_COINBASE_API_PRIVATE_KEY_PEM_PATH");
  if (path) return readFileSync(path, "utf8");
  const raw = env("GHOLA_ARB_CANARY_COINBASE_API_PRIVATE_KEY_PEM");
  if (raw) return raw.replace(/\\n/g, "\n");
  fail("GHOLA_ARB_CANARY_COINBASE_API_PRIVATE_KEY_PEM_B64 or _PEM_PATH is required");
}

function coinbaseBaseUrl(network) {
  return network === "sandbox"
    ? "https://api-sandbox.coinbase.com/api/v3/brokerage"
    : "https://api.coinbase.com/api/v3/brokerage";
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined && child !== null)
    .map(([key, child]) => [key, stripUndefined(child)]));
}

function commitment(prefix, value) {
  return `${prefix}_${createHash("sha256")
    .update(stableJson(value))
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
  const value = env(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(`${label} must be a positive number`);
  return number;
}

function numberValue(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function trim(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Number(number.toFixed(8))) : String(value);
}

function normalizeMarket(value) {
  const upper = String(value || "").trim().toUpperCase();
  if (upper === "SOL" || upper === "SOLANA" || upper === "SOL/USDC") return "SOL-USD";
  if (upper === "BTC" || upper === "BITCOIN") return "BTC-USD";
  if (upper === "ETH" || upper === "ETHEREUM") return "ETH-USD";
  return upper;
}

function baseMarket(productId) {
  return String(productId || "SOL-USD").split("-")[0].split("/")[0].toUpperCase();
}

function trimUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function canaryReportUrl() {
  const direct = env("GHOLA_ARB_CANARY_REPORT_URL");
  if (direct) return direct;
  const base = env("GHOLA_WEB_BASE_URL");
  return base ? `${trimUrl(base)}/v1/private-account/agent-passport/arb-canary-report` : "";
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return trimUrl(value);
  }
}

function fail(message, detail) {
  throw new Error(detail ? `${message}: ${detail}` : message);
}
