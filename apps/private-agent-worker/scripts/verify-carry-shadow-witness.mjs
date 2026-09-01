#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attestCarryReleaseSourceTree } from "../../../scripts/carry-source-tree-attestation.mjs";
import { CARRY_RELEASE_FILES } from "../../web/scripts/check-carry-execution-contract.mjs";
import { verifyCarryShadowDevelopmentWitness } from "../src/execution/carry-shadow-development-witness.js";
import { sourceRevision } from "./verify-carry-shadow.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function verifyCarryShadowWitnessFile(path, {
  now_ms: nowMs = Date.now(),
  source_revision: expectedSourceRevision,
  source_tree_digest: expectedSourceTreeDigest,
} = {}) {
  const witness = JSON.parse(readFileSync(resolve(path), "utf8"));
  return verifyCarryShadowDevelopmentWitness(witness, {
    now_ms: nowMs,
    source_revision: expectedSourceRevision,
    source_tree_digest: expectedSourceTreeDigest,
  });
}

function main() {
  const path = process.argv[2] || process.env.GHOLA_CARRY_SHADOW_WITNESS_PATH;
  if (!path) throw new Error("carry shadow witness path is required");
  const sourceTree = attestCarryReleaseSourceTree({
    repoRoot: REPO_ROOT,
    releaseFiles: Object.values(CARRY_RELEASE_FILES),
    expectedRevision: sourceRevision(process.env),
  });
  const result = verifyCarryShadowWitnessFile(path, {
    source_revision: sourceTree.source_revision,
    source_tree_digest: sourceTree.source_tree_digest,
  });
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
