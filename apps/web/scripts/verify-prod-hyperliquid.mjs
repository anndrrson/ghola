#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const {
  bytesToBase64,
  didKeyFromVerifying,
  hexToBytes,
  sealForTest,
} = await import(pathToFileURL(resolve(HERE, "../../private-agent-worker/src/crypto/envelope.js")).href);

const baseUrl = trimUrl(env("GHOLA_VERIFY_BASE_URL", "https://ghola.xyz"));
const email = required("GHOLA_VERIFY_EMAIL");
const password = required("GHOLA_VERIFY_PASSWORD");
const network = env("GHOLA_VERIFY_HYPERLIQUID_NETWORK", "mainnet") === "testnet" ? "testnet" : "mainnet";
const accountAddress = env("GHOLA_VERIFY_HYPERLIQUID_ACCOUNT_ADDRESS");
const apiWalletPrivateKey = env("GHOLA_VERIFY_HYPERLIQUID_API_WALLET_PRIVATE_KEY");
const market = env("GHOLA_VERIFY_HYPERLIQUID_MARKET", "BTC").toUpperCase();
const quoteSize = env("GHOLA_VERIFY_HYPERLIQUID_QUOTE_SIZE", "5");
const maxSlippageBps = env("GHOLA_VERIFY_HYPERLIQUID_MAX_SLIPPAGE_BPS", "50");
const allowMissingCredentials = boolEnv("GHOLA_VERIFY_ALLOW_MISSING_HYPERLIQUID_CREDENTIALS");
const storeVaultConfirm = env("GHOLA_VERIFY_STORE_HYPERLIQUID_VAULT_CONFIRM");
const liveSubmit = boolEnv("GHOLA_VERIFY_LIVE_SUBMIT");
const liveSubmitConfirm = env("GHOLA_VERIFY_LIVE_SUBMIT_CONFIRM");
const reportPath = resolve(REPO_ROOT, env("GHOLA_VERIFY_REPORT_PATH", ".dev/ghola-prod-hyperliquid-verify.json"));

const cookies = new Map();
const senderSecret = ed25519.utils.randomPrivateKey();
const senderPublic = ed25519.getPublicKey(senderSecret);
const senderDid = didKeyFromVerifying(senderPublic);
const startedAt = new Date().toISOString();
const report = {
  version: 1,
  base_url: baseUrl,
  started_at: startedAt,
  completed_at: null,
  status: "running",
  live_submit_requested: liveSubmit,
  checks: [],
  route_probe: null,
  runtime: null,
  connector_status: null,
  account_snapshot: null,
  account_stream: null,
  live_execution: null,
  note: liveSubmit
    ? "Live Hyperliquid submit requested. This verifier only submits when GHOLA_VERIFY_LIVE_SUBMIT_CONFIRM=I_UNDERSTAND_THIS_BROADCASTS."
    : "No order is sent. This verifies production routes, auth, sealed vault storage, worker account read, and account SSE.",
};

try {
  await checkHead("landing", "/");
  await checkHead("account_page", "/app/account");
  await getJson("/v1/private-account/products");
  await getJson("/v1/private-account/hyperliquid/market-snapshot?coin=BTC&interval=1m");
  record("public_hyperliquid_market_snapshot", true);

  const runtime = await getJson("/api/private-agent/status");
  report.runtime = summarizeRuntime(runtime);
  const recipient = selectedRecipient(runtime);
  record("private_agent_runtime_ready", Boolean(recipient), report.runtime);

  await postJson("/api/auth/session/email/signin", { email, password }, { sameOrigin: true });
  const session = await getJson("/api/auth/session/me");
  record("auth_session", session.authenticated === true, {
    authenticated: session.authenticated === true,
    user_id_present: Boolean(session.user?.id),
  });

  const rootStatus = await getJson("/v1/private-account/hyperliquid");
  const status = await getJson("/v1/private-account/hyperliquid/status");
  report.route_probe = {
    root_status: rootStatus.platform_class,
    status_platform: status.platform_class,
    pilot_stage: status.pilot_stage,
  };
  report.connector_status = sanitizePublicArtifact(status);
  record("hyperliquid_routes_deployed", rootStatus.platform_class === "hyperliquid_style_market", report.route_probe);
  record("hyperliquid_live_pilot_enabled", status.pilot_stage === "live_pilot", {
    pilot_stage: status.pilot_stage,
    reason_codes: status.gates?.reason_codes || [],
  });

  assertSafeArtifact("runtime_status", runtime);
  assertSafeArtifact("hyperliquid_status", status);

  if (!accountAddress || !apiWalletPrivateKey) {
    record("hyperliquid_credentials_supplied", false, {
      next_step: "Set GHOLA_VERIFY_HYPERLIQUID_ACCOUNT_ADDRESS and GHOLA_VERIFY_HYPERLIQUID_API_WALLET_PRIVATE_KEY.",
    });
    if (!allowMissingCredentials) {
      throw new Error("Hyperliquid verification requires a real account/API wallet, or set GHOLA_VERIFY_ALLOW_MISSING_HYPERLIQUID_CREDENTIALS=true for route-only smoke.");
    }
    report.status = "routes_ready_credentials_required";
  } else {
    if (storeVaultConfirm !== "I_UNDERSTAND_THIS_STORES_A_SEALED_VAULT") {
      throw new Error("Set GHOLA_VERIFY_STORE_HYPERLIQUID_VAULT_CONFIRM=I_UNDERSTAND_THIS_STORES_A_SEALED_VAULT before sealing production credentials.");
    }
    validateHyperliquidCredentialInputs({ accountAddress, apiWalletPrivateKey, quoteSize, maxSlippageBps });
    const vaultStatus = await getJson("/v1/private-account/hyperliquid/vault");
    const accountCommitment = stringValue(vaultStatus.account_commitment);
    record("private_account_loaded", Boolean(accountCommitment), {
      account_commitment: short(accountCommitment),
    });

    const encryptedVault = await sealBundle(recipient, {
      version: 1,
      kind: "ghola_hyperliquid_execution_vault",
      network,
      hyperliquid_account_address: accountAddress,
      api_wallet_private_key: apiWalletPrivateKey,
      allowed_operations: ["read", "limit_order", "cancel", "reconcile"],
      blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation", "staking"],
    }, [
      "ghola/hyperliquid-execution-vault-v1",
      `account:${accountCommitment}`,
      `recipient:${recipient.recipient_id}`,
      `network:${network}`,
    ].join("|"));

    const sealed = await postJson("/v1/private-account/hyperliquid/vault", {
      encrypted_execution_vault: encryptedVault,
    });
    record("sealed_hyperliquid_vault_stored", sealed.ready === true, {
      vault_commitment: short(sealed.hyperliquid_execution_vault?.vault_commitment),
    });
    assertSafeArtifact("sealed_hyperliquid_vault", sealed);

    const snapshot = await postJson("/v1/private-account/hyperliquid/account-snapshot", {});
    report.account_snapshot = sanitizePublicArtifact(snapshot);
    record("hyperliquid_account_snapshot", snapshot.status === "ready_to_trade" || snapshot.status === "needs_funds", {
      status: snapshot.status,
      account_source: snapshot.account_source,
      trading_enabled: snapshot.trading_enabled,
      next_step: snapshot.next_step,
    });
    assertSafeArtifact("hyperliquid_account_snapshot", snapshot);

    const stream = await readAccountStream(market);
    report.account_stream = sanitizePublicArtifact(stream);
    record("hyperliquid_account_stream", stream.status === "ready_to_trade" || stream.status === "needs_funds", {
      status: stream.status,
      stream_status: stream.stream_status,
      account_source: stream.account_source,
    });
    assertSafeArtifact("hyperliquid_account_stream", stream);

    if (liveSubmit) {
      if (liveSubmitConfirm !== "I_UNDERSTAND_THIS_BROADCASTS") {
        throw new Error("GHOLA_VERIFY_LIVE_SUBMIT_CONFIRM=I_UNDERSTAND_THIS_BROADCASTS is required for live submit.");
      }
      if (snapshot.status !== "ready_to_trade") {
        throw new Error(`Live submit requires ready_to_trade; account snapshot returned ${snapshot.status}.`);
      }
      report.live_execution = await runLiveSubmitCanary({ recipient, market, quoteSize, maxSlippageBps });
      report.status = "live_submitted";
    } else {
      report.status = "verified_no_submit";
    }
  }

  if (report.status === "running") {
    report.status = report.checks.every((check) => check.ok) ? "verified_no_submit" : "failed";
  }
} catch (error) {
  report.status = "failed";
  record("fatal", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  report.completed_at = new Date().toISOString();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[verify-prod-hyperliquid] ${report.status}`);
  console.log(`[verify-prod-hyperliquid] report=${reportPath}`);
  for (const check of report.checks) {
    console.log(`[verify-prod-hyperliquid] ${check.ok ? "ok" : "fail"} ${check.name}`);
  }
  if (
    report.status !== "verified_no_submit" &&
    report.status !== "live_submitted" &&
    report.status !== "routes_ready_credentials_required"
  ) {
    process.exit(1);
  }
  if (report.status === "routes_ready_credentials_required" && !allowMissingCredentials) {
    process.exit(1);
  }
}

async function runLiveSubmitCanary({ recipient, market, quoteSize, maxSlippageBps }) {
  const safeInput = {
    action_class: "trade_on_platform",
    platform_class: "hyperliquid_style_market",
    product_bucket: "perps",
    amount_bucket: amountBucket(quoteSize),
    urgency: "fast_degraded",
    destination_class: "platform_subaccount",
    asset_bucket: assetBucket(market),
    solver_count_bucket: "5+",
  };
  const intent = await postJson("/v1/private-account/actions/intent", {
    action_class: safeInput.action_class,
    product_bucket: safeInput.product_bucket,
    intent_seed: {
      amount_bucket: safeInput.amount_bucket,
      urgency: safeInput.urgency,
      destination_class: safeInput.destination_class,
      asset_bucket: safeInput.asset_bucket,
      solver_count_bucket: safeInput.solver_count_bucket,
    },
  });
  record("live_intent_created", Boolean(intent.intent_id), {
    intent_id_present: Boolean(intent.intent_id),
  });

  const previewBody = await postJson("/v1/private-account/actions/privacy-preview", {
    intent_id: intent.intent_id,
    platform_class: safeInput.platform_class,
    requested_rail: "direct_public_fallback",
    safe_input: safeInput,
  });
  const preview = previewBody.preview;
  record("live_preview_created", Boolean(preview?.preview_commitment), {
    preview_commitment: preview?.preview_commitment || null,
    claim_status: preview?.claim_status || null,
  });

  const encryptedInstruction = await sealBundle(recipient, {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    order: {
      market,
      side: "buy",
      quote_size: quoteSize,
      max_slippage_bps: maxSlippageBps,
      live_order_mode: "tiny_fill",
      tif: "Ioc",
    },
  }, [
    "ghola/private-execution-instruction-v1",
    `preview:${preview.preview_commitment}`,
    "venue:hyperliquid",
    `recipient:${recipient.recipient_id}`,
  ].join("|"));

  const approvalBody = await postJson("/v1/private-account/actions/approve", {
    intent_id: intent.intent_id,
    preview_commitment: preview.preview_commitment,
    degraded_accepted: true,
  });
  const approval = approvalBody.approval;
  record("live_approval_created", Boolean(approval?.approval_commitment), {
    approval_commitment: approval?.approval_commitment || null,
  });

  const execution = await postJson("/v1/private-account/actions/execute", {
    intent_id: intent.intent_id,
    preview_commitment: preview.preview_commitment,
    approval_commitment: approval.approval_commitment,
    encrypted_execution_instruction_bundle: encryptedInstruction,
  });
  const receipt = execution.receipt || {};
  record("live_hyperliquid_submit", execution.ok === true && Boolean(receipt.connector_result_commitment), {
    execution_commitment: execution.execution_commitment || null,
    receipt_commitment: receipt.receipt_commitment || null,
    connector_result_commitment: receipt.connector_result_commitment || null,
    work_order_commitment: receipt.work_order_commitment || null,
    claim_status: receipt.claim_status || null,
  });
  assertSafeArtifact("live_hyperliquid_execution", execution);

  return sanitizePublicArtifact({
    intent_id: intent.intent_id,
    preview_commitment: preview.preview_commitment,
    approval_commitment: approval.approval_commitment,
    execution_commitment: execution.execution_commitment || null,
    receipt_commitment: receipt.receipt_commitment || null,
    connector_result_commitment: receipt.connector_result_commitment || null,
    work_order_commitment: receipt.work_order_commitment || null,
    claim_status: receipt.claim_status || null,
  });
}

async function checkHead(name, path) {
  const response = await fetch(`${baseUrl}${path}`, { method: "GET", redirect: "manual" });
  record(name, response.status >= 200 && response.status < 400, { status: response.status });
}

async function getJson(path) {
  return requestJson(path, { method: "GET" });
}

async function postJson(path, body, options = {}) {
  return requestJson(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.sameOrigin ? { origin: baseUrl } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function requestJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      cookie: cookieHeader(),
      ...(init.headers || {}),
    },
  });
  captureCookies(response);
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned non-JSON ${response.status}: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body.error || text.slice(0, 200)}`);
  }
  return body;
}

async function readAccountStream(coin) {
  const response = await fetch(`${baseUrl}/v1/private-account/hyperliquid/account-stream?coin=${encodeURIComponent(coin)}`, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      cookie: cookieHeader(),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`/v1/private-account/hyperliquid/account-stream returned ${response.status}`);
  }
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
          .trim() || "message";
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (!data) continue;
        const parsed = JSON.parse(data);
        if (event === "account_state") return parsed;
        if (event === "error") {
          throw new Error(`account stream error: ${parsed.error || "unknown"}`);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error("account stream ended before account_state");
}

async function sealBundle(recipient, plaintext, aad) {
  const wire = await sealForTest({
    senderDid,
    recipientId: recipient.recipient_id,
    recipientX25519: hexToBytes(recipient.x25519_pub_hex),
    associatedData: aad,
    plaintext,
    signBody: async (digest) => ed25519.sign(digest, senderSecret),
  });
  return {
    alg: "sealed-provider-v1",
    ciphertext: bytesToBase64(wire),
    recipient: recipient.recipient_id,
    aad,
  };
}

function selectedRecipient(runtime) {
  const selected = runtime.providers?.find((provider) => provider.id === runtime.selected_provider) ||
    runtime.providers?.find((provider) => provider.id === "phala");
  const recipient = selected?.sealed_recipient;
  if (!recipient?.recipient_id || !recipient?.x25519_pub_hex) {
    throw new Error("production private-agent recipient is unavailable");
  }
  return recipient;
}

function summarizeRuntime(runtime) {
  return {
    selected_provider: runtime.selected_provider || null,
    remote_execution_ready: runtime.remote_execution_ready === true,
    providers: Array.isArray(runtime.providers)
      ? runtime.providers.map((provider) => ({
          id: provider.id,
          available: provider.available === true,
          attested: provider.attested === true,
          supports_trading_execution: provider.supports_trading_execution === true,
          has_recipient: Boolean(provider.sealed_recipient?.recipient_id && provider.sealed_recipient?.x25519_pub_hex),
        }))
      : [],
    blocking_reasons: runtime.blocking_reasons || [],
  };
}

function validateHyperliquidCredentialInputs(input) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.accountAddress)) {
    throw new Error("GHOLA_VERIFY_HYPERLIQUID_ACCOUNT_ADDRESS must be a 0x-prefixed address.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.apiWalletPrivateKey)) {
    throw new Error("GHOLA_VERIFY_HYPERLIQUID_API_WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte key.");
  }
  const notional = Number(input.quoteSize);
  if (!Number.isFinite(notional) || notional <= 0 || notional > 25) {
    throw new Error("GHOLA_VERIFY_HYPERLIQUID_QUOTE_SIZE must be > 0 and <= 25.");
  }
  const slippage = Number(input.maxSlippageBps);
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > 100) {
    throw new Error("GHOLA_VERIFY_HYPERLIQUID_MAX_SLIPPAGE_BPS must be an integer from 1 to 100.");
  }
}

const FORBIDDEN_PUBLIC_FIELDS = [
  "api_wallet_private_key",
  "private_key",
  "secret_key",
  "hyperliquid_account_address",
  "hyperliquid_account_id",
  "signature",
  "raw_order",
  "raw_payload",
  "provider_payload",
  "transaction",
];

function assertSafeArtifact(name, value) {
  const text = JSON.stringify(value).toLowerCase();
  const hit = FORBIDDEN_PUBLIC_FIELDS.find((field) => text.includes(field));
  if (hit) throw new Error(`${name} exposed forbidden public field: ${hit}`);
}

function sanitizePublicArtifact(value) {
  assertSafeArtifact("public_artifact", value);
  return value;
}

function captureCookies(response) {
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  for (const value of setCookies) {
    const first = String(value).split(";")[0];
    const index = first.indexOf("=");
    if (index > 0) cookies.set(first.slice(0, index), first.slice(index + 1));
  }
}

function cookieHeader() {
  return Array.from(cookies.entries()).map(([key, value]) => `${key}=${value}`).join("; ");
}

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, details });
}

function amountBucket(value) {
  const parsed = Number(value);
  if (parsed <= 5) return "5";
  if (parsed <= 10) return "10";
  if (parsed <= 25) return "25";
  if (parsed <= 50) return "50";
  return "100";
}

function assetBucket(value) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === "BTC" || normalized === "ETH" || normalized === "SOL") return normalized;
  return "major";
}

function boolEnv(name) {
  const value = env(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function required(name) {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function short(value) {
  const text = stringValue(value);
  return text.length > 22 ? `${text.slice(0, 14)}...${text.slice(-6)}` : text;
}

function trimUrl(value) {
  return String(value || "").replace(/\/$/, "");
}
