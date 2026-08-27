import { createHash } from "node:crypto";
import {
  DEFAULT_CARRY_SHADOW_ASSETS,
  verifyCarryShadowSet,
  verifyCarryShadowSoak,
} from "./perp-shadow-readiness.js";

const KIND = "carry_shadow_qualification";
const DEFAULT_REQUIRED_SAMPLES = 3;
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
    ? appendDistinctSample(retained, sample).slice(-requiredSamples)
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

function qualificationResult({
  sampleResults,
  requiredSamples,
  imageDigest,
  nowMs,
  maxAgeMs,
  evidenceCommitment = null,
  failures = [],
}) {
  const soak = verifyCarryShadowSoak(sampleResults, { required_samples: requiredSamples });
  const latestCheckedAtMs = sampleResults.at(-1)?.checked_at_ms || null;
  const stale = !Number.isSafeInteger(latestCheckedAtMs) || nowMs - latestCheckedAtMs > maxAgeMs;
  const combinedFailures = [
    ...failures,
    ...soak.failures,
    ...(stale && sampleResults.length >= requiredSamples ? ["shadow_qualification_stale"] : []),
  ];
  const uniqueFailures = [...new Set(combinedFailures)];
  return Object.freeze({
    version: 1,
    kind: KIND,
    ready: soak.ok && !stale && uniqueFailures.length === 0,
    release_bound: validImageDigest(imageDigest),
    transaction_broadcast: false,
    image_digest: imageDigest,
    checked_at_ms: latestCheckedAtMs,
    required_samples: requiredSamples,
    completed_samples: sampleResults.length,
    duration_ms: soak.duration_ms,
    venues: soak.venues || 0,
    assets: soak.assets || 0,
    requested_assets: Object.freeze([...(soak.requested_assets || [])]),
    expected_snapshots_per_sample: soak.expected_snapshots_per_sample || 0,
    sample_commitments: Object.freeze([...(soak.sample_commitments || [])]),
    evidence_commitment: evidenceCommitment,
    failures: Object.freeze(uniqueFailures),
  });
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
  if (samples.some((item) => item.sample_commitment === sample.sample_commitment)) return samples;
  return [...samples, sample];
}

function recordCommitment(record) {
  const payload = { ...record };
  delete payload.evidence_commitment;
  return `carry:shadow:qualification:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

function normalizeAssets(assets) {
  return Object.freeze([...new Set((Array.isArray(assets) ? assets : [])
    .map((asset) => String(asset).trim().toUpperCase())
    .filter((asset) => /^[A-Z0-9._-]{1,16}$/.test(asset)))].slice(0, 10));
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
