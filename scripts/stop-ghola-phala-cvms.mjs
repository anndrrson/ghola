#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

function usage() {
  console.log([
    "Usage:",
    "  node scripts/stop-ghola-phala-cvms.mjs [options]",
    "",
    "Options:",
    "  --env <path>       Env file containing PHALA_CLOUD_API_KEY.",
    "  --names <csv>      Explicit CVM names or ids to stop.",
    "  --prefixes <csv>   CVM name/id prefixes to discover and stop. Default: ghola-",
    "  --dry-run          Report matches without stopping them.",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    env: null,
    names: [],
    prefixes: ["ghola-"],
    dryRun: false,
  };
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
    if (arg === "--names") {
      args.names = splitCsv(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--prefixes") {
      args.prefixes = splitCsv(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function splitCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function phalaModuleRequire() {
  const moduleDir = process.env.PHALA_CLOUD_MODULE_DIR?.trim();
  if (moduleDir) return createRequire(resolve(moduleDir, "package.json"));
  return createRequire(resolve(root, "apps/web/package.json"));
}

async function loadPhalaCloud() {
  const requireFrom = phalaModuleRequire();
  return import(requireFrom.resolve("@phala/cloud"));
}

function publicCvm(value, fallbackName) {
  if (!value || typeof value !== "object") return { name: fallbackName, status: "unknown" };
  return {
    id: value.id ?? value.app_id ?? null,
    app_id: value.app_id ?? null,
    name: value.name ?? fallbackName,
    status: value.status ?? "unknown",
  };
}

function cvmKey(value, fallbackName) {
  const cvm = publicCvm(value, fallbackName);
  return String(cvm.name || cvm.id || cvm.app_id || fallbackName);
}

function matchesPrefix(value, prefixes) {
  const cvm = publicCvm(value, "");
  const candidates = [cvm.name, cvm.id, cvm.app_id].filter(Boolean).map(String);
  return candidates.some((candidate) => prefixes.some((prefix) => candidate.startsWith(prefix)));
}

async function discoverPrefixedCvms(client, prefixes) {
  if (!prefixes.length) return [];
  const discovered = new Map();
  for (let page = 1; page <= 50; page += 1) {
    let response;
    try {
      response = await client.getCvmList({ page, page_size: 100 }, { schema: false });
    } catch (error) {
      return {
        error: error instanceof Error ? error.message.slice(0, 180) : "cvm_list_failed",
        items: [...discovered.values()],
      };
    }
    const items = Array.isArray(response?.items) ? response.items : [];
    for (const item of items) {
      if (matchesPrefix(item, prefixes)) discovered.set(cvmKey(item, ""), item);
    }
    const pages = Number(response?.pages ?? 0);
    if (!items.length || (Number.isFinite(pages) && pages > 0 && page >= pages)) break;
  }
  return { error: null, items: [...discovered.values()] };
}

async function stopOne(client, id, dryRun) {
  let before = null;
  let beforeStatus = "unknown";
  let action = "none";
  try {
    before = await client.getCvmState({ id }, { schema: false });
    beforeStatus = before && typeof before === "object" ? String(before.status ?? "unknown") : "unknown";
    if (beforeStatus && beforeStatus !== "stopped" && beforeStatus !== "stopping") {
      action = dryRun ? "would_stop" : "stop_called";
      if (!dryRun) await client.stopCvm({ id });
    }
  } catch (error) {
    return {
      id,
      name: id,
      status: beforeStatus,
      action: "error",
      reason: error instanceof Error ? error.message.slice(0, 180) : "unknown_error",
    };
  }
  return {
    ...publicCvm(before, id),
    id,
    status: beforeStatus,
    action,
  };
}

const args = parseArgs(process.argv.slice(2));
loadEnvFile(args.env);

const apiKey = process.env.PHALA_CLOUD_API_KEY?.trim() || process.env.PHALA_API_KEY?.trim();
const baseURL = process.env.PHALA_CLOUD_API_PREFIX?.trim() || undefined;

if (!apiKey) {
  console.log(JSON.stringify({
    dry_run: args.dryRun,
    skipped: true,
    reason: "PHALA_CLOUD_API_KEY is missing.",
    rows: [],
  }, null, 2));
  process.exit(0);
}

const { createClient } = await loadPhalaCloud();
const client = createClient({ apiKey, ...(baseURL ? { baseURL } : {}) });
const explicitNames = new Set(args.names);
const discovered = await discoverPrefixedCvms(client, args.prefixes);
for (const item of discovered.items) {
  const cvm = publicCvm(item, "");
  const id = cvm.name || cvm.id || cvm.app_id;
  if (id) explicitNames.add(String(id));
}

const rows = [];
for (const name of [...explicitNames].sort()) {
  rows.push(await stopOne(client, name, args.dryRun));
}

console.log(JSON.stringify({
  dry_run: args.dryRun,
  skipped: false,
  prefixes: args.prefixes,
  discovered_error: discovered.error,
  rows,
}, null, 2));
