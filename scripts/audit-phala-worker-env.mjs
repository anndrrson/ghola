#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import {
  auditPhalaWorkerEnv,
  auditWorkerWebAuthorization,
} from "./lib/phala-worker-env.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.workerEnv) usage("Missing --worker-env <full-phala-worker.env>");
if (!existsSync(args.workerEnv)) fail(`Missing worker env: ${args.workerEnv}`);
if (args.webEnv && !existsSync(args.webEnv)) fail(`Missing web env: ${args.webEnv}`);

const worker = auditPhalaWorkerEnv(readEnvFile(args.workerEnv));
const authorization = args.webEnv
  ? auditWorkerWebAuthorization(readEnvFile(args.workerEnv), readEnvFile(args.webEnv))
  : null;
const ready = worker.complete && (!authorization || authorization.aligned);

console.log(JSON.stringify({
  ready_for_sealed_env_update: ready,
  mutates_cloud: false,
  worker,
  authorization,
}, null, 2));

if (!ready) process.exitCode = 2;

function parseArgs(argv) {
  const parsed = { workerEnv: "", webEnv: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--worker-env") parsed.workerEnv = argv[++index] || "";
    else if (arg === "--web-env") parsed.webEnv = argv[++index] || "";
    else if (arg === "-h" || arg === "--help") usage();
    else usage(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function usage(error = "") {
  if (error) console.error(error);
  console.error([
    "Usage:",
    "  node scripts/audit-phala-worker-env.mjs --worker-env .dev/phala-worker.env [--web-env .dev/vercel-preview.env]",
    "",
    "Read-only. Prints key names and short SHA-256 fingerprints, never secret values.",
  ].join("\n"));
  process.exit(error ? 1 : 0);
}

function readEnvFile(path) {
  const env = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    env[key] = unquote(line.slice(index + 1));
  }
  return env;
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
