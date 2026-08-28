import { createHash } from "node:crypto";
import { CARRY_SHADOW_ASSETS, CORE_PERP_VENUES, venueAdapterCapability } from "@ghola/execution-core";

export const DEFAULT_CARRY_SHADOW_ASSETS = CARRY_SHADOW_ASSETS;
const REQUIRED_SOURCES = Object.freeze(["market", "funding", "orderbook"]);

const NORMALIZED_FIELDS = Object.freeze([
  "mark_price_e8",
  "index_price_e8",
  "best_bid_e8",
  "best_ask_e8",
  "funding_rate_e12_per_interval",
  "funding_interval_ms",
  "maker_fee_bps",
  "taker_fee_bps",
  "minimum_notional_micro_usdc",
  "quantity_step_e8",
  "price_tick_e8",
  "initial_margin_bps",
  "maintenance_margin_bps",
  "liquidation_fee_bps",
]);

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
  const snapshotEvidence = [];

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
      failures.push(...verifyCarryShadowSnapshot(matches[0], {
        venue_id: venueId,
        asset,
        now_ms: nowMs,
        max_age_ms: maxAgeMs,
      }).failures);
      snapshotEvidence.push(snapshotEvidenceRow(matches[0], nowMs));
    }
  }

  const frozenEvidence = Object.freeze(snapshotEvidence.map((row) => Object.freeze(row)));

  return Object.freeze({
    ok: failures.length === 0,
    checked_at_ms: nowMs,
    venues: CORE_PERP_VENUES.length,
    assets: normalizedAssets.length,
    requested_assets: Object.freeze(normalizedAssets),
    expected_snapshots: CORE_PERP_VENUES.length * normalizedAssets.length,
    snapshot_evidence: frozenEvidence,
    source_observation_commitment: shadowSourceObservationCommitment(frozenEvidence),
    sample_commitment: shadowSampleCommitment(nowMs, frozenEvidence),
    failures: Object.freeze(failures),
  });
}

export function verifyCarryShadowSnapshot(snapshot, {
  venue_id: venueId = snapshot?.venue_id,
  asset = snapshot?.asset,
  now_ms: nowMs = Date.now(),
  max_age_ms: maxAgeMs = 30_000,
} = {}) {
  const failures = [];
  verifySnapshot(snapshot || {}, {
    venueId: String(venueId || "unknown"),
    asset: String(asset || "unknown").toUpperCase(),
    nowMs,
    maxAgeMs,
    failures,
  });
  return Object.freeze({
    ok: failures.length === 0,
    checked_at_ms: nowMs,
    failures: Object.freeze(failures),
  });
}

export function verifyCarryShadowSoak(sampleResults, {
  required_samples: requiredSamples = 3,
  minimum_span_ms: minimumSpanMs = 0,
} = {}) {
  const failures = [];
  const samples = Array.isArray(sampleResults) ? sampleResults : [];
  if (!Array.isArray(sampleResults)) failures.push("shadow_soak_samples_invalid");
  if (!Number.isSafeInteger(requiredSamples) || requiredSamples < 2) {
    failures.push("shadow_soak_required_samples_invalid");
  }
  if (!Number.isSafeInteger(minimumSpanMs) || minimumSpanMs < 0) {
    failures.push("shadow_soak_minimum_span_invalid");
  }
  if (samples.length < requiredSamples) {
    failures.push(`shadow_soak_samples_insufficient:${samples.length}:${requiredSamples}`);
  }
  let previousCheckedAt = 0;
  let expectedVenues = null;
  let expectedAssets = null;
  let expectedRequestedAssets = null;
  let expectedSnapshots = null;
  const sampleCommitments = [];
  const sourceObservationCommitments = [];
  let previousSourceObservations = null;
  let degradedSnapshots = 0;
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
    expectedRequestedAssets ??= Array.isArray(sample?.requested_assets) ? sample.requested_assets : null;
    expectedSnapshots ??= sample?.expected_snapshots;
    if (
      sample?.venues !== expectedVenues ||
      sample?.assets !== expectedAssets ||
      !sameStrings(sample?.requested_assets, expectedRequestedAssets) ||
      sample?.expected_snapshots !== expectedSnapshots
    ) failures.push(`shadow_soak_coverage_drift:${index}`);
    const evidence = Array.isArray(sample?.snapshot_evidence) ? sample.snapshot_evidence : [];
    if (!validSnapshotEvidence(evidence, sample?.expected_snapshots, sample?.requested_assets)) {
      failures.push(`shadow_soak_snapshot_evidence_invalid:${index}`);
    }
    for (const row of evidence) {
      if (row?.status !== "ready") {
        degradedSnapshots += 1;
        failures.push(`shadow_soak_snapshot_not_ready:${index}:${row?.venue_id || "unknown"}:${row?.asset || "unknown"}`);
      }
    }
    const sampleCommitment = String(sample?.sample_commitment || "");
    if (sampleCommitment !== shadowSampleCommitment(sample?.checked_at_ms, evidence)) {
      failures.push(`shadow_soak_sample_commitment_invalid:${index}`);
    }
    sampleCommitments.push(sampleCommitment);
    const sourceObservationCommitment = String(sample?.source_observation_commitment || "");
    if (sourceObservationCommitment !== shadowSourceObservationCommitment(evidence)) {
      failures.push(`shadow_soak_source_observation_commitment_invalid:${index}`);
    }
    sourceObservationCommitments.push(sourceObservationCommitment);
    const currentSourceObservations = sourceObservationRows(evidence);
    if (previousSourceObservations) {
      verifySourceObservationProgress(previousSourceObservations, currentSourceObservations, index, failures);
    }
    previousSourceObservations = currentSourceObservations;
  });
  if (new Set(sampleCommitments).size !== sampleCommitments.length) {
    failures.push("shadow_soak_sample_commitments_reused");
  }
  if (new Set(sourceObservationCommitments).size !== sourceObservationCommitments.length) {
    failures.push("shadow_soak_source_observation_commitments_reused");
  }
  const firstCheckedAt = samples[0]?.checked_at_ms;
  const lastCheckedAt = samples.at(-1)?.checked_at_ms;
  const durationMs = Number.isSafeInteger(firstCheckedAt) && Number.isSafeInteger(lastCheckedAt)
    ? Math.max(0, lastCheckedAt - firstCheckedAt)
    : 0;
  if (Number.isSafeInteger(minimumSpanMs) && minimumSpanMs >= 0 && durationMs < minimumSpanMs) {
    failures.push(`shadow_soak_duration_insufficient:${durationMs}:${minimumSpanMs}`);
  }
  return Object.freeze({
    ok: failures.length === 0,
    required_samples: requiredSamples,
    completed_samples: samples.length,
    minimum_span_ms: minimumSpanMs,
    duration_ms: durationMs,
    venues: expectedVenues,
    assets: expectedAssets,
    requested_assets: Object.freeze([...(expectedRequestedAssets || [])]),
    expected_snapshots_per_sample: expectedSnapshots,
    degraded_snapshots: degradedSnapshots,
    sample_commitments: Object.freeze(sampleCommitments),
    source_observation_commitments: Object.freeze(sourceObservationCommitments),
    failures: Object.freeze(failures),
  });
}

function snapshotEvidenceRow(snapshot, nowMs) {
  return {
    venue_id: snapshot?.venue_id,
    asset: snapshot?.asset,
    contract_id: snapshot?.contract_id,
    source_schema: snapshot?.source_schema,
    as_of_ms: Number.isSafeInteger(snapshot?.as_of_ms) ? snapshot.as_of_ms : null,
    age_ms: Number.isSafeInteger(snapshot?.as_of_ms) ? Math.max(0, nowMs - snapshot.as_of_ms) : null,
    status: snapshot?.status,
    source_observed_at_ms: Object.freeze({ ...(snapshot?.source_observed_at_ms || {}) }),
    source_max_age_ms: Object.freeze({ ...(snapshot?.source_max_age_ms || {}) }),
    snapshot_commitment: carryShadowSnapshotCommitment(snapshot),
  };
}

export function carryShadowSnapshotCommitment(snapshot) {
  return `carry:shadow:snapshot:${digest(stableJson(snapshot))}`;
}

function validSnapshotEvidence(evidence, expectedSnapshots, requestedAssets) {
  if (!Number.isSafeInteger(expectedSnapshots) || evidence.length !== expectedSnapshots) return false;
  const allowedAssets = new Set(Array.isArray(requestedAssets) ? requestedAssets : []);
  if (allowedAssets.size === 0) return false;
  const pairs = new Set();
  for (const row of evidence) {
    const venueId = String(row?.venue_id || "");
    const asset = String(row?.asset || "");
    const declared = venueAdapterCapability(venueId, "perp_shadow");
    if (!CORE_PERP_VENUES.includes(venueId)
      || !allowedAssets.has(asset)
      || row?.source_schema !== declared?.source_schema
      || typeof row?.contract_id !== "string"
      || !row.contract_id.startsWith(`${venueId}:`)
      || !Number.isSafeInteger(row?.as_of_ms)
      || !Number.isSafeInteger(row?.age_ms)
      || row.age_ms < 0
      || !["ready", "degraded"].includes(row?.status)
      || !validSourceEvidence(row?.source_observed_at_ms, row?.source_max_age_ms)
      || !/^carry:shadow:snapshot:[0-9a-f]{64}$/.test(String(row?.snapshot_commitment || ""))) return false;
    pairs.add(`${venueId}:${asset}`);
  }
  return pairs.size === expectedSnapshots;
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function shadowSampleCommitment(checkedAtMs, snapshotEvidence) {
  return `carry:shadow:sample:${digest(stableJson({
    checked_at_ms: checkedAtMs,
    snapshot_evidence: snapshotEvidence,
  }))}`;
}

function shadowSourceObservationCommitment(snapshotEvidence) {
  return `carry:shadow:sources:${digest(stableJson(sourceObservationRows(snapshotEvidence)))}`;
}

function sourceObservationRows(snapshotEvidence) {
  return (Array.isArray(snapshotEvidence) ? snapshotEvidence : [])
    .map((row) => ({
      venue_id: String(row?.venue_id || ""),
      asset: String(row?.asset || ""),
      contract_id: String(row?.contract_id || ""),
      source_observed_at_ms: Object.fromEntries(REQUIRED_SOURCES.map((source) => [
        source,
        Number.isSafeInteger(row?.source_observed_at_ms?.[source])
          ? row.source_observed_at_ms[source]
          : null,
      ])),
    }))
    .sort((left, right) => `${left.venue_id}:${left.asset}:${left.contract_id}`
      .localeCompare(`${right.venue_id}:${right.asset}:${right.contract_id}`));
}

function verifySourceObservationProgress(previousRows, currentRows, sampleIndex, failures) {
  const previousByIdentity = new Map(previousRows.map((row) => [sourceObservationIdentity(row), row]));
  const currentByIdentity = new Map(currentRows.map((row) => [sourceObservationIdentity(row), row]));
  for (const [identity, previous] of previousByIdentity) {
    const current = currentByIdentity.get(identity);
    if (!current) {
      failures.push(`shadow_soak_source_observation_missing:${sampleIndex}:${identity}`);
      continue;
    }
    let advanced = false;
    for (const source of REQUIRED_SOURCES) {
      const previousTimestamp = previous.source_observed_at_ms[source];
      const currentTimestamp = current.source_observed_at_ms[source];
      if (!Number.isSafeInteger(previousTimestamp) || !Number.isSafeInteger(currentTimestamp)) continue;
      if (currentTimestamp < previousTimestamp) {
        failures.push(`shadow_soak_source_observation_regressed:${sampleIndex}:${identity}:${source}`);
      }
      if (currentTimestamp > previousTimestamp) advanced = true;
    }
    if (!advanced) failures.push(`shadow_soak_source_observation_reused:${sampleIndex}:${identity}`);
  }
}

function sourceObservationIdentity(row) {
  return `${row.venue_id}:${row.asset}:${row.contract_id}`;
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

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
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
  const expectedHyperliquidQuote = ["HYPE", "PURR"].includes(asset) ? "USDC" : "USDT";
  if (venueId === "hyperliquid" && (snapshot.quote_asset !== expectedHyperliquidQuote || snapshot.collateral_asset !== "USDC")) {
    failures.push(`hyperliquid_core_contract_assets_invalid:${prefix}`);
  }
  if (snapshot.status === "quarantined" || snapshot.stale !== false) failures.push(`snapshot_quarantined:${prefix}`);
  const aggregateMaxAgeMs = Math.max(
    maxAgeMs,
    ...REQUIRED_SOURCES.map((source) => declared?.source_max_age_ms?.[source] || 0),
  );
  if (!Number.isSafeInteger(snapshot.as_of_ms)
    || snapshot.as_of_ms > nowMs + 5_000
    || nowMs - snapshot.as_of_ms > aggregateMaxAgeMs) {
    failures.push(`snapshot_stale:${prefix}`);
  }
  verifySourceFreshness(snapshot, { declared, prefix, nowMs, maxAgeMs, failures });
  for (const field of REQUIRED_FIELDS) {
    if (!Number.isSafeInteger(snapshot[field])) failures.push(`normalized_field_missing:${prefix}:${field}`);
  }
  if (!(snapshot.mark_price_e8 > 0) || !(snapshot.index_price_e8 > 0)) {
    failures.push(`reference_price_invalid:${prefix}`);
  }
  if (!(snapshot.best_bid_e8 > 0) || !(snapshot.best_ask_e8 > snapshot.best_bid_e8)) {
    failures.push(`orderbook_bbo_invalid:${prefix}`);
  }
  verifyDepthLadder(snapshot.depth_bids, { prefix, side: "bid", failures });
  verifyDepthLadder(snapshot.depth_asks, { prefix, side: "ask", failures });
  if (Array.isArray(snapshot.depth_bids) && snapshot.depth_bids.length > 0
    && Array.isArray(snapshot.depth_asks) && snapshot.depth_asks.length > 0
    && snapshot.depth_bids[0]?.price_e8 >= snapshot.depth_asks[0]?.price_e8) {
    failures.push(`liquidity_depth_crossed:${prefix}`);
  }
  if (!(snapshot.funding_interval_ms > 0) || snapshot.funding_interval_ms > 24 * 60 * 60 * 1_000) {
    failures.push(`funding_interval_invalid:${prefix}`);
  }
  if (!(snapshot.quantity_step_e8 > 0)) failures.push(`quantity_precision_invalid:${prefix}`);
  verifyOptionalEconomicFields(snapshot, { prefix, failures });
  if (!(snapshot.initial_margin_bps > snapshot.maintenance_margin_bps)
    || snapshot.maintenance_margin_bps < 0
    || snapshot.initial_margin_bps > 10_000) {
    failures.push(`margin_evidence_invalid:${prefix}`);
  }
  if (snapshot.margin_model !== declared?.margin_model || snapshot.margin_model === "unavailable") {
    failures.push(`margin_model_evidence_invalid:${prefix}`);
  }
  if (snapshot.liquidation_model !== declared?.liquidation_model || snapshot.liquidation_model === "unavailable") {
    failures.push(`liquidation_evidence_invalid:${prefix}`);
  }
  if (!Array.isArray(snapshot.quality_flags)) failures.push(`quality_flags_invalid:${prefix}`);
  if (!Array.isArray(snapshot.missing_fields)) failures.push(`missing_fields_invalid:${prefix}`);
  const actualMissingFields = NORMALIZED_FIELDS.filter((field) => snapshot[field] === null || snapshot[field] === undefined);
  const declaredMissingFields = Array.isArray(snapshot.missing_fields) ? snapshot.missing_fields : [];
  if (!sameStrings(declaredMissingFields, actualMissingFields)) {
    failures.push(`missing_field_manifest_mismatch:${prefix}`);
  }
  const expectedStatus = actualMissingFields.length > 0 ? "degraded" : "ready";
  if (snapshot.status !== expectedStatus) failures.push(`snapshot_status_inconsistent:${prefix}`);
  const flags = new Set(Array.isArray(snapshot.quality_flags) ? snapshot.quality_flags : []);
  for (const field of actualMissingFields) {
    const requiredFlag = MISSING_FIELD_EVIDENCE[field];
    if (!requiredFlag || !flags.has(requiredFlag)) failures.push(`missing_field_unjustified:${prefix}:${field}`);
  }
}

function verifyOptionalEconomicFields(snapshot, { prefix, failures }) {
  const bounded = [
    ["maker_fee_bps", -1_000, 10_000],
    ["taker_fee_bps", 0, 10_000],
    ["liquidation_fee_bps", 0, 10_000],
  ];
  for (const [field, minimum, maximum] of bounded) {
    const value = snapshot[field];
    if (value !== null && value !== undefined
      && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) {
      failures.push(`normalized_field_invalid:${prefix}:${field}`);
    }
  }
  for (const field of ["minimum_notional_micro_usdc", "price_tick_e8"]) {
    const value = snapshot[field];
    if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      failures.push(`normalized_field_invalid:${prefix}:${field}`);
    }
  }
}

function verifySourceFreshness(snapshot, { declared, prefix, nowMs, maxAgeMs, failures }) {
  const observed = snapshot?.source_observed_at_ms;
  const policies = snapshot?.source_max_age_ms;
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
    failures.push(`source_observations_invalid:${prefix}`);
    return;
  }
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) {
    failures.push(`source_freshness_policy_invalid:${prefix}`);
    return;
  }
  for (const source of REQUIRED_SOURCES) {
    const observedAt = observed[source];
    const allowedAgeMs = Math.max(maxAgeMs, declared?.source_max_age_ms?.[source] || 0);
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0) {
      failures.push(`source_observation_missing:${prefix}:${source}`);
    } else if (observedAt > nowMs + 5_000 || nowMs - observedAt > allowedAgeMs) {
      failures.push(`source_observation_stale:${prefix}:${source}`);
    }
    if (policies[source] !== allowedAgeMs) {
      failures.push(`source_freshness_policy_mismatch:${prefix}:${source}`);
    }
  }
  if (!Array.isArray(snapshot.stale_sources) || snapshot.stale_sources.length !== 0) {
    failures.push(`stale_source_evidence_invalid:${prefix}`);
  }
}

function validSourceEvidence(observed, policies) {
  return observed && typeof observed === "object" && !Array.isArray(observed)
    && policies && typeof policies === "object" && !Array.isArray(policies)
    && REQUIRED_SOURCES.every((source) => Number.isSafeInteger(observed[source])
      && observed[source] > 0
      && Number.isSafeInteger(policies[source])
      && policies[source] > 0);
}

function verifyDepthLadder(levels, { prefix, side, failures }) {
  if (!Array.isArray(levels) || levels.length === 0) {
    failures.push(`liquidity_depth_missing:${prefix}:${side}`);
    return;
  }
  let previousPrice = null;
  for (const level of levels) {
    const price = level?.price_e8;
    const size = level?.size_e8;
    if (!Number.isSafeInteger(price) || price <= 0 || !Number.isSafeInteger(size) || size <= 0) {
      failures.push(`liquidity_depth_invalid:${prefix}:${side}`);
      return;
    }
    if (previousPrice !== null && (side === "bid" ? price > previousPrice : price < previousPrice)) {
      failures.push(`liquidity_depth_unsorted:${prefix}:${side}`);
      return;
    }
    previousPrice = price;
  }
}
