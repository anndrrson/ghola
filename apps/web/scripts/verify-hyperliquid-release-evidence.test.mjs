import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_EVIDENCE_PATH,
  evidenceCommitment,
  verifyHyperliquidReleaseEvidence,
} from "./verify-hyperliquid-release-evidence.mjs";

const fixture = JSON.parse(readFileSync(DEFAULT_EVIDENCE_PATH, "utf8"));

test("accepts the committed mainnet round-trip proof", () => {
  assert.equal(verifyHyperliquidReleaseEvidence(fixture).ok, true);
});

test("rejects a proof without an exact reduce-only close", () => {
  const changed = structuredClone(fixture);
  changed.close.reduce_only = false;
  changed.evidence_commitment = evidenceCommitment(changed);
  assert.throws(
    () => verifyHyperliquidReleaseEvidence(changed),
    /close_reduce_only_required/,
  );
});

test("rejects a proof that does not end flat and clear", () => {
  const changed = structuredClone(fixture);
  changed.final_venue_state.open_orders = 1;
  changed.evidence_commitment = evidenceCommitment(changed);
  assert.throws(
    () => verifyHyperliquidReleaseEvidence(changed),
    /final_open_orders_not_zero/,
  );
});

test("rejects tampered evidence", () => {
  const changed = structuredClone(fixture);
  changed.protection.trigger_price_usd = 75;
  assert.throws(
    () => verifyHyperliquidReleaseEvidence(changed),
    /stop_price_mismatch|evidence_commitment_mismatch/,
  );
});
