#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

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
const authoritySecret = required("GHOLA_VERIFY_PHOENIX_AUTHORITY_PRIVATE_KEY");
const market = env("GHOLA_VERIFY_PHOENIX_MARKET", "SOL").toUpperCase();
const quoteSize = env("GHOLA_VERIFY_PHOENIX_QUOTE_SIZE", "5");
const limitPrice = env("GHOLA_VERIFY_PHOENIX_LIMIT_PRICE", "250");
const reportPath = resolve(REPO_ROOT, env("GHOLA_VERIFY_REPORT_PATH", ".dev/ghola-prod-trading-verify.json"));
const liveSubmit = env("GHOLA_VERIFY_LIVE_SUBMIT") === "true";
const liveSubmitConfirm = env("GHOLA_VERIFY_LIVE_SUBMIT_CONFIRM");

const cookies = new Map();
const senderSecret = ed25519.utils.randomPrivateKey();
const senderPublic = ed25519.getPublicKey(senderSecret);
const senderDid = didKeyFromVerifying(senderPublic);
const authority = keypairFromSecret(authoritySecret).publicKey.toBase58();
const startedAt = new Date().toISOString();
const report = {
  version: 1,
  base_url: baseUrl,
  started_at: startedAt,
  completed_at: null,
  status: "running",
  live_submit_requested: liveSubmit,
  checks: [],
  verification: null,
  live_readiness_certificate: null,
  live_execution: null,
  note: liveSubmit
    ? "Live submit mode requested. This verifier will only broadcast when GHOLA_VERIFY_LIVE_SUBMIT_CONFIRM=I_UNDERSTAND_THIS_BROADCASTS."
    : "No transaction is sent by this verifier. Live venue fill remains unproven until a funded canary is run.",
};

try {
  await checkHead("landing", "/");
  await checkHead("trade_page", "/app/account?flow=trade");
  const runtime = await getJson("/api/private-agent/status");
  record("private_agent_status", Boolean(
    runtime.selected_provider === "phala" &&
      runtime.remote_execution_ready === true &&
      runtime.providers?.some((provider) =>
        provider.id === "phala" &&
        provider.available === true &&
        provider.attested === true &&
        provider.supports_trading_execution === true &&
        provider.sealed_recipient?.recipient_id &&
        provider.sealed_recipient?.x25519_pub_hex
      )
  ), {
    selected_provider: runtime.selected_provider,
    remote_execution_ready: runtime.remote_execution_ready,
  });
  const recipient = selectedRecipient(runtime);

  const readiness = await postJson("/v1/private-account/connectors/readiness", {
    platform_class: "solana_perps_market",
  });
  const phoenixReady = readiness.readiness?.[0];
  record("phoenix_connector_readiness", Boolean(
    phoenixReady?.status === "ready" && phoenixReady?.live_submit_enabled === true
  ), {
    status: phoenixReady?.status,
    live_submit_enabled: phoenixReady?.live_submit_enabled,
    reason_codes: phoenixReady?.reason_codes || [],
  });

  await postJson("/api/auth/session/email/signin", { email, password }, { sameOrigin: true });
  const session = await getJson("/api/auth/session/me");
  record("auth_session", session.authenticated === true, {
    authenticated: session.authenticated === true,
    user_id_present: Boolean(session.user?.id),
  });

  const vaultStatus = await getJson("/v1/private-account/venues/solana_perps_market/vault");
  const accountCommitment = stringValue(vaultStatus.account_commitment);
  record("private_account_loaded", Boolean(accountCommitment), {
    account_commitment: short(accountCommitment),
  });

  const encryptedVault = await sealBundle(recipient, {
    version: 1,
    kind: "ghola_solana_perps_execution_vault",
    venue_id: "phoenix",
    network: "mainnet",
    execution_mode: "user_stealth",
    authority,
    wallet_private_key: authoritySecret,
    rpc_url: env("GHOLA_VERIFY_SOLANA_RPC_URL") || null,
    api_url: env("GHOLA_VERIFY_PHOENIX_API_URL") || null,
    trader_pda_index: Number.parseInt(env("GHOLA_VERIFY_PHOENIX_TRADER_PDA_INDEX", "0"), 10),
    trader_subaccount_index: Number.parseInt(env("GHOLA_VERIFY_PHOENIX_TRADER_SUBACCOUNT_INDEX", "0"), 10),
    allowed_operations: ["read", "perp_limit_order", "cancel", "fills", "reconcile"],
    blocked_operations: ["withdraw", "vault_transfer", "leverage_escalation", "staking", "raw_custody_transfer"],
  }, [
    "ghola/solana-perps-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    "mode:user_stealth",
    "network:mainnet",
    "venue:phoenix",
  ].join("|"));

  const sealed = await postJson("/v1/private-account/venues/solana_perps_market/vault", {
    execution_mode: "user_stealth",
    encrypted_execution_vault: encryptedVault,
  });
  record("sealed_vault_stored", sealed.ready === true, {
    vault_commitment: short(sealed.venue_execution_vault?.vault_commitment),
  });

  const workOrderCommitment = `connector_work_order_phoenix_verify_${sha256Hex(`${Date.now()}:${authority}`).slice(0, 32)}`;
  const encryptedInstruction = await sealBundle(recipient, {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "phoenix",
    operation_class: "perp_limit_order",
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    order: {
      market,
      side: "buy",
      quote_size: quoteSize,
      limit_price: limitPrice,
      live_order_mode: "tiny_fill",
      tif: "Ioc",
    },
  }, [
    "ghola/private-execution-instruction-v1",
    `work_order:${workOrderCommitment}`,
    "venue:phoenix",
    `recipient:${recipient.recipient_id}`,
  ].join("|"));

  const verification = await postJson("/v1/private-account/connectors/verify-no-submit", {
    platform_class: "solana_perps_market",
    work_order_commitment: workOrderCommitment,
    encrypted_execution_instruction_bundle: encryptedInstruction,
  });
  const noFunds = verification.verification;
  report.verification = {
    status: noFunds?.status,
    verification_commitment: noFunds?.verification_commitment || null,
    result_commitment: noFunds?.result_commitment || null,
    checks: noFunds?.checks || null,
    reason: noFunds?.reason || null,
  };
  report.live_readiness_certificate = noFunds?.live_readiness_certificate || null;
  record("no_submit_phoenix_verification", noFunds?.status === "verified_no_funds", {
    verification_commitment: noFunds?.verification_commitment || null,
    certificate_commitment: noFunds?.live_readiness_certificate?.certificate_commitment || null,
    certificate_status: noFunds?.live_readiness_certificate?.status || null,
    transaction_broadcast: noFunds?.checks?.transaction_broadcast,
  });

  if (liveSubmit) {
    if (liveSubmitConfirm !== "I_UNDERSTAND_THIS_BROADCASTS") {
      throw new Error("GHOLA_VERIFY_LIVE_SUBMIT_CONFIRM=I_UNDERSTAND_THIS_BROADCASTS is required for live submit");
    }
    if (noFunds?.status !== "verified_no_funds") {
      throw new Error("no-submit verification must pass before live submit");
    }
    const live = await runLiveSubmitCanary({ recipient, market, quoteSize, limitPrice });
    report.live_execution = live;
  }

  report.status = report.checks.every((check) => check.ok)
    ? liveSubmit ? "live_submitted" : "verified_no_funds"
    : "failed";
} catch (error) {
  report.status = "failed";
  record("fatal", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  report.completed_at = new Date().toISOString();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[verify-prod-trading] ${report.status}`);
  console.log(`[verify-prod-trading] report=${reportPath}`);
  for (const check of report.checks) {
    console.log(`[verify-prod-trading] ${check.ok ? "ok" : "fail"} ${check.name}`);
  }
  if (report.status !== "verified_no_funds" && report.status !== "live_submitted") process.exit(1);
}

async function runLiveSubmitCanary({ recipient, market, quoteSize, limitPrice }) {
  const safeInput = {
    action_class: "trade_on_platform",
    platform_class: "solana_perps_market",
    product_bucket: "perps",
    amount_bucket: quoteSize,
    urgency: "fast_degraded",
    destination_class: "platform_subaccount",
    asset_bucket: market,
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
    venue_id: "phoenix",
    operation_class: "perp_limit_order",
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    order: {
      market,
      side: "buy",
      quote_size: quoteSize,
      limit_price: limitPrice,
      live_order_mode: "tiny_fill",
      tif: "Ioc",
    },
  }, [
    "ghola/private-execution-instruction-v1",
    `preview:${preview.preview_commitment}`,
    "venue:phoenix",
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
  record("live_phoenix_submit", execution.ok === true && Boolean(receipt.connector_result_commitment), {
    execution_commitment: execution.execution_commitment || null,
    receipt_commitment: receipt.receipt_commitment || null,
    connector_result_commitment: receipt.connector_result_commitment || null,
    work_order_commitment: receipt.work_order_commitment || null,
    claim_status: receipt.claim_status || null,
  });

  return {
    intent_id: intent.intent_id,
    preview_commitment: preview.preview_commitment,
    approval_commitment: approval.approval_commitment,
    execution_commitment: execution.execution_commitment || null,
    receipt_commitment: receipt.receipt_commitment || null,
    connector_result_commitment: receipt.connector_result_commitment || null,
    work_order_commitment: receipt.work_order_commitment || null,
    claim_status: receipt.claim_status || null,
  };
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
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body.error || text.slice(0, 200)}`);
  }
  return body;
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

function keypairFromSecret(value) {
  const text = value.trim();
  if (text.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text).map(Number)));
  const hex = text.startsWith("0x") ? text.slice(2) : text;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Keypair.fromSeed(Uint8Array.from(Buffer.from(hex, "hex")));
  if (/^[0-9a-fA-F]{128}$/.test(hex)) return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, "hex")));
  const bytes = bs58.decode(text);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  throw new Error("GHOLA_VERIFY_PHOENIX_AUTHORITY_PRIVATE_KEY must be a 32-byte seed or 64-byte secret key");
}

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, details });
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

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
