import { createHash } from "node:crypto";

const COMMITMENT = /^[A-Za-z0-9:_-]{8,180}$/;
const VENUE = /^[a-z][a-z0-9_-]{2,31}$/;
const MARKET = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;
const CLIENT_ORDER_IDENTITY = /^carry:inventory-client-order:[0-9a-f]{40}$/;
const PROVIDER_ORDER_IDENTITY = /^carry:inventory-provider-order:[0-9a-f]{40}$/;

export function canonicalCarryPositiveDecimal(value) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = String(match[2] || "").replace(/0+$/, "");
  if (!/[1-9]/.test(`${whole}${fraction}`)) return null;
  return fraction ? `${whole}.${fraction}` : whole;
}

export function carryInventoryPositionIdentityCommitment({ venue_id, account_commitment, market } = {}) {
  const material = {
    venue_id: String(venue_id || ""),
    account_commitment: String(account_commitment || ""),
    market: canonicalMarket(market),
  };
  return `carry:inventory-position:${digest(stableJson(material)).slice(0, 40)}`;
}

export function carryInventoryClientOrderIdentityCommitment({ venue_id: venueId, client_order_id: clientOrderId } = {}) {
  const normalizedClientOrderId = String(clientOrderId ?? "").trim().toLowerCase();
  if (!VENUE.test(String(venueId || ""))
    || !/^[a-z0-9:_-]{1,180}$/.test(normalizedClientOrderId)) return null;
  return `carry:inventory-client-order:${digest(stableJson({
    venue_id: String(venueId),
    client_order_id: normalizedClientOrderId,
  })).slice(0, 40)}`;
}

export function carryInventoryProviderOrderIdentityCommitment({ venue_id: venueId, provider_order_id: providerOrderId } = {}) {
  const normalizedProviderOrderId = String(providerOrderId ?? "").trim().toLowerCase();
  if (!VENUE.test(String(venueId || ""))
    || !/^[a-z0-9._:-]{1,180}$/.test(normalizedProviderOrderId)) return null;
  return `carry:inventory-provider-order:${digest(stableJson({
    venue_id: String(venueId),
    provider_order_id: normalizedProviderOrderId,
  })).slice(0, 40)}`;
}

export function carryInventoryExpectation({
  venue_id: venueId,
  account_commitment: accountCommitment,
  market,
  side,
  base_size: baseSize,
  entry_work_order_commitment: entryWorkOrderCommitment,
  entry_provider_ref_commitment: entryProviderRefCommitment,
  entry_client_order_identity_commitment: entryClientOrderIdentityCommitment = null,
  entry_provider_order_identity_commitment: entryProviderOrderIdentityCommitment = null,
} = {}) {
  const targetMarket = canonicalMarket(market);
  const positionSide = canonicalPositionSide(side);
  const canonicalBaseSize = canonicalCarryPositiveDecimal(baseSize);
  if (!targetMarket || !positionSide || !canonicalBaseSize
    || !VENUE.test(String(venueId || ""))
    || !COMMITMENT.test(String(accountCommitment || ""))
    || !COMMITMENT.test(String(entryWorkOrderCommitment || ""))
    || !COMMITMENT.test(String(entryProviderRefCommitment || ""))
    || (entryClientOrderIdentityCommitment !== null
      && !CLIENT_ORDER_IDENTITY.test(String(entryClientOrderIdentityCommitment)))
    || (entryProviderOrderIdentityCommitment !== null
      && !PROVIDER_ORDER_IDENTITY.test(String(entryProviderOrderIdentityCommitment)))) return null;
  return Object.freeze({
    version: 1,
    venue_id: String(venueId),
    account_commitment: String(accountCommitment),
    market: targetMarket,
    side: positionSide,
    base_size: canonicalBaseSize,
    position_identity_commitment: carryInventoryPositionIdentityCommitment({
      venue_id: venueId,
      account_commitment: accountCommitment,
      market: targetMarket,
    }),
    entry_work_order_commitment: String(entryWorkOrderCommitment),
    entry_provider_ref_commitment: String(entryProviderRefCommitment),
    entry_client_order_identity_commitment: entryClientOrderIdentityCommitment === null
      ? null
      : String(entryClientOrderIdentityCommitment),
    entry_provider_order_identity_commitment: entryProviderOrderIdentityCommitment === null
      ? null
      : String(entryProviderOrderIdentityCommitment),
    expected_carry_open_order_count: 0,
  });
}

export function validCarryInventoryExpectation(value, { venue_id: venueId, account_commitment: accountCommitment } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1
    || value.venue_id !== venueId
    || value.account_commitment !== accountCommitment
    || value.expected_carry_open_order_count !== 0) return false;
  const rebuilt = carryInventoryExpectation(value);
  return rebuilt !== null && stableJson(rebuilt) === stableJson(value);
}

export function buildCarryInventoryEvidence({
  venue_id: venueId,
  account_commitment: accountCommitment,
  target_market: targetMarketInput,
  positions,
  open_orders: openOrders,
  position_inventory_verified: positionInventoryVerified,
  open_order_inventory_verified: openOrderInventoryVerified,
} = {}) {
  const targetMarket = canonicalMarket(targetMarketInput);
  const normalizedPositions = normalizeRows(positions, (row) => normalizePosition({
    row, venueId, accountCommitment,
  }));
  const normalizedOrders = normalizeRows(openOrders, normalizeOrder);
  const targetPositions = targetMarket
    ? normalizedPositions.rows.filter((row) => row.market === targetMarket)
    : [];
  const targetOpenOrders = targetMarket
    ? normalizedOrders.rows.filter((row) => row.market === targetMarket)
    : [];
  return Object.freeze({
    version: 1,
    target_market: targetMarket,
    position_inventory_verified: positionInventoryVerified === true && normalizedPositions.valid && Boolean(targetMarket),
    open_order_inventory_verified: openOrderInventoryVerified === true && normalizedOrders.valid && Boolean(targetMarket),
    target_positions: Object.freeze(targetPositions),
    target_open_orders: Object.freeze(targetOpenOrders),
  });
}

export function validCarryInventoryEvidence(value, { venue_id: venueId, account_commitment: accountCommitment } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
    || typeof value.position_inventory_verified !== "boolean"
    || typeof value.open_order_inventory_verified !== "boolean"
    || !Array.isArray(value.target_positions)
    || !Array.isArray(value.target_open_orders)) return false;
  const rebuilt = buildCarryInventoryEvidence({
    venue_id: venueId,
    account_commitment: accountCommitment,
    target_market: value.target_market,
    positions: value.target_positions,
    open_orders: value.target_open_orders,
    position_inventory_verified: value.position_inventory_verified,
    open_order_inventory_verified: value.open_order_inventory_verified,
  });
  return stableJson(rebuilt) === stableJson(value);
}

export function validateCarryInventoryBinding({ account_state: state, expectation } = {}) {
  if (!state || !validCarryInventoryExpectation(expectation, {
    venue_id: state?.venue_id,
    account_commitment: state?.account_commitment,
  }) || state.inventory?.version !== 1) return ambiguous("binding_missing");
  const inventory = state.inventory;
  if (expectation.venue_id !== state.venue_id
    || expectation.account_commitment !== state.account_commitment
    || inventory.target_market !== expectation.market
    || expectation.position_identity_commitment !== carryInventoryPositionIdentityCommitment(expectation)) {
    return ambiguous("binding_mismatch");
  }
  if (inventory.position_inventory_verified !== true) return ambiguous("positions_unverified");
  if (inventory.open_order_inventory_verified !== true) return ambiguous("orders_unverified");
  if (!Array.isArray(inventory.target_positions) || !Array.isArray(inventory.target_open_orders)) {
    return ambiguous("records_invalid");
  }
  const positions = inventory.target_positions.map((row) => normalizePosition({
    row,
    venueId: state.venue_id,
    accountCommitment: state.account_commitment,
  }));
  if (positions.some((row) => row === null)) return ambiguous("position_invalid");
  if (positions.length === 0) return drift("target_position_missing");
  if (positions.length !== 1) return drift("target_position_not_unique");
  const target = positions[0];
  if (target.position_identity_commitment !== expectation.position_identity_commitment) {
    return ambiguous("position_identity_unbound");
  }
  if (target.side !== expectation.side) return drift("target_position_side_drift");
  if (target.base_size !== expectation.base_size) return drift("target_position_size_drift");

  const orders = inventory.target_open_orders.map(normalizeOrder);
  if (orders.some((row) => row === null)) return ambiguous("order_invalid");
  const ownedOrders = orders.filter((row) => carryOrderOwnedByExpectation(row, expectation));
  if (ownedOrders.length > expectation.expected_carry_open_order_count) {
    return drift("carry_order_remains_open");
  }
  if (orders.length > ownedOrders.length) return ambiguous("target_market_order_unbound");
  return Object.freeze({ ok: true, disposition: "matched", reason: null });
}

export function inspectCarryInventoryForRecovery({ account_state: state, expectation } = {}) {
  if (!state || !validCarryInventoryExpectation(expectation, {
    venue_id: state?.venue_id,
    account_commitment: state?.account_commitment,
  }) || state.inventory?.version !== 1) return ambiguous("binding_missing");
  const inventory = state.inventory;
  if (expectation.venue_id !== state.venue_id
    || expectation.account_commitment !== state.account_commitment
    || inventory.target_market !== expectation.market
    || expectation.position_identity_commitment !== carryInventoryPositionIdentityCommitment(expectation)) {
    return ambiguous("binding_mismatch");
  }
  if (inventory.position_inventory_verified !== true) return ambiguous("positions_unverified");
  if (inventory.open_order_inventory_verified !== true) return ambiguous("orders_unverified");
  if (!Array.isArray(inventory.target_positions) || !Array.isArray(inventory.target_open_orders)) {
    return ambiguous("records_invalid");
  }
  const positions = inventory.target_positions.map((row) => normalizePosition({
    row,
    venueId: state.venue_id,
    accountCommitment: state.account_commitment,
  }));
  if (positions.some((row) => row === null)) return ambiguous("position_invalid");
  if (positions.length > 1) return ambiguous("target_position_not_unique");
  if (positions.length === 1
    && positions[0].position_identity_commitment !== expectation.position_identity_commitment) {
    return ambiguous("position_identity_unbound");
  }
  const orders = inventory.target_open_orders.map(normalizeOrder);
  if (orders.some((row) => row === null)) return ambiguous("order_invalid");
  const ownedOrders = orders.filter((row) => carryOrderOwnedByExpectation(row, expectation));
  if (orders.length !== ownedOrders.length) return ambiguous("target_market_order_unbound");
  if (ownedOrders.length > 1) return ambiguous("carry_order_not_unique");
  return Object.freeze({
    ok: true,
    disposition: "proven",
    reason: null,
    position: positions[0] || null,
    owned_open_orders: Object.freeze(ownedOrders),
  });
}

function normalizeRows(value, normalizer) {
  if (!Array.isArray(value)) return { valid: false, rows: [] };
  const rows = value.map(normalizer);
  return rows.some((row) => row === null)
    ? { valid: false, rows: rows.filter(Boolean) }
    : { valid: true, rows };
}

function normalizePosition({ row, venueId, accountCommitment }) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const market = canonicalMarket(row.market);
  const side = canonicalPositionSide(row.side);
  const baseSize = canonicalCarryPositiveDecimal(row.base_size);
  if (!market || !side || !baseSize) return null;
  const identity = carryInventoryPositionIdentityCommitment({
    venue_id: venueId,
    account_commitment: accountCommitment,
    market,
  });
  if (row.position_identity_commitment !== undefined
    && row.position_identity_commitment !== identity) return null;
  return Object.freeze({
    market,
    side,
    base_size: baseSize,
    position_identity_commitment: identity,
  });
}

function normalizeOrder(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const market = canonicalMarket(row.market);
  const side = canonicalOrderSide(row.side);
  const baseSize = canonicalCarryPositiveDecimal(row.base_size);
  const identity = String(row.order_identity_commitment || row.order_handle_commitment || "");
  const clientOrderIdentity = row.client_order_identity_commitment == null
    ? null
    : String(row.client_order_identity_commitment);
  const providerOrderIdentity = row.provider_order_identity_commitment == null
    ? null
    : String(row.provider_order_identity_commitment);
  if (!market || !side || !baseSize || !COMMITMENT.test(identity)) return null;
  const workOrder = row.carry_work_order_commitment == null
    ? null
    : String(row.carry_work_order_commitment);
  const providerRef = row.carry_provider_ref_commitment == null
    ? null
    : String(row.carry_provider_ref_commitment);
  if ((workOrder !== null && !COMMITMENT.test(workOrder))
    || (providerRef !== null && !COMMITMENT.test(providerRef))
    || (clientOrderIdentity !== null && !CLIENT_ORDER_IDENTITY.test(clientOrderIdentity))
    || (providerOrderIdentity !== null && !PROVIDER_ORDER_IDENTITY.test(providerOrderIdentity))) return null;
  return Object.freeze({
    market,
    side,
    base_size: baseSize,
    reduce_only: row.reduce_only === true,
    order_identity_commitment: identity,
    client_order_identity_commitment: clientOrderIdentity,
    provider_order_identity_commitment: providerOrderIdentity,
    carry_work_order_commitment: workOrder,
    carry_provider_ref_commitment: providerRef,
  });
}

function carryOrderOwnedByExpectation(row, expectation) {
  const durableLineage = row.carry_work_order_commitment === expectation.entry_work_order_commitment
    && row.carry_provider_ref_commitment === expectation.entry_provider_ref_commitment;
  const venueOrderLineage = expectation.entry_client_order_identity_commitment !== null
    && expectation.entry_provider_order_identity_commitment !== null
    && row.client_order_identity_commitment === expectation.entry_client_order_identity_commitment
    && row.provider_order_identity_commitment === expectation.entry_provider_order_identity_commitment;
  return durableLineage || venueOrderLineage;
}

function canonicalMarket(value) {
  const market = String(value || "").trim().toUpperCase();
  return MARKET.test(market) ? market : null;
}

function canonicalPositionSide(value) {
  const side = String(value || "").toLowerCase();
  if (side === "buy" || side === "long") return "long";
  if (side === "sell" || side === "short") return "short";
  return null;
}

function canonicalOrderSide(value) {
  const side = String(value || "").toLowerCase();
  if (side === "buy" || side === "long" || side === "b") return "buy";
  if (side === "sell" || side === "short" || side === "a") return "sell";
  return null;
}

function ambiguous(reason) {
  return Object.freeze({ ok: false, disposition: "ambiguous", reason });
}

function drift(reason) {
  return Object.freeze({ ok: false, disposition: "drift", reason });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
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
