export function hasProvenLiveOrderBroadcast(proof) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  if (proof.broadcast_performed === true) return true;
  return proof.broadcast_performed === false
    && proof.query_broadcast === false
    && proof.original_order_target_matched === true
    && proof.original_order_broadcast_proven === true;
}
