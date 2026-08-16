#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import {
  bytesToBase64,
  bytesToHex,
  didKeyFromVerifying,
  sealForTest,
} from "../src/crypto/envelope.js";
import {
  MAINNET_PROOF_CONFIRMATION,
  hyperliquidMainnetRoundTripEnabled,
  recoverHyperliquidMainnetCanary,
  runSealedHyperliquidMainnetRoundTrip,
  validateHyperliquidMainnetRoundTripRequest,
} from "../src/execution/hyperliquid-mainnet-roundtrip.js";
import { createPostgresWorkerState } from "../src/state/private-state.js";
import { hyperliquidCredentialFromVault } from "../src/venues/hyperliquid.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const REPORT_PATH = resolve(REPO_ROOT, ".dev/hyperliquid-mainnet-hardened-roundtrip.json");
const ACTIVE_CANARY_PATH = resolve(REPO_ROOT, ".dev/hyperliquid-mainnet-active-canary.json");

export function hardenedMainnetCanaryConfig(env = process.env) {
  const exact = {
    PRIVATE_AGENT_VENUE_DRY_RUN: "false",
    PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED: "true",
    PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "100",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "500",
    PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
  };
  for (const [name, value] of Object.entries(exact)) {
    if (env[name] !== value) throw new Error(`${name} must be ${value}`);
  }
  if (env.GHOLA_MAINNET_FUNDED_CANARY_CONFIRMATION !== MAINNET_PROOF_CONFIRMATION) {
    throw new Error("exact funded-canary confirmation is required");
  }
  const accountAddress = required(env, "GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS").toLowerCase();
  const privateKey = required(env, "GHOLA_HYPERLIQUID_MAINNET_API_WALLET_PRIVATE_KEY").toLowerCase();
  const databaseUrl = requiredEither(env, [
    "PRIVATE_AGENT_MAINNET_CANARY_POSTGRES_URL",
    "PRIVATE_AGENT_STATE_POSTGRES_URL",
  ]);
  if (!/^0x[0-9a-f]{40}$/u.test(accountAddress)) throw new Error("mainnet account address is invalid");
  if (!/^0x[0-9a-f]{64}$/u.test(privateKey)) throw new Error("mainnet API wallet key is invalid");
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl)) throw new Error("funded canary requires Postgres");
  return { accountAddress, privateKey, databaseUrl };
}

export function hardenedCanaryPolicyCommitment({ accountCommitment, vaultCommitment }) {
  if (!/^hyperliquid_account_[0-9a-f]{48}$/u.test(String(accountCommitment || "")) ||
      !/^hyperliquid_mainnet_vault_[0-9a-f]{48}$/u.test(String(vaultCommitment || ""))) {
    throw new Error("funded canary policy scope is invalid");
  }
  return `hyperliquid_mainnet_policy_${sha256(
    `${accountCommitment}:${vaultCommitment}:10.5:100`,
  ).slice(0, 48)}`;
}

export async function runHardenedMainnetCanary({ env = process.env } = {}) {
  const config = hardenedMainnetCanaryConfig(env);
  usePinnedLocalPython(env);
  if (!hyperliquidMainnetRoundTripEnabled(env)) throw new Error("hardened mainnet round trip is disabled");
  const runId = `${Date.now().toString(36)}_${randomBytes(8).toString("hex")}`;
  const recipientSecret = x25519.utils.randomPrivateKey();
  const recipient = {
    recipient_id: `local:hardened-mainnet-canary:${runId}`,
    x25519_pub_hex: bytesToHex(x25519.getPublicKey(recipientSecret)),
    x25519_secret_hex: bytesToHex(recipientSecret),
  };
  const accountCommitment = `hyperliquid_account_${sha256(config.accountAddress).slice(0, 48)}`;
  const vaultCommitment = `hyperliquid_mainnet_vault_${sha256(`${config.accountAddress}:${runId}`).slice(0, 48)}`;
  const policyCommitment = hardenedCanaryPolicyCommitment({ accountCommitment, vaultCommitment });
  const aad = [
    "ghola/hyperliquid-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    "network:mainnet",
  ].join("|");
  const senderSecret = ed25519.utils.randomPrivateKey();
  const wire = await sealForTest({
    recipientId: recipient.recipient_id,
    recipientX25519: x25519.getPublicKey(recipientSecret),
    senderDid: didKeyFromVerifying(ed25519.getPublicKey(senderSecret)),
    associatedData: aad,
    plaintext: {
      version: 1,
      kind: "ghola_hyperliquid_execution_vault",
      network: "mainnet",
      hyperliquid_account_address: config.accountAddress,
      api_wallet_private_key: config.privateKey,
      agent_name: env.GHOLA_HYPERLIQUID_MAINNET_API_WALLET_NAME || "ghola-mainnet",
    },
    signBody: async (digest) => ed25519.sign(digest, senderSecret),
  });
  const body = {
    version: 1,
    confirmation: MAINNET_PROOF_CONFIRMATION,
    execution_mode: "byo_api_key",
    account_commitment: accountCommitment,
    vault_commitment: vaultCommitment,
    policy_commitment: policyCommitment,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(wire),
      recipient: recipient.recipient_id,
      aad,
    },
    market: "HYPE",
    notional_usd: 10.5,
    slippage_bps: 100,
  };
  const errors = validateHyperliquidMainnetRoundTripRequest(body, recipient);
  if (errors.length) throw new Error(`hardened canary request is invalid: ${errors.join(", ")}`);
  const state = createPostgresWorkerState(config.databaseUrl, { driver: "pg" });
  const proofWorkOrder = `hl_mainnet_investor_proof_${sha256(vaultCommitment).slice(0, 32)}`;
  try {
    await recoverArmedMainnetCanary({ config, state });
    writeActiveCanary({
      version: 1,
      status: "armed",
      account_commitment: `sha256:${sha256(config.accountAddress)}`,
      proof_work_order_commitment: proofWorkOrder,
      armed_at: new Date().toISOString(),
    });
    try {
      const report = await runSealedHyperliquidMainnetRoundTrip({ body, recipient, state });
      writeActiveCanary({
        version: 1,
        status: "completed",
        account_commitment: `sha256:${sha256(config.accountAddress)}`,
        proof_work_order_commitment: proofWorkOrder,
        completed_at: report.completed_at,
      });
      return report;
    } catch (error) {
      const recovery = await recoverHyperliquidMainnetCanary({
        credential: mainnetCredential(config),
        state,
        proofWorkOrder,
      });
      writeActiveCanary({
        version: 1,
        status: "recovered",
        account_commitment: `sha256:${sha256(config.accountAddress)}`,
        proof_work_order_commitment: proofWorkOrder,
        recovery,
      });
      throw error;
    }
  } finally {
    await state.close?.();
  }
}

async function recoverArmedMainnetCanary({ config, state }) {
  if (!existsSync(ACTIVE_CANARY_PATH)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(ACTIVE_CANARY_PATH, "utf8"));
  } catch {
    throw new Error("active mainnet canary recovery manifest is invalid");
  }
  if (manifest?.status !== "armed") return null;
  const accountCommitment = `sha256:${sha256(config.accountAddress)}`;
  if (manifest?.version !== 1 || manifest.account_commitment !== accountCommitment ||
      !/^hl_mainnet_investor_proof_[0-9a-f]{32}$/u.test(String(manifest.proof_work_order_commitment || ""))) {
    throw new Error("active mainnet canary recovery scope does not match");
  }
  const recovery = await recoverHyperliquidMainnetCanary({
    credential: mainnetCredential(config),
    state,
    proofWorkOrder: manifest.proof_work_order_commitment,
  });
  writeActiveCanary({ ...manifest, status: "recovered", recovery });
  return recovery;
}

function mainnetCredential(config) {
  return hyperliquidCredentialFromVault({
    version: 1,
    kind: "ghola_hyperliquid_execution_vault",
    network: "mainnet",
    hyperliquid_account_address: config.accountAddress,
    api_wallet_private_key: config.privateKey,
  });
}

function writeActiveCanary(value) {
  mkdirSync(dirname(ACTIVE_CANARY_PATH), { recursive: true });
  const temporary = `${ACTIVE_CANARY_PATH}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, ACTIVE_CANARY_PATH);
}

function usePinnedLocalPython(env) {
  if (env.PRIVATE_AGENT_PYTHON) return;
  const candidate = resolve(REPO_ROOT, ".dev/hyperliquid-venv/bin/python");
  if (existsSync(candidate)) process.env.PRIVATE_AGENT_PYTHON = candidate;
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredEither(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new Error(`${names.join(" or ")} is required`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  let report;
  try {
    report = await runHardenedMainnetCanary();
  } catch (error) {
    report = {
      version: 1,
      ok: false,
      status: "unproven",
      network: "mainnet",
      market: "HYPE",
      error: error instanceof Error ? error.message : String(error),
      completed_at: new Date().toISOString(),
    };
  }
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.ok !== true) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
