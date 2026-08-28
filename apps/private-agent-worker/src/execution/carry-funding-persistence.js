import { createHash } from "node:crypto";
import {
  CARRY_EXECUTION_VENUES,
  CORE_PERP_VENUES,
  evaluatePerpContractPairBasis,
} from "@ghola/execution-core";
import { observeCarryShadowQualification } from "./carry-shadow-qualification.js";
import { buildCarryRoutingAdvantageEvidence } from "./carry-routing-advantage.js";
import { createCarryLoopSupervisor, disabledCarryLoopHealth } from "./carry-loop-supervisor.js";
import { writeCarryShadowSnapshot } from "./carry-shadow-snapshot.js";

const HOUR_MS = 3_600_000;
const DEFAULT_MIN_SAMPLES = 8;
const DEFAULT_MIN_SPAN_MS = 30 * 60_000;
const DEFAULT_MAX_AGE_MS = 24 * HOUR_MS;
const DEFAULT_MAX_DATA_SKEW_MS = 2_000;
const DEFAULT_OBSERVER_ASSETS = Object.freeze(["BTC", "ETH", "SOL"]);

export async function runCarryFundingObservationTick({
  state,
  fetchPerpShadowSet,
  assets = DEFAULT_OBSERVER_ASSETS,
  now_ms: nowMs = Date.now(),
  env = process.env,
}) {
  if (typeof fetchPerpShadowSet !== "function") throw new Error("carry_shadow_fetcher_required");
  const normalizedAssets = [...new Set(assets.map((asset) => String(asset).trim().toUpperCase())
    .filter((asset) => /^[A-Z0-9._-]{1,16}$/.test(asset)))].slice(0, 10);
  if (!normalizedAssets.length) throw new Error("carry_shadow_assets_required");
  const venues = await fetchPerpShadowSet({
    assets: normalizedAssets,
    now_ms: nowMs,
    timeout_ms: 8_000,
    max_age_ms: 60_000,
  });
  const [fundingPersistence, shadowQualification] = await Promise.all([
    observeCarryFundingUniverse({
      state,
      venues,
      assets: normalizedAssets,
      now_ms: nowMs,
      env,
    }),
    observeCarryShadowQualification({
      state,
      venues,
      assets: normalizedAssets,
      now_ms: nowMs,
      env,
    }),
  ]);
  const routingAdvantage = buildCarryRoutingAdvantageEvidence({
    venues,
    funding_persistence: fundingPersistence,
    shadow_qualification: shadowQualification,
    assets: normalizedAssets,
    now_ms: nowMs,
    env,
  });
  const shadowSnapshot = await writeCarryShadowSnapshot({
    state,
    venues,
    assets: normalizedAssets,
    funding_persistence: fundingPersistence,
    shadow_qualification: shadowQualification,
    routing_advantage: routingAdvantage,
    observed_at_ms: nowMs,
  });
  const currentFeedSetComplete = coreFeedSetComplete(venues, normalizedAssets);
  return Object.freeze({
    version: 1,
    ok: fundingPersistence.observed_route_count > 0 && currentFeedSetComplete,
    error: currentFeedSetComplete ? null : "carry_shadow_feed_set_incomplete",
    transaction_broadcast: false,
    observed_at_ms: nowMs,
    assets: Object.freeze(normalizedAssets),
    current_feed_set_complete: currentFeedSetComplete,
    funding_persistence: fundingPersistence,
    shadow_qualification: shadowQualification,
    routing_advantage: routingAdvantage,
    shadow_snapshot: shadowSnapshot,
  });
}

function coreFeedSetComplete(venues, assets) {
  const rows = Array.isArray(venues) ? venues : [];
  const requestedAssets = new Set(assets);
  return CORE_PERP_VENUES.every((venueId) => {
    const matches = rows.filter((row) => row?.venue_id === venueId);
    if (matches.length !== 1 || matches[0].ok !== true) return false;
    const observedAssets = new Set((Array.isArray(matches[0].snapshots) ? matches[0].snapshots : [])
      .map((snapshot) => snapshot?.asset)
      .filter((asset) => requestedAssets.has(asset)));
    return observedAssets.size === requestedAssets.size;
  });
}

export function startCarryFundingObservationLoop({
  state,
  fetchPerpShadowSet,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  if (String(env.PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ENABLED ?? "true").toLowerCase() === "false") {
    const health = disabledCarryLoopHealth("carry_shadow_observer");
    return {
      runNow: async () => ({ ok: false, error: "carry_shadow_observer_disabled" }),
      health: () => health,
      stop() {},
    };
  }
  const intervalMs = boundedEnvInteger(
    env.PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INTERVAL_MS,
    15_000,
    15 * 60_000,
    60_000,
  );
  const initialDelayMs = boundedEnvInteger(
    env.PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INITIAL_DELAY_MS,
    0,
    60_000,
    5_000,
  );
  const stallAfterMs = boundedEnvInteger(
    env.PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_STALL_MS,
    intervalMs,
    60 * 60_000,
    intervalMs * 3,
  );
  const assets = String(env.PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ASSETS || DEFAULT_OBSERVER_ASSETS.join(","))
    .split(",");
  const supervisor = createCarryLoopSupervisor({
    name: "carry_shadow_observer",
    now,
    maxSilenceMs: stallAfterMs,
    run: () => runCarryFundingObservationTick({
      state,
      fetchPerpShadowSet,
      assets,
      now_ms: now(),
      env,
    }),
  });
  let timer = null;
  let stopped = false;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await supervisor.runOnce();
      schedule(intervalMs);
    }, delay);
    timer.unref?.();
  };
  schedule(initialDelayMs);
  return {
    runNow: supervisor.runOnce,
    health: supervisor.health,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      supervisor.stop();
    },
  };
}

export async function observeCarryFundingUniverse({
  state,
  venues,
  assets = [],
  now_ms: nowMs = Date.now(),
  env = process.env,
}) {
  const requestedAssets = new Set(assets.map((asset) => String(asset).trim().toUpperCase()).filter(Boolean));
  const executionVenues = new Map((Array.isArray(venues) ? venues : [])
    .filter((venue) => CARRY_EXECUTION_VENUES.includes(venue?.venue_id))
    .map((venue) => [venue.venue_id, venue]));
  const discoveredAssets = new Set([...executionVenues.values()]
    .flatMap((venue) => Array.isArray(venue.snapshots) ? venue.snapshots : [])
    .map((snapshot) => snapshot?.asset)
    .filter((asset) => typeof asset === "string" && (!requestedAssets.size || requestedAssets.has(asset))));
  const maxDataSkewMs = boundedEnvInteger(
    env.PRIVATE_AGENT_CARRY_MAX_MARKET_DATA_SKEW_MS,
    0,
    60_000,
    DEFAULT_MAX_DATA_SKEW_MS,
  );
  const routes = [];

  for (const asset of [...discoveredAssets].sort()) {
    const snapshots = new Map();
    for (const venueId of CARRY_EXECUTION_VENUES) {
      const venue = executionVenues.get(venueId);
      const snapshot = venue?.snapshots?.find((candidate) => candidate?.asset === asset);
      if (venue?.ok === true && validTrustedSnapshot(snapshot, venueId, nowMs)) snapshots.set(venueId, snapshot);
    }
    for (const longVenueId of CARRY_EXECUTION_VENUES) {
      for (const shortVenueId of CARRY_EXECUTION_VENUES) {
        if (longVenueId === shortVenueId) continue;
        const longSnapshot = snapshots.get(longVenueId);
        const shortSnapshot = snapshots.get(shortVenueId);
        if (!longSnapshot || !shortSnapshot) continue;
        const skewMs = Math.abs(longSnapshot.as_of_ms - shortSnapshot.as_of_ms);
        let pairBasis;
        try {
          pairBasis = evaluatePerpContractPairBasis({
            version: 1,
            long_contract: longSnapshot,
            short_contract: shortSnapshot,
            max_index_price_divergence_bps: boundedEnvInteger(
              env.PRIVATE_AGENT_CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS,
              0,
              10_000,
              25,
            ),
            max_mark_price_divergence_bps: boundedEnvInteger(
              env.PRIVATE_AGENT_CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS,
              0,
              10_000,
              50,
            ),
          });
        } catch {
          continue;
        }
        if (!pairBasis.eligible || skewMs > maxDataSkewMs) continue;
        let persistence;
        try {
          persistence = await observeCarryFundingPersistence({
            state,
            evidence: [
              { venue_id: longVenueId, side: "buy", snapshot: longSnapshot },
              { venue_id: shortVenueId, side: "sell", snapshot: shortSnapshot },
            ],
            now_ms: nowMs,
            env,
          });
        } catch {
          persistence = result(false, ["funding_persistence_observation_failed"]);
        }
        routes.push(Object.freeze({
          asset,
          long_venue_id: longVenueId,
          short_venue_id: shortVenueId,
          ready: persistence.ready,
          reasons: persistence.reasons,
          sample_count: persistence.sample_count || 0,
          minimum_samples: persistence.minimum_samples || 0,
          observed_span_ms: persistence.observed_span_ms || 0,
          minimum_span_ms: persistence.minimum_span_ms || 0,
          conservative_hourly_spread_e12: persistence.conservative_hourly_spread_e12 ?? null,
          conservative_funding_rate_e12_by_venue:
            persistence.conservative_funding_rate_e12_by_venue || Object.freeze({}),
          evidence_commitment: persistence.evidence_commitment || null,
        }));
      }
    }
  }

  return Object.freeze({
    version: 1,
    transaction_broadcast: false,
    observed_route_count: routes.length,
    ready_route_count: routes.filter((route) => route.ready).length,
    routes: Object.freeze(routes),
  });
}

export async function observeCarryFundingPersistence({
  state,
  evidence,
  phase = "opening",
  now_ms: nowMs = Date.now(),
  env = process.env,
}) {
  if (phase === "monitoring") return monitoringResult(evidence);
  const route = fundingRoute(evidence);
  if (!route) return result(false, ["funding_persistence_route_invalid"]);
  if (typeof state?.getIdempotency !== "function" || typeof state?.putIdempotency !== "function") {
    return result(false, ["funding_persistence_state_unavailable"], { route });
  }

  const minimumSamples = boundedEnvInteger(env.PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SAMPLES, 1, 96, DEFAULT_MIN_SAMPLES);
  const minimumSpanMs = boundedEnvInteger(env.PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SPAN_MS, 0, DEFAULT_MAX_AGE_MS, DEFAULT_MIN_SPAN_MS);
  const maxAgeMs = boundedEnvInteger(env.PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MAX_AGE_MS, minimumSpanMs || 1, 7 * DEFAULT_MAX_AGE_MS, DEFAULT_MAX_AGE_MS);
  const minimumObservationIntervalMs = minimumSamples > 1
    ? Math.max(30_000, Math.floor(minimumSpanMs / (minimumSamples - 1)))
    : 30_000;
  const key = persistenceKey(route);
  const stored = await state.getIdempotency(key);
  const storedValid = validRecord(stored?.receipt, route);
  const prior = storedValid ? stored.receipt.observations : [];
  const storageInvalid = Boolean(stored?.receipt) && !storedValid;
  const current = observation(route, nowMs);
  const retained = prior.filter((item) => item.observed_at_ms >= nowMs - maxAgeMs && item.observed_at_ms <= nowMs);
  const observations = appendDistinct(retained, current, minimumObservationIntervalMs).slice(-96);
  const observationsChanged = !sameObservations(prior, observations);
  const record = observationsChanged || !storedValid
    ? {
        version: 1,
        kind: "carry_funding_persistence",
        route,
        observations,
        updated_at_ms: nowMs,
      }
    : stored.receipt;
  if (observationsChanged || !storedValid) {
    record.evidence_commitment = commitment(record);
    await state.putIdempotency(key, record);
  }

  const sampleCount = observations.length;
  const observedSpanMs = sampleCount > 1
    ? observations.at(-1).observed_at_ms - observations[0].observed_at_ms
    : 0;
  const longRates = observations.map((item) => item.long_rate_e12_per_interval);
  const shortRates = observations.map((item) => item.short_rate_e12_per_interval);
  const conservativeLongRate = Math.max(longRates.at(-1), percentile(longRates, 0.75, "upper"));
  const conservativeShortRate = Math.min(shortRates.at(-1), percentile(shortRates, 0.25, "lower"));
  const conservativeLongHourly = hourlyRate(conservativeLongRate, route.long_interval_ms);
  const conservativeShortHourly = hourlyRate(conservativeShortRate, route.short_interval_ms);
  const conservativeRates = Object.freeze({
    [route.long_venue_id]: conservativeLongRate,
    [route.short_venue_id]: conservativeShortRate,
  });
  const reasons = [
    ...(storageInvalid ? ["funding_persistence_evidence_invalid"] : []),
    ...(sampleCount < minimumSamples ? ["funding_history_insufficient"] : []),
    ...(observedSpanMs < minimumSpanMs ? ["funding_observation_span_insufficient"] : []),
    ...(conservativeShortHourly - conservativeLongHourly <= 0 ? ["funding_not_persistent"] : []),
  ];
  return result(reasons.length === 0, reasons, {
    route,
    sample_count: sampleCount,
    minimum_samples: minimumSamples,
    observed_span_ms: observedSpanMs,
    minimum_span_ms: minimumSpanMs,
    conservative_hourly_spread_e12: conservativeShortHourly - conservativeLongHourly,
    conservative_funding_rate_e12_by_venue: conservativeRates,
    evidence_commitment: record.evidence_commitment,
  });
}

function monitoringResult(evidence) {
  const route = fundingRoute(evidence);
  return result(Boolean(route), route ? [] : ["funding_persistence_route_invalid"], {
    route,
    monitoring_uses_current_funding: true,
    conservative_funding_rate_e12_by_venue: route ? Object.freeze({
      [route.long_venue_id]: route.long_rate_e12_per_interval,
      [route.short_venue_id]: route.short_rate_e12_per_interval,
    }) : Object.freeze({}),
  });
}

function fundingRoute(evidence) {
  if (!Array.isArray(evidence) || evidence.length !== 2) return null;
  const long = evidence.find((item) => item?.side === "buy");
  const short = evidence.find((item) => item?.side === "sell");
  if (!validLeg(long) || !validLeg(short)) return null;
  if (long.venue_id === short.venue_id || long.snapshot.economic_equivalence_id !== short.snapshot.economic_equivalence_id) return null;
  return Object.freeze({
    economic_equivalence_id: long.snapshot.economic_equivalence_id,
    asset: long.snapshot.asset,
    long_venue_id: long.venue_id,
    short_venue_id: short.venue_id,
    long_rate_e12_per_interval: long.snapshot.funding_rate_e12_per_interval,
    short_rate_e12_per_interval: short.snapshot.funding_rate_e12_per_interval,
    long_interval_ms: long.snapshot.funding_interval_ms,
    short_interval_ms: short.snapshot.funding_interval_ms,
  });
}

function validLeg(value) {
  return typeof value?.venue_id === "string"
    && typeof value?.snapshot?.economic_equivalence_id === "string"
    && typeof value?.snapshot?.asset === "string"
    && Number.isSafeInteger(value?.snapshot?.funding_rate_e12_per_interval)
    && Number.isSafeInteger(value?.snapshot?.funding_interval_ms)
    && value.snapshot.funding_interval_ms > 0;
}

function validTrustedSnapshot(value, expectedVenueId, nowMs) {
  if (!value || value.stale === true || value.status === "quarantined") return false;
  if (value.venue_id !== expectedVenueId) return false;
  if (!Number.isSafeInteger(value.as_of_ms) || value.as_of_ms > nowMs) return false;
  if (!Number.isSafeInteger(value.source_observed_at_ms?.funding)) return false;
  if (!Number.isSafeInteger(value.source_max_age_ms?.funding) || value.source_max_age_ms.funding < 0) return false;
  if (value.source_observed_at_ms.funding > nowMs
    || nowMs - value.source_observed_at_ms.funding > value.source_max_age_ms.funding) return false;
  if (Array.isArray(value.stale_sources) && value.stale_sources.includes("funding")) return false;
  return validLeg({ venue_id: value.venue_id, snapshot: value });
}

function observation(route, nowMs) {
  return Object.freeze({
    observed_at_ms: nowMs,
    long_rate_e12_per_interval: route.long_rate_e12_per_interval,
    short_rate_e12_per_interval: route.short_rate_e12_per_interval,
    long_interval_ms: route.long_interval_ms,
    short_interval_ms: route.short_interval_ms,
  });
}

function appendDistinct(items, next, minimumObservationIntervalMs) {
  const duplicate = items.some((item) => item.observed_at_ms === next.observed_at_ms
    || (item.long_rate_e12_per_interval === next.long_rate_e12_per_interval
      && item.short_rate_e12_per_interval === next.short_rate_e12_per_interval
      && next.observed_at_ms - item.observed_at_ms < minimumObservationIntervalMs));
  return duplicate ? items : [...items, next];
}

function sameObservations(left, right) {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index];
    return item.observed_at_ms === candidate.observed_at_ms
      && item.long_rate_e12_per_interval === candidate.long_rate_e12_per_interval
      && item.short_rate_e12_per_interval === candidate.short_rate_e12_per_interval
      && item.long_interval_ms === candidate.long_interval_ms
      && item.short_interval_ms === candidate.short_interval_ms;
  });
}

function validRecord(value, route) {
  if (!value || value.version !== 1 || value.kind !== "carry_funding_persistence") return false;
  if (!sameRoute(value.route, route)) return false;
  if (!Array.isArray(value.observations)
    || value.observations.length > 96
    || value.observations.some((item) => !validObservation(item))
    || value.observations.some((item, index) => index > 0
      && item.observed_at_ms <= value.observations[index - 1].observed_at_ms)) return false;
  return value.evidence_commitment === commitment(value);
}

function validObservation(value) {
  return Number.isSafeInteger(value?.observed_at_ms) && value.observed_at_ms > 0
    && Number.isSafeInteger(value?.long_rate_e12_per_interval)
    && Number.isSafeInteger(value?.short_rate_e12_per_interval)
    && Number.isSafeInteger(value?.long_interval_ms) && value.long_interval_ms > 0
    && Number.isSafeInteger(value?.short_interval_ms) && value.short_interval_ms > 0;
}

function persistenceKey(route) {
  return `carry_funding_persistence:${createHash("sha256").update(JSON.stringify([
    route.economic_equivalence_id,
    route.long_venue_id,
    route.short_venue_id,
  ])).digest("hex").slice(0, 40)}`;
}

function commitment(value) {
  return `carry:funding:${createHash("sha256").update(JSON.stringify({
    version: value.version,
    kind: value.kind,
    route: value.route,
    observations: value.observations,
    updated_at_ms: value.updated_at_ms,
  })).digest("hex")}`;
}

function hourlyRate(rate, intervalMs) {
  return Number(BigInt(rate) * BigInt(HOUR_MS) / BigInt(intervalMs));
}

function sameRoute(left, right) {
  return left?.economic_equivalence_id === right?.economic_equivalence_id
    && left?.asset === right?.asset
    && left?.long_venue_id === right?.long_venue_id
    && left?.short_venue_id === right?.short_venue_id
    && left?.long_interval_ms === right?.long_interval_ms
    && left?.short_interval_ms === right?.short_interval_ms;
}

function percentile(values, fraction, direction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = fraction * (sorted.length - 1);
  return direction === "upper" ? sorted[Math.ceil(index)] : sorted[Math.floor(index)];
}

function boundedEnvInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function result(ready, reasons, extra = {}) {
  return Object.freeze({
    version: 1,
    ready,
    reasons: Object.freeze([...new Set(reasons)]),
    ...extra,
  });
}
