#!/usr/bin/env node
import { pathToFileURL } from "node:url";
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
  console.log(JSON.stringify({
    version: 1,
    kind: "ghola_carry_shadow_soak_verification",
    ...result,
    sample_results: sampleResults,
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
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
