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

export const CARRY_EXECUTION_REQUIRED_ADAPTER_CAPABILITIES = Object.freeze([
  "carry_execution",
  "no_submit_reconciliation",
  "exact_quantity_recovery",
]);

export const CARRY_RECOVERY_POLICY = Object.freeze({
  ambiguous_submission: "freeze_reconcile_never_retry",
  partial_fill: "exact_quantity_reduce_only",
  worker_restart: "reconcile_before_action",
});

const CARRY_IMPLEMENTATION_STATUSES = Object.freeze(["proven", "implemented_unproven"]);

const specs = [
  venue("hyperliquid", "Hyperliquid", "core_perp", "proven", "enabled", ["perp"], {
    perp_shadow: adapter("hyperliquid_shadow_v1", "enabled", {
      read_only: true,
      source_schema: "hyperliquid_metaAndAssetCtxs_l2Book_v1",
      trading_api_available: true,
    }),
    carry_execution: adapter("hyperliquid_v1", "proven"),
    no_submit_reconciliation: adapter("hyperliquid_v1", "proven"),
    exact_quantity_recovery: adapter("hyperliquid_v1", "proven", CARRY_RECOVERY_POLICY),
    collateral_route_observer: adapter("hyperliquid_arbitrum_usdc_v1", "implemented_unproven", {
      read_only: true,
      collateral_asset: "USDC",
      chain_id: 42161,
      owner_approval_required: true,
    }),
  }),
  venue("lighter", "Lighter", "core_perp", "integration", "implemented_unproven", ["perp"], {
    perp_shadow: adapter("lighter_shadow_v1", "enabled", {
      read_only: true,
      source_schema: "lighter_orderBookDetails_fundingRates_v1",
      trading_api_available: true,
    }),
    browser_carry_stream: adapter("lighter_browser_stream_v1", "enabled"),
    carry_execution: adapter("lighter_v1", "implemented_unproven"),
    no_submit_reconciliation: adapter("lighter_v1", "implemented_unproven"),
    exact_quantity_recovery: adapter("lighter_v1", "implemented_unproven", CARRY_RECOVERY_POLICY),
    collateral_route_observer: adapter("lighter_arbitrum_usdc_v1", "implemented_unproven", {
      read_only: true,
      collateral_asset: "USDC",
      chain_id: 42161,
      owner_approval_required: true,
    }),
  }),
  venue("aster", "Aster", "core_perp", "integration", "implemented_unproven", ["perp"], {
    perp_shadow: adapter("aster_shadow_v1", "enabled", {
      read_only: true,
      source_schema: "aster_fapi_v3_fundingInfo_v1",
      trading_api_available: true,
    }),
    browser_carry_stream: adapter("aster_browser_stream_v1", "enabled"),
    carry_execution: adapter("aster_v1", "implemented_unproven"),
    no_submit_reconciliation: adapter("aster_v1", "implemented_unproven"),
    exact_quantity_recovery: adapter("aster_v1", "implemented_unproven", CARRY_RECOVERY_POLICY),
    collateral_route_observer: adapter("aster_arbitrum_usdt_v1", "implemented_unproven", {
      read_only: true,
      collateral_asset: "USDT",
      chain_id: 42161,
      owner_approval_required: true,
    }),
  }),
  venue("edgex", "edgeX", "core_perp", "candidate", "unimplemented", ["perp"], {
    perp_shadow: adapter("edgex_shadow_v1", "enabled", {
      read_only: true,
      source_schema: "edgex_public_v2",
      trading_api_available: true,
      source_max_age_ms: Object.freeze({ funding: 120_000 }),
    }),
    browser_carry_stream: adapter("edgex_browser_stream_v1", "enabled"),
  }),
  venue("dydx", "dYdX", "core_perp", "candidate", "unimplemented", ["perp"], {
    perp_shadow: adapter("dydx_shadow_v1", "enabled", {
      read_only: true,
      source_schema: "dydx_indexer_v4",
      trading_api_available: true,
    }),
    browser_carry_stream: adapter("dydx_browser_stream_v1", "enabled"),
  }),
  venue("variational_omni", "Variational Omni", "adjacent", "research_only", "quarantined", ["perp"], {
    perp_shadow: adapter("variational_shadow_v1", "quarantined", {
      read_only: true,
      source_schema: "variational_metadata_stats_v1",
      trading_api_available: false,
    }),
  }),
  venue("drift", "Drift", "adjacent", "integration", "quarantined", ["perp"]),
  venue("phoenix", "Phoenix", "adjacent", "legacy", "isolated", ["perp"]),
  venue("backpack", "Backpack", "adjacent", "legacy", "isolated", ["perp", "spot"]),
  venue("coinbase_advanced", "Coinbase Advanced", "adjacent", "proven", "enabled", ["spot"], {
    exact_quantity_recovery: adapter("coinbase_advanced_v1", "proven"),
  }),
  venue("jupiter", "Jupiter", "adjacent", "proven", "enabled", ["spot"]),
];

export const EXECUTION_VENUE_SPECS = deepFreeze(
  Object.fromEntries(specs.map((spec) => [spec.venue_id, spec])),
);

export const SUPPORTED_EXECUTION_VENUES = Object.freeze(specs.map((spec) => spec.venue_id));

export const CORE_PERP_VENUES = Object.freeze(
  specs
    .filter((spec) => spec.cohort === "core_perp" && spec.adapter_capabilities.perp_shadow?.status === "enabled")
    .map((spec) => spec.venue_id),
);

export const CARRY_EXECUTION_VENUES = Object.freeze(
  specs
    .filter((spec) => carryExecutionQualificationForSpec(spec).eligible)
    .map((spec) => spec.venue_id),
);

export const CARRY_BROWSER_STREAM_VENUES = Object.freeze(
  specs
    .filter((spec) => spec.adapter_capabilities.browser_carry_stream?.status === "enabled")
    .map((spec) => spec.venue_id),
);

export function executionVenueSpec(venueId) {
  return EXECUTION_VENUE_SPECS[venueId] || null;
}

export function executionVenueLabel(venueId) {
  return executionVenueSpec(venueId)?.label || String(venueId || "");
}

export function carryExecutionQualification(venueId) {
  const spec = executionVenueSpec(venueId);
  if (!spec) return Object.freeze({ venue_id: venueId, eligible: false, gaps: Object.freeze(["venue_unregistered"]) });
  return carryExecutionQualificationForSpec(spec);
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
  return venueAdapterCapability(venueId, "exact_quantity_recovery")?.adapter_id || null;
}

export function supportsExactQuantityRecovery(venueId) {
  return venueAdapterCapability(venueId, "exact_quantity_recovery")?.status === "proven";
}

export function venueAdapterCapability(venueId, capability) {
  if (typeof capability !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(capability)) return null;
  return executionVenueSpec(venueId)?.adapter_capabilities?.[capability] || null;
}

export function venuesWithAdapterCapability(capability, {
  cohort = null,
  product = null,
  statuses = ["enabled", "proven", "implemented_unproven"],
} = {}) {
  const allowedStatuses = new Set(statuses);
  return Object.freeze(specs.filter((spec) => {
    const declared = spec.adapter_capabilities[capability];
    return declared && allowedStatuses.has(declared.status)
      && (!cohort || spec.cohort === cohort)
      && (!product || spec.products.includes(product));
  }).map((spec) => spec.venue_id));
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

function venue(venueId, label, cohort, qualificationStatus, workerRoutingStatus, products, adapterCapabilities = {}) {
  const capabilities = Object.freeze({ ...adapterCapabilities });
  return {
    venue_id: venueId,
    label,
    cohort,
    qualification_status: qualificationStatus,
    worker_routing_status: workerRoutingStatus,
    exact_quantity_recovery_adapter: capabilities.exact_quantity_recovery?.adapter_id || null,
    adapter_capabilities: capabilities,
    products: Object.freeze([...products]),
    primary_product: products[0],
  };
}

function adapter(adapterId, status, metadata = {}) {
  return Object.freeze({ adapter_id: adapterId, status, ...metadata });
}

function carryExecutionQualificationForSpec(spec) {
  const gaps = [];
  if (spec.cohort !== "core_perp") gaps.push("core_perp_cohort_required");
  if (!spec.products.includes("perp")) gaps.push("perp_product_required");
  for (const capability of CARRY_EXECUTION_REQUIRED_ADAPTER_CAPABILITIES) {
    const declared = spec.adapter_capabilities[capability];
    if (!declared) gaps.push(`adapter_missing:${capability}`);
    else if (!CARRY_IMPLEMENTATION_STATUSES.includes(declared.status)) gaps.push(`adapter_unqualified:${capability}:${declared.status}`);
  }
  return Object.freeze({
    venue_id: spec.venue_id,
    eligible: gaps.length === 0,
    gaps: Object.freeze(gaps),
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
