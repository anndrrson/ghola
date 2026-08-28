#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyCarryShadowDevelopmentWitness } from "../src/execution/carry-shadow-development-witness.js";
import { sourceRevision } from "./verify-carry-shadow.mjs";

export function verifyCarryShadowWitnessFile(path, {
  now_ms: nowMs = Date.now(),
  source_revision: expectedSourceRevision,
} = {}) {
  const witness = JSON.parse(readFileSync(resolve(path), "utf8"));
  return verifyCarryShadowDevelopmentWitness(witness, {
    now_ms: nowMs,
    source_revision: expectedSourceRevision,
  });
}

function main() {
  const path = process.argv[2] || process.env.GHOLA_CARRY_SHADOW_WITNESS_PATH;
  if (!path) throw new Error("carry shadow witness path is required");
  const result = verifyCarryShadowWitnessFile(path, { source_revision: sourceRevision(process.env) });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    process.exitCode = 1;
  }
}
