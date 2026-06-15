#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const workerRequire = createRequire(resolve(root, "apps/private-agent-worker/package.json"));
const { Keypair } = workerRequire("@solana/web3.js");

const DEFAULT_OUT = "deploy/private-agent-pooled-credentials.env";
const REQUIRED_KEYS = [
  "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_BACKPACK_API_KEY",
  "PRIVATE_AGENT_BACKPACK_API_SECRET",
  "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_JUPITER_API_KEY",
  "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON",
];
const JSON_SECRET_KEYS = new Set([
  "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON",
]);
const CREDENTIAL_INTAKE_KEYS = [
  "PRIVATE_AGENT_HYPERLIQUID_APPROVAL_EVIDENCE",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_AUTHORITY_SOURCE",
  "PRIVATE_AGENT_BACKPACK_API_KEY_EVIDENCE",
  "PRIVATE_AGENT_BACKPACK_TRANSFERS_DISABLED_CONFIRMED",
  "PRIVATE_AGENT_JUPITER_POOLED_AUTHORITY_SOURCE",
  "PRIVATE_AGENT_JUPITER_API_KEY_EVIDENCE",
  "PRIVATE_AGENT_JUPITER_AUTHORITY_FUNDING_EVIDENCE",
  "PRIVATE_AGENT_COINBASE_OMNIBUS_EVIDENCE",
  "PRIVATE_AGENT_COINBASE_TRANSFERS_DISABLED_CONFIRMED",
];
const REQUIRED_INSTALL_EVIDENCE_KEYS = [
  "PRIVATE_AGENT_HYPERLIQUID_APPROVAL_EVIDENCE",
  "PRIVATE_AGENT_BACKPACK_API_KEY_EVIDENCE",
  "PRIVATE_AGENT_BACKPACK_TRANSFERS_DISABLED_CONFIRMED",
  "PRIVATE_AGENT_JUPITER_API_KEY_EVIDENCE",
  "PRIVATE_AGENT_JUPITER_AUTHORITY_FUNDING_EVIDENCE",
  "PRIVATE_AGENT_COINBASE_OMNIBUS_EVIDENCE",
  "PRIVATE_AGENT_COINBASE_TRANSFERS_DISABLED_CONFIRMED",
];
const BOOLEAN_EVIDENCE_KEYS = new Set([
  "PRIVATE_AGENT_COINBASE_TRANSFERS_DISABLED_CONFIRMED",
  "PRIVATE_AGENT_BACKPACK_TRANSFERS_DISABLED_CONFIRMED",
]);
const PLACEHOLDER_RE = /(?:REPLACE|PLACEHOLDER|EXAMPLE|TODO|DUMMY|FAKE|TEST_ONLY)/i;

const args = parseArgs(process.argv.slice(2));
const outPath = resolve(root, args.out || DEFAULT_OUT);
const sources = [
  outPath,
  ...args.env.map((file) => resolve(process.cwd(), file)),
  resolve(root, ".dev/private-agent-staging.env"),
  resolve(root, "apps/web/.env.local"),
  resolve(root, ".dev/vercel-prod.env"),
];

const merged = {};
for (const file of sources) {
  if (!existsSync(file)) continue;
  Object.assign(merged, readEnvFile(file));
}
Object.assign(merged, envSubset(process.env));

normalizeAliases(merged);
const generated = [];

if (!nonEmpty(merged.PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON)) {
  merged.PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON = JSON.stringify(
    solanaVault("ghola_solana_perps_execution_vault"),
  );
  if (!nonEmpty(merged.PRIVATE_AGENT_SOLANA_PERPS_POOLED_AUTHORITY_SOURCE)) {
    merged.PRIVATE_AGENT_SOLANA_PERPS_POOLED_AUTHORITY_SOURCE = "generated_by_bootstrap_unfunded";
  }
  generated.push("phoenix_authority");
}

if (!nonEmpty(merged.PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON)) {
  merged.PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON = JSON.stringify(
    solanaVault("ghola_solana_swap_execution_vault"),
  );
  if (!nonEmpty(merged.PRIVATE_AGENT_JUPITER_POOLED_AUTHORITY_SOURCE)) {
    merged.PRIVATE_AGENT_JUPITER_POOLED_AUTHORITY_SOURCE = "generated_by_bootstrap_unfunded";
  }
  generated.push("jupiter_authority");
}

const installEnv = {};
for (const key of [...REQUIRED_KEYS, ...CREDENTIAL_INTAKE_KEYS]) {
  installEnv[key] = merged[key] || "";
}

writeFileSync(outPath, serializeEnv(installEnv), { mode: 0o600 });

const status = summarize(installEnv);
const evidence = summarizeEvidence(installEnv);
console.log(JSON.stringify({
  output: relativeRoot(outPath),
  wrote_gitignored_secret_file: true,
  generated,
  present: status.present,
  missing: status.missing,
  evidence_present: evidence.present,
  evidence_missing: evidence.missing,
  next_command: status.missing.length === 0 && evidence.missing.length === 0
    ? `node scripts/install-phala-pooled-credentials.mjs --env ${relativeRoot(outPath)} --worker-env .dev/phala-worker.env`
    : null,
}, null, 2));

if (args.install) {
  if (status.missing.length > 0) {
    fail(`Not installing; missing required external credential(s): ${status.missing.join(", ")}`);
  }
  if (evidence.missing.length > 0) {
    fail(`Not installing; missing credential intake evidence: ${evidence.missing.join(", ")}`);
  }
  if (!args.workerEnv) {
    fail("Not installing; pass --worker-env <full-phala-worker.env> so Phala receives a complete sealed env.");
  }
  run("node", [
    "scripts/install-phala-pooled-credentials.mjs",
    "--env",
    relativeRoot(outPath),
    "--worker-env",
    args.workerEnv,
  ]);
}

function parseArgs(argv) {
  const parsed = { env: [], out: DEFAULT_OUT, install: false, workerEnv: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env") parsed.env.push(argv[++i] || "");
    else if (arg === "--out") parsed.out = argv[++i] || DEFAULT_OUT;
    else if (arg === "--install") parsed.install = true;
    else if (arg === "--worker-env") parsed.workerEnv = argv[++i] || "";
    else if (arg === "-h" || arg === "--help") usage();
    else usage(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function usage(error = "") {
  if (error) console.error(error);
  console.error([
    "Usage:",
    "  node scripts/bootstrap-phala-pooled-credentials.mjs [--env extra.env] [--worker-env .dev/phala-worker.env] [--install]",
    "",
    "Creates or updates deploy/private-agent-pooled-credentials.env.",
    "Generates Phoenix and Jupiter Solana authority keys when absent, marked as generated/unfunded.",
    "Does not generate external exchange credentials or approval evidence for Hyperliquid, Backpack, Jupiter API, or Coinbase.",
  ].join("\n"));
  process.exit(error ? 1 : 0);
}

function solanaVault(kind) {
  const keypair = Keypair.generate();
  return {
    kind,
    network: "mainnet",
    authority: keypair.publicKey.toBase58(),
    wallet_private_key: Array.from(keypair.secretKey),
  };
}

function normalizeAliases(env) {
  if (!nonEmpty(env.PRIVATE_AGENT_JUPITER_API_KEY)) {
    env.PRIVATE_AGENT_JUPITER_API_KEY =
      env.JUPITER_API_KEY ||
      env.GHOLA_JUPITER_API_KEY ||
      "";
  }
  if (!nonEmpty(env.PRIVATE_AGENT_BACKPACK_API_KEY)) {
    env.PRIVATE_AGENT_BACKPACK_API_KEY =
      env.BACKPACK_API_KEY ||
      env.GHOLA_BACKPACK_API_KEY ||
      "";
  }
  if (!nonEmpty(env.PRIVATE_AGENT_BACKPACK_API_SECRET)) {
    env.PRIVATE_AGENT_BACKPACK_API_SECRET =
      env.BACKPACK_API_SECRET ||
      env.BACKPACK_API_PRIVATE_KEY_B64 ||
      env.GHOLA_BACKPACK_API_SECRET ||
      env.GHOLA_BACKPACK_API_PRIVATE_KEY_B64 ||
      "";
  }
  if (!nonEmpty(env.PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON)) {
    const account = env.PRIVATE_AGENT_HYPERLIQUID_ACCOUNT_ADDRESS ||
      env.HYPERLIQUID_ACCOUNT_ADDRESS ||
      "";
    const key = env.PRIVATE_AGENT_HYPERLIQUID_API_WALLET_PRIVATE_KEY ||
      env.HYPERLIQUID_API_WALLET_PRIVATE_KEY ||
      env.HYPERLIQUID_API_PRIVATE_KEY ||
      "";
    if (account && key) {
      env.PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON = JSON.stringify({
        accounts: [{
          network: "mainnet",
          account_address: account,
          api_wallet_private_key: key,
        }],
      });
    }
  }
  if (!nonEmpty(env.PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON)) {
    const apiKeyName = env.PRIVATE_AGENT_COINBASE_API_KEY_NAME ||
      env.COINBASE_API_KEY_NAME ||
      env.GHOLA_COINBASE_API_KEY_NAME ||
      "";
    const apiPrivateKeyPem = env.PRIVATE_AGENT_COINBASE_API_PRIVATE_KEY_PEM ||
      env.COINBASE_API_PRIVATE_KEY_PEM ||
      env.COINBASE_API_PRIVATE_KEY ||
      env.GHOLA_COINBASE_API_PRIVATE_KEY ||
      "";
    if (apiKeyName && apiPrivateKeyPem) {
      env.PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON = JSON.stringify({
        kind: "ghola_coinbase_advanced_execution_vault",
        network: "mainnet",
        api_key_name: apiKeyName,
        api_private_key_pem: apiPrivateKeyPem,
        ...(env.COINBASE_PORTFOLIO_ID ? { portfolio_id: env.COINBASE_PORTFOLIO_ID } : {}),
      });
    }
  }
}

function summarize(env) {
  const present = [];
  const missing = [];
  for (const key of REQUIRED_KEYS) {
    if (nonEmpty(env[key])) present.push(key);
    else missing.push(key);
  }
  return { present, missing };
}

function summarizeEvidence(env) {
  const present = [];
  const missing = [];
  for (const key of REQUIRED_INSTALL_EVIDENCE_KEYS) {
    if (validInstallEvidence(key, env[key])) present.push(key);
    else missing.push(key);
  }
  return { present, missing };
}

function validInstallEvidence(key, value) {
  const string = String(value || "").trim();
  if (BOOLEAN_EVIDENCE_KEYS.has(key)) return string.toLowerCase() === "true";
  return nonEmpty(string) && !PLACEHOLDER_RE.test(string);
}

function envSubset(env) {
  const subset = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      key.startsWith("PRIVATE_AGENT_") ||
      key.startsWith("GHOLA_") ||
      key.startsWith("HYPERLIQUID_") ||
      key.startsWith("JUPITER_") ||
      key.startsWith("BACKPACK_") ||
      key.startsWith("COINBASE_")
    ) {
      subset[key] = value;
    }
  }
  return subset;
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
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n");
  }
  return trimmed;
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

function relativeRoot(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function run(command, argv) {
  const result = spawnSync(command, argv, {
    cwd: root,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
