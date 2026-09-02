import { createHash } from "node:crypto";
import {
  carryInventoryPositionIdentityCommitment,
  validCarryInventoryExpectation,
  validCarryInventoryEvidence,
} from "./carry-inventory.js";

export function assessCarryFlatReconciliation({
  evidence,
  venue_ids: venueIds,
  owner_commitment: expectedOwnerCommitment = null,
  carry_position_id: expectedPositionId = null,
  account_commitments: expectedAccountCommitments = null,
  inventory_expectations: expectedInventoryExpectations = null,
}) {
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
  if (!commitment(evidence.owner_commitment)) reasons.push("carry_reconciliation_owner_binding_invalid");
  if (expectedOwnerCommitment && evidence.owner_commitment !== expectedOwnerCommitment) reasons.push("carry_reconciliation_owner_binding_mismatch");
  if (!commitment(evidence.carry_position_id)) reasons.push("carry_reconciliation_position_binding_invalid");
  if (expectedPositionId && evidence.carry_position_id !== expectedPositionId) reasons.push("carry_reconciliation_position_binding_mismatch");
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
    if (!commitment(item.account_commitment)) reasons.push(`carry_reconciliation_account_binding_invalid:${venueId}`);
    const expectedAccountCommitment = expectedAccountCommitments?.[venueId];
    if (expectedAccountCommitments && !commitment(expectedAccountCommitment)) reasons.push(`carry_reconciliation_expected_account_missing:${venueId}`);
    if (expectedAccountCommitment && item.account_commitment !== expectedAccountCommitment) reasons.push(`carry_reconciliation_account_binding_mismatch:${venueId}`);
    if (item.authorized !== true) reasons.push(`carry_reconciliation_venue_unauthorized:${venueId}`);
    if (item.account_state_checked !== true) reasons.push(`carry_reconciliation_venue_unchecked:${venueId}`);
    if (item.flat_zero_orders !== true) reasons.push(`carry_reconciliation_venue_flat_unproven:${venueId}`);
    if (item.position_count !== 0) reasons.push(`carry_reconciliation_venue_position_nonzero:${venueId}`);
    if (item.open_order_count !== 0) reasons.push(`carry_reconciliation_venue_orders_nonzero:${venueId}`);
    const inventory = item.inventory;
    if (!validCarryInventoryEvidence(inventory, {
      venue_id: venueId,
      account_commitment: item.account_commitment,
    })) {
      reasons.push(`carry_reconciliation_inventory_invalid:${venueId}`);
      continue;
    }
    if (inventory.position_inventory_verified !== true) reasons.push(`carry_reconciliation_positions_unverified:${venueId}`);
    if (inventory.open_order_inventory_verified !== true) reasons.push(`carry_reconciliation_orders_unverified:${venueId}`);
    if (inventory.target_positions.length !== 0) reasons.push(`carry_reconciliation_target_position_nonzero:${venueId}`);
    if (inventory.target_open_orders.length !== 0) reasons.push(`carry_reconciliation_target_orders_nonzero:${venueId}`);
    const positionIdentity = carryInventoryPositionIdentityCommitment({
      venue_id: venueId,
      account_commitment: item.account_commitment,
      market: inventory.target_market,
    });
    if (!commitment(item.position_identity_commitment)
      || item.position_identity_commitment !== positionIdentity) {
      reasons.push(`carry_reconciliation_inventory_binding_invalid:${venueId}`);
    }
    const expectedInventory = expectedInventoryExpectations?.[venueId];
    if (expectedInventoryExpectations && !validCarryInventoryExpectation(expectedInventory, {
      venue_id: venueId,
      account_commitment: item.account_commitment,
    })) {
      reasons.push(`carry_reconciliation_expected_inventory_missing:${venueId}`);
    } else if (expectedInventory) {
      if (expectedInventory.venue_id !== venueId
        || expectedInventory.account_commitment !== item.account_commitment
        || expectedInventory.market !== inventory.target_market
        || expectedInventory.position_identity_commitment !== item.position_identity_commitment
        || expectedInventory.position_identity_commitment !== carryInventoryPositionIdentityCommitment(expectedInventory)) {
        reasons.push(`carry_reconciliation_inventory_binding_mismatch:${venueId}`);
      }
    }
  }
  const expectedReconciliationCommitment = carryReconciliationCommitment(evidence);
  if (evidence.reconciliation_commitment !== expectedReconciliationCommitment) {
    reasons.push("carry_reconciliation_commitment_mismatch");
  }
  return result(reasons.length === 0, reasons, {
    venues: pair.map((venueId) => values.find((item) => item?.venue_id === venueId)).filter(Boolean),
  });
}

export function carryReconciliationCommitment(evidence) {
  return `carry:reconciliation:${createHash("sha256")
    .update(stableJson(reconciliationMaterial(evidence)))
    .digest("hex")
    .slice(0, 40)}`;
}

export function hasExactCarryFlatReconciliation(evidence, venueIds, expected = {}) {
  return assessCarryFlatReconciliation({ evidence, venue_ids: venueIds, ...expected }).flat;
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

function reconciliationMaterial(evidence) {
  const values = Array.isArray(evidence?.venues) ? evidence.venues : [];
  return {
    version: 1,
    owner_commitment: evidence?.owner_commitment,
    carry_position_id: evidence?.carry_position_id,
    gross_exposure_micro_usdc: evidence?.gross_exposure_micro_usdc,
    open_order_count: evidence?.open_order_count,
    account_state_checked: evidence?.account_state_checked,
    transaction_broadcast: evidence?.transaction_broadcast,
    checked_at_ms: evidence?.checked_at_ms,
    venues: values.map((item) => ({
      venue_id: item?.venue_id,
      account_commitment: item?.account_commitment,
      authorized: item?.authorized,
      flat_zero_orders: item?.flat_zero_orders,
      position_count: item?.position_count,
      open_order_count: item?.open_order_count,
      account_state_checked: item?.account_state_checked,
      position_identity_commitment: item?.position_identity_commitment,
      inventory: item?.inventory,
    })).sort((left, right) => String(left.venue_id).localeCompare(String(right.venue_id))),
  };
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
