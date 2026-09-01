import { createHash } from "node:crypto";
import { CORE_PERP_VENUES, normalizeCarryShadowAssets } from "@ghola/execution-core";
import {
  DEFAULT_CARRY_SHADOW_ASSETS,
  verifyCarryShadowSet,
  verifyCarryShadowSoak,
} from "./perp-shadow-readiness.js";

const KIND = "carry_shadow_qualification";
const DEFAULT_REQUIRED_SAMPLES = 3;
const REQUIRED_MINIMUM_SPAN_MS = 2 * 60_000;
const DEFAULT_MAX_AGE_MS = 10 * 60_000;
const SOURCE_MAX_AGE_MS = 60_000;

export async function observeCarryShadowQualification({
  state,
  venues,
  assets = DEFAULT_CARRY_SHADOW_ASSETS,
  now_ms: nowMs = Date.now(),
  env = process.env,
}) {
  const requestedAssets = normalizeAssets(assets);
  const requiredSamples = boundedInteger(
    env.PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_SAMPLES,
    3,
    12,
    DEFAULT_REQUIRED_SAMPLES,
  );
  const maxAgeMs = boundedInteger(
    env.PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_MAX_AGE_MS,
    60_000,
    24 * 60 * 60_000,
    DEFAULT_MAX_AGE_MS,
  );
  const imageDigest = normalizeImageDigest(env.PHALA_CVM_IMAGE_DIGEST);
  const sample = verifyCarryShadowSet(venues, {
    assets: requestedAssets,
    now_ms: nowMs,
    max_age_ms: SOURCE_MAX_AGE_MS,
  });
  if (typeof state?.getIdempotency !== "function" || typeof state?.putIdempotency !== "function") {
    return qualificationResult({
      sampleResults: sample.ok ? [sample] : [],
      requiredSamples,
      imageDigest,
      nowMs,
      maxAgeMs,
      failures: ["shadow_qualification_state_unavailable", ...sample.failures],
    });
  }

  const key = carryShadowQualificationKey(requestedAssets);
  const stored = (await state.getIdempotency(key))?.receipt;
  const storedValid = validRecord(stored);
  const compatible = storedValid
    && stored.image_digest === imageDigest
    && stored.required_samples === requiredSamples
    && sameStrings(stored.requested_assets, requestedAssets);
  const retained = compatible
    ? stored.sample_results.filter((item) =>
      Number.isSafeInteger(item?.checked_at_ms)
      && item.checked_at_ms >= nowMs - maxAgeMs
      && item.checked_at_ms < nowMs)
    : [];
  const sampleResults = sample.ok
    ? qualificationSampleWindow(appendDistinctSample(retained, sample), requiredSamples)
    : [];
  const record = {
    version: 1,
    kind: KIND,
    image_digest: imageDigest,
    requested_assets: requestedAssets,
    required_samples: requiredSamples,
    sample_results: sampleResults,
    updated_at_ms: nowMs,
    transaction_broadcast: false,
  };
  record.evidence_commitment = recordCommitment(record);
  await state.putIdempotency(key, record);
  return qualificationResult({
    sampleResults,
    requiredSamples,
    imageDigest,
    nowMs,
    maxAgeMs,
    evidenceCommitment: record.evidence_commitment,
    failures: [
      ...(!storedValid && stored ? ["shadow_qualification_evidence_invalid"] : []),
      ...sample.failures,
    ],
  });
}

export async function readCarryShadowQualification({
  state,
  assets = DEFAULT_CARRY_SHADOW_ASSETS,
  now_ms: nowMs = Date.now(),
  env = process.env,
}) {
  const requestedAssets = normalizeAssets(assets);
  const requiredSamples = boundedInteger(
    env.PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_SAMPLES,
    3,
    12,
    DEFAULT_REQUIRED_SAMPLES,
  );
  const maxAgeMs = boundedInteger(
    env.PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_MAX_AGE_MS,
    60_000,
    24 * 60 * 60_000,
    DEFAULT_MAX_AGE_MS,
  );
  const expectedImageDigest = normalizeImageDigest(env.PHALA_CVM_IMAGE_DIGEST);
  if (typeof state?.getIdempotency !== "function") {
    return qualificationResult({
      sampleResults: [],
      requiredSamples,
      imageDigest: expectedImageDigest,
      nowMs,
      maxAgeMs,
      failures: ["shadow_qualification_state_unavailable"],
    });
  }
  const stored = (await state.getIdempotency(carryShadowQualificationKey(requestedAssets)))?.receipt;
  if (!validRecord(stored)) {
    return qualificationResult({
      sampleResults: [],
      requiredSamples,
      imageDigest: expectedImageDigest,
      nowMs,
      maxAgeMs,
      failures: [stored ? "shadow_qualification_evidence_invalid" : "shadow_qualification_missing"],
    });
  }
  const failures = [
    ...(stored.image_digest !== expectedImageDigest ? ["shadow_qualification_image_mismatch"] : []),
    ...(stored.required_samples !== requiredSamples ? ["shadow_qualification_sample_policy_mismatch"] : []),
    ...(!sameStrings(stored.requested_assets, requestedAssets) ? ["shadow_qualification_asset_mismatch"] : []),
  ];
  return qualificationResult({
    sampleResults: stored.sample_results,
    requiredSamples,
    imageDigest: stored.image_digest,
    nowMs,
    maxAgeMs,
    evidenceCommitment: stored.evidence_commitment,
    failures,
  });
}

export function carryShadowQualificationKey(assets = DEFAULT_CARRY_SHADOW_ASSETS) {
  return `carry:shadow:qualification:${normalizeAssets(assets).join(",")}`;
}

export function verifyCarryShadowQualification(value, {
  image_digest: imageDigest,
  now_ms: nowMs = Date.now(),
  max_age_ms: maxAgeMs = 60_000,
} = {}) {
  const checkedAtMs = value?.checked_at_ms;
  const requiredSamples = value?.required_samples;
  const sampleCommitments = Array.isArray(value?.sample_commitments) ? value.sample_commitments : [];
  const sourceObservationCommitments = Array.isArray(value?.source_observation_commitments)
    ? value.source_observation_commitments
    : [];
  const valid = value?.version === 1
    && value?.kind === KIND
    && value?.ready === true
    && value?.release_bound === true
    && value?.transaction_broadcast === false
    && value?.image_digest === imageDigest
    && Number.isSafeInteger(nowMs)
    && Number.isSafeInteger(maxAgeMs)
    && maxAgeMs > 0
    && Number.isSafeInteger(checkedAtMs)
    && checkedAtMs <= nowMs + 5_000
    && nowMs - checkedAtMs <= maxAgeMs
    && Number.isSafeInteger(requiredSamples)
    && requiredSamples >= 3
    && value?.completed_samples === requiredSamples
    && Number.isSafeInteger(value?.duration_ms)
    && value?.minimum_span_ms === REQUIRED_MINIMUM_SPAN_MS
    && value.duration_ms >= value.minimum_span_ms
    && value?.venues === CORE_PERP_VENUES.length
    && value?.assets >= 3
    && Array.isArray(value?.requested_assets)
    && value.requested_assets.length === value.assets
    && new Set(value.requested_assets).size === value.assets
    && value?.expected_snapshots_per_sample === value.venues * value.assets
    && value?.degraded_snapshots === 0
    && Array.isArray(value?.failures)
    && value.failures.length === 0
    && sampleCommitments.length === requiredSamples
    && new Set(sampleCommitments).size === sampleCommitments.length
    && sampleCommitments.every((commitment) => /^carry:shadow:sample:[0-9a-f]{64}$/.test(String(commitment)))
    && sourceObservationCommitments.length === requiredSamples
    && new Set(sourceObservationCommitments).size === sourceObservationCommitments.length
    && sourceObservationCommitments.every((commitment) => /^carry:shadow:sources:[0-9a-f]{64}$/.test(String(commitment)))
    && /^carry:shadow:qualification:[0-9a-f]{64}$/.test(String(value?.evidence_commitment || ""))
    && value?.qualification_commitment === qualificationResultCommitment(value);
  return valid
    ? Object.freeze({ ok: true, qualification: Object.freeze(structuredClone(value)) })
    : Object.freeze({ ok: false, error: "shadow_qualification_result_invalid" });
}

function qualificationResult({
  sampleResults,
  requiredSamples,
  imageDigest,
  nowMs,
  maxAgeMs,
  evidenceCommitment = null,
  failures = [],
}) {
  const soak = verifyCarryShadowSoak(sampleResults, {
    required_samples: requiredSamples,
    minimum_span_ms: REQUIRED_MINIMUM_SPAN_MS,
  });
  const latestCheckedAtMs = sampleResults.at(-1)?.checked_at_ms || null;
  const stale = !Number.isSafeInteger(latestCheckedAtMs) || nowMs - latestCheckedAtMs > maxAgeMs;
  const combinedFailures = [
    ...failures,
    ...soak.failures,
    ...(stale && sampleResults.length >= requiredSamples ? ["shadow_qualification_stale"] : []),
  ];
  const uniqueFailures = [...new Set(combinedFailures)];
  const material = {
    version: 1,
    kind: KIND,
    ready: soak.ok && !stale && uniqueFailures.length === 0,
    release_bound: validImageDigest(imageDigest),
    transaction_broadcast: false,
    image_digest: imageDigest,
    checked_at_ms: latestCheckedAtMs,
    required_samples: requiredSamples,
    completed_samples: sampleResults.length,
    minimum_span_ms: soak.minimum_span_ms,
    duration_ms: soak.duration_ms,
    venues: soak.venues || 0,
    assets: soak.assets || 0,
    requested_assets: Object.freeze([...(soak.requested_assets || [])]),
    expected_snapshots_per_sample: soak.expected_snapshots_per_sample || 0,
    degraded_snapshots: soak.degraded_snapshots || 0,
    sample_commitments: Object.freeze([...(soak.sample_commitments || [])]),
    source_observation_commitments: Object.freeze([...(soak.source_observation_commitments || [])]),
    evidence_commitment: evidenceCommitment,
    failures: Object.freeze(uniqueFailures),
  };
  return Object.freeze({
    ...material,
    qualification_commitment: qualificationResultCommitment(material),
  });
}

function qualificationResultCommitment(value) {
  const { qualification_commitment: _ignored, ...material } = value || {};
  return `carry:shadow:result:${createHash("sha256").update(stableJson(material)).digest("hex")}`;
}

function validRecord(record) {
  return record?.version === 1
    && record.kind === KIND
    && record.transaction_broadcast === false
    && typeof record.image_digest === "string"
    && Array.isArray(record.requested_assets)
    && Number.isSafeInteger(record.required_samples)
    && Array.isArray(record.sample_results)
    && record.sample_results.length <= record.required_samples
    && record.evidence_commitment === recordCommitment(record);
}

function appendDistinctSample(samples, sample) {
  if (samples.some((item) => item.sample_commitment === sample.sample_commitment
    || item.source_observation_commitment === sample.source_observation_commitment)) return samples;
  return [...samples, sample];
}

function qualificationSampleWindow(samples, requiredSamples) {
  if (samples.length <= requiredSamples) return samples;
  // Keep the beginning of the current uninterrupted healthy run while rolling
  // the remaining observations forward. Dropping the oldest sample here makes
  // a sub-minute observer mathematically unable to prove the two-minute floor.
  return [samples[0], ...samples.slice(-(requiredSamples - 1))];
}

function recordCommitment(record) {
  const payload = { ...record };
  delete payload.evidence_commitment;
  return `carry:shadow:qualification:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

function normalizeAssets(assets) {
  return normalizeCarryShadowAssets(assets) || Object.freeze([]);
}

function normalizeImageDigest(value) {
  const digest = String(value || "").trim().toLowerCase();
  return validImageDigest(digest) ? digest : "unbound:local";
}

function validImageDigest(value) {
  return /^sha256:[0-9a-f]{12,128}$/.test(String(value || ""));
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
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
