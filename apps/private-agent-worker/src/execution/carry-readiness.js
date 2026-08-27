import { createHash } from "node:crypto";
import { CARRY_EXECUTION_VENUES, venueAdapterCapability } from "@ghola/execution-core";
import { runtimeCarryQualificationImageDigest } from "./carry-qualification.js";

const DEFAULT_MAX_AGE_MS = 15 * 60_000;

export async function storeCarryExecutionReadiness({ state, request, matrix, now_ms: nowMs = Date.now(), env = process.env }) {
  const evidence = buildCarryExecutionReadiness({ request, matrix, now_ms: nowMs, env });
  const assessed = assessCarryExecutionReadiness({
    evidence,
    owner_commitment: request?.owner_commitment,
    venue_access: request?.venue_access,
    asset: request?.asset,
    notional_usd: request?.notional_usd,
    horizon_days: request?.horizon_days,
    now_ms: nowMs,
    env,
  });
  if (!assessed.ready) return { ok: false, error: assessed.reasons[0] || "carry_readiness_invalid", readiness: assessed };
  if (typeof state?.putIdempotency !== "function") {
    return { ok: false, error: "carry_readiness_state_unavailable", readiness: assessed };
  }
  await state.putIdempotency(readinessKey({
    owner_commitment: evidence.owner_commitment,
    image_digest: evidence.image_digest,
    venue_ids: evidence.registry_venue_ids,
    asset: evidence.asset,
    notional_usd: evidence.notional_usd,
    horizon_days: evidence.horizon_days,
  }), evidence);
  return { ok: true, readiness: assessed };
}

export async function readCarryExecutionReadiness({ state, owner_commitment: ownerCommitment, venue_access: venueAccess, asset, notional_usd: notionalUsd, horizon_days: horizonDays, now_ms: nowMs = Date.now(), env = process.env }) {
  const imageDigest = runtimeCarryQualificationImageDigest(env);
  if (!imageDigest) return readinessResult(false, ["runtime_image_digest_missing"]);
  const route = readinessRoute({ asset, notional_usd: notionalUsd, horizon_days: horizonDays });
  if (!route) return readinessResult(false, ["carry_readiness_route_invalid"]);
  if (!venueAccess || typeof venueAccess !== "object" || Array.isArray(venueAccess)) {
    return readinessResult(false, ["carry_readiness_access_missing"]);
  }
  if (typeof state?.getIdempotency !== "function") return readinessResult(false, ["carry_readiness_state_unavailable"]);
  const stored = await state.getIdempotency(readinessKey({
    owner_commitment: ownerCommitment,
    image_digest: imageDigest,
    venue_ids: CARRY_EXECUTION_VENUES,
    ...route,
  }));
  return assessCarryExecutionReadiness({
    evidence: stored?.receipt,
    owner_commitment: ownerCommitment,
    venue_access: venueAccess,
    ...route,
    now_ms: nowMs,
    env,
  });
}

export function assessCarryExecutionReadiness({ evidence, owner_commitment: ownerCommitment, venue_access: venueAccess, asset, notional_usd: notionalUsd, horizon_days: horizonDays, now_ms: nowMs = Date.now(), env = process.env }) {
  const reasons = [];
  const expectedImage = runtimeCarryQualificationImageDigest(env);
  const expectedVenues = [...CARRY_EXECUTION_VENUES];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return readinessResult(false, ["carry_readiness_evidence_missing"]);
  }
  if (evidence.version !== 1 || evidence.kind !== "carry_execution_no_submit_readiness") reasons.push("carry_readiness_version_invalid");
  if (!ownerCommitment || evidence.owner_commitment !== ownerCommitment) reasons.push("carry_readiness_owner_mismatch");
  if (evidence.operation_class !== "matrix_no_submit" || !commitment(evidence.work_order_commitment)) reasons.push("carry_readiness_request_unbound");
  if (evidence.network !== "mainnet") reasons.push("carry_readiness_network_invalid");
  const expectedRoute = readinessRoute({
    asset: asset ?? evidence.asset,
    notional_usd: notionalUsd ?? evidence.notional_usd,
    horizon_days: horizonDays ?? evidence.horizon_days,
  });
  if (!expectedRoute) reasons.push("carry_readiness_route_invalid");
  if (!/^[A-Z0-9]{2,16}$/.test(String(evidence.asset || ""))) reasons.push("carry_readiness_asset_invalid");
  if (!positiveDecimal(evidence.notional_usd) || !positiveDecimal(evidence.horizon_days)) reasons.push("carry_readiness_parameters_invalid");
  if (expectedRoute && (evidence.asset !== expectedRoute.asset
    || evidence.notional_usd !== expectedRoute.notional_usd
    || evidence.horizon_days !== expectedRoute.horizon_days)) reasons.push("carry_readiness_route_mismatch");
  if (!expectedImage || evidence.image_digest !== expectedImage) reasons.push("carry_readiness_image_mismatch");
  if (!sameStrings(evidence.registry_venue_ids, expectedVenues)) reasons.push("carry_readiness_registry_mismatch");
  const checkedAt = positiveInteger(evidence.checked_at_ms);
  const maxAge = readinessMaxAge(env);
  if (!checkedAt || checkedAt > nowMs || nowMs - checkedAt > maxAge) reasons.push("carry_readiness_stale");
  if (evidence.transaction_broadcast !== false) reasons.push("carry_readiness_broadcast_unsafe");
  const venues = Array.isArray(evidence.venues) ? evidence.venues : [];
  if (venues.length !== expectedVenues.length) reasons.push("carry_readiness_venue_count_invalid");
  for (const venueId of expectedVenues) {
    const expectedAdapter = venueAdapterCapability(venueId, "carry_execution")?.adapter_id;
    const matchingVenues = venues.filter((item) => item?.venue_id === venueId);
    const venue = matchingVenues[0];
    if (matchingVenues.length !== 1) {
      reasons.push(`carry_readiness_venue_missing:${venueId}`);
      continue;
    }
    if (!expectedAdapter || venue.adapter_id !== expectedAdapter) reasons.push(`carry_readiness_adapter_mismatch:${venueId}`);
    if (venue.transaction_broadcast !== false) reasons.push(`carry_readiness_broadcast_unsafe:${venueId}`);
    if (venue.account_state_checked !== true) reasons.push(`carry_readiness_account_unchecked:${venueId}`);
    if (venue.order_request_checked !== true) reasons.push(`carry_readiness_order_unchecked:${venueId}`);
    const verificationCommitments = Array.isArray(venue.verification_commitments) ? venue.verification_commitments : [];
    const workOrderCommitments = Array.isArray(venue.work_order_commitments) ? venue.work_order_commitments : [];
    if (verificationCommitments.length !== expectedVenues.length - 1
      || new Set(verificationCommitments).size !== verificationCommitments.length
      || !verificationCommitments.every(commitment)) {
      reasons.push(`carry_readiness_commitment_missing:${venueId}`);
    }
    if (workOrderCommitments.length !== expectedVenues.length - 1
      || new Set(workOrderCommitments).size !== workOrderCommitments.length
      || !workOrderCommitments.every(commitment)) {
      reasons.push(`carry_readiness_work_order_missing:${venueId}`);
    }
    if (!commitment(venue.account_commitment) || !commitment(venue.vault_commitment) || !commitment(venue.policy_commitment)) {
      reasons.push(`carry_readiness_access_unbound:${venueId}`);
    }
    const currentAccess = venueAccess?.[venueId];
    if (venueAccess && (!currentAccess
      || venue.account_commitment !== currentAccess.account_commitment
      || venue.vault_commitment !== currentAccess.vault_commitment
      || venue.policy_commitment !== currentAccess.policy_commitment)) {
      reasons.push(`carry_readiness_access_rotated:${venueId}`);
    }
  }
  const pairs = Array.isArray(evidence.pairs) ? evidence.pairs : [];
  const expectedPairs = allVenuePairs(expectedVenues);
  const capitalByVenue = new Map(expectedVenues.map((venueId) => [venueId, []]));
  if (pairs.length !== expectedPairs.length) reasons.push("carry_readiness_pair_count_invalid");
  for (const [pairIndex, [left, right]] of expectedPairs.entries()) {
    const matchingPairs = pairs.filter((item) => new Set([item?.long_venue_id, item?.short_venue_id]).size === 2
      && [item?.long_venue_id, item?.short_venue_id].includes(left)
      && [item?.long_venue_id, item?.short_venue_id].includes(right));
    const pair = matchingPairs[0];
    if (matchingPairs.length !== 1 || pair.no_submit_ready !== true || pair.transaction_broadcast !== false) {
      reasons.push(`carry_readiness_pair_unproven:${left}:${right}`);
      continue;
    }
    const expectedPairWorkOrder = `${evidence.work_order_commitment}_pair_${pairIndex + 1}`;
    if (pair.work_order_commitment !== expectedPairWorkOrder) {
      reasons.push(`carry_readiness_pair_work_order_mismatch:${left}:${right}`);
    }
    const legs = Array.isArray(pair.leg_evidence) ? pair.leg_evidence : [];
    if (legs.length !== 2 || new Set(legs.map((item) => item?.venue_id)).size !== 2
      || ![left, right].every((venueId) => legs.some((item) => item?.venue_id === venueId))) {
      reasons.push(`carry_readiness_pair_legs_invalid:${left}:${right}`);
      continue;
    }
    for (const venueId of [left, right]) {
      const leg = legs.find((item) => item?.venue_id === venueId);
      const venue = venues.find((item) => item?.venue_id === venueId);
      if (leg.work_order_commitment !== `${expectedPairWorkOrder}_${venueId}`) {
        reasons.push(`carry_readiness_leg_work_order_mismatch:${left}:${right}:${venueId}`);
      }
      if (!commitment(leg.verification_commitment)
        || leg.account_commitment !== venue?.account_commitment
        || leg.transaction_broadcast !== false
        || leg.account_state_checked !== true
        || leg.order_request_checked !== true) {
        reasons.push(`carry_readiness_leg_unproven:${left}:${right}:${venueId}`);
      }
      if (!venue?.verification_commitments?.includes(leg.verification_commitment)
        || !venue?.work_order_commitments?.includes(leg.work_order_commitment)) {
        reasons.push(`carry_readiness_leg_venue_binding_mismatch:${left}:${right}:${venueId}`);
      }
    }
    const accounts = Array.isArray(pair.account_readiness) ? pair.account_readiness : [];
    if (accounts.length !== 2 || new Set(accounts.map((item) => item?.venue_id)).size !== 2
      || ![left, right].every((venueId) => accounts.some((item) => item?.venue_id === venueId))) {
      reasons.push(`carry_readiness_capital_plan_invalid:${left}:${right}`);
      continue;
    }
    let pairCapitalReady = true;
    for (const venueId of [left, right]) {
      const account = accounts.find((item) => item?.venue_id === venueId);
      const available = nonnegativeInteger(account?.available_balance_micro_usdc);
      const venueMinimum = nonnegativeInteger(account?.venue_minimum_margin_micro_usdc);
      const required = positiveInteger(account?.required_opening_collateral_micro_usdc);
      const shortfall = nonnegativeInteger(account?.opening_collateral_shortfall_micro_usdc);
      const valid = typeof account?.authorized === "boolean"
        && typeof account?.flat_zero_orders === "boolean"
        && typeof account?.capital_ready === "boolean"
        && account?.execution_leverage === 1
        && account?.owner_only_funding === true
        && available !== null
        && venueMinimum !== null
        && required > 0
        && shortfall !== null
        && venueMinimum <= required
        && shortfall === Math.max(0, required - available)
        && account.capital_ready === (account.authorized && account.flat_zero_orders && shortfall === 0);
      if (!valid) reasons.push(`carry_readiness_capital_invalid:${left}:${right}:${venueId}`);
      pairCapitalReady = pairCapitalReady && account?.capital_ready === true;
      capitalByVenue.get(venueId)?.push(capitalRecord(account));
    }
    if (pair.capital_ready !== pairCapitalReady) {
      reasons.push(`carry_readiness_pair_capital_mismatch:${left}:${right}`);
    }
  }
  for (const venueId of expectedVenues) {
    const records = capitalByVenue.get(venueId) || [];
    if (records.length !== expectedVenues.length - 1
      || records.some((record) => JSON.stringify(record) !== JSON.stringify(records[0]))) {
      reasons.push(`carry_readiness_capital_inconsistent:${venueId}`);
    }
  }
  if (!commitment(evidence.evidence_commitment) || evidence.evidence_commitment !== evidenceCommitment(evidence)) {
    reasons.push("carry_readiness_commitment_invalid");
  }
  return readinessResult(reasons.length === 0, reasons, {
    owner_commitment: evidence.owner_commitment,
    asset: evidence.asset,
    network: evidence.network,
    notional_usd: evidence.notional_usd,
    horizon_days: evidence.horizon_days,
    image_digest: evidence.image_digest,
    registry_venue_ids: Object.freeze([...expectedVenues]),
    checked_at_ms: checkedAt || null,
    expires_at_ms: checkedAt ? checkedAt + maxAge : null,
    evidence_commitment: evidence.evidence_commitment || null,
    capital_ready: expectedVenues.every((venueId) => capitalByVenue.get(venueId)?.[0]?.capital_ready === true),
    capital_plan: Object.freeze(expectedVenues.map((venueId) => capitalByVenue.get(venueId)?.[0]).filter(Boolean)),
  });
}

function buildCarryExecutionReadiness({ request, matrix, now_ms: nowMs, env }) {
  const registryVenueIds = [...CARRY_EXECUTION_VENUES];
  const evidence = {
    version: 1,
    kind: "carry_execution_no_submit_readiness",
    network: "mainnet",
    owner_commitment: String(request?.owner_commitment || ""),
    operation_class: String(request?.operation_class || ""),
    work_order_commitment: String(request?.work_order_commitment || ""),
    asset: String(request?.asset || "").toUpperCase(),
    notional_usd: canonicalDecimal(request?.notional_usd),
    horizon_days: canonicalDecimal(request?.horizon_days),
    image_digest: runtimeCarryQualificationImageDigest(env),
    registry_venue_ids: registryVenueIds,
    checked_at_ms: nowMs,
    transaction_broadcast: matrix?.transaction_broadcast === false ? false : null,
    venues: registryVenueIds.map((venueId) => {
      const item = matrix?.venues?.find((entry) => entry?.venue_id === venueId) || {};
      const access = request?.venue_access?.[venueId] || {};
      return {
        venue_id: venueId,
        adapter_id: venueAdapterCapability(venueId, "carry_execution")?.adapter_id || null,
        transaction_broadcast: item.transaction_broadcast === false && item.checks?.transaction_broadcast === false ? false : null,
        account_state_checked: item.checks?.account_state_checked === true,
        order_request_checked: item.checks?.order_request_checked === true || item.checks?.order_request_built === true,
        verification_commitments: (Array.isArray(item.verification_commitments) ? item.verification_commitments : []).map(String),
        work_order_commitments: (Array.isArray(item.work_order_commitments) ? item.work_order_commitments : []).map(String),
        account_commitment: String(item.account_commitment || ""),
        vault_commitment: String(access.vault_commitment || ""),
        policy_commitment: String(access.policy_commitment || ""),
      };
    }),
    pairs: (matrix?.pairs || []).map((pair) => ({
      long_venue_id: String(pair?.long_venue_id || ""),
      short_venue_id: String(pair?.short_venue_id || ""),
      no_submit_ready: pair?.no_submit_ready === true,
      capital_ready: pair?.capital_ready === true,
      transaction_broadcast: pair?.transaction_broadcast === false ? false : null,
      work_order_commitment: String(pair?.work_order_commitment || ""),
      account_readiness: (Array.isArray(pair?.account_readiness) ? pair.account_readiness : []).map(capitalRecord),
      leg_evidence: (Array.isArray(pair?.leg_evidence) ? pair.leg_evidence : []).map((leg) => ({
        venue_id: String(leg?.venue_id || ""),
        account_commitment: String(leg?.account_commitment || ""),
        work_order_commitment: String(leg?.work_order_commitment || ""),
        verification_commitment: String(leg?.verification_commitment || ""),
        transaction_broadcast: leg?.transaction_broadcast === false ? false : null,
        account_state_checked: leg?.account_state_checked === true,
        order_request_checked: leg?.order_request_checked === true,
      })),
    })),
  };
  evidence.evidence_commitment = evidenceCommitment(evidence);
  return evidence;
}

function readinessKey({ owner_commitment: ownerCommitment, image_digest: imageDigest, venue_ids: venueIds, asset, notional_usd: notionalUsd, horizon_days: horizonDays }) {
  return `carry:readiness:${createHash("sha256").update(JSON.stringify({ ownerCommitment, imageDigest, venueIds, asset, notionalUsd, horizonDays })).digest("hex").slice(0, 40)}`;
}

function evidenceCommitment(evidence) {
  const { evidence_commitment: _ignored, ...material } = evidence || {};
  return `carry:readiness:evidence:${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 40)}`;
}

function readinessResult(ready, reasons, extra = {}) {
  return Object.freeze({
    version: 1,
    ready,
    reasons: Object.freeze([...new Set(reasons)]),
    ...extra,
  });
}

function readinessMaxAge(env) {
  const parsed = Number.parseInt(String(env.PRIVATE_AGENT_CARRY_READINESS_MAX_AGE_MS || ""), 10);
  return Number.isInteger(parsed) ? Math.max(60_000, Math.min(86_400_000, parsed)) : DEFAULT_MAX_AGE_MS;
}

function commitment(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{8,180}$/.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function capitalRecord(value) {
  return {
    venue_id: String(value?.venue_id || ""),
    authorized: value?.authorized === true,
    flat_zero_orders: value?.flat_zero_orders === true,
    capital_ready: value?.capital_ready === true,
    available_balance_micro_usdc: value?.available_balance_micro_usdc,
    venue_minimum_margin_micro_usdc: value?.venue_minimum_margin_micro_usdc,
    required_opening_collateral_micro_usdc: value?.required_opening_collateral_micro_usdc,
    opening_collateral_shortfall_micro_usdc: value?.opening_collateral_shortfall_micro_usdc,
    execution_leverage: value?.execution_leverage,
    owner_only_funding: value?.owner_only_funding === true,
  };
}

function positiveDecimal(value) {
  return /^\d+(?:\.\d+)?$/.test(String(value || "")) && Number(value) > 0;
}

function canonicalDecimal(value) {
  return positiveDecimal(value) ? String(Number(value)) : "";
}

function readinessRoute({ asset, notional_usd: notionalUsd, horizon_days: horizonDays }) {
  const normalizedAsset = String(asset || "").toUpperCase();
  const normalizedNotional = canonicalDecimal(notionalUsd);
  const normalizedHorizon = canonicalDecimal(horizonDays);
  if (!/^[A-Z0-9]{2,16}$/.test(normalizedAsset) || !normalizedNotional || !normalizedHorizon) return null;
  return Object.freeze({
    asset: normalizedAsset,
    notional_usd: normalizedNotional,
    horizon_days: normalizedHorizon,
  });
}

function sameStrings(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function allVenuePairs(venues) {
  return venues.flatMap((left, leftIndex) => venues.slice(leftIndex + 1).map((right) => [left, right]));
}
