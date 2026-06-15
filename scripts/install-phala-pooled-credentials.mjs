#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED_SECRET_KEYS = [
  "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_BACKPACK_API_KEY",
  "PRIVATE_AGENT_BACKPACK_API_SECRET",
  "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_JUPITER_API_KEY",
  "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON",
];
const VENUE_SECRET_KEYS = {
  hyperliquid: ["PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON"],
  phoenix: ["PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON"],
  backpack: [
    "PRIVATE_AGENT_BACKPACK_API_KEY",
    "PRIVATE_AGENT_BACKPACK_API_SECRET",
  ],
  jupiter: [
    "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON",
    "PRIVATE_AGENT_JUPITER_API_KEY",
  ],
  coinbase: ["PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON"],
};
const VENUE_EVIDENCE_KEYS = {
  hyperliquid: ["PRIVATE_AGENT_HYPERLIQUID_APPROVAL_EVIDENCE"],
  phoenix: [],
  backpack: [
    "PRIVATE_AGENT_BACKPACK_API_KEY_EVIDENCE",
    "PRIVATE_AGENT_BACKPACK_TRANSFERS_DISABLED_CONFIRMED",
  ],
  jupiter: [
    "PRIVATE_AGENT_JUPITER_API_KEY_EVIDENCE",
    "PRIVATE_AGENT_JUPITER_AUTHORITY_FUNDING_EVIDENCE",
  ],
  coinbase: [
    "PRIVATE_AGENT_COINBASE_OMNIBUS_EVIDENCE",
    "PRIVATE_AGENT_COINBASE_TRANSFERS_DISABLED_CONFIRMED",
  ],
};
const BOOLEAN_EVIDENCE_KEYS = new Set([
  "PRIVATE_AGENT_COINBASE_TRANSFERS_DISABLED_CONFIRMED",
  "PRIVATE_AGENT_BACKPACK_TRANSFERS_DISABLED_CONFIRMED",
]);
const JSON_SECRET_KEYS = new Set([
  "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON",
]);
const PLACEHOLDER_RE = /(?:REPLACE|PLACEHOLDER|EXAMPLE|TODO|DUMMY|FAKE|TEST_ONLY)/i;

const args = parseArgs(process.argv.slice(2));
if (!args.env) {
  usage("Missing --env <pooled-credentials.env>");
}
if (!existsSync(args.env)) {
  fail([
    `Missing pooled credential file: ${args.env}`,
    "Create deploy/private-agent-pooled-credentials.env from deploy/private-agent-pooled-credentials.env.example.",
    "The file is gitignored because it must contain real venue signing credentials.",
  ].join("\n"));
}

const pooledEnv = readEnvFile(args.env);
normalizeB64Json(pooledEnv, [
  "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON",
]);
normalizeAlias(pooledEnv, "PRIVATE_AGENT_JUPITER_API_KEY", [
  "JUPITER_API_KEY",
  "GHOLA_JUPITER_API_KEY",
]);
normalizeAlias(pooledEnv, "PRIVATE_AGENT_BACKPACK_API_KEY", [
  "BACKPACK_API_KEY",
  "GHOLA_BACKPACK_API_KEY",
]);
normalizeAlias(pooledEnv, "PRIVATE_AGENT_BACKPACK_API_SECRET", [
  "BACKPACK_API_SECRET",
  "BACKPACK_API_PRIVATE_KEY_B64",
  "GHOLA_BACKPACK_API_SECRET",
  "GHOLA_BACKPACK_API_PRIVATE_KEY_B64",
]);

const missing = REQUIRED_SECRET_KEYS.filter((key) => !nonEmpty(pooledEnv[key]));
const requestedVenues = selectedVenues(args.venues);
const completeVenues = requestedVenues.filter((venue) =>
  VENUE_SECRET_KEYS[venue].every((key) => nonEmpty(pooledEnv[key])),
);
const selectedCompleteVenues = args.allowPartial ? completeVenues : requestedVenues;
const selectedSecretKeys = [...new Set(selectedCompleteVenues.flatMap((venue) => VENUE_SECRET_KEYS[venue]))];
const selectedEvidenceKeys = [...new Set(selectedCompleteVenues.flatMap((venue) => VENUE_EVIDENCE_KEYS[venue] || []))];
const selectedMissing = [...new Set(requestedVenues
  .flatMap((venue) => VENUE_SECRET_KEYS[venue])
  .filter((key) => !nonEmpty(pooledEnv[key])))];
const selectedEvidenceMissing = credentialEvidenceMissing(selectedCompleteVenues, pooledEnv);

if (!args.allowPartial && missing.length) {
  fail(`Missing required pooled credential env(s): ${missing.join(", ")}`);
}
if (args.allowPartial && selectedCompleteVenues.length === 0) {
  fail(`No complete pooled venue credentials found. Missing: ${selectedMissing.join(", ")}`);
}
if (selectedEvidenceMissing.length) {
  fail([
    `Missing required credential intake evidence: ${selectedEvidenceMissing.join(", ")}`,
    "These are non-secret operator notes proving the venue key was created, approved, funded, or permission-checked outside Ghola.",
    "Do not paste secrets into evidence fields.",
  ].join("\n"));
}

for (const key of [...selectedSecretKeys, ...selectedEvidenceKeys]) {
  assertNoPlaceholderEnvValue(key, pooledEnv[key]);
}

const validation = {};
if (selectedCompleteVenues.includes("hyperliquid")) {
  validation.hyperliquid_accounts = validateHyperliquidPool(
    jsonValue(pooledEnv.PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON, "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON"),
  );
}
if (selectedCompleteVenues.includes("phoenix")) {
  validation.phoenix_authority = validateSolanaVault(
    jsonValue(pooledEnv.PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON, "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON"),
    "phoenix",
  );
}
if (selectedCompleteVenues.includes("backpack")) {
  validation.backpack_api_key = validateBackpackApiKey(
    pooledEnv.PRIVATE_AGENT_BACKPACK_API_KEY,
    pooledEnv.PRIVATE_AGENT_BACKPACK_API_SECRET,
  );
}
if (selectedCompleteVenues.includes("jupiter")) {
  validation.jupiter_authority = validateSolanaVault(
    jsonValue(pooledEnv.PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON, "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON"),
    "jupiter",
  );
  validation.jupiter_api_key = pooledEnv.PRIVATE_AGENT_JUPITER_API_KEY.length >= 12;
}
if (selectedCompleteVenues.includes("coinbase")) {
  validation.coinbase_pool = validateCoinbaseVault(
    jsonValue(pooledEnv.PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON, "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON"),
  );
}

if (validation.jupiter_api_key === false) {
  fail("PRIVATE_AGENT_JUPITER_API_KEY looks too short.");
}

const cvmName =
  args.cvm ||
  process.env.GHOLA_PHALA_PRIVATE_AGENT_CVM_NAME ||
  "ghola-private-agent-worker-no-submit-f510d61";

const pooledSealedEnv = Object.fromEntries(selectedSecretKeys.map((key) => [key, pooledEnv[key]]));
const workerSealedEnv = args.workerEnv ? readEnvFile(args.workerEnv) : {};
const sealedEnv = { ...workerSealedEnv, ...pooledSealedEnv };

console.log(JSON.stringify({
  installing_to_cvm: cvmName,
  dry_run: args.dryRun,
  allow_partial: args.allowPartial,
  sealed_env_mode: args.workerEnv ? "worker_env_plus_pooled_credentials" : "pooled_credentials_only",
  requested_venues: requestedVenues,
  complete_venues: completeVenues,
  selected_venues: selectedCompleteVenues,
  missing_for_requested_venues: selectedMissing,
  credential_evidence_keys: selectedEvidenceKeys,
  validated: validation,
  pooled_sealed_env_keys: Object.keys(pooledSealedEnv),
  sealed_env_key_count: Object.keys(sealedEnv).length,
}, null, 2));

if (args.dryRun) process.exit(0);
if (!args.workerEnv) {
  fail([
    "Refusing to update Phala with pooled keys only.",
    "Phala sealed env updates replace the worker env set for this CVM.",
    "Pass --worker-env <full-phala-worker.env> so runtime config, image pins, funding signer, and pooled credentials are sealed together.",
  ].join("\n"));
}

const prodEnv = args.vercel === false ? new Map() : pullVercelProductionEnv();
const phalaApiKey =
  process.env.PHALA_CLOUD_API_KEY ||
  prodEnv.get("PHALA_CLOUD_API_KEY") ||
  "";
const resolvedCvmName =
  args.cvm ||
  process.env.GHOLA_PHALA_PRIVATE_AGENT_CVM_NAME ||
  prodEnv.get("GHOLA_PHALA_PRIVATE_AGENT_CVM_NAME") ||
  cvmName;

if (!phalaApiKey) fail("PHALA_CLOUD_API_KEY is missing. Set it or allow --vercel production env pull.");

const tempDir = mkdtempSync(join(tmpdir(), "ghola-pooled-env-"));
const sealedEnvPath = join(tempDir, "pooled.env");
try {
  writeFileSync(sealedEnvPath, serializeEnv(sealedEnv), { mode: 0o600 });
  run("npx", [
    "phala",
    "envs",
    "update",
    resolvedCvmName,
    "--api-key",
    phalaApiKey,
    "-e",
    sealedEnvPath,
    "--json",
  ]);

  const status = fetchJson("https://ghola.xyz/v1/private-account/live-trading/status");
  const summary = {
    live_submit_mode: status.live_submit_mode,
    pooled_live_trading_enabled: status.pooled_live_trading_enabled,
    pooled_live_venues: status.pooled_live_venues,
    pooled_reason_codes: status.pooled_reason_codes,
  };
  console.log(JSON.stringify({ public_status_after_install: summary }, null, 2));
  if (status.pooled_live_trading_enabled !== true) {
    process.exitCode = 2;
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function parseArgs(argv) {
  const parsed = { dryRun: false, vercel: true, env: "", workerEnv: "", cvm: "", venues: "", allowPartial: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env") parsed.env = argv[++i] || "";
    else if (arg === "--worker-env") parsed.workerEnv = argv[++i] || "";
    else if (arg === "--cvm") parsed.cvm = argv[++i] || "";
    else if (arg === "--venues") parsed.venues = argv[++i] || "";
    else if (arg === "--allow-partial") parsed.allowPartial = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--no-vercel") parsed.vercel = false;
    else if (arg === "-h" || arg === "--help") usage();
    else usage(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function usage(error = "") {
  if (error) console.error(error);
  console.error([
    "Usage:",
    "  node scripts/install-phala-pooled-credentials.mjs --env deploy/private-agent-pooled-credentials.env --worker-env .dev/phala-worker.env",
    "  node scripts/install-phala-pooled-credentials.mjs --env deploy/private-agent-pooled-credentials.env --worker-env .dev/phala-worker.env --allow-partial --venues phoenix",
    "",
    "The env file must contain:",
    ...REQUIRED_SECRET_KEYS.map((key) => `  ${key}=...`),
    "",
    "Hyperliquid, Backpack, Jupiter, and Coinbase also require non-secret intake evidence fields from the example file.",
    "",
    "JSON values may also be provided as *_B64.",
  ].join("\n"));
  process.exit(error ? 1 : 0);
}

function selectedVenues(raw) {
  const venues = raw
    ? raw.split(",").map((venue) => venue.trim()).filter(Boolean)
    : Object.keys(VENUE_SECRET_KEYS);
  for (const venue of venues) {
    if (!Object.prototype.hasOwnProperty.call(VENUE_SECRET_KEYS, venue)) {
      fail(`Unsupported pooled venue: ${venue}`);
    }
  }
  return [...new Set(venues)];
}

function credentialEvidenceMissing(venues, env) {
  const missingEvidence = [];
  for (const venue of venues) {
    for (const key of VENUE_EVIDENCE_KEYS[venue] || []) {
      if (BOOLEAN_EVIDENCE_KEYS.has(key)) {
        if (String(env[key] || "").trim().toLowerCase() !== "true") missingEvidence.push(key);
      } else if (!validOperatorEvidence(env[key])) {
        missingEvidence.push(key);
      }
    }
  }
  return [...new Set(missingEvidence)];
}

function validOperatorEvidence(value) {
  if (!nonEmpty(value)) return false;
  return !PLACEHOLDER_RE.test(String(value));
}

function readEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const env = {};
  let key = "";
  let quote = "";
  let value = "";
  for (const rawLine of text.split(/\n/)) {
    if (quote) {
      value += `\n${rawLine}`;
      if (rawLine.endsWith(quote)) {
        env[key] = unquote(value);
        key = "";
        quote = "";
        value = "";
      }
      continue;
    }
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    key = line.slice(0, index).trim();
    value = line.slice(index + 1);
    if ((value.startsWith('"') && !value.endsWith('"')) || (value.startsWith("'") && !value.endsWith("'"))) {
      quote = value[0];
      continue;
    }
    env[key] = unquote(value);
    key = "";
    value = "";
  }
  if (quote) fail(`Unclosed quoted env value for ${key}`);
  return env;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1).replace(/\\n/g, "\n");
    }
  }
  if (
    trimmed.startsWith("'") && trimmed.endsWith("'")
  ) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n");
  }
  return trimmed;
}

function normalizeB64Json(env, keys) {
  for (const key of keys) {
    if (nonEmpty(env[key])) continue;
    const b64 = env[`${key}_B64`];
    if (nonEmpty(b64)) env[key] = Buffer.from(b64, "base64").toString("utf8");
  }
}

function normalizeAlias(env, key, aliases) {
  if (nonEmpty(env[key])) return;
  for (const alias of aliases) {
    if (nonEmpty(env[alias])) {
      env[key] = env[alias];
      return;
    }
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function jsonValue(value, key) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`${key} is not valid JSON.`);
  }
}

function assertNoPlaceholderEnvValue(key, value) {
  if (!nonEmpty(value)) return;
  const string = String(value);
  if (PLACEHOLDER_RE.test(string)) {
    fail(`${key} contains a placeholder; install only real venue-issued material.`);
  }
  if (JSON_SECRET_KEYS.has(key)) {
    assertNoPlaceholderJson(jsonValue(string, key), key);
  }
}

function assertNoPlaceholderJson(value, path) {
  if (typeof value === "string") {
    if (
      PLACEHOLDER_RE.test(value) ||
      /^0x0{40}$/i.test(value) ||
      /^0x(?:0{64}|1{64})$/i.test(value)
    ) {
      fail(`${path} contains placeholder-looking credential material.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 1 && Number(value[0]) === 0) {
      fail(`${path} contains the example Solana secret [0].`);
    }
    value.forEach((entry, index) => assertNoPlaceholderJson(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      assertNoPlaceholderJson(childValue, `${path}.${childKey}`);
    }
  }
}

function validateHyperliquidPool(value) {
  const accounts = Array.isArray(value) ? value : value?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) fail("Hyperliquid pool has no accounts.");
  const mainnet = accounts.filter((account) => account?.network === "mainnet");
  if (mainnet.length === 0) fail("Hyperliquid pool has no mainnet account.");
  for (const account of mainnet) {
    const address = String(account.account_address || "");
    const apiWalletKey = String(account.api_wallet_private_key || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      fail("Hyperliquid mainnet account_address is invalid.");
    }
    if (/^0x0{40}$/i.test(address)) {
      fail("Hyperliquid mainnet account_address must not be the zero address.");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(apiWalletKey)) {
      fail("Hyperliquid mainnet api_wallet_private_key is invalid.");
    }
    if (/^0x(?:0{64}|1{64})$/i.test(apiWalletKey)) {
      fail("Hyperliquid mainnet api_wallet_private_key looks like a generated placeholder.");
    }
  }
  return { mainnet_account_count: mainnet.length };
}

function validateSolanaVault(value, venue) {
  const expectedKind = venue === "phoenix"
    ? "ghola_solana_perps_execution_vault"
    : "ghola_solana_swap_execution_vault";
  if (value?.kind && value.kind !== expectedKind) fail(`${venue} vault kind is invalid.`);
  const secret = value?.wallet_private_key || value?.authority_private_key || value?.secret_key || value?.private_key;
  if (!secret) fail(`${venue} vault wallet_private_key is missing.`);
  if (Array.isArray(secret)) {
    if (![32, 64].includes(secret.length) || secret.every((entry) => Number(entry) === 0)) {
      fail(`${venue} vault wallet_private_key is not a real Solana secret key.`);
    }
  }
  return {
    network: value?.network || "mainnet",
    has_authority: nonEmpty(value?.authority),
  };
}

function validateBackpackApiKey(apiKey, apiSecret) {
  if (!nonEmpty(apiKey) || apiKey.length < 12) fail("PRIVATE_AGENT_BACKPACK_API_KEY looks too short.");
  let seedLength = 0;
  try {
    seedLength = Buffer.from(apiSecret, "base64").length;
  } catch {
    seedLength = 0;
  }
  const cleanHex = String(apiSecret || "").startsWith("0x") ? String(apiSecret).slice(2) : String(apiSecret || "");
  if (![32, 64].includes(seedLength) && !/^[0-9a-fA-F]{64}$/.test(cleanHex) && !/^[0-9a-fA-F]{128}$/.test(cleanHex)) {
    fail("PRIVATE_AGENT_BACKPACK_API_SECRET must be a 32-byte or 64-byte base64/hex Ed25519 secret.");
  }
  return {
    key_present: true,
    secret_format: seedLength ? `base64_${seedLength}_bytes` : "hex",
  };
}

function validateCoinbaseVault(value) {
  if (value?.kind && value.kind !== "ghola_coinbase_advanced_execution_vault") {
    fail("Coinbase vault kind is invalid.");
  }
  if (!nonEmpty(value?.api_key_name)) fail("Coinbase api_key_name is missing.");
  if (!String(value?.api_private_key_pem || "").includes("PRIVATE KEY")) {
    fail("Coinbase api_private_key_pem is missing or invalid.");
  }
  return {
    network: value?.network || "mainnet",
    has_portfolio_id: nonEmpty(value?.portfolio_id),
  };
}

function pullVercelProductionEnv() {
  const tmp = mkdtempSync(join(tmpdir(), "ghola-vercel-env-"));
  const out = join(tmp, "production.env");
  const cwd = existsSync("apps/web/.vercel/project.json") ? "apps/web" : process.cwd();
  try {
    run("vercel", ["env", "pull", out, "--environment=production"], { quiet: true, cwd });
    return new Map(Object.entries(readEnvFile(out)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function serializeEnv(env) {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${serializeEnvValue(key, value)}`)
    .join("\n") + "\n";
}

function serializeEnvValue(key, value) {
  const string = String(value ?? "");
  if (!string) return "";
  if (JSON_SECRET_KEYS.has(key)) {
    try {
      return JSON.stringify(JSON.parse(string));
    } catch {
      fail(`${key} is not valid JSON.`);
    }
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(string)) return string;
  return `'${string.replace(/'/g, "'\\''").replace(/\n/g, "\\n")}'`;
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: "utf8",
    cwd: options.cwd,
  });
  if (result.status !== 0) {
    if (options.quiet && result.stderr) process.stderr.write(result.stderr);
    fail(`${command} ${argv.slice(0, 3).join(" ")} failed.`);
  }
  return result.stdout || "";
}

function fetchJson(url) {
  const result = spawnSync("curl", ["-fsS", url], { encoding: "utf8" });
  if (result.status !== 0) fail(`Could not fetch ${url}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`${url} did not return JSON`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
