const PERP_ROUTE_CAPABILITIES = Object.freeze([
  "market_data",
  "funding",
  "fees",
  "orders",
  "positions",
  "collateral",
  "reconciliation",
  "delegated_signing",
]);

const PERP_CARRY_CAPABILITIES = Object.freeze([
  ...PERP_ROUTE_CAPABILITIES,
  "contract_specs",
  "funding_history",
  "margin",
  "liquidation",
  "cancel",
  "reduce_only",
]);

const SPOT_ROUTE_CAPABILITIES = Object.freeze([
  "market_data",
  "fees",
  "orders",
  "balances",
  "reconciliation",
  "trade_only_credentials",
]);

const SWAP_ROUTE_CAPABILITIES = Object.freeze([
  "market_data",
  "fees",
  "quotes",
  "swap",
  "balances",
  "reconciliation",
  "delegated_signing",
]);

const specs = [
  venue("hyperliquid", "Hyperliquid", "core_perp", "proven", "enabled", "hyperliquid_v1", ["perp"]),
  venue("lighter", "Lighter", "core_perp", "integration", "implemented_unproven", "lighter_v1", ["perp"]),
  venue("aster", "Aster", "core_perp", "integration", "implemented_unproven", "aster_v1", ["perp"]),
  venue("edgex", "edgeX", "core_perp", "candidate", "unimplemented", null, ["perp"]),
  venue("dydx", "dYdX", "core_perp", "candidate", "unimplemented", null, ["perp"]),
  venue("variational_omni", "Variational Omni", "adjacent", "research_only", "quarantined", null, ["perp"]),
  venue("drift", "Drift", "adjacent", "integration", "quarantined", null, ["perp"]),
  venue("phoenix", "Phoenix", "adjacent", "legacy", "isolated", null, ["perp"]),
  venue("backpack", "Backpack", "adjacent", "legacy", "isolated", null, ["perp", "spot"]),
  venue("coinbase_advanced", "Coinbase Advanced", "adjacent", "proven", "enabled", "coinbase_advanced_v1", ["spot"]),
  venue("jupiter", "Jupiter", "adjacent", "proven", "enabled", null, ["spot"]),
];

export const EXECUTION_VENUE_SPECS = deepFreeze(
  Object.fromEntries(specs.map((spec) => [spec.venue_id, spec])),
);

export const SUPPORTED_EXECUTION_VENUES = Object.freeze(specs.map((spec) => spec.venue_id));

export const CORE_PERP_VENUES = Object.freeze(
  specs.filter((spec) => spec.cohort === "core_perp").map((spec) => spec.venue_id),
);

export const CARRY_EXECUTION_VENUES = Object.freeze(
  specs
    .filter((spec) =>
      spec.cohort === "core_perp" &&
      spec.products.includes("perp") &&
      spec.exact_quantity_recovery_adapter !== null &&
      ["enabled", "implemented_unproven"].includes(spec.worker_routing_status)
    )
    .map((spec) => spec.venue_id),
);

export function executionVenueSpec(venueId) {
  return EXECUTION_VENUE_SPECS[venueId] || null;
}

export function isExecutionVenue(venueId) {
  return executionVenueSpec(venueId) !== null;
}

export function isCarryExecutionVenue(venueId) {
  return CARRY_EXECUTION_VENUES.includes(venueId);
}

export function venueSupportsProduct(venueId, productType) {
  return executionVenueSpec(venueId)?.products.includes(productType) === true;
}

export function exactQuantityRecoveryAdapter(venueId) {
  return executionVenueSpec(venueId)?.exact_quantity_recovery_adapter || null;
}

export function supportsExactQuantityRecovery(venueId) {
  const spec = executionVenueSpec(venueId);
  return spec?.qualification_status === "proven" && spec.exact_quantity_recovery_adapter !== null;
}

export function requiredVenueCapabilities({
  venue_id: venueId,
  product_type: productType,
  operation_class: operationClass,
  reduce_only: reduceOnly = false,
  mode = "route",
} = {}) {
  const spec = executionVenueSpec(venueId);
  if (!spec) return Object.freeze([]);
  const product = productType || spec.primary_product;
  if (!venueSupportsProduct(venueId, product)) return Object.freeze([]);

  let required;
  if (venueId === "jupiter" || operationClass === "swap") required = SWAP_ROUTE_CAPABILITIES;
  else if (product === "perp" && mode === "carry") required = PERP_CARRY_CAPABILITIES;
  else if (product === "perp") required = PERP_ROUTE_CAPABILITIES;
  else required = SPOT_ROUTE_CAPABILITIES;

  return reduceOnly && !required.includes("reduce_only")
    ? Object.freeze([...required, "reduce_only"])
    : required;
}

function venue(venueId, label, cohort, qualificationStatus, workerRoutingStatus, recoveryAdapter, products) {
  return {
    venue_id: venueId,
    label,
    cohort,
    qualification_status: qualificationStatus,
    worker_routing_status: workerRoutingStatus,
    exact_quantity_recovery_adapter: recoveryAdapter,
    products: Object.freeze([...products]),
    primary_product: products[0],
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
