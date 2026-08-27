import {
  CARRY_EXECUTION_VENUES,
  adverseExecutionSlippageE6Bps,
  calculateMarginRunway,
  estimatePerpDepthExecution,
  evaluateCarryOpportunity,
  evaluatePerpContractPairBasis,
  exactQuantityRecoveryAdapter,
  isCarryExecutionVenue,
  normalizeCarryRiskMandate,
  venueAdapterCapability,
} from "@ghola/execution-core";
import { fetchPerpShadowVenue } from "./perp-shadow-adapters.js";
import { verifyCarryShadowSnapshot } from "./perp-shadow-readiness.js";
import { readCarryVenueQualification } from "./carry-qualification.js";
import {
  carryAccountStateCommitment,
  storeCarryExecutionDiagnostic,
  storeCarryExecutionReadiness,
} from "./carry-readiness.js";
import { observeCarryFundingPersistence } from "./carry-funding-persistence.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export async function preflightCarryPair({
  body,
  recipient,
  state,
  verifyOrder,
  readHyperliquidSnapshot,
  readHyperliquidCarryMetrics,
  fetchVenue = fetchPerpShadowVenue,
  now = () => Date.now(),
  env = process.env,
}) {
  const asset = String(body.asset).toUpperCase();
  const longVenue = String(body.long_venue_id);
  const shortVenue = String(body.short_venue_id);
  const notionalUsd = Number(body.notional_usd);
  const horizonDays = Number(body.horizon_days);
  if (longVenue === shortVenue || !isCarryExecutionVenue(longVenue) || !isCarryExecutionVenue(shortVenue)) {
    throw carryError("carry_pair_not_execution_qualified", 422);
  }

  const phase = body.phase === "monitoring"
    ? "monitoring"
    : body.phase === "migration"
      ? "migration"
      : "opening";
  const observedAt = now();
  const runtimeMaxContractDataSkewMs = carryMarketDataSkewMs(env);
  const runtimeMaxIndexPriceDivergenceBps = carryBasisBudgetBps(env, "PRIVATE_AGENT_CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS", 25);
  const runtimeMaxMarkPriceDivergenceBps = carryBasisBudgetBps(env, "PRIVATE_AGENT_CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS", 50);
  const executionMandate = body.risk_mandate
    ? normalizeCarryRiskMandate(body.risk_mandate)
    : null;
  const maxContractDataSkewMs = Math.min(
    runtimeMaxContractDataSkewMs,
    executionMandate?.max_contract_data_skew_ms ?? runtimeMaxContractDataSkewMs,
  );
  const maxIndexPriceDivergenceBps = Math.min(
    runtimeMaxIndexPriceDivergenceBps,
    executionMandate?.max_index_price_divergence_bps ?? runtimeMaxIndexPriceDivergenceBps,
  );
  const maxMarkPriceDivergenceBps = Math.min(
    runtimeMaxMarkPriceDivergenceBps,
    executionMandate?.max_mark_price_divergence_bps ?? runtimeMaxMarkPriceDivergenceBps,
  );
  const [longSnapshots, shortSnapshots] = await Promise.all([
    fetchVenue({ venue_id: longVenue, assets: [asset], now_ms: observedAt, max_age_ms: 60_000 }),
    fetchVenue({ venue_id: shortVenue, assets: [asset], now_ms: observedAt, max_age_ms: 60_000 }),
  ]);
  const longSnapshot = selectSnapshot(longSnapshots, asset, longVenue, observedAt);
  const shortSnapshot = selectSnapshot(shortSnapshots, asset, shortVenue, observedAt);
  const contractDataSkewMs = Math.abs(longSnapshot.as_of_ms - shortSnapshot.as_of_ms);
  if (!Number.isSafeInteger(contractDataSkewMs)
    || (phase !== "monitoring" && contractDataSkewMs > maxContractDataSkewMs)) {
    throw carryError("carry_market_data_skew_exceeded", 409);
  }
  const contractPairBasis = evaluatePerpContractPairBasis({
    version: 1,
    long_contract: longSnapshot,
    short_contract: shortSnapshot,
    max_index_price_divergence_bps: maxIndexPriceDivergenceBps,
    max_mark_price_divergence_bps: maxMarkPriceDivergenceBps,
  });
  if (phase !== "monitoring" && !contractPairBasis.eligible) {
    throw carryError(`carry_contract_equivalence_failed:${contractPairBasis.reasons[0]}`, 409);
  }
  const legs = [
    { venue_id: longVenue, side: "buy", snapshot: longSnapshot },
    { venue_id: shortVenue, side: "sell", snapshot: shortSnapshot },
  ];

  const evidence = await Promise.all(legs.map(async (leg) => {
    const access = venueAccess(body, leg.venue_id);
    const instruction = orderInstruction(leg, notionalUsd);
    const workOrderCommitment = `${body.work_order_commitment}_${leg.venue_id}`;
    const execution = executionFromAccess(access);
    const receipt = await verifyOrder({
      venue_id: leg.venue_id,
      operation_class: "limit_order",
      work_order_commitment: workOrderCommitment,
      policy_commitment: access.policy_commitment,
      session_policy: {
        market_allowlist: [instruction.order.market],
        max_notional_bucket: notionalBucket(notionalUsd),
        max_order_count: 1,
        kill_switch: false,
      },
      instruction,
      execution,
      recipient,
      state,
    });
    if (receipt?.account_commitment !== access.account_commitment) {
      throw carryError(`carry_account_verification_mismatch:${leg.venue_id}`, 403);
    }
    let account = receipt.account || null;
    let accountSnapshot = null;
    if (leg.venue_id === "hyperliquid") {
      [accountSnapshot, account] = await Promise.all([
        readHyperliquidSnapshot({ body: execution, recipient, state }),
        readHyperliquidCarryMetrics({ body: execution, recipient, state }),
      ]);
    }
    return {
      ...leg,
      receipt,
      account,
      account_snapshot: accountSnapshot,
      account_checked_at_ms: observedAt,
      account_commitment: access.account_commitment,
    };
  }));

  const fundingPersistence = await observeCarryFundingPersistence({
    state,
    evidence,
    phase,
    now_ms: observedAt,
    env,
  });

  const modeled = modelCarryPairPreflight({
    evidence,
    notional_usd: notionalUsd,
    horizon_days: horizonDays,
    now_ms: now(),
    phase,
    max_contract_data_skew_ms: maxContractDataSkewMs,
    max_index_price_divergence_bps: maxIndexPriceDivergenceBps,
    max_mark_price_divergence_bps: maxMarkPriceDivergenceBps,
    min_margin_runway_ms: executionMandate?.min_margin_runway_ms ?? 6 * HOUR_MS,
    conservative_funding_rate_e12_by_venue: fundingPersistence.conservative_funding_rate_e12_by_venue,
  });
  const qualifications = await Promise.all(evidence.map((leg) => readCarryVenueQualification({
    state,
    venue_id: leg.venue_id,
    now_ms: observedAt,
    env,
  })));
  const qualificationByVenue = new Map(qualifications.map((item) => [item.venue_id, item]));
  const qualificationReasons = evidence.flatMap((leg) => {
    const qualification = qualificationByVenue.get(leg.venue_id);
    return [
      ...(qualification?.proven === true ? [] : [`venue_not_proven:${leg.venue_id}`]),
      ...(qualification?.proven === true
        ? []
        : [exactQuantityRecoveryAdapter(leg.venue_id)
          ? `exact_quantity_recovery_unproven:${leg.venue_id}`
          : `exact_quantity_recovery_unavailable:${leg.venue_id}`]),
      ...(!acceptableAuthorityBoundary(leg.receipt?.authority_boundary)
        ? [`credential_authority_boundary_unacceptable:${leg.venue_id}`]
        : []),
      ...(!trustedAccountFeeEvidence(leg.account)
        ? [`account_fee_tier_unverified:${leg.venue_id}`]
        : []),
    ];
  });
  if (modeled.collateral_basis.supported !== true) {
    qualificationReasons.push("cross_collateral_basis_risk_unmodeled");
  }
  if (phase !== "monitoring" && fundingPersistence.ready !== true) {
    qualificationReasons.push(...fundingPersistence.reasons);
  }
  const economicOpportunity = Object.freeze({
    ...modeled.opportunity,
    eligible: modeled.opportunity.eligible && (phase === "monitoring" || fundingPersistence.ready === true),
    reasons: Object.freeze([...new Set([
      ...modeled.opportunity.reasons,
      ...(phase === "monitoring" ? [] : fundingPersistence.reasons),
    ])]),
    funding_persistence: fundingPersistence,
  });
  const unproven = qualifications.filter((item) => item.proven !== true);
  const pilotCandidate = unproven.length === 1
    && venueAdapterCapability(unproven[0].venue_id, "carry_execution")?.status === "implemented_unproven"
    && exactQuantityRecoveryAdapter(unproven[0].venue_id)
    ? unproven[0].venue_id
    : null;
  const pilotAllowedReasons = new Set(pilotCandidate ? [
    `venue_not_proven:${pilotCandidate}`,
    `exact_quantity_recovery_unproven:${pilotCandidate}`,
  ] : []);
  const qualificationPilotReady = env.PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED === "true"
    && Boolean(pilotCandidate)
    && modeled.no_submit_ready
    && modeled.capital_ready
    && economicOpportunity.eligible
    && qualificationReasons.every((reason) => pilotAllowedReasons.has(reason));
  const liveCreationReady = modeled.no_submit_ready
    && modeled.capital_ready
    && economicOpportunity.eligible
    && qualificationReasons.length === 0;
  const creationOpportunity = {
    ...economicOpportunity,
    all_venues_ready: modeled.no_submit_ready,
    live_creation_ready: liveCreationReady,
    qualification_pilot_ready: qualificationPilotReady,
    qualification_pilot_candidate_venue_id: pilotCandidate,
    long_margin_runway_ms: modeled.margin_runways[0]?.runway_ms ?? 0,
    short_margin_runway_ms: modeled.margin_runways[1]?.runway_ms ?? 0,
  };
  const accountReadiness = modeled.account_readiness.map((account, index) =>
    bindAccountStateEvidence(account, evidence[index]));
  return {
    version: 1,
    mode: phase === "monitoring"
      ? "paired_monitoring_no_submit"
      : phase === "migration"
        ? "paired_migration_no_submit"
        : "paired_no_submit",
    asset,
    transaction_broadcast: false,
    no_submit_ready: modeled.no_submit_ready,
    capital_ready: modeled.capital_ready,
    economic_opportunity: economicOpportunity,
    creation_opportunity: creationOpportunity,
    funding_persistence: fundingPersistence,
    collateral_basis: modeled.collateral_basis,
    contract_pair_basis: modeled.opportunity.contract_pair_basis,
    margin_runways: modeled.margin_runways,
    account_readiness: accountReadiness,
    opening_capital_plan: modeled.opening_capital_plan,
    evidence: evidence.map((leg, index) => publicEvidence(
      leg,
      qualificationByVenue.get(leg.venue_id),
      accountReadiness[index],
    )),
    live_creation_ready: liveCreationReady,
    qualification_pilot_ready: qualificationPilotReady,
    qualification_pilot_candidate_venue_id: pilotCandidate,
    qualification_reasons: [...new Set(qualificationReasons)],
    checked_at: new Date(modeled.checked_at_ms).toISOString(),
  };
}

export async function preflightCarryExecutionMatrix({ body, ...dependencies }) {
  const venues = [...CARRY_EXECUTION_VENUES];
  if (venues.length < 3) throw carryError("carry_execution_matrix_incomplete", 409);
  const observedAt = dependencies.now ? dependencies.now() : Date.now();
  const matrixDependencies = { ...dependencies, now: () => observedAt };
  const anchor = venues.find((venueId) => venueAdapterCapability(venueId, "carry_execution")?.status === "proven") || venues[0];
  const orderedVenues = [anchor, ...venues.filter((venueId) => venueId !== anchor)];
  const pairs = allVenuePairs(orderedVenues).map(([left, right], index) => ({
    long_venue_id: index % 2 === 0 ? left : right,
    short_venue_id: index % 2 === 0 ? right : left,
  }));
  const settledResults = await Promise.allSettled(pairs.map((pair, index) => preflightCarryPair({
    ...matrixDependencies,
    body: {
      ...body,
      operation_class: "paired_no_submit",
      work_order_commitment: `${body.work_order_commitment}_pair_${index + 1}`,
      ...pair,
    },
  })));
  const results = settledResults.map((result) => result.status === "fulfilled" ? result.value : null);
  const evidence = results.flatMap((result) => result?.evidence || []);
  const failures = [];
  for (const [index, result] of settledResults.entries()) {
    if (result.status === "rejected") {
      failures.push(`pair_check_failed:${index + 1}:${carryPairFailureCode(result.reason)}`);
    } else if (result.value.transaction_broadcast !== false || result.value.no_submit_ready !== true) {
      failures.push(`pair_not_ready:${index + 1}`);
    }
  }
  const venueEvidence = venues.map((venueId) => {
    const items = evidence.filter((item) => item.venue_id === venueId);
    if (items.length !== venues.length - 1) failures.push(`venue_evidence_count_invalid:${venueId}`);
    for (const item of items) {
      if (item.transaction_broadcast !== false || item.checks?.transaction_broadcast !== false) failures.push(`venue_broadcast_unsafe:${venueId}`);
      if (item.checks?.account_state_checked !== true) failures.push(`venue_account_unverified:${venueId}`);
      if (item.checks?.order_request_built !== true && item.checks?.order_request_checked !== true) failures.push(`venue_order_shape_unverified:${venueId}`);
      if (!acceptableAuthorityBoundary(item.authority_boundary)) failures.push(`venue_authority_unverified:${venueId}`);
      if (!validCommitment(item.work_order_commitment)) failures.push(`venue_work_order_unbound:${venueId}`);
      if (!validCommitment(item.verification_commitment)) failures.push(`venue_verification_unbound:${venueId}`);
      if (item.account_commitment !== body.venue_access?.[venueId]?.account_commitment) failures.push(`venue_account_binding_mismatch:${venueId}`);
      if (!validAccountStateEvidence(item.account_state, item)) failures.push(`venue_account_state_unbound:${venueId}`);
    }
    const first = items[0] || { venue_id: venueId };
    return {
      ...first,
      venue_id: venueId,
      work_order_commitments: items.map((item) => item.work_order_commitment),
      verification_commitments: items.map((item) => item.verification_commitment),
      account_state_commitments: items.map((item) => item.account_state?.account_state_commitment),
      transaction_broadcast: items.length === venues.length - 1
        && items.every((item) => item.transaction_broadcast === false && item.checks?.transaction_broadcast === false)
        ? false
        : null,
      checks: {
        transaction_broadcast: items.length === venues.length - 1
          && items.every((item) => item.checks?.transaction_broadcast === false)
          ? false
          : null,
        account_state_checked: items.length === venues.length - 1
          && items.every((item) => item.checks?.account_state_checked === true),
        order_request_checked: items.length === venues.length - 1
          && items.every((item) => item.checks?.order_request_built === true || item.checks?.order_request_checked === true),
      },
    };
  });
  const matrix = {
    version: 1,
    mode: "carry_execution_no_submit_matrix",
    transaction_broadcast: false,
    no_submit_ready: failures.length === 0,
    capital_ready: results.every((result) => result?.capital_ready === true),
    venues: venueEvidence,
    pairs: pairs.map((pair, index) => {
      const result = results[index];
      const errorCode = settledResults[index].status === "rejected"
        ? carryPairFailureCode(settledResults[index].reason)
        : null;
      return {
        ...pair,
        work_order_commitment: `${body.work_order_commitment}_pair_${index + 1}`,
        no_submit_ready: result?.no_submit_ready === true,
        capital_ready: result?.capital_ready === true,
        transaction_broadcast: false,
        error_code: errorCode,
        qualification_reasons: result?.qualification_reasons || [],
        account_readiness: result?.account_readiness || [],
        leg_evidence: (result?.evidence || []).map((item) => ({
          venue_id: item.venue_id,
          account_commitment: item.account_commitment,
          work_order_commitment: item.work_order_commitment,
          verification_commitment: item.verification_commitment,
          account_state: item.account_state,
          transaction_broadcast: item.transaction_broadcast === false && item.checks?.transaction_broadcast === false ? false : null,
          account_state_checked: item.checks?.account_state_checked === true,
          order_request_checked: item.checks?.order_request_built === true || item.checks?.order_request_checked === true,
        })),
      };
    }),
    failures,
    checked_at: new Date(observedAt).toISOString(),
  };
  const diagnostic = await storeCarryExecutionDiagnostic({
    state: dependencies.state,
    request: body,
    matrix,
    now_ms: observedAt,
    env: dependencies.env || process.env,
  });
  matrix.diagnostic_persisted = diagnostic.ok;
  if (diagnostic.ok) matrix.diagnostic = diagnostic.diagnostic;
  if (!matrix.no_submit_ready) return matrix;
  const stored = await storeCarryExecutionReadiness({
    state: dependencies.state,
    request: body,
    matrix,
    now_ms: observedAt,
    env: dependencies.env || process.env,
  });
  if (!stored.ok) {
    matrix.no_submit_ready = false;
    matrix.failures.push(stored.error || "carry_readiness_not_persisted");
  }
  matrix.readiness = stored.readiness;
  return matrix;
}

function carryPairFailureCode(reason) {
  const candidate = typeof reason?.code === "string"
    ? reason.code
    : typeof reason?.message === "string"
      ? reason.message
      : "";
  return /^[a-z][a-z0-9:_-]{2,180}$/.test(candidate)
    ? candidate
    : "carry_pair_check_failed";
}

function allVenuePairs(venues) {
  return venues.flatMap((left, leftIndex) => venues.slice(leftIndex + 1).map((right) => [left, right]));
}

function validCommitment(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{8,180}$/.test(value);
}

function validAccountStateEvidence(value, receipt) {
  return value?.venue_id === receipt?.venue_id
    && value?.account_commitment === receipt?.account_commitment
    && value?.verification_commitment === receipt?.verification_commitment
    && Number.isSafeInteger(value?.checked_at_ms)
    && value.checked_at_ms > 0
    && Number.isSafeInteger(value?.position_count)
    && value.position_count >= 0
    && Number.isSafeInteger(value?.open_order_count)
    && value.open_order_count >= 0
    && value.flat_zero_orders === (value.position_count === 0 && value.open_order_count === 0)
    && validCommitment(value?.account_state_commitment)
    && value.account_state_commitment === carryAccountStateCommitment(value);
}

function acceptableAuthorityBoundary(boundary) {
  if (!boundary || typeof boundary !== "object") return false;
  if (boundary.venue_native_trade_only === true) {
    return boundary.withdrawal_request_permitted !== true
      && boundary.non_owner_fund_movement_possible !== true;
  }
  return boundary.venue_native_trade_only === false &&
    boundary.withdrawal_request_permitted === false &&
    boundary.secure_withdrawal_destination === "owner_l1_only" &&
    boundary.owner_wallet_key_present === false &&
    boundary.non_owner_fund_movement_possible === false;
}

function trustedAccountFeeEvidence(account) {
  return typeof account?.fee_source === "string" && account.fee_source.length > 0
    && (account.fees_exact_for_account === true || account.fees_conservative_upper_bound === true);
}

export function modelCarryPairPreflight({
  evidence,
  notional_usd: notionalUsd,
  horizon_days: horizonDays,
  now_ms: nowMs,
  phase = "opening",
  max_contract_data_skew_ms: maxContractDataSkewMs = 2_000,
  max_index_price_divergence_bps: maxIndexPriceDivergenceBps = 25,
  max_mark_price_divergence_bps: maxMarkPriceDivergenceBps = 50,
  min_margin_runway_ms: minMarginRunwayMs = 6 * HOUR_MS,
  conservative_funding_rate_e12_by_venue: conservativeFundingRates = null,
}) {
  const notionalMicro = usdMicro(notionalUsd);
  const monitoring = phase === "monitoring";
  const accounts = evidence.map((leg) => accountReadiness(leg, notionalMicro));
  const openingCapitalPlan = compileOpeningCapitalPlan(evidence, accounts, notionalMicro, minMarginRunwayMs);
  const marginRunways = evidence.map((leg, index) => projectedMarginRunway(leg, accounts[index], notionalMicro, nowMs));
  const contracts = evidence.map((leg) => contractSpec(
    leg,
    notionalMicro,
    conservativeFundingRates?.[leg.venue_id],
  ));
  const costs = evidence.map((leg) => legCosts(leg, notionalMicro));
  const collateralBasis = collateralBasisModel(contracts[0].collateral_asset, contracts[1].collateral_asset);
  const connectionReady = evidence.every((leg, index) =>
    leg.receipt?.checks?.transaction_broadcast === false &&
    (leg.receipt?.checks?.order_request_built === true || leg.receipt?.checks?.order_request_checked === true) &&
    accounts[index].authorized
  );
  const capitalReady = accounts.every((account) => account.capital_ready);
  const monitoringReady = accounts.every((account) => account.monitoring_ready);
  const noSubmitReady = connectionReady && (!monitoring || monitoringReady);
  const evaluatedOpportunity = evaluateCarryOpportunity({
    version: 1,
    long_contract: contracts[0],
    short_contract: contracts[1],
    notional_micro_usdc: notionalMicro,
    capital_committed_micro_usdc: openingCapitalPlan.total_required_opening_collateral_micro_usdc,
    horizon_ms: Math.round(horizonDays * DAY_MS),
    long_costs: costs[0],
    short_costs: costs[1],
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 10,
    collateral_basis_risk_bps: collateralBasis.risk_bps,
    min_expected_net_benefit_bps: 5,
    min_margin_runway_ms: minMarginRunwayMs,
    margin_runways: marginRunways.map((runway, index) => ({
      venue_id: runway.venue_id,
      status: (monitoring ? accounts[index].monitoring_ready : accounts[index].capital_ready) ? runway.status : "breached",
      runway_ms: runway.runway_ms,
    })),
    now_ms: nowMs,
    max_data_age_ms: 60_000,
    max_contract_data_skew_ms: maxContractDataSkewMs,
    max_index_price_divergence_bps: maxIndexPriceDivergenceBps,
    max_mark_price_divergence_bps: maxMarkPriceDivergenceBps,
  });
  const depthReasons = costs.flatMap((cost) => cost.depth_impact.flatMap((impact) =>
    impact.status === "sufficient" ? [] : [`depth_${impact.status}:${cost.venue_id}:${impact.phase}`]
  ));
  const opportunity = Object.freeze({
    ...evaluatedOpportunity,
    eligible: evaluatedOpportunity.eligible && depthReasons.length === 0,
    reasons: Object.freeze([...new Set([...evaluatedOpportunity.reasons, ...depthReasons])]),
    depth_impact: Object.freeze(costs.map((cost) => Object.freeze({
      venue_id: cost.venue_id,
      observations: Object.freeze(cost.depth_impact),
    }))),
  });
  return {
    checked_at_ms: nowMs,
    connection_ready: connectionReady,
    no_submit_ready: noSubmitReady,
    capital_ready: capitalReady,
    monitoring_ready: monitoringReady,
    opening_capital_plan: openingCapitalPlan,
    opportunity: Object.freeze({
      ...opportunity,
      collateral_basis_mode: collateralBasis.mode,
      long_collateral_asset: contracts[0].collateral_asset,
      short_collateral_asset: contracts[1].collateral_asset,
    }),
    collateral_basis: collateralBasis,
    margin_runways: marginRunways,
    account_readiness: accounts,
  };
}

function compileOpeningCapitalPlan(evidence, accounts, notionalMicro, minMarginRunwayMs) {
  const legs = accounts.map((account, index) => {
    const stress = stressAdjustedCapitalTarget(evidence[index], notionalMicro, minMarginRunwayMs);
    return Object.freeze({
      venue_id: account.venue_id,
      available_balance_micro_usdc: account.available_balance_micro_usdc,
      required_opening_collateral_micro_usdc: account.required_opening_collateral_micro_usdc,
      opening_collateral_shortfall_micro_usdc: account.opening_collateral_shortfall_micro_usdc,
      excess_collateral_micro_usdc: Math.max(
        0,
        account.available_balance_micro_usdc - account.required_opening_collateral_micro_usdc,
      ),
      recommended_action: account.opening_collateral_shortfall_micro_usdc > 0
        ? "owner_fund_venue"
        : "none",
      stress_adjusted_target_collateral_micro_usdc: stress.target_collateral_micro_usdc,
      potential_releasable_collateral_micro_usdc: account.opening_collateral_shortfall_micro_usdc === 0
        ? stress.potential_releasable_collateral_micro_usdc
        : 0,
      owner_maximum_stress_adjusted_leverage: stress.maximum_safe_leverage,
      owner_leverage_configuration_required: stress.maximum_safe_leverage > account.execution_leverage,
    });
  });
  const total = (field) => legs.reduce((sum, leg) => sum + leg[field], 0);
  const totalShortfall = total("opening_collateral_shortfall_micro_usdc");
  return Object.freeze({
    version: 1,
    status: totalShortfall > 0 ? "owner_funding_required" : "ready",
    total_available_balance_micro_usdc: total("available_balance_micro_usdc"),
    total_required_opening_collateral_micro_usdc: total("required_opening_collateral_micro_usdc"),
    total_opening_collateral_shortfall_micro_usdc: totalShortfall,
    total_excess_collateral_micro_usdc: total("excess_collateral_micro_usdc"),
    total_stress_adjusted_target_collateral_micro_usdc: total("stress_adjusted_target_collateral_micro_usdc"),
    total_potential_releasable_collateral_micro_usdc: total("potential_releasable_collateral_micro_usdc"),
    proposal_only: true,
    live_execution_leverage_unchanged: true,
    owner_only_funding: true,
    automatic_transfer_permitted: false,
    transaction_broadcast: false,
    legs: Object.freeze(legs),
  });
}

function stressAdjustedCapitalTarget(leg, notionalMicro, minMarginRunwayMs) {
  const maintenance = microFromBps(notionalMicro, leg.snapshot.maintenance_margin_bps);
  const safetyBuffer = Math.max(10_000_000, microFromBps(notionalMicro, 1_000));
  const stressLossPerHour = microFromBps(notionalMicro, 100);
  const fundingDebitBps = leg.side === "buy"
    ? Math.max(0, Math.ceil(leg.snapshot.funding_rate_e12_per_interval / 100_000_000))
    : Math.max(0, Math.ceil(-leg.snapshot.funding_rate_e12_per_interval / 100_000_000));
  const fundingDebitPerHour = Math.ceil(
    microFromBps(notionalMicro, fundingDebitBps) * HOUR_MS / leg.snapshot.funding_interval_ms,
  );
  const runwayReserve = Math.ceil(
    (stressLossPerHour + fundingDebitPerHour) * minMarginRunwayMs / HOUR_MS,
  );
  const venueMinimum = microFromBps(notionalMicro, leg.snapshot.initial_margin_bps);
  const target = Math.min(notionalMicro, Math.max(venueMinimum, maintenance + safetyBuffer + runwayReserve));
  return Object.freeze({
    target_collateral_micro_usdc: target,
    potential_releasable_collateral_micro_usdc: Math.max(0, notionalMicro - target),
    maximum_safe_leverage: Math.max(1, Math.floor(notionalMicro / target)),
  });
}

function collateralBasisModel(longAsset, shortAsset) {
  if (longAsset === shortAsset) {
    return Object.freeze({ supported: true, mode: "same_collateral", risk_bps: 0 });
  }
  const stablecoins = new Set(["USDC", "USDT"]);
  if (stablecoins.has(longAsset) && stablecoins.has(shortAsset)) {
    return Object.freeze({ supported: true, mode: "usdc_usdt_stress_buffer", risk_bps: 50 });
  }
  return Object.freeze({ supported: false, mode: "unsupported_cross_collateral", risk_bps: 10_000 });
}

function contractSpec(leg, notionalMicro, conservativeFundingRate) {
  const snapshot = leg.snapshot;
  const shape = leg.receipt?.order_shape || {};
  const account = leg.account || {};
  const makerE6 = signedFeeE6Bps(account.maker_fee_bps);
  const takerE6 = feeE6Bps(account.taker_fee_bps);
  return {
    version: 1,
    venue_id: leg.venue_id,
    contract_id: snapshot.contract_id,
    economic_equivalence_id: snapshot.economic_equivalence_id,
    asset: snapshot.asset,
    market: snapshot.market,
    quote_asset: snapshot.quote_asset,
    collateral_asset: snapshot.collateral_asset,
    contract_type: snapshot.contract_type,
    mark_price_e8: snapshot.mark_price_e8,
    index_price_e8: snapshot.index_price_e8,
    funding_rate_bps_per_interval: Math.trunc(
      (Number.isSafeInteger(conservativeFundingRate)
        ? conservativeFundingRate
        : snapshot.funding_rate_e12_per_interval) / 100_000_000,
    ),
    funding_rate_e12_per_interval: Number.isSafeInteger(conservativeFundingRate)
      ? conservativeFundingRate
      : snapshot.funding_rate_e12_per_interval,
    funding_interval_ms: snapshot.funding_interval_ms,
    maker_fee_bps: Math.ceil(account.maker_fee_bps),
    taker_fee_bps: Math.ceil(account.taker_fee_bps),
    maker_fee_e6_bps: makerE6,
    taker_fee_e6_bps: takerE6,
    minimum_notional_micro_usdc: Math.min(notionalMicro, positiveInteger(shape.notional_micro_usdc, "carry_order_shape_notional")),
    quantity_step_e8: positiveInteger(shape.quantity_step_e8 ?? snapshot.quantity_step_e8, "carry_quantity_step_unavailable"),
    price_tick_e8: positiveInteger(shape.price_tick_e8 ?? snapshot.price_tick_e8, "carry_price_tick_unavailable"),
    as_of_ms: snapshot.as_of_ms,
  };
}

function legCosts(leg, notionalMicro) {
  const fee = feeE6Bps(leg.account?.taker_fee_bps);
  const snapshot = leg.snapshot;
  const exitSide = leg.side === "buy" ? "sell" : "buy";
  const entry = estimatePerpDepthExecution({
    side: leg.side,
    depth_levels: leg.side === "buy" ? snapshot.depth_asks : snapshot.depth_bids,
    fallback_price_e8: leg.side === "buy" ? snapshot.best_ask_e8 : snapshot.best_bid_e8,
    target_notional_micro_usdc: notionalMicro,
    phase: "entry",
  });
  const exit = estimatePerpDepthExecution({
    side: exitSide,
    depth_levels: exitSide === "buy" ? snapshot.depth_asks : snapshot.depth_bids,
    fallback_price_e8: exitSide === "buy" ? snapshot.best_ask_e8 : snapshot.best_bid_e8,
    target_notional_micro_usdc: notionalMicro,
    phase: "exit",
  });
  return {
    venue_id: leg.venue_id,
    entry_fee_e6_bps: fee,
    exit_fee_e6_bps: fee,
    entry_slippage_e6_bps: adverseExecutionSlippageE6Bps({
      side: leg.side,
      mark_price_e8: snapshot.mark_price_e8,
      execution_price_e8: entry.execution_price_e8,
    }),
    exit_slippage_e6_bps: adverseExecutionSlippageE6Bps({
      side: exitSide,
      mark_price_e8: snapshot.mark_price_e8,
      execution_price_e8: exit.execution_price_e8,
    }),
    latency_penalty_bps: 1,
    gas_micro_usdc: 0,
    depth_impact: Object.freeze([entry, exit]),
  };
}

function accountReadiness(leg, notionalMicro) {
  const account = leg.account || {};
  const available = usdMicro(account.available_balance);
  const balance = usdMicro(account.margin_balance);
  const venueMinimumMargin = microFromBps(notionalMicro, leg.snapshot.initial_margin_bps);
  const requiredOpeningCollateral = notionalMicro;
  const openingCollateralShortfall = Math.max(0, requiredOpeningCollateral - available);
  const accountSnapshotReady = leg.venue_id !== "hyperliquid" || (
    leg.account_snapshot?.status === "ready_to_trade" && leg.account_snapshot?.trading_enabled === true
  );
  const rawPositionCount = leg.venue_id === "hyperliquid"
    ? leg.account_snapshot?.position_count
    : account.position_count;
  const rawOpenOrderCount = leg.venue_id === "hyperliquid"
    ? leg.account_snapshot?.open_order_count
    : account.open_order_count;
  const positionCount = Number(rawPositionCount);
  const openOrderCount = Number(rawOpenOrderCount);
  const countsKnown = rawPositionCount !== undefined
    && rawOpenOrderCount !== undefined
    && Number.isSafeInteger(positionCount)
    && positionCount >= 0
    && Number.isSafeInteger(openOrderCount)
    && openOrderCount >= 0;
  const flat = countsKnown && positionCount === 0 && openOrderCount === 0;
  const authorized = leg.receipt?.checks?.transaction_broadcast === false && account.can_trade === true && accountSnapshotReady;
  return {
    venue_id: leg.venue_id,
    account_commitment: leg.account_commitment,
    authorized,
    flat_zero_orders: flat,
    position_count: countsKnown ? positionCount : null,
    open_order_count: countsKnown ? openOrderCount : null,
    capital_ready: authorized && flat && openingCollateralShortfall === 0,
    monitoring_ready: authorized && balance > 0,
    available_balance_micro_usdc: available,
    margin_balance_micro_usdc: balance,
    venue_minimum_margin_micro_usdc: venueMinimumMargin,
    required_opening_collateral_micro_usdc: requiredOpeningCollateral,
    opening_collateral_shortfall_micro_usdc: openingCollateralShortfall,
    execution_leverage: 1,
    owner_only_funding: true,
  };
}

function projectedMarginRunway(leg, readiness, notionalMicro, nowMs) {
  const account = leg.account || {};
  const reportedMaintenance = usdMicro(account.maintenance_margin);
  const contractMaintenanceFloor = microFromBps(notionalMicro, leg.snapshot.maintenance_margin_bps);
  const maintenance = Math.max(reportedMaintenance, contractMaintenanceFloor);
  const safetyBuffer = Math.max(10_000_000, microFromBps(notionalMicro, 1_000));
  const projectedHeadroom = Math.max(0, readiness.margin_balance_micro_usdc - maintenance - safetyBuffer);
  const fundingDebit = leg.side === "buy"
    ? Math.max(0, Math.ceil(leg.snapshot.funding_rate_e12_per_interval / 100_000_000))
    : Math.max(0, Math.ceil(-leg.snapshot.funding_rate_e12_per_interval / 100_000_000));
  const runway = calculateMarginRunway({
    version: 1,
    venue_id: leg.venue_id,
    equity_micro_usdc: readiness.margin_balance_micro_usdc,
    maintenance_margin_micro_usdc: maintenance,
    safety_buffer_micro_usdc: safetyBuffer,
    position_notional_micro_usdc: notionalMicro,
    stress_loss_bps_per_hour: 100,
    funding_debit_bps_per_interval: fundingDebit,
    funding_interval_ms: leg.snapshot.funding_interval_ms,
    owner_transfer_latency_ms: 2 * HOUR_MS,
    owner_response_buffer_ms: HOUR_MS,
    liquidation_distance_bps: Math.min(100_000, Math.floor(projectedHeadroom * 10_000 / notionalMicro)),
    minimum_liquidation_distance_bps: 1_000,
    as_of_ms: nowMs,
  });
  return Object.freeze({
    ...runway,
    account_commitment: readiness.account_commitment,
    reported_maintenance_margin_micro_usdc: reportedMaintenance,
    contract_maintenance_floor_micro_usdc: contractMaintenanceFloor,
    maintenance_evidence_basis: reportedMaintenance >= contractMaintenanceFloor
      ? "venue_account_total"
      : "contract_spec_floor",
  });
}

function orderInstruction(leg, notionalUsd) {
  const snapshot = leg.snapshot;
  if (leg.venue_id === "hyperliquid") {
    return {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "hyperliquid",
      operation_class: "limit_order",
      order: {
        market: snapshot.asset,
        side: leg.side,
        quote_size: String(notionalUsd),
        size_mode: "quote",
        order_type: "limit",
        live_order_mode: "tiny_fill",
        max_slippage_bps: "50",
        tif: "Ioc",
        reduce_only: false,
        leverage: 1,
        margin_mode: "cross",
      },
    };
  }
  const priceE8 = leg.side === "buy" ? snapshot.best_ask_e8 : snapshot.best_bid_e8;
  if (!(priceE8 > 0) || !(snapshot.quantity_step_e8 > 0) || !(snapshot.price_tick_e8 > 0)) {
    throw carryError(`carry_${leg.venue_id}_order_shape_unavailable`, 422);
  }
  const price = priceE8 / 100_000_000;
  const step = snapshot.quantity_step_e8 / 100_000_000;
  const base = Math.floor((notionalUsd / price) / step) * step;
  if (!(price > 0) || !(step > 0) || !(base > 0)) throw carryError(`carry_${leg.venue_id}_order_shape_unavailable`, 422);
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: leg.venue_id,
    operation_class: "limit_order",
    order: {
      market: snapshot.asset,
      side: leg.side,
      base_size: decimalString(base, step),
      quote_size: String(base * price),
      limit_price: decimalString(price, snapshot.price_tick_e8 / 100_000_000),
      order_type: "limit",
      size_mode: "base",
      tif: "Ioc",
      reduce_only: false,
      leverage: 1,
      margin_mode: "cross",
    },
  };
}

function selectSnapshot(snapshots, asset, venueId, nowMs) {
  const snapshot = snapshots.find((item) => item.asset === asset);
  const verification = verifyCarryShadowSnapshot(snapshot, {
    venue_id: venueId,
    asset,
    now_ms: nowMs,
    max_age_ms: 60_000,
  });
  if (!verification.ok) {
    throw carryError(`carry_shadow_unavailable:${venueId}:${verification.failures[0]}`, 409);
  }
  return snapshot;
}

function venueAccess(body, venueId) {
  const access = body.venue_access?.[venueId];
  if (!access || access.status !== "ready") throw carryError(`carry_account_not_ready:${venueId}`, 409);
  if (access.owner_commitment !== body.owner_commitment) throw carryError(`carry_account_owner_mismatch:${venueId}`, 403);
  return access;
}

function executionFromAccess(access) {
  return {
    execution_mode: "byo_api_key",
    vault_commitment: access.vault_commitment,
    encrypted_vault_commitment: access.encrypted_vault_commitment,
    encrypted_execution_vault: access.encrypted_execution_vault,
    account_commitment: access.account_commitment,
    owner_commitment: access.owner_commitment,
  };
}

function bindAccountStateEvidence(account, leg) {
  const evidence = {
    venue_id: leg.venue_id,
    account_commitment: leg.account_commitment,
    verification_commitment: leg.receipt.verification_commitment,
    checked_at_ms: leg.account_checked_at_ms,
    position_count: account.position_count,
    open_order_count: account.open_order_count,
    flat_zero_orders: account.flat_zero_orders,
  };
  return {
    ...account,
    account_state_checked_at_ms: evidence.checked_at_ms,
    account_state_commitment: carryAccountStateCommitment(evidence),
  };
}

function publicEvidence(leg, qualification, accountReadiness) {
  const accountState = {
    venue_id: leg.venue_id,
    account_commitment: leg.account_commitment,
    verification_commitment: leg.receipt.verification_commitment,
    checked_at_ms: accountReadiness.account_state_checked_at_ms,
    position_count: accountReadiness.position_count,
    open_order_count: accountReadiness.open_order_count,
    flat_zero_orders: accountReadiness.flat_zero_orders,
    account_state_commitment: accountReadiness.account_state_commitment,
  };
  return {
    venue_id: leg.venue_id,
    side: leg.side,
    status: leg.receipt.status,
    work_order_commitment: leg.receipt.work_order_commitment,
    verification_commitment: leg.receipt.verification_commitment,
    account_commitment: leg.receipt.account_commitment,
    account_state: accountState,
    order_shape: leg.receipt.order_shape,
    reference_mark_price_e8: leg.snapshot.mark_price_e8,
    reference_price_source: "verified_pre_submit_mark",
    checks: {
      ...leg.receipt.checks,
      account_state_checked: leg.receipt?.checks?.account_state_checked === true || Boolean(leg.account),
    },
    authority_boundary: leg.receipt.authority_boundary || null,
    fee_evidence: {
      source: leg.account?.fee_source || null,
      exact_for_account: leg.account?.fees_exact_for_account === true,
      conservative_upper_bound: leg.account?.fees_conservative_upper_bound === true,
    },
    qualification: qualification ? {
      proven: qualification.proven === true,
      source: qualification.source || null,
      reasons: [...(qualification.reasons || [])],
      adapter_id: qualification.adapter_id || null,
      image_digest: qualification.image_digest || null,
      verified_at_ms: qualification.verified_at_ms || null,
      evidence_commitment: qualification.evidence_commitment || null,
    } : null,
    transaction_broadcast: false,
  };
}

function notionalBucket(value) {
  for (const bucket of [5, 10, 25, 50, 100, 250, 500, 1_000]) if (value <= bucket) return String(bucket);
  throw carryError("carry_notional_above_pilot_limit", 422);
}

function decimalString(value, step) {
  const decimals = Math.max(0, Math.min(8, Math.ceil(-Math.log10(step))));
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

function feeE6Bps(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw carryError("carry_account_fee_unavailable", 409);
  return Math.round(number * 1_000_000);
}

function signedFeeE6Bps(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw carryError("carry_account_fee_unavailable", 409);
  return Math.round(number * 1_000_000);
}

function usdMicro(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number * 1_000_000);
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw carryError(code, 409);
  return value;
}

function microFromBps(amount, bps) {
  return Math.ceil(amount * bps / 10_000);
}

function carryMarketDataSkewMs(env) {
  const parsed = Number.parseInt(String(env.PRIVATE_AGENT_CARRY_MAX_MARKET_DATA_SKEW_MS || ""), 10);
  return Number.isSafeInteger(parsed) ? Math.max(50, Math.min(60_000, parsed)) : 2_000;
}

function carryBasisBudgetBps(env, name, fallback) {
  const parsed = Number.parseInt(String(env[name] || ""), 10);
  return Number.isSafeInteger(parsed) ? Math.max(0, Math.min(10_000, parsed)) : fallback;
}

function carryError(code, status) {
  return Object.assign(new Error(code), { code, status });
}
