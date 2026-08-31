#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCarryShadowDevelopmentWitness } from "../src/execution/carry-shadow-development-witness.js";
import { fetchCorePerpShadowSet } from "../src/execution/perp-shadow-adapters.js";
import {
  DEFAULT_CARRY_SHADOW_ASSETS,
  verifyCarryShadowSet,
  verifyCarryShadowSoak,
} from "../src/execution/perp-shadow-readiness.js";

export { DEFAULT_CARRY_SHADOW_ASSETS, verifyCarryShadowSet, verifyCarryShadowSoak };

async function main() {
  const assets = process.env.GHOLA_CARRY_SHADOW_ASSETS
    ? process.env.GHOLA_CARRY_SHADOW_ASSETS.split(",").map((asset) => asset.trim()).filter(Boolean)
    : DEFAULT_CARRY_SHADOW_ASSETS;
  const sampleCount = positiveInteger(process.env.GHOLA_CARRY_SHADOW_SAMPLES, 3);
  const minimumSpanMs = nonNegativeInteger(process.env.GHOLA_CARRY_SHADOW_MINIMUM_SPAN_MS, 120_000);
  const intervalMs = nonNegativeInteger(
    process.env.GHOLA_CARRY_SHADOW_INTERVAL_MS,
    sampleCount > 1 ? Math.ceil(minimumSpanMs / (sampleCount - 1)) : 0,
  );
  const sampleResults = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const observedAtMs = Date.now();
    const rows = await fetchCorePerpShadowSet({ assets, now_ms: observedAtMs, timeout_ms: 8_000 });
    sampleResults.push(verifyCarryShadowSet(rows, { assets, now_ms: Date.now() }));
    if (index + 1 < sampleCount && intervalMs > 0) await delay(intervalMs);
  }
  const result = verifyCarryShadowSoak(sampleResults, {
    required_samples: sampleCount,
    minimum_span_ms: minimumSpanMs,
  });
  const verification = {
    version: 1,
    kind: "ghola_carry_shadow_soak_verification",
    transaction_broadcast: false,
    ...result,
    sample_results: sampleResults,
  };
  const witnessPath = String(process.env.GHOLA_CARRY_SHADOW_WITNESS_PATH || "").trim();
  if (witnessPath) {
    const witness = buildCarryShadowDevelopmentWitness({
      sample_results: sampleResults,
      required_samples: sampleCount,
      minimum_span_ms: minimumSpanMs,
      source_revision: sourceRevision(process.env),
      created_at_ms: Date.now(),
    });
    writeWitness(witnessPath, witness);
    console.log(JSON.stringify(witness, null, 2));
  } else {
    console.log(JSON.stringify(verification, null, 2));
  }
  if (!result.ok) process.exitCode = 1;
}

export function sourceRevision(env = process.env) {
  const configured = String(env.GHOLA_SOURCE_REVISION || env.GITHUB_SHA || env.VERCEL_GIT_COMMIT_SHA || "").trim();
  if (/^[0-9a-f]{40}$/i.test(configured)) return configured.toLowerCase();
  if (/^[0-9a-f]{7,39}$/i.test(configured)) {
    return discoveredSourceRevision(configured) || configured.toLowerCase();
  }
  const discovered = discoveredSourceRevision("HEAD");
  if (!discovered) throw new Error("source revision is unavailable");
  return discovered;
}

function discoveredSourceRevision(reference) {
  try {
    const discovered = String(execFileSync("git", ["rev-parse", "--verify", `${reference}^{commit}`], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
    return /^[0-9a-f]{40}$/i.test(discovered) ? discovered.toLowerCase() : null;
  } catch {
    return null;
  }
}

function writeWitness(path, witness) {
  const destination = resolve(path);
  const temporary = `${destination}.${process.pid}.tmp`;
  mkdirSync(dirname(destination), { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(witness, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 2 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
