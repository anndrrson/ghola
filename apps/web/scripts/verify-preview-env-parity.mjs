#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const IGNORED_KEYS = new Set(["VERCEL_OIDC_TOKEN"]);

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

  const whitespaceDrift = referenceKeys.filter((key) =>
    reference[key] !== candidate[key] && reference[key].trim() === candidate[key].trim());
  if (whitespaceDrift.length) {
    throw new Error(`preview_env_whitespace_drift:${whitespaceDrift.join(",")}`);
  }

  const mismatch = referenceKeys.filter((key) =>
    reference[key] !== "" && reference[key] !== candidate[key]);
  if (mismatch.length) throw new Error(`preview_env_value_mismatch:${mismatch.join(",")}`);

  return {
    reference_keys: referenceKeys.length,
    candidate_keys: candidateKeys.length,
    opaque_keys: referenceKeys.filter((key) => reference[key] === "").length,
  };
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
  console.log(`[preview-env-parity] verified ${result.candidate_keys} effective keys (${result.opaque_keys} opaque)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`[preview-env-parity] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
