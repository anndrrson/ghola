import { createHash } from "node:crypto";
import { venueAdapterCapability } from "@ghola/execution-core";

const OWNER = /^[A-Za-z0-9_.:-]{8,240}$/;
const COMMITMENT = /^[A-Za-z0-9_.:-]{8,240}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const STATUSES = new Set(["available", "degraded", "unavailable"]);

export async function storeCarryTransferRouteEvidence({
  state,
  owner_commitment: ownerCommitment,
  worker_image_digest: workerImageDigest,
  routes,
  checked_at_ms: checkedAtMs,
  expires_at_ms: expiresAtMs,
  now_ms: nowMs = Date.now(),
}) {
  if (!Number.isSafeInteger(nowMs) || Math.abs(nowMs - checkedAtMs) > 5_000) {
    fail("carry_transfer_route_observation_time_invalid");
  }
  const evidence = normalizeEvidence({
    version: 1,
    kind: "ghola_carry_transfer_route_evidence",
    owner_commitment: ownerCommitment,
    worker_image_digest: workerImageDigest,
    routes,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
  }, { requireCommitment: false });
  const committed = Object.freeze({
    ...evidence,
    evidence_commitment: evidenceCommitment(evidence),
  });
  await state.putIdempotency(evidenceKey(ownerCommitment), committed);
  return committed;
}

export async function loadCarryTransferRouteEvidence({
  state,
  owner_commitment: ownerCommitment,
  now_ms: nowMs,
  max_data_age_ms: maxDataAgeMs,
  expected_worker_image_digest: expectedWorkerImageDigest,
}) {
  if (!OWNER.test(String(ownerCommitment || ""))) return unavailable("carry_transfer_route_owner_invalid");
  const stored = (await state.getIdempotency(evidenceKey(ownerCommitment)))?.receipt;
  if (!stored) return unavailable("carry_transfer_route_evidence_missing");
  try {
    const evidence = normalizeEvidence(stored, { requireCommitment: true });
    if (evidence.owner_commitment !== ownerCommitment) return unavailable("carry_transfer_route_owner_mismatch");
    if (!IMAGE_DIGEST.test(String(expectedWorkerImageDigest || ""))
      || evidence.worker_image_digest !== expectedWorkerImageDigest) {
      return unavailable("carry_transfer_route_worker_image_mismatch");
    }
    if (evidence.checked_at_ms > nowMs + 5_000
      || evidence.expires_at_ms <= nowMs
      || nowMs - evidence.checked_at_ms > maxDataAgeMs) {
      return unavailable("carry_transfer_route_evidence_stale");
    }
    return {
      ok: true,
      evidence,
      routes: evidence.routes.map((route) => Object.freeze({
        ...route,
        evidence_source: "attested_worker",
        evidence_commitment: evidence.evidence_commitment,
        evidence_checked_at_ms: evidence.checked_at_ms,
        worker_image_digest: evidence.worker_image_digest,
      })),
    };
  } catch (error) {
    return unavailable(safeError(error));
  }
}

export function verifyCarryTransferRouteEvidence(value) {
  try {
    return { ok: true, evidence: normalizeEvidence(value, { requireCommitment: true }) };
  } catch (error) {
    return unavailable(safeError(error));
  }
}

function normalizeEvidence(value, { requireCommitment }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("carry_transfer_route_evidence_required");
  if (value.version !== 1 || value.kind !== "ghola_carry_transfer_route_evidence") {
    fail("carry_transfer_route_evidence_version");
  }
  const ownerCommitment = requiredCommitment(value.owner_commitment, "carry_transfer_route_owner_invalid");
  const workerImageDigest = String(value.worker_image_digest || "");
  if (!IMAGE_DIGEST.test(workerImageDigest)) fail("carry_transfer_route_image_digest_invalid");
  const checkedAtMs = positiveInteger(value.checked_at_ms, "carry_transfer_route_checked_at_invalid");
  const expiresAtMs = positiveInteger(value.expires_at_ms, "carry_transfer_route_expiry_invalid");
  if (expiresAtMs <= checkedAtMs || expiresAtMs - checkedAtMs > 300_000) {
    fail("carry_transfer_route_expiry_invalid");
  }
  if (value.owner_approval_required !== true
    || value.fund_movement_authorized !== false
    || value.transaction_broadcast !== false
    || value.automatic_transfer_permitted !== false) {
    fail("carry_transfer_route_authority_boundary");
  }
  if (!Array.isArray(value.routes) || value.routes.length > 1_000) fail("carry_transfer_routes_invalid");
  const routes = value.routes.map((route) => normalizeRoute(route, checkedAtMs));
  if (new Set(routes.map((route) => route.route_id)).size !== routes.length) {
    fail("carry_transfer_route_duplicate");
  }
  routes.sort((left, right) => left.route_id.localeCompare(right.route_id));
  const evidence = {
    version: 1,
    kind: "ghola_carry_transfer_route_evidence",
    owner_commitment: ownerCommitment,
    worker_image_digest: workerImageDigest,
    routes: Object.freeze(routes),
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
  };
  if (requireCommitment) {
    const commitment = requiredCommitment(value.evidence_commitment, "carry_transfer_route_commitment_invalid");
    if (commitment !== evidenceCommitment(evidence)) fail("carry_transfer_route_commitment_invalid");
    evidence.evidence_commitment = commitment;
  }
  return Object.freeze(evidence);
}

function normalizeRoute(value, checkedAtMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("carry_transfer_route_invalid");
  if (value.version !== 1 || value.settlement_asset !== "USDC") fail("carry_transfer_route_invalid");
  const fromVenueId = String(value.from_venue_id || "");
  const toVenueId = String(value.to_venue_id || "");
  const fromAccountCommitment = requiredCommitment(value.from_account_commitment, "carry_transfer_route_from_account_invalid");
  const toAccountCommitment = requiredCommitment(value.to_account_commitment, "carry_transfer_route_to_account_invalid");
  const sourceAdapterId = venueAdapterCapability(fromVenueId, "carry_execution")?.adapter_id || null;
  const destinationAdapterId = venueAdapterCapability(toVenueId, "carry_execution")?.adapter_id || null;
  if (!sourceAdapterId || !destinationAdapterId
    || value.source_adapter_id !== sourceAdapterId
    || value.destination_adapter_id !== destinationAdapterId
    || fromVenueId === toVenueId
    || fromAccountCommitment === toAccountCommitment) {
    fail("carry_transfer_route_adapter_binding_invalid");
  }
  const asOfMs = positiveInteger(value.as_of_ms, "carry_transfer_route_as_of_invalid");
  if (asOfMs > checkedAtMs + 5_000 || checkedAtMs - asOfMs > 300_000) fail("carry_transfer_route_as_of_invalid");
  const minimum = nonnegativeInteger(value.minimum_transfer_micro_usdc, "carry_transfer_route_minimum_invalid");
  const maximum = nonnegativeInteger(value.maximum_transfer_micro_usdc, "carry_transfer_route_maximum_invalid");
  if (maximum < minimum) fail("carry_transfer_route_capacity_invalid");
  if (value.owner_approval_required !== true
    || value.fund_movement_authorized !== false
    || value.transaction_broadcast !== false
    || value.automatic_transfer_permitted !== false) {
    fail("carry_transfer_route_authority_boundary");
  }
  return Object.freeze({
    version: 1,
    route_id: requiredCommitment(value.route_id, "carry_transfer_route_id_invalid"),
    from_account_commitment: fromAccountCommitment,
    from_venue_id: fromVenueId,
    to_account_commitment: toAccountCommitment,
    to_venue_id: toVenueId,
    source_adapter_id: sourceAdapterId,
    destination_adapter_id: destinationAdapterId,
    source_account_state_commitment: requiredCommitment(value.source_account_state_commitment, "carry_transfer_route_source_state_invalid"),
    destination_account_state_commitment: requiredCommitment(value.destination_account_state_commitment, "carry_transfer_route_destination_state_invalid"),
    quote_commitment: requiredCommitment(value.quote_commitment, "carry_transfer_route_quote_invalid"),
    settlement_asset: "USDC",
    status: status(value.status),
    minimum_transfer_micro_usdc: minimum,
    maximum_transfer_micro_usdc: maximum,
    fee_micro_usdc: nonnegativeInteger(value.fee_micro_usdc, "carry_transfer_route_fee_invalid"),
    estimated_latency_ms: boundedInteger(value.estimated_latency_ms, 0, 7 * 86_400_000, "carry_transfer_route_latency_invalid"),
    as_of_ms: asOfMs,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
  });
}

function evidenceCommitment(value) {
  const { evidence_commitment: _ignored, ...material } = value || {};
  return `carry:transfer-routes:evidence:${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 40)}`;
}

function evidenceKey(ownerCommitment) {
  return `carry:transfer-routes:latest:${ownerCommitment}`;
}

function requiredCommitment(value, code) {
  const normalized = String(value || "");
  if (!COMMITMENT.test(normalized)) fail(code);
  return normalized;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function nonnegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function status(value) {
  if (!STATUSES.has(value)) fail("carry_transfer_route_status_invalid");
  return value;
}

function unavailable(error) {
  return {
    ok: false,
    error,
    routes: Object.freeze([]),
    transaction_broadcast: false,
    fund_movement_authorized: false,
  };
}

function safeError(error) {
  const value = String(error?.message || "carry_transfer_route_evidence_invalid");
  return /^[a-z0-9_:-]{3,120}$/.test(value) ? value : "carry_transfer_route_evidence_invalid";
}

function fail(code) {
  throw new Error(code);
}
