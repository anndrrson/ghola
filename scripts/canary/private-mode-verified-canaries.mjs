#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const baseUrl = trimTrailingSlash(process.env.GHOLA_BASE_URL || "http://localhost:3000");
const token = process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN || "";
const payloadPath = process.argv[2] || process.env.GHOLA_PRIVATE_MODE_CANARY_PAYLOAD_FILE || "";

function fail(message, detail) {
  console.error(`[private-mode-canary] ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function usage() {
  console.error(
    "usage: GHOLA_BASE_URL=https://ghola.xyz GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN=... " +
      "node scripts/canary/private-mode-verified-canaries.mjs ./canaries.json",
  );
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

async function readPayload(path) {
  if (!path) {
    usage();
    fail("set a payload path argument or GHOLA_PRIVATE_MODE_CANARY_PAYLOAD_FILE");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`could not read canary payload: ${path}`, String(error));
  }
  return Array.isArray(parsed) ? { canaries: parsed } : parsed;
}

if (!token.trim()) {
  usage();
  fail("GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN is required");
}

const payload = await readPayload(payloadPath);
const response = await fetch(`${baseUrl}/v1/private-account/canaries/run`, {
  method: "POST",
  headers: {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(payload),
}).catch((error) => fail("canary request failed", String(error)));

const text = await response.text();
let body = null;
try {
  body = text ? JSON.parse(text) : null;
} catch {
  fail("canary endpoint returned non-JSON", text.slice(0, 1_000));
}

if (!response.ok) {
  fail(`canary endpoint returned HTTP ${response.status}`, text);
}
if (body?.status !== "green") {
  fail("private mode canaries are not green", JSON.stringify(body, null, 2));
}
if (!Array.isArray(body.canaries) || body.canaries.some((item) => item.status !== "green")) {
  fail("canary response did not include all green canaries", JSON.stringify(body, null, 2));
}

console.log(
  `[private-mode-canary] passed checked_at=${body.checked_at} ` +
    `canaries=${body.canaries.map((item) => item.canary_kind).join(",")}`,
);
