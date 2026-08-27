import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadCarryTransferRouteEvidence,
  storeCarryTransferRouteEvidence,
  verifyCarryTransferRouteEvidence,
} from "../src/execution/carry-transfer-routes.js";
import { createWorkerState } from "../src/state/private-state.js";

const NOW = 1_800_000_000_000;
const OWNER = "owner:commitment:0001";

test("stores only commitment-backed worker transfer-route evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-transfer-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const evidence = await storeCarryTransferRouteEvidence({
    state,
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"a".repeat(64)}`,
    routes: [route()],
    checked_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
    now_ms: NOW,
  });
  assert.match(evidence.evidence_commitment, /^carry:transfer-routes:evidence:/);
  assert.equal(evidence.transaction_broadcast, false);
  assert.equal(evidence.fund_movement_authorized, false);

  const loaded = await loadCarryTransferRouteEvidence({
    state: createWorkerState(dir),
    owner_commitment: OWNER,
    now_ms: NOW + 1_000,
    max_data_age_ms: 30_000,
    expected_worker_image_digest: evidence.worker_image_digest,
  });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.routes.length, 1);
  assert.equal(loaded.routes[0].evidence_source, "attested_worker");
  assert.equal(loaded.routes[0].evidence_commitment, evidence.evidence_commitment);
  assert.equal(loaded.routes[0].worker_image_digest, evidence.worker_image_digest);
});

test("rejects tampered, stale, and registry-mismatched transfer routes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-transfer-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const evidence = await storeCarryTransferRouteEvidence({
    state,
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"b".repeat(64)}`,
    routes: [route()],
    checked_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
    now_ms: NOW,
  });
  assert.deepEqual(verifyCarryTransferRouteEvidence({
    ...evidence,
    routes: [{ ...evidence.routes[0], fee_micro_usdc: 99 }],
  }), {
    ok: false,
    error: "carry_transfer_route_commitment_invalid",
    routes: [],
    transaction_broadcast: false,
    fund_movement_authorized: false,
  });
  const imageMismatch = await loadCarryTransferRouteEvidence({
    state,
    owner_commitment: OWNER,
    now_ms: NOW + 1_000,
    max_data_age_ms: 30_000,
    expected_worker_image_digest: `sha256:${"c".repeat(64)}`,
  });
  assert.equal(imageMismatch.error, "carry_transfer_route_worker_image_mismatch");
  const stale = await loadCarryTransferRouteEvidence({
    state,
    owner_commitment: OWNER,
    now_ms: NOW + 31_000,
    max_data_age_ms: 30_000,
    expected_worker_image_digest: evidence.worker_image_digest,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "carry_transfer_route_evidence_stale");
  await assert.rejects(() => storeCarryTransferRouteEvidence({
    state,
    owner_commitment: OWNER,
    worker_image_digest: `sha256:${"c".repeat(64)}`,
    routes: [route({ source_adapter_id: "spoofed_adapter" })],
    checked_at_ms: NOW,
    expires_at_ms: NOW + 30_000,
    now_ms: NOW,
  }), /carry_transfer_route_adapter_binding_invalid/);
});

function route(overrides = {}) {
  return {
    version: 1,
    route_id: "carry:transfer-route:lighter-hyperliquid:0001",
    from_account_commitment: "account:lighter:0001",
    from_venue_id: "lighter",
    to_account_commitment: "account:hyperliquid:0001",
    to_venue_id: "hyperliquid",
    source_adapter_id: "lighter_v1",
    destination_adapter_id: "hyperliquid_v1",
    source_account_state_commitment: "carry:account-state:lighter:0001",
    destination_account_state_commitment: "carry:account-state:hyperliquid:0001",
    quote_commitment: "carry:transfer-quote:0001",
    settlement_asset: "USDC",
    status: "available",
    minimum_transfer_micro_usdc: 0,
    maximum_transfer_micro_usdc: 100_000_000,
    fee_micro_usdc: 1_000,
    estimated_latency_ms: 60_000,
    as_of_ms: NOW,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    ...overrides,
  };
}
