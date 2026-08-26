#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { fetchCorePerpShadowSet } from "../src/execution/perp-shadow-adapters.js";
import {
  DEFAULT_CARRY_SHADOW_ASSETS,
  verifyCarryShadowSet,
} from "../src/execution/perp-shadow-readiness.js";

export { DEFAULT_CARRY_SHADOW_ASSETS, verifyCarryShadowSet };

async function main() {
  const assets = process.env.GHOLA_CARRY_SHADOW_ASSETS
    ? process.env.GHOLA_CARRY_SHADOW_ASSETS.split(",").map((asset) => asset.trim()).filter(Boolean)
    : DEFAULT_CARRY_SHADOW_ASSETS;
  const nowMs = Date.now();
  const rows = await fetchCorePerpShadowSet({ assets, now_ms: nowMs, timeout_ms: 8_000 });
  const result = verifyCarryShadowSet(rows, { assets, now_ms: nowMs });
  console.log(JSON.stringify({ version: 1, kind: "ghola_carry_shadow_verification", ...result }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
