import { CORE_PERP_VENUES, venueAdapterCapability } from "@ghola/execution-core";

export const DEFAULT_CARRY_SHADOW_ASSETS = Object.freeze(["BTC", "ETH", "SOL"]);

const REQUIRED_FIELDS = Object.freeze([
  "mark_price_e8",
  "index_price_e8",
  "best_bid_e8",
  "best_ask_e8",
  "funding_rate_e12_per_interval",
  "funding_interval_ms",
  "quantity_step_e8",
  "initial_margin_bps",
  "maintenance_margin_bps",
]);

const MISSING_FIELD_EVIDENCE = Object.freeze({
  maker_fee_bps: "fees_account_specific",
  taker_fee_bps: "fees_account_specific",
  minimum_notional_micro_usdc: "minimum_notional_unverified",
  price_tick_e8: "price_tick_dynamic",
  liquidation_fee_bps: "liquidation_fee_unverified",
});

export function verifyCarryShadowSet(rows, {
  assets = DEFAULT_CARRY_SHADOW_ASSETS,
  now_ms: nowMs = Date.now(),
  max_age_ms: maxAgeMs = 30_000,
} = {}) {
  const failures = [];
  const inputRows = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(rows)) failures.push("shadow_set_invalid");
  const byVenue = new Map();
  for (const row of inputRows) {
    const venueId = typeof row?.venue_id === "string" ? row.venue_id : "unknown";
    if (!CORE_PERP_VENUES.includes(venueId)) {
      failures.push(`venue_unregistered:${venueId}`);
      continue;
    }
    if (byVenue.has(venueId)) {
      failures.push(`venue_duplicate:${venueId}`);
      continue;
    }
    byVenue.set(venueId, row);
  }
  const requestedAssets = Array.isArray(assets) ? assets : [];
  if (!Array.isArray(assets)) failures.push("asset_set_invalid");
  const normalizedAssets = [...new Set(requestedAssets.map((asset) => String(asset).toUpperCase()))];
  if (normalizedAssets.length === 0) failures.push("asset_set_empty");

  for (const venueId of CORE_PERP_VENUES) {
    const venue = byVenue.get(venueId);
    if (!venue) {
      failures.push(`venue_missing:${venueId}`);
      continue;
    }
    if (venue.ok !== true) failures.push(`venue_fetch_failed:${venueId}:${venue.error || "unknown"}`);
    const snapshots = Array.isArray(venue.snapshots) ? venue.snapshots : [];
    for (const asset of normalizedAssets) {
      const matches = snapshots.filter((snapshot) => snapshot?.asset === asset);
      if (matches.length !== 1) {
        failures.push(`asset_snapshot_count:${venueId}:${asset}:${matches.length}`);
        continue;
      }
      verifySnapshot(matches[0], { venueId, asset, nowMs, maxAgeMs, failures });
    }
  }

  return Object.freeze({
    ok: failures.length === 0,
    checked_at_ms: nowMs,
    venues: CORE_PERP_VENUES.length,
    assets: normalizedAssets.length,
    expected_snapshots: CORE_PERP_VENUES.length * normalizedAssets.length,
    failures: Object.freeze(failures),
  });
}

export function verifyCarryShadowSoak(sampleResults, {
  required_samples: requiredSamples = 3,
} = {}) {
  const failures = [];
  const samples = Array.isArray(sampleResults) ? sampleResults : [];
  if (!Array.isArray(sampleResults)) failures.push("shadow_soak_samples_invalid");
  if (!Number.isSafeInteger(requiredSamples) || requiredSamples < 2) {
    failures.push("shadow_soak_required_samples_invalid");
  }
  if (samples.length < requiredSamples) {
    failures.push(`shadow_soak_samples_insufficient:${samples.length}:${requiredSamples}`);
  }
  let previousCheckedAt = 0;
  let expectedVenues = null;
  let expectedAssets = null;
  let expectedSnapshots = null;
  samples.forEach((sample, index) => {
    if (sample?.ok !== true || (Array.isArray(sample?.failures) && sample.failures.length > 0)) {
      failures.push(`shadow_soak_sample_failed:${index}`);
    }
    if (!Number.isSafeInteger(sample?.checked_at_ms) || sample.checked_at_ms <= previousCheckedAt) {
      failures.push(`shadow_soak_timeline_invalid:${index}`);
    }
    previousCheckedAt = Number.isSafeInteger(sample?.checked_at_ms) ? sample.checked_at_ms : previousCheckedAt;
    expectedVenues ??= sample?.venues;
    expectedAssets ??= sample?.assets;
    expectedSnapshots ??= sample?.expected_snapshots;
    if (
      sample?.venues !== expectedVenues ||
      sample?.assets !== expectedAssets ||
      sample?.expected_snapshots !== expectedSnapshots
    ) failures.push(`shadow_soak_coverage_drift:${index}`);
  });
  const firstCheckedAt = samples[0]?.checked_at_ms;
  const lastCheckedAt = samples.at(-1)?.checked_at_ms;
  return Object.freeze({
    ok: failures.length === 0,
    required_samples: requiredSamples,
    completed_samples: samples.length,
    duration_ms: Number.isSafeInteger(firstCheckedAt) && Number.isSafeInteger(lastCheckedAt)
      ? Math.max(0, lastCheckedAt - firstCheckedAt)
      : 0,
    venues: expectedVenues,
    assets: expectedAssets,
    expected_snapshots_per_sample: expectedSnapshots,
    failures: Object.freeze(failures),
  });
}

function verifySnapshot(snapshot, { venueId, asset, nowMs, maxAgeMs, failures }) {
  const prefix = `${venueId}:${asset}`;
  const declared = venueAdapterCapability(venueId, "perp_shadow");
  if (snapshot.version !== 1) failures.push(`snapshot_version_invalid:${prefix}`);
  if (snapshot.venue_id !== venueId) failures.push(`venue_mismatch:${prefix}`);
  if (declared?.read_only !== true || declared?.status !== "enabled") failures.push(`registry_boundary_invalid:${prefix}`);
  if (snapshot.source_schema !== declared?.source_schema) failures.push(`source_schema_mismatch:${prefix}`);
  if (snapshot.adapter_mode !== "shadow_read_only" || snapshot.executable !== false) {
    failures.push(`read_only_boundary_invalid:${prefix}`);
  }
  if (snapshot.trading_api_available !== true) failures.push(`trading_api_unavailable:${prefix}`);
  if (snapshot.economic_equivalence_id !== `carry:${asset}-usd-linear`) {
    failures.push(`economic_equivalence_invalid:${prefix}`);
  }
  if (snapshot.contract_type !== "linear_perp" || snapshot.market !== `${asset}-USD`) {
    failures.push(`contract_shape_invalid:${prefix}`);
  }
  if (typeof snapshot.contract_id !== "string" || !snapshot.contract_id.startsWith(`${venueId}:`)) {
    failures.push(`contract_id_invalid:${prefix}`);
  }
  if (!["USD", "USDC", "USDT"].includes(snapshot.quote_asset) || !["USDC", "USDT"].includes(snapshot.collateral_asset)) {
    failures.push(`settlement_asset_invalid:${prefix}`);
  }
  if (venueId === "hyperliquid" && (snapshot.quote_asset !== "USDT" || snapshot.collateral_asset !== "USDC")) {
    failures.push(`hyperliquid_core_contract_assets_invalid:${prefix}`);
  }
  if (snapshot.status === "quarantined" || snapshot.stale !== false) failures.push(`snapshot_quarantined:${prefix}`);
  if (!Number.isSafeInteger(snapshot.as_of_ms) || snapshot.as_of_ms > nowMs + 5_000 || nowMs - snapshot.as_of_ms > maxAgeMs) {
    failures.push(`snapshot_stale:${prefix}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Number.isSafeInteger(snapshot[field])) failures.push(`normalized_field_missing:${prefix}:${field}`);
  }
  if (!(snapshot.mark_price_e8 > 0) || !(snapshot.index_price_e8 > 0)) {
    failures.push(`reference_price_invalid:${prefix}`);
  }
  if (!(snapshot.best_bid_e8 > 0) || !(snapshot.best_ask_e8 > snapshot.best_bid_e8)) {
    failures.push(`orderbook_bbo_invalid:${prefix}`);
  }
  if (!(snapshot.funding_interval_ms > 0) || snapshot.funding_interval_ms > 24 * 60 * 60 * 1_000) {
    failures.push(`funding_interval_invalid:${prefix}`);
  }
  if (!(snapshot.quantity_step_e8 > 0)) failures.push(`quantity_precision_invalid:${prefix}`);
  if (!(snapshot.initial_margin_bps > snapshot.maintenance_margin_bps) || snapshot.initial_margin_bps > 10_000) {
    failures.push(`margin_evidence_invalid:${prefix}`);
  }
  if (!snapshot.liquidation_model || snapshot.liquidation_model === "unavailable") {
    failures.push(`liquidation_evidence_invalid:${prefix}`);
  }
  if (!Array.isArray(snapshot.quality_flags)) failures.push(`quality_flags_invalid:${prefix}`);
  if (!Array.isArray(snapshot.missing_fields)) failures.push(`missing_fields_invalid:${prefix}`);
  const flags = new Set(Array.isArray(snapshot.quality_flags) ? snapshot.quality_flags : []);
  for (const field of Array.isArray(snapshot.missing_fields) ? snapshot.missing_fields : []) {
    const requiredFlag = MISSING_FIELD_EVIDENCE[field];
    if (!requiredFlag || !flags.has(requiredFlag)) failures.push(`missing_field_unjustified:${prefix}:${field}`);
  }
}
