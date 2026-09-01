import assert from "node:assert/strict";
import test from "node:test";
import { hasProvenLiveOrderBroadcast } from "../src/execution/order-broadcast-proof.js";

test("accepts direct broadcast or exact read-only reconciliation of the original order", () => {
  assert.equal(hasProvenLiveOrderBroadcast({ broadcast_performed: true }), true);
  assert.equal(hasProvenLiveOrderBroadcast({
    broadcast_performed: false,
    query_broadcast: false,
    original_order_target_matched: true,
    original_order_broadcast_proven: true,
  }), true);
});

test("rejects unbound or mutating reconciliation claims", () => {
  const exact = {
    broadcast_performed: false,
    query_broadcast: false,
    original_order_target_matched: true,
    original_order_broadcast_proven: true,
  };
  for (const field of ["original_order_target_matched", "original_order_broadcast_proven"]) {
    assert.equal(hasProvenLiveOrderBroadcast({ ...exact, [field]: false }), false);
  }
  assert.equal(hasProvenLiveOrderBroadcast({ ...exact, query_broadcast: true }), false);
  assert.equal(hasProvenLiveOrderBroadcast(null), false);
});
