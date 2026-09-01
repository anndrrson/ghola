import { createHash } from "node:crypto";
import { CORE_PERP_VENUES } from "@ghola/execution-core";
import {
  DEFAULT_CARRY_SHADOW_ASSETS,
  verifyCarryShadowSoak,
} from "./perp-shadow-readiness.js";

const KIND = "ghola_carry_shadow_development_witness";
const MINIMUM_SAMPLES = 3;
const MINIMUM_SPAN_MS = 120_000;

export function buildCarryShadowDevelopmentWitness({
  sample_results: sampleResults,
  required_samples: requiredSamples = MINIMUM_SAMPLES,
  minimum_span_ms: minimumSpanMs = MINIMUM_SPAN_MS,
  source_revision: sourceRevision,
  source_tree_digest: sourceTreeDigest,
  created_at_ms: createdAtMs = Date.now(),
}) {
  const soak = verifyCarryShadowSoak(sampleResults, {
    required_samples: requiredSamples,
    minimum_span_ms: minimumSpanMs,
  });
  const failures = witnessFailures({
    soak,
    sampleResults,
    requiredSamples,
    minimumSpanMs,
    sourceRevision,
    sourceTreeDigest,
    createdAtMs,
  });
  if (failures.length > 0) {
    throw new Error(`carry shadow development witness rejected: ${failures.join(", ")}`);
  }
  const material = {
    version: 1,
    kind: KIND,
    scope: "public_market_data_only",
    source_revision: sourceRevision,
    source_tree_digest: sourceTreeDigest,
    created_at_ms: createdAtMs,
    release_bound: false,
    worker_image_digest: null,
    owner_accounts_bound: false,
    no_submit_proven: false,
    live_trading_proven: false,
    ready_for_execution: false,
    transaction_broadcast: false,
    ...soak,
    sample_results: structuredClone(sampleResults),
  };
  return Object.freeze({
    ...material,
    witness_commitment: witnessCommitment(material),
  });
}

export function verifyCarryShadowDevelopmentWitness(value, {
  now_ms: nowMs = Date.now(),
  source_revision: expectedSourceRevision,
  source_tree_digest: expectedSourceTreeDigest,
} = {}) {
  const sampleResults = Array.isArray(value?.sample_results) ? value.sample_results : [];
  const recomputed = verifyCarryShadowSoak(sampleResults, {
    required_samples: value?.required_samples,
    minimum_span_ms: value?.minimum_span_ms,
  });
  const failures = [
    ...(value?.version === 1 ? [] : ["witness_version_invalid"]),
    ...(value?.kind === KIND ? [] : ["witness_kind_invalid"]),
    ...(value?.scope === "public_market_data_only" ? [] : ["witness_scope_invalid"]),
    ...(!expectedSourceRevision || value?.source_revision === expectedSourceRevision
      ? [] : ["witness_source_revision_mismatch"]),
    ...(!expectedSourceTreeDigest || value?.source_tree_digest === expectedSourceTreeDigest
      ? [] : ["witness_source_tree_digest_mismatch"]),
    ...(value?.release_bound === false ? [] : ["witness_release_boundary_invalid"]),
    ...(value?.worker_image_digest === null ? [] : ["witness_worker_image_claim_forbidden"]),
    ...(value?.owner_accounts_bound === false ? [] : ["witness_owner_account_claim_forbidden"]),
    ...(value?.no_submit_proven === false ? [] : ["witness_no_submit_claim_forbidden"]),
    ...(value?.live_trading_proven === false ? [] : ["witness_live_trade_claim_forbidden"]),
    ...(value?.ready_for_execution === false ? [] : ["witness_execution_claim_forbidden"]),
    ...(value?.transaction_broadcast === false ? [] : ["witness_broadcast_detected"]),
    ...witnessFailures({
      soak: recomputed,
      sampleResults,
      requiredSamples: value?.required_samples,
      minimumSpanMs: value?.minimum_span_ms,
      sourceRevision: value?.source_revision,
      sourceTreeDigest: value?.source_tree_digest,
      createdAtMs: value?.created_at_ms,
      nowMs,
    }),
    ...(!sameSummary(value, recomputed) ? ["witness_summary_mismatch"] : []),
    ...(value?.witness_commitment === witnessCommitment(value) ? [] : ["witness_commitment_mismatch"]),
  ];
  const uniqueFailures = [...new Set(failures)];
  return Object.freeze({
    ok: uniqueFailures.length === 0,
    failures: Object.freeze(uniqueFailures),
    witness_commitment: uniqueFailures.length === 0 ? value.witness_commitment : null,
  });
}

function witnessFailures({
  soak,
  sampleResults,
  requiredSamples,
  minimumSpanMs,
  sourceRevision,
  sourceTreeDigest,
  createdAtMs,
  nowMs = createdAtMs,
}) {
  const latestCheckedAtMs = sampleResults?.at(-1)?.checked_at_ms;
  return [
    ...(soak?.ok === true ? [] : ["witness_soak_invalid", ...(soak?.failures || [])]),
    ...(Number.isSafeInteger(requiredSamples) && requiredSamples >= MINIMUM_SAMPLES
      ? [] : ["witness_sample_floor_invalid"]),
    ...(Array.isArray(sampleResults) && sampleResults.length === requiredSamples
      ? [] : ["witness_sample_count_invalid"]),
    ...(Number.isSafeInteger(minimumSpanMs) && minimumSpanMs >= MINIMUM_SPAN_MS
      ? [] : ["witness_duration_policy_invalid"]),
    ...(soak?.venues === CORE_PERP_VENUES.length ? [] : ["witness_venue_coverage_invalid"]),
    ...(soak?.assets === DEFAULT_CARRY_SHADOW_ASSETS.length
      && sameStrings(soak?.requested_assets, DEFAULT_CARRY_SHADOW_ASSETS)
      ? [] : ["witness_asset_coverage_invalid"]),
    ...(soak?.expected_snapshots_per_sample === CORE_PERP_VENUES.length * DEFAULT_CARRY_SHADOW_ASSETS.length
      ? [] : ["witness_snapshot_coverage_invalid"]),
    ...(soak?.degraded_snapshots === 0 ? [] : ["witness_degraded_snapshot_detected"]),
    ...(/^[0-9a-f]{7,40}$/i.test(String(sourceRevision || "")) ? [] : ["witness_source_revision_invalid"]),
    ...(/^sha256:[0-9a-f]{64}$/.test(String(sourceTreeDigest || "")) ? [] : ["witness_source_tree_digest_invalid"]),
    ...(Number.isSafeInteger(createdAtMs)
      && Number.isSafeInteger(latestCheckedAtMs)
      && createdAtMs >= latestCheckedAtMs
      && createdAtMs <= nowMs + 5_000
      ? [] : ["witness_creation_time_invalid"]),
  ];
}

function sameSummary(value, soak) {
  const fields = [
    "ok",
    "required_samples",
    "completed_samples",
    "minimum_span_ms",
    "duration_ms",
    "venues",
    "assets",
    "expected_snapshots_per_sample",
    "degraded_snapshots",
  ];
  return fields.every((field) => value?.[field] === soak?.[field])
    && sameStrings(value?.requested_assets, soak?.requested_assets)
    && sameStrings(value?.sample_commitments, soak?.sample_commitments)
    && sameStrings(value?.source_observation_commitments, soak?.source_observation_commitments)
    && sameStrings(value?.failures, soak?.failures);
}

function witnessCommitment(value) {
  const { witness_commitment: _ignored, ...material } = value || {};
  return `carry:shadow:development:${createHash("sha256").update(stableJson(material)).digest("hex")}`;
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
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
