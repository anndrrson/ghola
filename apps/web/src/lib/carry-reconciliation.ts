export function hasExactCarryFlatReconciliation(evidence: unknown, venueIds: readonly string[]) {
  if (!record(evidence)
    || evidence.account_state_checked !== true
    || evidence.transaction_broadcast !== false
    || evidence.gross_exposure_micro_usdc !== 0
    || evidence.open_order_count !== 0
    || !Number.isSafeInteger(evidence.checked_at_ms)
    || Number(evidence.checked_at_ms) <= 0
    || typeof evidence.reconciliation_commitment !== "string"
    || !evidence.reconciliation_commitment.startsWith("carry:reconciliation:")) return false;
  if (venueIds.length !== 2 || new Set(venueIds).size !== 2 || !Array.isArray(evidence.venues)) return false;
  const venues = evidence.venues.filter(record);
  if (venues.length !== venueIds.length || new Set(venues.map((item) => item.venue_id)).size !== venueIds.length) return false;
  return venueIds.every((venueId) => venues.some((item) => item.venue_id === venueId
    && item.authorized === true
    && item.flat_zero_orders === true
    && item.position_count === 0
    && item.open_order_count === 0
    && item.account_state_checked === true));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
