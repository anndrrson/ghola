import { createHash } from "node:crypto";

const HOUR_MS = 3_600_000;
const DEFAULT_MIN_SAMPLES = 8;
const DEFAULT_MIN_SPAN_MS = 30 * 60_000;
const DEFAULT_MAX_AGE_MS = 24 * HOUR_MS;

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
  const key = persistenceKey(route);
  const stored = await state.getIdempotency(key);
  const prior = validRecord(stored?.receipt, route) ? stored.receipt.observations : [];
  const storageInvalid = Boolean(stored?.receipt) && prior.length === 0;
  const current = observation(route, nowMs);
  const retained = prior.filter((item) => item.observed_at_ms >= nowMs - maxAgeMs && item.observed_at_ms <= nowMs);
  const observations = appendDistinct(retained, current).slice(-96);
  const record = {
    version: 1,
    kind: "carry_funding_persistence",
    route,
    observations,
    updated_at_ms: nowMs,
  };
  record.evidence_commitment = commitment(record);
  await state.putIdempotency(key, record);

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

function observation(route, nowMs) {
  return Object.freeze({
    observed_at_ms: nowMs,
    long_rate_e12_per_interval: route.long_rate_e12_per_interval,
    short_rate_e12_per_interval: route.short_rate_e12_per_interval,
    long_interval_ms: route.long_interval_ms,
    short_interval_ms: route.short_interval_ms,
  });
}

function appendDistinct(items, next) {
  const duplicate = items.some((item) => item.observed_at_ms === next.observed_at_ms
    || (item.long_rate_e12_per_interval === next.long_rate_e12_per_interval
      && item.short_rate_e12_per_interval === next.short_rate_e12_per_interval
      && next.observed_at_ms - item.observed_at_ms < 30_000));
  return duplicate ? items : [...items, next];
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
