#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const webRequire = createRequire(resolve(root, "apps/web/package.json"));

function usage() {
  console.log([
    "Usage:",
    "  node scripts/stop-phala-private-agent.mjs --env .dev/vercel-web-prod.env",
    "",
    "Options:",
    "  --env <path>   Env file containing PHALA_CLOUD_API_KEY and optional CVM name.",
    "  --name <name>  Override GHOLA_PHALA_PRIVATE_AGENT_CVM_NAME.",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = { env: null, name: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--env") {
      args.env = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--name") {
      args.name = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(file) {
  if (!file) return;
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) throw new Error(`Env file not found: ${path}`);
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = unquote(trimmed.slice(separator + 1));
    if (/^[A-Z0-9_]+$/.test(key)) process.env[key] = value;
  }
}

function publicState(value, fallbackName) {
  if (!value || typeof value !== "object") return { status: null, name: fallbackName };
  return {
    status: value.status ?? null,
    app_id: value.app_id ?? value.id ?? null,
    name: value.name ?? fallbackName,
  };
}

const args = parseArgs(process.argv.slice(2));
loadEnvFile(args.env);

const apiKey = process.env.PHALA_CLOUD_API_KEY?.trim() || process.env.PHALA_API_KEY?.trim();
const name = args.name?.trim() ||
  process.env.GHOLA_PHALA_PRIVATE_AGENT_CVM_NAME?.trim() ||
  "ghola-private-agent-worker";
const baseURL = process.env.PHALA_CLOUD_API_PREFIX?.trim() || undefined;

if (!apiKey) throw new Error("PHALA_CLOUD_API_KEY is missing.");

const { createClient } = await import(webRequire.resolve("@phala/cloud"));
const client = createClient({ apiKey, ...(baseURL ? { baseURL } : {}) });

const before = await client.getCvmState({ id: name }, { schema: false });
const beforeStatus = before && typeof before === "object" ? String(before.status ?? "") : "";
let stopCalled = false;
if (beforeStatus !== "stopped" && beforeStatus !== "stopping") {
  await client.stopCvm({ id: name });
  stopCalled = true;
}
const after = await client.getCvmState({ id: name }, { schema: false });

console.log(JSON.stringify({
  cvm_name: name,
  before: publicState(before, name),
  stop_called: stopCalled,
  after: publicState(after, name),
}, null, 2));
