import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCarryShadowDevelopmentWitness,
  verifyCarryShadowDevelopmentWitness,
} from "../src/execution/carry-shadow-development-witness.js";
import { verifyCarryShadowWitnessFile } from "../scripts/verify-carry-shadow-witness.mjs";
import { sourceRevision } from "../scripts/verify-carry-shadow.mjs";
import { carryShadowFixture } from "./carry-shadow-fixture.js";
import { verifyCarryShadowSet } from "../src/execution/perp-shadow-readiness.js";

const NOW = 1_800_000_000_000;
const REVISION = "a".repeat(40);
const SOURCE_TREE_DIGEST = `sha256:${"b".repeat(64)}`;

test("persists a capital-free five-venue witness without claiming execution readiness", () => {
  const witness = buildWitness();
  assert.equal(witness.release_bound, false);
  assert.equal(witness.worker_image_digest, null);
  assert.equal(witness.owner_accounts_bound, false);
  assert.equal(witness.no_submit_proven, false);
  assert.equal(witness.live_trading_proven, false);
  assert.equal(witness.ready_for_execution, false);
  assert.equal(witness.transaction_broadcast, false);
  assert.equal(witness.venues, 5);
  assert.equal(witness.assets, 3);
  assert.equal(witness.completed_samples, 3);
  assert.equal(witness.duration_ms, 120_000);
  assert.equal(witness.source_tree_digest, SOURCE_TREE_DIGEST);
  assert.match(witness.witness_commitment, /^carry:shadow:development:[0-9a-f]{64}$/);
  assert.equal(verifyCarryShadowDevelopmentWitness(witness, {
    now_ms: NOW + 120_000,
    source_revision: REVISION,
    source_tree_digest: SOURCE_TREE_DIGEST,
  }).ok, true);
});

test("rejects tampering and any attempt to promote a development witness", () => {
  const executionClaim = structuredClone(buildWitness());
  executionClaim.ready_for_execution = true;
  const executionResult = verifyCarryShadowDevelopmentWitness(executionClaim, { now_ms: NOW + 120_000 });
  assert.equal(executionResult.ok, false);
  assert.ok(executionResult.failures.includes("witness_execution_claim_forbidden"));
  assert.ok(executionResult.failures.includes("witness_commitment_mismatch"));

  const sampleTamper = structuredClone(buildWitness());
  sampleTamper.sample_results[0].snapshot_evidence[0].age_ms += 1;
  const sampleResult = verifyCarryShadowDevelopmentWitness(sampleTamper, { now_ms: NOW + 120_000 });
  assert.equal(sampleResult.ok, false);
  assert.ok(sampleResult.failures.includes("witness_soak_invalid"));
  assert.ok(sampleResult.failures.includes("witness_commitment_mismatch"));

  const revisionResult = verifyCarryShadowDevelopmentWitness(buildWitness(), {
    now_ms: NOW + 120_000,
    source_revision: "b".repeat(40),
  });
  assert.equal(revisionResult.ok, false);
  assert.ok(revisionResult.failures.includes("witness_source_revision_mismatch"));

  const digestResult = verifyCarryShadowDevelopmentWitness(buildWitness(), {
    now_ms: NOW + 120_000,
    source_tree_digest: `sha256:${"c".repeat(64)}`,
  });
  assert.equal(digestResult.ok, false);
  assert.ok(digestResult.failures.includes("witness_source_tree_digest_mismatch"));
});

test("independently verifies a persisted witness file", () => {
  const directory = mkdtempSync(join(tmpdir(), "ghola-shadow-witness-"));
  try {
    const path = join(directory, "witness.json");
    writeFileSync(path, JSON.stringify(buildWitness()));
    const result = verifyCarryShadowWitnessFile(path, {
      now_ms: NOW + 120_000,
      source_revision: REVISION,
      source_tree_digest: SOURCE_TREE_DIGEST,
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonicalizes a configured short source revision before witness binding", () => {
  const full = sourceRevision({});
  assert.equal(sourceRevision({ GHOLA_SOURCE_REVISION: full.slice(0, 8) }), full);
});

function buildWitness() {
  const sampleResults = [0, 1, 2].map((index) => {
    const nowMs = NOW + index * 60_000;
    return verifyCarryShadowSet(carryShadowFixture(nowMs), { now_ms: nowMs, max_age_ms: 60_000 });
  });
  return buildCarryShadowDevelopmentWitness({
    sample_results: sampleResults,
    required_samples: 3,
    minimum_span_ms: 120_000,
    source_revision: REVISION,
    source_tree_digest: SOURCE_TREE_DIGEST,
    created_at_ms: NOW + 120_000,
  });
}
