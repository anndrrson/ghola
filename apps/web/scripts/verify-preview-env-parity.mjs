#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const IGNORED_KEYS = new Set(["VERCEL_OIDC_TOKEN"]);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPAQUE_VALUE_RE = /^(?:\[(?:SENSITIVE|ENCRYPTED|REDACTED|HIDDEN|SECRET)\]|<REDACTED>|\*{3,})$/i;

export function isOpaqueVercelEnvValue(value) {
  let normalized = String(value ?? "").trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized === "" || OPAQUE_VALUE_RE.test(normalized);
}

export function assertMaterializedVercelEnvValue(key, value, context = "use") {
  if (!ENV_KEY_RE.test(String(key))) throw new Error("preview_env_key_invalid");
  if (isOpaqueVercelEnvValue(value)) {
    throw new Error(`preview_env_opaque:${key}:${context}`);
  }
  return String(value);
}

export function parseVercelEnv(serialized) {
  const env = {};
  for (const match of String(serialized).matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)) {
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        throw new Error(`preview_env_value_invalid:${match[1]}`);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/\\n/g, "\n");
    }
    if (Object.hasOwn(env, match[1])) {
      throw new Error(`preview_env_duplicate:${match[1]}`);
    }
    env[match[1]] = value;
  }
  return env;
}

export function verifyPreviewEnvParity(reference, candidate) {
  const referenceKeys = Object.keys(reference).filter((key) => !IGNORED_KEYS.has(key)).sort();
  const candidateKeys = Object.keys(candidate).filter((key) => !IGNORED_KEYS.has(key)).sort();
  const missing = referenceKeys.filter((key) => !(key in candidate));
  if (missing.length) throw new Error(`preview_env_missing:${missing.join(",")}`);

  const unexpected = candidateKeys.filter((key) => !(key in reference));
  if (unexpected.length) throw new Error(`preview_env_unexpected:${unexpected.join(",")}`);

  const opaque = referenceKeys.filter((key) =>
    isOpaqueVercelEnvValue(reference[key]) || isOpaqueVercelEnvValue(candidate[key]));
  if (opaque.length) throw new Error(`preview_env_parity_unprovable:${opaque.join(",")}`);

  const whitespaceDrift = referenceKeys.filter((key) =>
    reference[key] !== candidate[key] && reference[key].trim() === candidate[key].trim());
  if (whitespaceDrift.length) {
    throw new Error(`preview_env_whitespace_drift:${whitespaceDrift.join(",")}`);
  }

  const mismatch = referenceKeys.filter((key) => reference[key] !== candidate[key]);
  if (mismatch.length) throw new Error(`preview_env_value_mismatch:${mismatch.join(",")}`);

  return {
    reference_keys: referenceKeys.length,
    candidate_keys: candidateKeys.length,
    verified_value_keys: referenceKeys.length,
  };
}

export function buildPreviewEnvCopyPlan(source, keys) {
  const selectedKeys = normalizeKeyAllowlist(keys);
  const missing = selectedKeys.filter((key) => !Object.hasOwn(source, key));
  if (missing.length) throw new Error(`preview_env_copy_missing:${missing.join(",")}`);

  const opaque = selectedKeys.filter((key) => isOpaqueVercelEnvValue(source[key]));
  if (opaque.length) throw new Error(`preview_env_copy_opaque:${opaque.join(",")}`);

  return selectedKeys.map((key) => Object.freeze({ key, value: String(source[key]) }));
}

export async function copyVerifiedPreviewEnv({ source, keys, copy }) {
  if (typeof copy !== "function") throw new TypeError("preview_env_copy_callback_required");

  // Validate the complete allowlist before the first external write.
  const plan = buildPreviewEnvCopyPlan(source, keys);
  for (const entry of plan) await copy(entry);
  return {
    copied_keys: plan.length,
    keys: plan.map(({ key }) => key),
  };
}

function normalizeKeyAllowlist(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("preview_env_copy_allowlist_required");
  }
  const normalized = [...new Set(keys.map((key) => String(key).trim()).filter(Boolean))].sort();
  if (!normalized.length) throw new Error("preview_env_copy_allowlist_required");
  if (normalized.some((key) => !ENV_KEY_RE.test(key))) {
    throw new Error("preview_env_copy_key_invalid");
  }
  return normalized;
}

function main() {
  const [referencePath, candidatePath] = process.argv.slice(2);
  if (!referencePath || !candidatePath) {
    throw new Error("usage: verify-preview-env-parity <reference.env> <candidate.env>");
  }
  const result = verifyPreviewEnvParity(
    parseVercelEnv(readFileSync(referencePath, "utf8")),
    parseVercelEnv(readFileSync(candidatePath, "utf8")),
  );
  console.log(`[preview-env-parity] verified ${result.verified_value_keys} materialized values`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`[preview-env-parity] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
