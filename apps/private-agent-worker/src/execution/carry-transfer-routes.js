import { createHash } from "node:crypto";
import { venueAdapterCapability } from "@ghola/execution-core";

const OWNER = /^[A-Za-z0-9_.:-]{8,240}$/;
const COMMITMENT = /^[A-Za-z0-9_.:-]{8,240}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const STATUSES = new Set(["available", "degraded", "unavailable"]);

export async function observeCarryTransferRoutes({
  state,
  owner_commitment: ownerCommitment,
  worker_image_digest: workerImageDigest,
  accounts,
  probe_route: probeRoute,
  checked_at_ms: checkedAtMs = Date.now(),
  expires_at_ms: expiresAtMs = checkedAtMs + 30_000,
  max_account_state_age_ms: maxAccountStateAgeMs = 30_000,
  now_ms: nowMs = checkedAtMs,
}) {
  const normalizedAccounts = normalizeObserverAccounts(accounts, checkedAtMs, maxAccountStateAgeMs);
  const routes = [];
  const failures = [];
  for (const source of normalizedAccounts) {
    for (const destination of normalizedAccounts) {
      if (source.venue_id === destination.venue_id
        || source.account_commitment === destination.account_commitment) continue;
      const request = observerRequest(source, destination, checkedAtMs);
      let quote;
      try {
        if (typeof probeRoute !== "function") fail("carry_transfer_route_probe_unavailable");
        quote = normalizeObservedQuote(await probeRoute(request), request, checkedAtMs);
      } catch (error) {
        const reason = safeError(error);
        failures.push(`${source.venue_id}:${destination.venue_id}:${reason}`);
        quote = unavailableObservedQuote(request, checkedAtMs, reason);
      }
      routes.push(Object.freeze({
        ...request,
        ...quote,
        quote_commitment: quoteCommitment(request, quote),
      }));
    }
  }
  const evidence = await storeCarryTransferRouteEvidence({
    state,
    owner_commitment: ownerCommitment,
    worker_image_digest: workerImageDigest,
    routes,
    checked_at_ms: checkedAtMs,
    expires_at_ms: expiresAtMs,
    now_ms: nowMs,
  });
  return Object.freeze({
    evidence,
    observed_route_count: evidence.routes.length,
    available_route_count: evidence.routes.filter((route) => route.status === "available").length,
    failures: Object.freeze(failures),
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
  });
}

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
  const sourceAdapterId = venueAdapterCapability(fromVenueId, "collateral_route_observer")?.adapter_id || null;
  const destinationAdapterId = venueAdapterCapability(toVenueId, "collateral_route_observer")?.adapter_id || null;
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
  const routeStatus = status(value.status);
  const quoteVerified = value.quote_verified === true;
  const allInFeeVerified = value.all_in_fee_verified === true;
  if ((routeStatus === "available" && maximum === 0)
    || (routeStatus !== "unavailable" && (!quoteVerified || !allInFeeVerified))) {
    fail("carry_transfer_route_quote_unverified");
  }
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
    status: routeStatus,
    quote_verified: quoteVerified,
    all_in_fee_verified: allInFeeVerified,
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

function normalizeObserverAccounts(value, checkedAtMs, maxAccountStateAgeMs) {
  if (!Array.isArray(value) || value.length > 20) fail("carry_transfer_route_accounts_invalid");
  const maximumAge = boundedInteger(
    maxAccountStateAgeMs,
    1,
    300_000,
    "carry_transfer_route_account_state_age_invalid",
  );
  const accounts = value.map((account) => {
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      fail("carry_transfer_route_account_invalid");
    }
    const venueId = String(account.venue_id || "");
    const capability = venueAdapterCapability(venueId, "collateral_route_observer");
    if (!capability?.adapter_id || capability.read_only !== true || capability.owner_approval_required !== true) {
      fail("carry_transfer_route_account_adapter_invalid");
    }
    const stateCheckedAtMs = positiveInteger(
      account.account_state_checked_at_ms,
      "carry_transfer_route_account_state_time_invalid",
    );
    if (stateCheckedAtMs > checkedAtMs + 5_000 || checkedAtMs - stateCheckedAtMs > maximumAge) {
      fail("carry_transfer_route_account_state_stale");
    }
    return Object.freeze({
      venue_id: venueId,
      account_commitment: requiredCommitment(account.account_commitment, "carry_transfer_route_account_invalid"),
      account_state_commitment: requiredCommitment(
        account.account_state_commitment,
        "carry_transfer_route_account_state_invalid",
      ),
      account_state_checked_at_ms: stateCheckedAtMs,
      observer_adapter_id: capability.adapter_id,
    });
  });
  if (new Set(accounts.map((account) => account.account_commitment)).size !== accounts.length) {
    fail("carry_transfer_route_account_duplicate");
  }
  return accounts.sort((left, right) => left.venue_id.localeCompare(right.venue_id)
    || left.account_commitment.localeCompare(right.account_commitment));
}

function observerRequest(source, destination, checkedAtMs) {
  const lineage = `${source.account_commitment}:${destination.account_commitment}`;
  return Object.freeze({
    version: 1,
    route_id: `carry:transfer-route:${source.venue_id}-${destination.venue_id}:${createHash("sha256").update(lineage).digest("hex").slice(0, 16)}`,
    from_account_commitment: source.account_commitment,
    from_venue_id: source.venue_id,
    to_account_commitment: destination.account_commitment,
    to_venue_id: destination.venue_id,
    source_adapter_id: source.observer_adapter_id,
    destination_adapter_id: destination.observer_adapter_id,
    source_account_state_commitment: source.account_state_commitment,
    destination_account_state_commitment: destination.account_state_commitment,
    settlement_asset: "USDC",
    checked_at_ms: checkedAtMs,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
  });
}

function normalizeObservedQuote(value, request, checkedAtMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("carry_transfer_route_probe_invalid");
  }
  if (value.settlement_asset !== "USDC"
    || value.owner_approval_required !== true
    || value.fund_movement_authorized !== false
    || value.transaction_broadcast !== false
    || value.automatic_transfer_permitted !== false) {
    fail("carry_transfer_route_probe_authority_boundary");
  }
  const routeStatus = status(value.status);
  if (routeStatus !== "unavailable"
    && (value.quote_verified !== true || value.all_in_fee_verified !== true)) {
    fail("carry_transfer_route_probe_quote_unverified");
  }
  const minimum = nonnegativeInteger(value.minimum_transfer_micro_usdc, "carry_transfer_route_probe_minimum_invalid");
  const maximum = nonnegativeInteger(value.maximum_transfer_micro_usdc, "carry_transfer_route_probe_maximum_invalid");
  if (maximum < minimum || (routeStatus === "available" && maximum === 0)) {
    fail("carry_transfer_route_probe_capacity_invalid");
  }
  const asOfMs = positiveInteger(value.as_of_ms, "carry_transfer_route_probe_as_of_invalid");
  if (asOfMs > checkedAtMs + 5_000 || checkedAtMs - asOfMs > 300_000) {
    fail("carry_transfer_route_probe_as_of_invalid");
  }
  return Object.freeze({
    status: routeStatus,
    quote_verified: value.quote_verified === true,
    all_in_fee_verified: value.all_in_fee_verified === true,
    minimum_transfer_micro_usdc: minimum,
    maximum_transfer_micro_usdc: maximum,
    fee_micro_usdc: nonnegativeInteger(value.fee_micro_usdc, "carry_transfer_route_probe_fee_invalid"),
    estimated_latency_ms: boundedInteger(
      value.estimated_latency_ms,
      0,
      7 * 86_400_000,
      "carry_transfer_route_probe_latency_invalid",
    ),
    as_of_ms: asOfMs,
    observation_binding: `${request.source_account_state_commitment}:${request.destination_account_state_commitment}`,
  });
}

function unavailableObservedQuote(request, checkedAtMs, reason) {
  return Object.freeze({
    status: "unavailable",
    quote_verified: false,
    all_in_fee_verified: false,
    minimum_transfer_micro_usdc: 0,
    maximum_transfer_micro_usdc: 0,
    fee_micro_usdc: 0,
    estimated_latency_ms: 0,
    as_of_ms: checkedAtMs,
    observation_binding: `${request.source_account_state_commitment}:${request.destination_account_state_commitment}:${reason}`,
  });
}

function quoteCommitment(request, quote) {
  return `carry:transfer-quote:${createHash("sha256").update(JSON.stringify({
    route_id: request.route_id,
    source_account_state_commitment: request.source_account_state_commitment,
    destination_account_state_commitment: request.destination_account_state_commitment,
    status: quote.status,
    quote_verified: quote.quote_verified,
    all_in_fee_verified: quote.all_in_fee_verified,
    minimum_transfer_micro_usdc: quote.minimum_transfer_micro_usdc,
    maximum_transfer_micro_usdc: quote.maximum_transfer_micro_usdc,
    fee_micro_usdc: quote.fee_micro_usdc,
    estimated_latency_ms: quote.estimated_latency_ms,
    as_of_ms: quote.as_of_ms,
    observation_binding: quote.observation_binding,
  })).digest("hex").slice(0, 40)}`;
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
