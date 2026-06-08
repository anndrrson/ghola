#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED_SECRET_KEYS = [
  "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_JUPITER_API_KEY",
  "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON",
];

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

const missing = REQUIRED_SECRET_KEYS.filter((key) => !nonEmpty(pooledEnv[key]));
if (missing.length) {
  fail(`Missing required pooled credential env(s): ${missing.join(", ")}`);
}

const validation = {
  hyperliquid_accounts: validateHyperliquidPool(
    jsonValue(pooledEnv.PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON, "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON"),
  ),
  phoenix_authority: validateSolanaVault(
    jsonValue(pooledEnv.PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON, "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON"),
    "phoenix",
  ),
  jupiter_authority: validateSolanaVault(
    jsonValue(pooledEnv.PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON, "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON"),
    "jupiter",
  ),
  jupiter_api_key: pooledEnv.PRIVATE_AGENT_JUPITER_API_KEY.length >= 12,
  coinbase_pool: validateCoinbaseVault(
    jsonValue(pooledEnv.PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON, "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON"),
  ),
};

if (!validation.jupiter_api_key) {
  fail("PRIVATE_AGENT_JUPITER_API_KEY looks too short.");
}

const cvmName =
  args.cvm ||
  process.env.GHOLA_PHALA_PRIVATE_AGENT_CVM_NAME ||
  "ghola-private-agent-worker-no-submit-f510d61";

const sealedEnv = {
  PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON:
    pooledEnv.PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON,
  PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON:
    pooledEnv.PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON,
  PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON:
    pooledEnv.PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON,
  PRIVATE_AGENT_JUPITER_API_KEY:
    pooledEnv.PRIVATE_AGENT_JUPITER_API_KEY,
  PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON:
    pooledEnv.PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON,
};

console.log(JSON.stringify({
  installing_to_cvm: cvmName,
  dry_run: args.dryRun,
  validated: validation,
  sealed_env_keys: Object.keys(sealedEnv),
}, null, 2));

if (args.dryRun) process.exit(0);

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
  const parsed = { dryRun: false, vercel: true, env: "", cvm: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env") parsed.env = argv[++i] || "";
    else if (arg === "--cvm") parsed.cvm = argv[++i] || "";
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
    "  node scripts/install-phala-pooled-credentials.mjs --env deploy/private-agent-pooled-credentials.env",
    "",
    "The env file must contain:",
    ...REQUIRED_SECRET_KEYS.map((key) => `  ${key}=...`),
    "",
    "JSON values may also be provided as *_B64.",
  ].join("\n"));
  process.exit(error ? 1 : 0);
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
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
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

function validateHyperliquidPool(value) {
  const accounts = Array.isArray(value) ? value : value?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) fail("Hyperliquid pool has no accounts.");
  const mainnet = accounts.filter((account) => account?.network === "mainnet");
  if (mainnet.length === 0) fail("Hyperliquid pool has no mainnet account.");
  for (const account of mainnet) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(account.account_address || ""))) {
      fail("Hyperliquid mainnet account_address is invalid.");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(account.api_wallet_private_key || ""))) {
      fail("Hyperliquid mainnet api_wallet_private_key is invalid.");
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
  return {
    network: value?.network || "mainnet",
    has_authority: nonEmpty(value?.authority),
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
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join("\n") + "\n";
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
