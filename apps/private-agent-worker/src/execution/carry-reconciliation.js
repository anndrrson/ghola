export function assessCarryFlatReconciliation({ evidence, venue_ids: venueIds }) {
  const reasons = [];
  const pair = Array.isArray(venueIds) ? venueIds.map(String) : [];
  if (pair.length !== 2 || new Set(pair).size !== 2 || pair.some((venueId) => !identifier(venueId))) {
    reasons.push("carry_reconciliation_pair_invalid");
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return result(false, ["carry_reconciliation_evidence_missing", ...reasons]);
  }
  if (evidence.account_state_checked !== true) reasons.push("carry_reconciliation_account_unchecked");
  if (evidence.transaction_broadcast !== false) reasons.push("carry_reconciliation_broadcast_unsafe");
  if (evidence.gross_exposure_micro_usdc !== 0) reasons.push("carry_reconciliation_exposure_nonzero");
  if (evidence.open_order_count !== 0) reasons.push("carry_reconciliation_orders_nonzero");
  if (!Number.isSafeInteger(evidence.checked_at_ms) || evidence.checked_at_ms <= 0) reasons.push("carry_reconciliation_timestamp_invalid");
  if (!commitment(evidence.reconciliation_commitment)) reasons.push("carry_reconciliation_commitment_invalid");

  const values = Array.isArray(evidence.venues) ? evidence.venues : [];
  if (values.length !== pair.length) reasons.push("carry_reconciliation_venue_count_invalid");
  const venueIdsSeen = values.map((item) => String(item?.venue_id || ""));
  if (new Set(venueIdsSeen).size !== values.length || pair.some((venueId) => !venueIdsSeen.includes(venueId))) {
    reasons.push("carry_reconciliation_venue_set_invalid");
  }
  for (const venueId of pair) {
    const matching = values.filter((item) => item?.venue_id === venueId);
    if (matching.length !== 1) {
      reasons.push(`carry_reconciliation_venue_missing:${venueId}`);
      continue;
    }
    const item = matching[0];
    if (item.authorized !== true) reasons.push(`carry_reconciliation_venue_unauthorized:${venueId}`);
    if (item.account_state_checked !== true) reasons.push(`carry_reconciliation_venue_unchecked:${venueId}`);
    if (item.flat_zero_orders !== true) reasons.push(`carry_reconciliation_venue_flat_unproven:${venueId}`);
    if (item.position_count !== 0) reasons.push(`carry_reconciliation_venue_position_nonzero:${venueId}`);
    if (item.open_order_count !== 0) reasons.push(`carry_reconciliation_venue_orders_nonzero:${venueId}`);
  }
  return result(reasons.length === 0, reasons, {
    venues: pair.map((venueId) => values.find((item) => item?.venue_id === venueId)).filter(Boolean),
  });
}

export function hasExactCarryFlatReconciliation(evidence, venueIds) {
  return assessCarryFlatReconciliation({ evidence, venue_ids: venueIds }).flat;
}

function result(flat, reasons, extra = {}) {
  return Object.freeze({
    flat,
    reasons: Object.freeze([...new Set(reasons)]),
    ...extra,
  });
}

function identifier(value) {
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(String(value || ""));
}

function commitment(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{8,180}$/.test(value);
}
