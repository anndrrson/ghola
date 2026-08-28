import { createHash } from "node:crypto";
import {
  DEFAULT_CARRY_SHADOW_ASSETS,
  verifyCarryShadowSet,
} from "./perp-shadow-readiness.js";
import { normalizeCarryShadowAssets } from "@ghola/execution-core";

const KIND = "carry_shadow_snapshot";
const SOURCE_MAX_AGE_MS = 60_000;
const DEFAULT_CACHE_MAX_AGE_MS = 60_000;

export async function writeCarryShadowSnapshot({
  state,
  venues,
  assets = DEFAULT_CARRY_SHADOW_ASSETS,
  funding_persistence: fundingPersistence,
  shadow_qualification: shadowQualification,
  routing_advantage: routingAdvantage,
  observed_at_ms: observedAtMs = Date.now(),
}) {
  const requestedAssets = normalizeAssets(assets);
  if (typeof state?.putIdempotency !== "function" || !requestedAssets.length) {
    return Object.freeze({ stored: false, reason: "shadow_snapshot_state_unavailable" });
  }
  if (fundingPersistence?.transaction_broadcast !== false
    || shadowQualification?.transaction_broadcast !== false
    || routingAdvantage?.transaction_broadcast !== false) {
    return Object.freeze({ stored: false, reason: "shadow_snapshot_proof_incomplete" });
  }
  const readiness = verifyCarryShadowSet(venues, {
    assets: requestedAssets,
    now_ms: observedAtMs,
    max_age_ms: SOURCE_MAX_AGE_MS,
  });
  const record = {
    version: 1,
    kind: KIND,
    requested_assets: requestedAssets,
    observed_at_ms: observedAtMs,
    readiness,
    funding_persistence: fundingPersistence || null,
    shadow_qualification: shadowQualification || null,
    routing_advantage: routingAdvantage || null,
    venues: Array.isArray(venues) ? structuredClone(venues) : [],
    transaction_broadcast: false,
  };
  record.evidence_commitment = recordCommitment(record);
  await state.putIdempotency(carryShadowSnapshotKey(requestedAssets), record);
  return Object.freeze({
    stored: true,
    ready: readiness.ok,
    evidence_commitment: record.evidence_commitment,
  });
}

export async function readCarryShadowSnapshot({
  state,
  assets = DEFAULT_CARRY_SHADOW_ASSETS,
  now_ms: nowMs = Date.now(),
  env = process.env,
}) {
  const requestedAssets = normalizeAssets(assets);
  if (typeof state?.getIdempotency !== "function" || !requestedAssets.length) {
    return miss("shadow_snapshot_state_unavailable");
  }
  const stored = (await state.getIdempotency(carryShadowSnapshotKey(requestedAssets)))?.receipt;
  if (!stored) return miss("shadow_snapshot_missing");
  if (!validRecord(stored)) return miss("shadow_snapshot_evidence_invalid");
  if (!sameStrings(stored.requested_assets, requestedAssets)) return miss("shadow_snapshot_asset_mismatch");

  const maxAgeMs = boundedInteger(
    env.PRIVATE_AGENT_CARRY_SHADOW_CACHE_MAX_AGE_MS,
    5_000,
    SOURCE_MAX_AGE_MS,
    DEFAULT_CACHE_MAX_AGE_MS,
  );
  const ageMs = nowMs - stored.observed_at_ms;
  if (!Number.isSafeInteger(ageMs) || ageMs < 0 || ageMs > maxAgeMs) {
    return miss("shadow_snapshot_stale");
  }
  const readiness = verifyCarryShadowSet(stored.venues, {
    assets: requestedAssets,
    now_ms: nowMs,
    max_age_ms: SOURCE_MAX_AGE_MS,
  });
  if (!readiness.ok) return miss("shadow_snapshot_source_stale", readiness.failures);

  return Object.freeze({
    ok: true,
    age_ms: ageMs,
    evidence_commitment: stored.evidence_commitment,
    snapshot: Object.freeze({
      version: 1,
      mode: "shadow_read_only",
      executable: false,
      observed_at: new Date(stored.observed_at_ms).toISOString(),
      readiness,
      shadow_qualification: stored.shadow_qualification,
      funding_persistence: stored.funding_persistence,
      routing_advantage: stored.routing_advantage,
      venues: Object.freeze(structuredClone(stored.venues)),
      served_from: "durable_observer",
      cache_age_ms: ageMs,
      evidence_commitment: stored.evidence_commitment,
    }),
  });
}

export function carryShadowSnapshotKey(assets = DEFAULT_CARRY_SHADOW_ASSETS) {
  return `carry:shadow:snapshot:${normalizeAssets(assets).join(",")}`;
}

function validRecord(record) {
  return record?.version === 1
    && record.kind === KIND
    && record.transaction_broadcast === false
    && Array.isArray(record.requested_assets)
    && Number.isSafeInteger(record.observed_at_ms)
    && Array.isArray(record.venues)
    && record.funding_persistence?.transaction_broadcast === false
    && record.shadow_qualification?.transaction_broadcast === false
    && record.routing_advantage?.transaction_broadcast === false
    && record.evidence_commitment === recordCommitment(record);
}

function recordCommitment(record) {
  const payload = { ...record };
  delete payload.evidence_commitment;
  return `carry:shadow:snapshot:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

function normalizeAssets(assets) {
  return normalizeCarryShadowAssets(assets) || Object.freeze([]);
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

function miss(reason, failures = []) {
  return Object.freeze({ ok: false, reason, failures: Object.freeze([...failures]) });
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
