#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_OUT = ".dev/phala-worker.env";

const WORKER_KEYS = [
  "PORT",
  "PRIVATE_AGENT_PROVIDER_ID",
  "PRIVATE_AGENT_TEE_KIND",
  "PRIVATE_AGENT_EXECUTION_TOKEN",
  "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
  "PRIVATE_AGENT_FUNDING_SIGNING_KEY",
  "PRIVATE_AGENT_STATE_STORE",
  "PRIVATE_AGENT_STATE_SINGLE_CVM_OK",
  "PRIVATE_AGENT_STATE_POSTGRES_URL",
  "PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE",
  "PHALA_CVM_IMAGE_DIGEST",
  "PRIVATE_AGENT_VENUE_DRY_RUN",
  "PRIVATE_AGENT_GLOBAL_KILL_SWITCH",
  "PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY",
  "PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE",
  "PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD",
  "PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT",
  "PRIVATE_AGENT_AUTOPILOT_TICK_MS",
  "PRIVATE_AGENT_AI_DIRECT_ENABLED",
  "PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR",
  "PRIVATE_AGENT_AI_MODEL",
  "PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE",
  "PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS",
  "PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON",
  "PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE",
  "PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET",
  "PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_SOLANA_PERPS_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_SOLANA_RPC_URL",
  "PRIVATE_AGENT_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS",
  "PRIVATE_AGENT_BACKPACK_POOLED_ENABLED",
  "PRIVATE_AGENT_BACKPACK_LIVE_MODE",
  "PRIVATE_AGENT_BACKPACK_ALLOWED_SYMBOLS",
  "PRIVATE_AGENT_BACKPACK_MAX_ORDER_NOTIONAL_USD",
  "PRIVATE_AGENT_BACKPACK_DAILY_NOTIONAL_CAP_USD",
  "PRIVATE_AGENT_BACKPACK_POST_ONLY_MM",
  "PRIVATE_AGENT_BACKPACK_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_BACKPACK_API_URL",
  "PRIVATE_AGENT_JUPITER_LIVE_MODE",
  "PRIVATE_AGENT_JUPITER_API_KEY",
  "PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS",
  "PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS",
  "PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_JUPITER_POOLED_VAULT_JSON",
  "PRIVATE_AGENT_COINBASE_LIVE_MODE",
  "PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS",
  "PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD",
  "PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON",
  "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE",
  "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
  "GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD",
  "GHOLA_LIVE_TRADING_DAILY_CAP_USD",
  "GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS",
  "PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD",
  "PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD",
];

const REQUIRED = [
  "PRIVATE_AGENT_EXECUTION_TOKEN",
  "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
  "PRIVATE_AGENT_FUNDING_SIGNING_KEY",
  "PRIVATE_AGENT_STATE_STORE",
];

const ALIASES = {
  PRIVATE_AGENT_EXECUTION_TOKEN: ["GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN"],
  PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: ["GHOLA_WORKER_CAPABILITY_SECRET"],
  PRIVATE_AGENT_FUNDING_SIGNING_KEY: ["GHOLA_PRIVATE_AGENT_FUNDING_SIGNING_KEY"],
  PRIVATE_AGENT_STATE_STORE: ["GHOLA_PRIVATE_AGENT_STATE_STORE"],
  PRIVATE_AGENT_STATE_POSTGRES_URL: [
    "GHOLA_PRIVATE_AGENT_STATE_POSTGRES_URL",
    "GHOLA_PRIVATE_ACCOUNT_DATABASE_URL",
    "PRIVATE_AGENT_DATABASE_URL",
    "DATABASE_URL",
  ],
  PHALA_CVM_IMAGE_DIGEST: ["GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST", "GHOLA_PRIVATE_AGENT_IMAGE_DIGEST"],
  PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: ["GHOLA_HYPERLIQUID_ALLOW_MAINNET"],
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: ["GHOLA_HYPERLIQUID_LIVE_MODE"],
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: ["GHOLA_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD"],
  PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: ["GHOLA_HYPERLIQUID_LIVE_DAILY_NOTIONAL_CAP_USD"],
  PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: ["GHOLA_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD"],
  PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: ["GHOLA_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD"],
  PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: ["GHOLA_HYPERLIQUID_LIVE_MAX_SLIPPAGE_BPS"],
  PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT: ["GHOLA_PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT"],
  PRIVATE_AGENT_AUTOPILOT_TICK_MS: ["GHOLA_PRIVATE_AGENT_AUTOPILOT_TICK_MS"],
  PRIVATE_AGENT_AI_DIRECT_ENABLED: ["GHOLA_PRIVATE_AGENT_AI_DIRECT_ENABLED"],
  PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR: ["GHOLA_PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR"],
  PRIVATE_AGENT_AI_MODEL: ["GHOLA_PRIVATE_AGENT_AI_MODEL"],
  PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE: ["GHOLA_SOLANA_PERPS_LIVE_MODE"],
  PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET: ["GHOLA_SOLANA_PERPS_ALLOW_MAINNET"],
  PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD: ["GHOLA_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD"],
  PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD: ["GHOLA_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD"],
  PRIVATE_AGENT_SOLANA_PERPS_MAX_SLIPPAGE_BPS: ["GHOLA_SOLANA_PERPS_MAX_SLIPPAGE_BPS"],
  PRIVATE_AGENT_SOLANA_RPC_URL: ["GHOLA_SOLANA_RPC_URL", "SOLANA_RPC_URL"],
  PRIVATE_AGENT_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS: ["GHOLA_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS"],
  PRIVATE_AGENT_BACKPACK_POOLED_ENABLED: ["GHOLA_BACKPACK_POOLED_ENABLED"],
  PRIVATE_AGENT_BACKPACK_LIVE_MODE: ["GHOLA_BACKPACK_LIVE_MODE"],
  PRIVATE_AGENT_BACKPACK_ALLOWED_SYMBOLS: ["GHOLA_BACKPACK_ALLOWED_SYMBOLS"],
  PRIVATE_AGENT_BACKPACK_MAX_ORDER_NOTIONAL_USD: ["GHOLA_BACKPACK_MAX_ORDER_NOTIONAL_USD"],
  PRIVATE_AGENT_BACKPACK_DAILY_NOTIONAL_CAP_USD: ["GHOLA_BACKPACK_DAILY_NOTIONAL_CAP_USD"],
  PRIVATE_AGENT_BACKPACK_POST_ONLY_MM: ["GHOLA_BACKPACK_POST_ONLY_MM"],
  PRIVATE_AGENT_BACKPACK_MAX_SLIPPAGE_BPS: ["GHOLA_BACKPACK_MAX_SLIPPAGE_BPS"],
  PRIVATE_AGENT_BACKPACK_API_URL: ["GHOLA_BACKPACK_API_URL"],
  PRIVATE_AGENT_JUPITER_API_KEY: ["JUPITER_API_KEY", "GHOLA_JUPITER_API_KEY"],
  PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS: ["GHOLA_JUPITER_ALLOWED_INPUT_MINTS"],
  PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS: ["GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS"],
  PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD: ["GHOLA_JUPITER_LIVE_MAX_NOTIONAL_USD"],
  PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS: ["GHOLA_JUPITER_MAX_SLIPPAGE_BPS"],
  PRIVATE_AGENT_COINBASE_LIVE_MODE: ["GHOLA_COINBASE_LIVE_MODE"],
  PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS: ["GHOLA_COINBASE_ALLOWED_PRODUCTS"],
  PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD: ["GHOLA_COINBASE_LIVE_MAX_NOTIONAL_USD"],
};

const DEFAULTS = {
  PORT: "8787",
  PRIVATE_AGENT_PROVIDER_ID: "phala",
  PRIVATE_AGENT_TEE_KIND: "phala",
  PRIVATE_AGENT_STATE_SINGLE_CVM_OK: "false",
  PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true",
  PRIVATE_AGENT_VENUE_DRY_RUN: "false",
  PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
  PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "true",
  PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE: "60",
  PRIVATE_AGENT_MIN_ORDER_NOTIONAL_USD: "0",
  PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT: "false",
  PRIVATE_AGENT_AUTOPILOT_TICK_MS: "30000",
  PRIVATE_AGENT_AI_DIRECT_ENABLED: "false",
  PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR: "12",
  PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "false",
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "disabled",
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "5",
  PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: "25",
  PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "50",
  PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS: "12000",
  PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE: "disabled",
  PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET: "false",
  PRIVATE_AGENT_SOLANA_PERPS_LIVE_MAX_NOTIONAL_USD: "5",
  PRIVATE_AGENT_SOLANA_PERPS_PRIORITY_FEE_MICRO_LAMPORTS: "0",
  PRIVATE_AGENT_BACKPACK_POOLED_ENABLED: "false",
  PRIVATE_AGENT_BACKPACK_LIVE_MODE: "disabled",
  PRIVATE_AGENT_BACKPACK_POST_ONLY_MM: "false",
  PRIVATE_AGENT_BACKPACK_MAX_SLIPPAGE_BPS: "25",
  PRIVATE_AGENT_JUPITER_LIVE_MODE: "disabled",
  PRIVATE_AGENT_COINBASE_LIVE_MODE: "disabled",
};

const args = parseArgs(process.argv.slice(2));
const merged = {};
for (const file of args.env) Object.assign(merged, readEnvFile(file));
Object.assign(merged, envSubset(process.env));

const out = {};
for (const key of WORKER_KEYS) {
  const value = firstEnv(merged, [key, ...(ALIASES[key] || [])]);
  if (value) out[key] = value;
}
for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!out[key]) out[key] = value;
}
if (!out.PRIVATE_AGENT_STATE_STORE && out.PRIVATE_AGENT_STATE_POSTGRES_URL) {
  out.PRIVATE_AGENT_STATE_STORE = "postgres";
}

const missing = REQUIRED.filter((key) => !out[key]);
const stateStore = String(out.PRIVATE_AGENT_STATE_STORE || "").toLowerCase();
const singleCvmOk = out.PRIVATE_AGENT_STATE_SINGLE_CVM_OK === "true";
if (!out.PRIVATE_AGENT_STATE_POSTGRES_URL && (stateStore === "postgres" || !singleCvmOk)) {
  missing.push("PRIVATE_AGENT_STATE_POSTGRES_URL");
}
if (missing.length) {
  fail(`Missing required worker env(s): ${missing.join(", ")}`);
}

const outPath = resolve(process.cwd(), args.out || DEFAULT_OUT);
writeFileSync(outPath, serializeEnv(out), { mode: 0o600 });
console.log(JSON.stringify({
  output: outPath,
  wrote_secret_file: true,
  key_count: Object.keys(out).length,
  required_present: REQUIRED,
}, null, 2));

function parseArgs(argv) {
  const parsed = { env: [], out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") parsed.env.push(argv[++index] || "");
    else if (arg === "--out") parsed.out = argv[++index] || DEFAULT_OUT;
    else if (arg === "-h" || arg === "--help") usage();
    else usage(`Unknown argument: ${arg}`);
  }
  if (parsed.env.length === 0) usage("Pass at least one --env file.");
  return parsed;
}

function usage(error = "") {
  if (error) console.error(error);
  console.error([
    "Usage:",
    "  node scripts/build-phala-worker-env.mjs --env vercel-production.env --env .dev/phala-worker.env --out .dev/phala-worker.env",
    "",
    "Builds a complete worker-side env file from Vercel/app env names.",
    "The output contains secrets and must stay gitignored.",
  ].join("\n"));
  process.exit(error ? 1 : 0);
}

function readEnvFile(file) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) fail(`Env file not found: ${path}`);
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

function envSubset(env) {
  const subset = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(PRIVATE_AGENT|GHOLA|PHALA|JUPITER|COINBASE|SOLANA|DATABASE)_/.test(key) || key === "DATABASE_URL") {
      subset[key] = value;
    }
  }
  return subset;
}

function firstEnv(env, keys) {
  for (const key of keys) {
    const value = String(env[key] || "").trim();
    if (value) return value;
  }
  return "";
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
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${serializeEnvValue(value)}`)
    .join("\n") + "\n";
}

function serializeEnvValue(value) {
  const string = String(value ?? "");
  if (!string) return "";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(string)) return string;
  return `'${string.replace(/'/g, "'\\''").replace(/\n/g, "\\n")}'`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
