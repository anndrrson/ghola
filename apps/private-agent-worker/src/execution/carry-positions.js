import { createHash } from "node:crypto";
import {
  CARRY_EXECUTION_VENUES,
  advanceCarryPosition,
  appendCarryValueLedgerEntry,
  carryCollateralReviewMessage,
  compileCarryCapitalActionPlan,
  compileCarryCollateralReview,
  compileCarryPortfolioCapitalPlan,
  compileCarryPortfolioValueReport,
  createCarryValueLedger,
  finalizeCarryValueLedger,
  normalizeCarryCollateralReviewAuthorization,
} from "@ghola/execution-core";
import { hashMessage, recoverMessageAddress } from "viem";
import { preflightCarryPair } from "./carry-preflight.js";
import { verifyCarryRiskMandateAuthorization } from "./carry-mandate.js";
import { hasExactCarryFlatReconciliation } from "./carry-reconciliation.js";
import { listAllCarryPositionRecords } from "./carry-record-scan.js";
import { createCarryLoopSupervisor, disabledCarryLoopHealth } from "./carry-loop-supervisor.js";
import { loadCarryTransferRouteEvidence, observeCarryTransferRoutes } from "./carry-transfer-routes.js";
import { runtimeCarryQualificationImageDigest } from "./carry-qualification.js";
import { verifyCarryCreationOpportunityAuthentication } from "./carry-opportunity-authentication.js";

const OWNER = /^[A-Za-z0-9:_-]{8,180}$/;

export async function createStoredCarryPosition({
  state,
  owner_commitment: ownerCommitment,
  position_input: positionInput,
  opportunity,
  monitoring_context: monitoringContext,
  qualification_pilot: qualificationPilot = null,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  const mandate = await verifyCarryRiskMandateAuthorization({
    owner_commitment: ownerCommitment,
    position_input: positionInput,
    now_ms: nowMs,
  });
  if (!mandate.ok) return mandate;
  const workerOpportunity = verifyCarryCreationOpportunityAuthentication({
    owner_commitment: ownerCommitment,
    opportunity,
    now_ms: nowMs,
  });
  if (!workerOpportunity.ok) return workerOpportunity;
  const lineage = await validateMigrationLineage({
    state,
    ownerCommitment,
    position: mandate.position,
    opportunity,
  });
  if (!lineage.ok) return lineage;
  const normalizedPilot = normalizeQualificationPilot({ qualificationPilot, positionInput, opportunity, env });
  if (!normalizedPilot.ok) return denied(normalizedPilot.error);
  const opportunityError = validateCreationOpportunity(positionInput, opportunity, nowMs, normalizedPilot.value);
  if (opportunityError) return denied(opportunityError);
  if (mandate.position.opportunity_evidence_commitment !== workerOpportunity.authentication.evidence_commitment) {
    return denied("carry_opportunity_mandate_mismatch");
  }
  const normalizedMonitoring = normalizeMonitoringContext(monitoringContext, mandate.position, ownerCommitment);
  if (!normalizedMonitoring.ok) return normalizedMonitoring;
  try {
    const position = mandate.position;
    const ledger = createCarryValueLedger({
      version: 1,
      position_id: position.position_id,
      modeled: {
        gross_funding_micro_usdc: opportunity.projected_gross_funding_micro_usdc,
        trading_cost_micro_usdc: opportunity.projected_trading_cost_micro_usdc,
        capital_cost_micro_usdc: opportunity.projected_capital_cost_micro_usdc,
        risk_buffer_micro_usdc: opportunity.risk_buffer_micro_usdc,
        ...modeledValueBreakdown(opportunity),
      },
      now_ms: nowMs,
    });
    const record = {
      version: 1,
      record_version: 1,
      owner_commitment: ownerCommitment,
      position,
      opportunity: publicOpportunity(opportunity),
      opportunity_provenance: workerOpportunity.authentication,
      opportunity_authentication_material: opportunityAuthenticationMaterial(opportunity),
      monitoring_context: normalizedMonitoring.context,
      value_ledger: ledger,
      value_evidence: {
        entry: { status: "pending_exact_receipts" },
        funding: {
          status: "pending_authoritative_settlement_history",
          cursor_ms_by_venue: {
            [position.long_venue_id]: nowMs,
            [position.short_venue_id]: nowMs,
          },
        },
        exit: { status: "pending_exact_receipts" },
        costs_complete: false,
      },
      ...(normalizedPilot.value ? { qualification_pilot: normalizedPilot.value } : {}),
      lifecycle_events: [],
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    };
    const stored = await state.putCarryPositionRecord(record, { expected_version: null });
    return publicStoredResult(stored);
  } catch (error) {
    return denied(typeof error?.code === "string" ? error.code : "carry_position_invalid");
  }
}

export function verifyStoredCarryOpportunityBinding({ record, require_material: requireMaterial = true }) {
  const material = record?.opportunity_authentication_material;
  if (!material || typeof material !== "object" || Array.isArray(material)) {
    return requireMaterial
      ? denied("carry_stored_opportunity_material_missing")
      : { ok: true, legacy: true };
  }
  const provenance = record?.opportunity_provenance;
  const checkedAtMs = provenance?.checked_at_ms;
  const verified = verifyCarryCreationOpportunityAuthentication({
    owner_commitment: record?.owner_commitment,
    opportunity: { ...material, worker_authentication: provenance },
    now_ms: checkedAtMs,
  });
  if (!verified.ok) return denied(`carry_stored_opportunity_${verified.error}`);
  if (record?.position?.opportunity_evidence_commitment !== verified.authentication.evidence_commitment) {
    return denied("carry_stored_opportunity_mandate_mismatch");
  }
  if (JSON.stringify(publicOpportunity(material)) !== JSON.stringify(record?.opportunity)) {
    return denied("carry_stored_opportunity_projection_mismatch");
  }
  return { ok: true, authentication: verified.authentication };
}

function validateCreationOpportunity(positionInput, opportunity, nowMs, qualificationPilot = null) {
  if (!opportunity || opportunity.version !== 1 || opportunity.eligible !== true || !Array.isArray(opportunity.reasons) || opportunity.reasons.length > 0) return "carry_opportunity_not_eligible";
  if (opportunity.live_creation_ready !== true && qualificationPilot === null) return "carry_live_creation_not_qualified";
  if (opportunity.all_venues_ready !== true) return "carry_venue_accounts_not_ready";
  if (opportunity.asset !== positionInput?.asset
    || opportunity.long_venue_id !== positionInput?.long_venue_id
    || opportunity.short_venue_id !== positionInput?.short_venue_id
    || opportunity.long_venue_id === opportunity.short_venue_id) return "carry_opportunity_position_mismatch";
  if (opportunity.notional_micro_usdc !== positionInput?.target_notional_micro_usdc) return "carry_opportunity_notional_mismatch";
  const maxAgeMs = positionInput?.risk_mandate?.max_data_age_ms;
  if (!Number.isInteger(opportunity.checked_at_ms)
    || !Number.isInteger(maxAgeMs)
    || maxAgeMs <= 0
    || opportunity.checked_at_ms > nowMs + 5_000
    || nowMs - opportunity.checked_at_ms > maxAgeMs) return "carry_opportunity_stale";
  const minRunwayMs = positionInput?.risk_mandate?.min_margin_runway_ms;
  if (!Number.isInteger(minRunwayMs)
    || !Number.isInteger(opportunity.long_margin_runway_ms)
    || !Number.isInteger(opportunity.short_margin_runway_ms)
    || opportunity.long_margin_runway_ms < minRunwayMs
    || opportunity.short_margin_runway_ms < minRunwayMs) return "carry_margin_runway_insufficient";
  if (!Number.isInteger(opportunity.contract_data_skew_ms)
    || !Number.isInteger(opportunity.max_contract_data_skew_ms)
    || opportunity.contract_data_skew_ms < 0
    || opportunity.max_contract_data_skew_ms < 0
    || opportunity.max_contract_data_skew_ms > maxAgeMs) return "carry_market_data_skew_invalid";
  if (opportunity.contract_data_skew_ms > opportunity.max_contract_data_skew_ms) {
    return "carry_market_data_skew_exceeded";
  }
  if (positionInput?.risk_mandate?.max_contract_data_skew_ms !== opportunity.max_contract_data_skew_ms) {
    return "carry_unsigned_contract_data_skew_limit";
  }
  const contractBasisValues = [
    opportunity.index_price_divergence_bps,
    opportunity.mark_price_divergence_bps,
    opportunity.max_index_price_divergence_bps,
    opportunity.max_mark_price_divergence_bps,
  ];
  if (!contractBasisValues.every((value) => Number.isInteger(value) && value >= 0 && value <= 10_000)) {
    return "carry_contract_basis_invalid";
  }
  if (opportunity.index_price_divergence_bps > opportunity.max_index_price_divergence_bps
    || opportunity.mark_price_divergence_bps > opportunity.max_mark_price_divergence_bps) {
    return "carry_contract_basis_exceeded";
  }
  if (positionInput?.risk_mandate?.max_index_price_divergence_bps !== opportunity.max_index_price_divergence_bps
    || positionInput?.risk_mandate?.max_mark_price_divergence_bps !== opportunity.max_mark_price_divergence_bps) {
    return "carry_unsigned_contract_basis_limit";
  }
  if (typeof opportunity.economic_equivalence_id !== "string"
    || opportunity.economic_equivalence_id.length < 8
    || opportunity.contract_type !== "linear_perp"
    || !["USD", "USDC", "USDT"].includes(opportunity.long_quote_asset)
    || !["USD", "USDC", "USDT"].includes(opportunity.short_quote_asset)) {
    return "carry_contract_equivalence_evidence_invalid";
  }
  const modeledAmounts = [
    opportunity.notional_micro_usdc,
    opportunity.capital_committed_micro_usdc,
    opportunity.projected_gross_funding_micro_usdc,
    opportunity.projected_trading_cost_micro_usdc,
    opportunity.projected_capital_cost_micro_usdc,
    opportunity.risk_buffer_micro_usdc,
  ];
  if (!modeledAmounts.every((value) => Number.isInteger(value) && value >= 0)
    || !Number.isInteger(opportunity.horizon_ms)
    || opportunity.horizon_ms <= 0
    || !Number.isInteger(opportunity.break_even_ms)
    || opportunity.break_even_ms < 0
    || !Number.isInteger(opportunity.projected_net_value_micro_usdc)
    || opportunity.projected_net_value_micro_usdc <= 0
    || !Number.isInteger(opportunity.projected_net_value_bps)
    || opportunity.projected_net_value_bps < positionInput?.risk_mandate?.min_expected_net_benefit_bps
    || opportunity.break_even_ms > opportunity.horizon_ms) return "carry_expected_value_insufficient";
  const breakdown = modeledValueBreakdown(opportunity);
  const breakdownFields = [
    "funding_credit_micro_usdc",
    "funding_debit_micro_usdc",
    "trading_fee_micro_usdc",
    "slippage_micro_usdc",
    "gas_micro_usdc",
    "latency_buffer_micro_usdc",
  ];
  const sourceFields = breakdownFields.map((field) => `projected_${field}`);
  const suppliedBreakdownCount = sourceFields.filter((field) => opportunity[field] !== undefined).length;
  if (suppliedBreakdownCount !== 0 && suppliedBreakdownCount !== sourceFields.length) {
    return "carry_value_breakdown_incomplete";
  }
  if (suppliedBreakdownCount > 0 && (
    Object.keys(breakdown).length !== breakdownFields.length
    || breakdown.funding_credit_micro_usdc - breakdown.funding_debit_micro_usdc !== opportunity.projected_gross_funding_micro_usdc
    || breakdown.trading_fee_micro_usdc + breakdown.slippage_micro_usdc
      + breakdown.gas_micro_usdc + breakdown.latency_buffer_micro_usdc !== opportunity.projected_trading_cost_micro_usdc
  )) return "carry_value_breakdown_invalid";
  return null;
}

async function validateMigrationLineage({ state, ownerCommitment, position, opportunity }) {
  const parentId = position?.migration_parent_position_id;
  const candidateId = position?.migration_candidate_id;
  if (!parentId && !candidateId) return { ok: true };
  if (!parentId || !candidateId || parentId === position.position_id) {
    return denied("carry_migration_lineage_invalid");
  }
  const parent = await state.getCarryPositionRecord(parentId);
  if (!parent || parent.owner_commitment !== ownerCommitment) return denied("carry_migration_parent_not_found");
  const pending = parent.position?.pending_migration;
  const selected = pending?.selected_candidate;
  const finalState = parent.final_reconciliation_evidence;
  const parentPair = [parent.position?.long_venue_id, parent.position?.short_venue_id];
  if (parent.position?.status !== "reconciled"
    || pending?.status !== "owner_signature_required"
    || !hasExactCarryFlatReconciliation(finalState, parentPair, reconciliationBinding(parent))) {
    return denied("carry_migration_parent_not_flat");
  }
  if (selected?.candidate_id !== candidateId
    || selected?.long_venue_id !== position.long_venue_id
    || selected?.short_venue_id !== position.short_venue_id
    || parent.position.asset !== position.asset
    || parent.position.target_notional_micro_usdc !== position.target_notional_micro_usdc
    || parent.opportunity?.economic_equivalence_id !== opportunity?.economic_equivalence_id) {
    return denied("carry_migration_candidate_mismatch");
  }
  const existing = await listAllCarryPositionRecords({ state, owner_commitment: ownerCommitment });
  if (existing.some((record) => record.position?.migration_parent_position_id === parentId
    && record.position?.position_id !== position.position_id)) {
    return denied("carry_migration_replacement_exists");
  }
  return { ok: true };
}

function normalizeQualificationPilot({ qualificationPilot, positionInput, opportunity, env }) {
  if (qualificationPilot === null || qualificationPilot === undefined) return { ok: true, value: null };
  if (qualificationPilot?.enabled !== true) return { ok: false, error: "carry_qualification_pilot_invalid" };
  if (env.PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED !== "true") return { ok: false, error: "carry_qualification_pilot_disabled" };
  const candidate = String(qualificationPilot.candidate_venue_id || "");
  if (opportunity?.qualification_pilot_ready !== true
    || opportunity?.qualification_pilot_candidate_venue_id !== candidate
    || ![positionInput?.long_venue_id, positionInput?.short_venue_id].includes(candidate)) {
    return { ok: false, error: "carry_qualification_pilot_not_ready" };
  }
  const cap = boundedPilotNotional(env.PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC);
  if (!Number.isSafeInteger(positionInput?.target_notional_micro_usdc) || positionInput.target_notional_micro_usdc > cap) {
    return { ok: false, error: "carry_qualification_pilot_notional_exceeds_cap" };
  }
  return {
    ok: true,
    value: Object.freeze({
      version: 1,
      status: "pending",
      candidate_venue_id: candidate,
      max_notional_micro_usdc: cap,
      requires_separate_live_confirmation: true,
    }),
  };
}

function boundedPilotNotional(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) ? Math.max(5_000_000, Math.min(100_000_000, parsed)) : 25_000_000;
}

export async function advanceStoredCarryPosition({ state, position_id: positionId, owner_commitment: ownerCommitment, event, now_ms: nowMs = Date.now() }) {
  const record = await ownedRecord(state, positionId, ownerCommitment);
  if (!record.ok) return record;
  const advanced = advanceCarryPosition({ position: record.record.position, event, now_ms: nowMs });
  if (!advanced.ok) return advanced;
  if (advanced.duplicate) return { ok: true, duplicate: true, record: publicRecord(record.record) };
  const recordedEvent = { ...event, recorded_at_ms: nowMs };
  const next = {
    ...record.record,
    position: advanced.position,
    lifecycle_events: [...record.record.lifecycle_events, recordedEvent].slice(-256),
    ...(event.type === "observation" ? { latest_observation: publicObservation(recordedEvent) } : {}),
    ...((event.type === "exit_reconciled" || (
      event.type === "reconciliation_complete"
      && event.known_flat === true
      && event.open_order_count === 0
    )) ? { final_reconciliation_evidence: publicReconciliationEvidence(event, nowMs) } : {}),
    updated_at: new Date(nowMs).toISOString(),
  };
  return storeUpdate(state, next, record.record.record_version);
}

export async function requestStoredCarryPositionExit({
  state,
  position_id: positionId,
  owner_commitment: ownerCommitment,
  event_id: eventId,
  sequence,
  now_ms: nowMs = Date.now(),
}) {
  return advanceStoredCarryPosition({
    state,
    position_id: positionId,
    owner_commitment: ownerCommitment,
    event: {
      version: 1,
      event_id: eventId,
      sequence,
      type: "manual_exit_requested",
    },
    now_ms: nowMs,
  });
}

export async function appendStoredCarryValueEntry({ state, position_id: positionId, owner_commitment: ownerCommitment, entry, now_ms: nowMs = Date.now() }) {
  const record = await ownedRecord(state, positionId, ownerCommitment);
  if (!record.ok) return record;
  const appended = appendCarryValueLedgerEntry({ ledger: record.record.value_ledger, entry, now_ms: nowMs });
  if (!appended.ok) return appended;
  if (appended.duplicate) return { ok: true, duplicate: true, record: publicRecord(record.record) };
  return storeUpdate(state, {
    ...record.record,
    value_ledger: appended.ledger,
    updated_at: new Date(nowMs).toISOString(),
  }, record.record.record_version);
}

export async function finalizeStoredCarryValueLedger({ state, position_id: positionId, owner_commitment: ownerCommitment, evidence, now_ms: nowMs = Date.now() }) {
  const record = await ownedRecord(state, positionId, ownerCommitment);
  if (!record.ok) return record;
  if (record.record.position.status !== "reconciled") return denied("carry_position_not_reconciled");
  const finalized = finalizeCarryValueLedger({ ledger: record.record.value_ledger, evidence, now_ms: nowMs });
  if (!finalized.ok) return finalized;
  return storeUpdate(state, {
    ...record.record,
    value_ledger: finalized.ledger,
    updated_at: new Date(nowMs).toISOString(),
  }, record.record.record_version);
}

export async function getStoredCarryPosition({ state, position_id: positionId, owner_commitment: ownerCommitment }) {
  const owned = await ownedRecord(state, positionId, ownerCommitment);
  return owned.ok ? { ok: true, record: publicRecord(owned.record) } : owned;
}

export async function listStoredCarryPositions({ state, owner_commitment: ownerCommitment, status, limit = 100 }) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  const records = await state.listCarryPositionRecords({ owner_commitment: ownerCommitment, status, limit });
  return { ok: true, records: records.map(publicRecord) };
}

export async function compileStoredCarryPortfolioCapitalPlan({
  state,
  owner_commitment: ownerCommitment,
  owner_capital_budget_micro_usdc: ownerCapitalBudget = 0,
  max_data_age_ms: maxDataAgeMs = 30_000,
  minimum_transfer_arrival_buffer_ms: minimumTransferArrivalBufferMs = 300_000,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  if (!Number.isSafeInteger(ownerCapitalBudget) || ownerCapitalBudget < 0) {
    return denied("carry_portfolio_capital_budget_invalid");
  }
  const maxAge = boundedInteger(maxDataAgeMs, 250, 300_000, 30_000);
  const records = (await Promise.all(["active", "rebalancing", "exiting", "frozen"].map((status) =>
    listAllCarryPositionRecords({ state, owner_commitment: ownerCommitment, status })
  ))).flat();
  const unique = [...new Map(records.map((record) => [record.position?.position_id, record])).values()];
  const missingPositionIds = unique
    .filter((record) => !record.latest_observation?.capital_action_plan)
    .map((record) => record.position?.position_id)
    .filter(Boolean);
  if (missingPositionIds.length > 0) {
    return {
      ok: false,
      error: "carry_portfolio_capital_evidence_incomplete",
      missing_position_ids: missingPositionIds,
      proposal_only: true,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
    };
  }
  try {
    const routeEvidence = await loadCarryTransferRouteEvidence({
      state,
      owner_commitment: ownerCommitment,
      now_ms: nowMs,
      max_data_age_ms: maxAge,
      expected_worker_image_digest: runtimeCarryQualificationImageDigest(env),
    });
    const plan = compileCarryPortfolioCapitalPlan({
      version: 1,
      now_ms: nowMs,
      max_data_age_ms: maxAge,
      owner_capital_budget_micro_usdc: ownerCapitalBudget,
      minimum_transfer_arrival_buffer_ms: minimumTransferArrivalBufferMs,
      transfer_routes: routeEvidence.ok ? routeEvidence.routes : [],
      position_plans: unique.map((record) => record.latest_observation.capital_action_plan),
    });
    return {
      ok: true,
      plan,
      transfer_route_evidence_status: routeEvidence.ok ? "verified" : "unavailable",
      transfer_route_evidence_commitment: routeEvidence.ok ? routeEvidence.evidence.evidence_commitment : null,
      transfer_route_evidence_error: routeEvidence.ok ? null : routeEvidence.error,
    };
  } catch (error) {
    return denied(safeError(error));
  }
}

export async function refreshStoredCarryTransferRoutes({
  state,
  owner_commitment: ownerCommitment,
  probe_transfer_route: probeTransferRoute,
  max_account_state_age_ms: maxAccountStateAgeMs = 30_000,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  const records = (await Promise.all(["active", "rebalancing"].map((status) =>
    listAllCarryPositionRecords({ state, owner_commitment: ownerCommitment, status })
  ))).flat();
  const unique = [...new Map(records.map((record) => [record.position?.position_id, record])).values()];
  const plans = unique.map((record) => record.latest_observation?.capital_action_plan);
  if (plans.some((plan) => !plan)) return denied("carry_portfolio_capital_evidence_incomplete");
  const accounts = new Map();
  const venueAccessByAccount = new Map();
  try {
    for (const record of unique) {
      for (const access of Object.values(record.monitoring_context?.venue_access || {})) {
        if (!access?.account_commitment) continue;
        const existing = venueAccessByAccount.get(access.account_commitment);
        if (existing && (existing.vault_commitment !== access.vault_commitment
          || existing.encrypted_vault_commitment !== access.encrypted_vault_commitment)) {
          return denied("carry_transfer_route_access_ambiguous");
        }
        venueAccessByAccount.set(access.account_commitment, access);
      }
    }
    for (const plan of plans) {
      for (const leg of plan.legs) {
        const current = accounts.get(leg.account_commitment);
        if (current && current.venue_id !== leg.venue_id) {
          return denied("carry_portfolio_capital_account_venue_mismatch");
        }
        if (current
          && current.account_state_checked_at_ms === plan.checked_at_ms
          && current.account_state_commitment !== leg.account_state_commitment) {
          return denied("carry_portfolio_capital_account_state_ambiguous");
        }
        if (!current || plan.checked_at_ms > current.account_state_checked_at_ms) {
          accounts.set(leg.account_commitment, {
            venue_id: leg.venue_id,
            account_commitment: leg.account_commitment,
            account_state_commitment: leg.account_state_commitment,
            account_state_checked_at_ms: plan.checked_at_ms,
          });
        }
      }
    }
    const observation = await observeCarryTransferRoutes({
      state,
      owner_commitment: ownerCommitment,
      worker_image_digest: runtimeCarryQualificationImageDigest(env),
      accounts: [...accounts.values()],
      probe_route: probeTransferRoute,
      probe_context: Object.freeze({
        owner_commitment: ownerCommitment,
        venue_access_by_account: Object.freeze(Object.fromEntries(venueAccessByAccount)),
      }),
      checked_at_ms: nowMs,
      max_account_state_age_ms: maxAccountStateAgeMs,
      now_ms: nowMs,
    });
    return { ok: true, ...observation };
  } catch (error) {
    return denied(safeError(error));
  }
}

export async function compileStoredCarryCollateralReview({
  state,
  owner_commitment: ownerCommitment,
  owner_capital_budget_micro_usdc: ownerCapitalBudget = 0,
  max_data_age_ms: maxDataAgeMs = 30_000,
  minimum_transfer_arrival_buffer_ms: minimumTransferArrivalBufferMs = 300_000,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  if (!Number.isSafeInteger(ownerCapitalBudget) || ownerCapitalBudget < 0) {
    return denied("carry_portfolio_capital_budget_invalid");
  }
  const maxAge = boundedInteger(maxDataAgeMs, 250, 300_000, 30_000);
  const records = (await Promise.all(["active", "rebalancing", "exiting", "frozen"].map((status) =>
    listAllCarryPositionRecords({ state, owner_commitment: ownerCommitment, status })
  ))).flat();
  const unique = [...new Map(records.map((record) => [record.position?.position_id, record])).values()];
  const positionPlans = unique
    .map((record) => record.latest_observation?.capital_action_plan)
    .filter(Boolean);
  if (positionPlans.length !== unique.length) {
    return {
      ok: false,
      error: "carry_portfolio_capital_evidence_incomplete",
      missing_position_ids: unique
        .filter((record) => !record.latest_observation?.capital_action_plan)
        .map((record) => record.position?.position_id)
        .filter(Boolean),
      proposal_only: true,
      review_only: true,
      execution_authorized: false,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
    };
  }
  try {
    const routeEvidence = await loadCarryTransferRouteEvidence({
      state,
      owner_commitment: ownerCommitment,
      now_ms: nowMs,
      max_data_age_ms: maxAge,
      expected_worker_image_digest: runtimeCarryQualificationImageDigest(env),
    });
    const ownerWallets = [...new Set(unique.map((record) =>
      record.position?.mandate_authorization?.signed_mandate?.owner_wallet_address
    ).filter(Boolean).map((address) => String(address).toLowerCase()))];
    if (unique.length > 0 && ownerWallets.length !== 1) {
      return denied("carry_collateral_review_owner_wallet_inconsistent");
    }
    const lineage = unique.map((record) => record.position.position_id).sort().join(":");
    const review = compileCarryCollateralReview({
      version: 1,
      owner_commitment: ownerCommitment,
      owner_wallet_address: ownerWallets[0] ?? null,
      review_id: `carry:collateral-review:${digest(`${ownerCommitment}:${nowMs}:${lineage}`).slice(0, 24)}`,
      now_ms: nowMs,
      expires_at_ms: nowMs + 10 * 60_000,
      max_data_age_ms: maxAge,
      owner_capital_budget_micro_usdc: ownerCapitalBudget,
      minimum_transfer_arrival_buffer_ms: minimumTransferArrivalBufferMs,
      transfer_routes: routeEvidence.ok ? routeEvidence.routes : [],
      position_plans: positionPlans,
    });
    const planCommitment = collateralReviewPlanCommitment(review);
    const storedApproval = await state.getIdempotency(`carry-collateral-plan:${planCommitment}`);
    const approvalReceipt = storedApproval?.receipt;
    const activeApproval = approvalReceipt?.kind === "ghola_carry_collateral_review_approval_receipt"
      && approvalReceipt.plan_commitment === planCommitment
      && approvalReceipt.owner_commitment === ownerCommitment
      && approvalReceipt.owner_wallet_address === review.owner_wallet_address
      && Number.isSafeInteger(approvalReceipt.expires_at_ms)
      && approvalReceipt.expires_at_ms > nowMs
      ? approvalReceipt
      : null;
    const latestStored = await state.getIdempotency(`carry-collateral-latest:${ownerCommitment}`);
    const latestApproval = normalizeStoredCollateralApproval(latestStored?.receipt, ownerCommitment, nowMs);
    const outcomeReceipt = latestApproval
      ? await compileCollateralReviewOutcome({
          state,
          approvalReceipt: latestApproval,
          currentReview: review,
          nowMs,
        })
      : null;
    return {
      ok: true,
      review,
      plan_commitment: planCommitment,
      approval_receipt: activeApproval,
      followup_approval_receipt: latestApproval,
      outcome_receipt: outcomeReceipt,
      transfer_route_evidence_status: routeEvidence.ok ? "verified" : "unavailable",
      transfer_route_evidence_commitment: routeEvidence.ok ? routeEvidence.evidence.evidence_commitment : null,
      transfer_route_evidence_error: routeEvidence.ok ? null : routeEvidence.error,
    };
  } catch (error) {
    return denied(safeError(error));
  }
}

export async function approveStoredCarryCollateralReview({
  state,
  owner_commitment: ownerCommitment,
  authorization: authorizationInput,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  try {
    const authorization = normalizeCarryCollateralReviewAuthorization(authorizationInput);
    const signed = authorization.signed_review;
    if (signed.owner_commitment !== ownerCommitment) {
      return denied("carry_collateral_review_owner_mismatch");
    }
    if (signed.issued_at_ms > nowMs + 5_000 || signed.expires_at_ms <= nowMs) {
      return denied("carry_collateral_review_expired");
    }
    const message = carryCollateralReviewMessage(signed);
    if (authorization.review_commitment !== hashMessage(message)) {
      return denied("carry_collateral_review_commitment_mismatch");
    }
    const recovered = await recoverMessageAddress({ message, signature: authorization.signature });
    if (recovered.toLowerCase() !== signed.owner_wallet_address) {
      return denied("carry_collateral_review_signature_mismatch");
    }
    const current = await compileStoredCarryCollateralReview({
      state,
      owner_commitment: ownerCommitment,
      owner_capital_budget_micro_usdc: signed.capital_plan.owner_capital_budget_micro_usdc,
      max_data_age_ms: signed.max_data_age_ms,
      minimum_transfer_arrival_buffer_ms: signed.minimum_transfer_arrival_buffer_ms,
      env,
      now_ms: signed.issued_at_ms,
    });
    if (!current.ok || carryCollateralReviewMessage(current.review) !== message) {
      return denied("carry_collateral_review_stale");
    }
    const consumed = await state.consumeCapabilityJti(
      `carry-collateral-review:${signed.review_id}`,
      Math.ceil(signed.expires_at_ms / 1_000),
    );
    if (!consumed.ok) return denied("carry_collateral_review_replayed");
    const planCommitment = collateralReviewPlanCommitment(signed);
    const receipt = {
      version: 1,
      kind: "ghola_carry_collateral_review_approval_receipt",
      review_id: signed.review_id,
      plan_commitment: planCommitment,
      owner_commitment: ownerCommitment,
      owner_wallet_address: signed.owner_wallet_address,
      review_commitment: authorization.review_commitment,
      status: "owner_signature_verified",
      instruction_count: signed.transfer_instructions.length + signed.funding_instructions.length,
      approved_target_accounts: collateralReviewTargets(signed),
      owner_capital_budget_micro_usdc: signed.capital_plan.owner_capital_budget_micro_usdc,
      max_data_age_ms: signed.max_data_age_ms,
      execution_authorized: false,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
      withdrawal_permitted: false,
      trade_permitted: false,
      verified_at_ms: nowMs,
      expires_at_ms: signed.expires_at_ms,
      followup_expires_at_ms: nowMs + 24 * 60 * 60_000,
    };
    await state.putIdempotency(`carry-collateral-plan:${planCommitment}`, receipt);
    await state.putIdempotency(`carry-collateral-latest:${ownerCommitment}`, receipt);
    return { ok: true, receipt };
  } catch (error) {
    return denied(safeError(error));
  }
}

async function compileCollateralReviewOutcome({ state, approvalReceipt, currentReview, nowMs }) {
  const currentPlan = currentReview.capital_plan;
  const currentByAccount = new Map(currentPlan.accounts.map((account) => [account.account_commitment, account]));
  const accounts = approvalReceipt.approved_target_accounts.map((target) => {
    const current = currentByAccount.get(target.account_commitment);
    const satisfied = Boolean(current)
      && current.requested_micro_usdc === 0
      && current.risk_action_required !== true
      && current.current_headroom_micro_usdc >= current.target_headroom_micro_usdc;
    return {
      account_commitment: target.account_commitment,
      venue_id: target.venue_id,
      status: current ? (satisfied ? "safe_runway_verified" : "owner_action_pending") : "account_evidence_missing",
      current_headroom_micro_usdc: current?.current_headroom_micro_usdc ?? null,
      target_headroom_micro_usdc: current?.target_headroom_micro_usdc ?? target.target_headroom_micro_usdc,
      requested_micro_usdc: current?.requested_micro_usdc ?? null,
    };
  });
  const allTargetsSafe = accounts.length > 0
    && accounts.every((account) => account.status === "safe_runway_verified");
  const status = currentPlan.status === "quarantined"
    ? "reconciliation_required"
    : currentPlan.status === "exit_required"
      ? "reduce_only_exit_required"
      : currentPlan.status === "balanced" && allTargetsSafe
        ? "safe_runway_verified"
        : "owner_action_pending";
  const receipt = {
    version: 1,
    kind: "ghola_carry_collateral_outcome_receipt",
    review_id: approvalReceipt.review_id,
    plan_commitment: approvalReceipt.plan_commitment,
    owner_commitment: approvalReceipt.owner_commitment,
    owner_wallet_address: approvalReceipt.owner_wallet_address,
    status,
    capital_outcome_verified: status === "safe_runway_verified",
    owner_action_causality_claimed: false,
    fund_movement_verified: false,
    account_state_checked: currentPlan.reconciliation_required !== true,
    accounts,
    current_plan_status: currentPlan.status,
    execution_authorized: false,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    withdrawal_permitted: false,
    trade_permitted: false,
    checked_at_ms: nowMs,
    evidence_expires_at_ms: nowMs + currentReview.max_data_age_ms,
  };
  if (receipt.capital_outcome_verified) {
    const outcomeKey = `carry-collateral-outcome:${approvalReceipt.plan_commitment}`;
    const existing = await state.getIdempotency(outcomeKey);
    if (!existing?.receipt) await state.putIdempotency(outcomeKey, receipt);
  }
  return receipt;
}

function collateralReviewTargets(review) {
  const targetIds = new Set([
    ...review.transfer_instructions.map((instruction) => instruction.to_account_commitment),
    ...review.funding_instructions.map((instruction) => instruction.account_commitment),
  ]);
  return review.capital_plan.accounts
    .filter((account) => targetIds.has(account.account_commitment))
    .map((account) => ({
      account_commitment: account.account_commitment,
      venue_id: account.venue_id,
      target_headroom_micro_usdc: account.target_headroom_micro_usdc,
    }));
}

function normalizeStoredCollateralApproval(receipt, ownerCommitment, nowMs) {
  if (!receipt || receipt.kind !== "ghola_carry_collateral_review_approval_receipt"
    || receipt.status !== "owner_signature_verified"
    || receipt.owner_commitment !== ownerCommitment
    || !Array.isArray(receipt.approved_target_accounts)
    || receipt.approved_target_accounts.length === 0
    || !Number.isSafeInteger(receipt.followup_expires_at_ms)
    || receipt.followup_expires_at_ms <= nowMs) return null;
  return receipt;
}

export async function compileStoredCarryPortfolioValueReport({
  state,
  owner_commitment: ownerCommitment,
  owner_capital_budget_micro_usdc: ownerCapitalBudget = 0,
  max_data_age_ms: maxDataAgeMs = 30_000,
  minimum_transfer_arrival_buffer_ms: minimumTransferArrivalBufferMs = 300_000,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  const records = await listAllCarryPositionRecords({ state, owner_commitment: ownerCommitment });
  const capital = await compileStoredCarryPortfolioCapitalPlan({
    state,
    owner_commitment: ownerCommitment,
    owner_capital_budget_micro_usdc: ownerCapitalBudget,
    max_data_age_ms: maxDataAgeMs,
    minimum_transfer_arrival_buffer_ms: minimumTransferArrivalBufferMs,
    env,
    now_ms: nowMs,
  });
  if (!capital.ok && capital.error !== "carry_portfolio_capital_evidence_incomplete") return capital;
  try {
    const report = compileCarryPortfolioValueReport({
      version: 1,
      now_ms: nowMs,
      position_values: records.map((record) => ({
        position_id: record.position?.position_id,
        position_status: record.position?.status,
        target_notional_micro_usdc: record.position?.target_notional_micro_usdc,
        value_ledger: record.value_ledger,
      })),
      capital_evidence: capital.ok
        ? { status: "ready", plan: capital.plan }
        : { status: "incomplete", missing_position_ids: capital.missing_position_ids },
    });
    return { ok: true, report };
  } catch (error) {
    return denied(safeError(error));
  }
}

export async function runCarryMonitoringTick({
  state,
  recipient,
  verifyOrder,
  readHyperliquidSnapshot,
  readHyperliquidCarryMetrics,
  readFundingSettlements,
  probeTransferRoute,
  preflight = preflightCarryPair,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  const records = (await Promise.all(["active", "rebalancing"].map((status) =>
    listAllCarryPositionRecords({ state, status })
  ))).flat();
  const concurrency = boundedInteger(env.PRIVATE_AGENT_CARRY_MONITOR_CONCURRENCY, 1, 32, 8);
  const results = await mapConcurrentOrdered(records, concurrency, async (record) => {
    if (!record.monitoring_context?.venue_access) {
      return { position_id: record.position?.position_id, ok: false, error: "carry_monitor_context_missing" };
    }
    try {
      const result = await observeStoredCarryPosition({
        state,
        owner_commitment: record.owner_commitment,
        position_id: record.position.position_id,
        venue_access: record.monitoring_context.venue_access,
        recipient,
        verifyOrder,
        readHyperliquidSnapshot,
        readHyperliquidCarryMetrics,
        readFundingSettlements,
        preflight,
        observation_source: "supervised_loop",
        now_ms: nowMs,
      });
      return { position_id: record.position.position_id, ...result };
    } catch (error) {
      return { position_id: record.position.position_id, ok: false, error: safeError(error) };
    }
  });
  const refreshedOwners = records
    .filter((_record, index) => results[index]?.ok === true && results[index]?.observation_ok === true)
    .map((record) => record.owner_commitment)
    .filter(Boolean);
  const routeObservations = typeof probeTransferRoute === "function"
    ? await Promise.all([...new Set(refreshedOwners)].sort()
      .map((ownerCommitment) => refreshStoredCarryTransferRoutes({
        state,
        owner_commitment: ownerCommitment,
        probe_transfer_route: probeTransferRoute,
        env,
        now_ms: nowMs,
      })))
    : [];
  return {
    ok: results.every((result) => result.ok),
    checked: records.length,
    results,
    route_observations: routeObservations,
  };
}

export function startCarryMonitoringLoop({
  state,
  recipient,
  verifyOrder,
  readHyperliquidSnapshot,
  readHyperliquidCarryMetrics,
  readFundingSettlements,
  probeTransferRoute,
  preflight = preflightCarryPair,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  if (String(env.PRIVATE_AGENT_CARRY_MONITOR_ENABLED ?? "true").toLowerCase() === "false") {
    const health = disabledCarryLoopHealth("carry_monitor");
    return { runNow: async () => ({ ok: false, error: "carry_monitor_disabled" }), health: () => health, stop() {} };
  }
  const intervalMs = boundedMs(env.PRIVATE_AGENT_CARRY_MONITOR_INTERVAL_MS, 5_000, 300_000, 5_000);
  const initialDelayMs = boundedMs(env.PRIVATE_AGENT_CARRY_MONITOR_INITIAL_DELAY_MS, 0, 60_000, 5_000);
  const stallAfterMs = boundedMs(
    env.PRIVATE_AGENT_CARRY_MONITOR_STALL_MS,
    intervalMs * 2,
    1_800_000,
    Math.max(intervalMs * 3, initialDelayMs + intervalMs * 2),
  );
  let timer = null;
  let stopped = false;
  const supervisor = createCarryLoopSupervisor({
    name: "carry_monitor",
    now,
    maxSilenceMs: stallAfterMs,
    run: () => runCarryMonitoringTick({
      state,
      recipient,
      verifyOrder,
      readHyperliquidSnapshot,
      readHyperliquidCarryMetrics,
      readFundingSettlements,
      probeTransferRoute,
      preflight,
      now_ms: now(),
    }),
  });
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

export async function observeStoredCarryPosition({
  state,
  owner_commitment: ownerCommitment,
  position_id: positionId,
  venue_access: venueAccess,
  recipient,
  verifyOrder,
  readHyperliquidSnapshot,
  readHyperliquidCarryMetrics,
  readFundingSettlements,
  preflight = preflightCarryPair,
  observation_source: observationSource = "manual",
  now_ms: nowMs = Date.now(),
}) {
  const owned = await ownedRecord(state, positionId, ownerCommitment);
  if (!owned.ok) return owned;
  const position = owned.record.position;
  if (position.status !== "active" && position.status !== "rebalancing") {
    return denied("carry_position_not_monitorable");
  }
  if (!venueAccess?.[position.long_venue_id] || !venueAccess?.[position.short_venue_id]) {
    return denied("carry_monitor_access_missing");
  }
  const sequence = position.last_event_sequence + 1;
  const eventBase = `carry:monitor:${digest(`${position.position_id}:${sequence}`).slice(0, 32)}`;
  const storedOpportunity = verifyStoredCarryOpportunityBinding({
    record: owned.record,
    require_material: false,
  });
  if (!storedOpportunity.ok) {
    return advanceStoredCarryPosition({
      state,
      position_id: positionId,
      owner_commitment: ownerCommitment,
      event: {
        version: 1,
        event_id: `${eventBase}:opportunity-invalid`,
        sequence,
        type: "mandate_invalid",
        reason: storedOpportunity.error,
      },
      now_ms: nowMs,
    });
  }
  const mandate = await verifyCarryRiskMandateAuthorization({
    owner_commitment: ownerCommitment,
    position_input: position,
    now_ms: nowMs,
  });
  if (!mandate.ok) {
    return advanceStoredCarryPosition({
      state,
      position_id: positionId,
      owner_commitment: ownerCommitment,
      event: {
        version: 1,
        event_id: `${eventBase}:mandate-invalid`,
        sequence,
        type: "mandate_invalid",
        reason: mandate.error,
      },
      now_ms: nowMs,
    });
  }
  let observation;
  try {
    observation = await preflight({
      body: {
        version: 1,
        phase: "monitoring",
        owner_commitment: ownerCommitment,
        work_order_commitment: `carry_monitor_${digest(`${position.position_id}:${sequence}:${nowMs}`).slice(0, 32)}`,
        asset: position.asset,
        long_venue_id: position.long_venue_id,
        short_venue_id: position.short_venue_id,
        notional_usd: String(position.target_notional_micro_usdc / 1_000_000),
        horizon_days: String(Math.max(1, Math.ceil(Number(owned.record.opportunity?.horizon_ms || 86_400_000) / 86_400_000))),
        risk_mandate: position.risk_mandate,
        venue_access: venueAccess,
      },
      recipient,
      state,
      verifyOrder,
      readHyperliquidSnapshot,
      readHyperliquidCarryMetrics,
      now: () => nowMs,
    });
  } catch (error) {
    const frozen = await advanceStoredCarryPosition({
      state,
      position_id: positionId,
      owner_commitment: ownerCommitment,
      event: {
        version: 1,
        event_id: `${eventBase}:unavailable`,
        sequence,
        type: "observation_unavailable",
        reason: safeError(error),
      },
      now_ms: nowMs,
    });
    return frozen.ok ? { ...frozen, observation_ok: false, observation: null } : frozen;
  }
  const opportunity = observation?.economic_opportunity || {};
  let capitalActionPlan;
  try {
    capitalActionPlan = compileCarryCapitalActionPlan({
      version: 1,
      position,
      margin_runways: observation?.margin_runways,
      now_ms: nowMs,
    });
  } catch (error) {
    const frozen = await advanceStoredCarryPosition({
      state,
      position_id: positionId,
      owner_commitment: ownerCommitment,
      event: {
        version: 1,
        event_id: `${eventBase}:capital-evidence-unavailable`,
        sequence,
        type: "observation_unavailable",
        reason: `capital_action_plan:${safeError(error)}`,
      },
      now_ms: nowMs,
    });
    return frozen.ok ? { ...frozen, observation_ok: false, observation: null } : frozen;
  }
  const migrationCandidates = ["reduce_only_exit", "reconcile_only"].includes(capitalActionPlan.recommended_action)
    ? []
    : await evaluateMigrationCandidates({
      state,
      position,
      record: owned.record,
      opportunity,
      venueAccess,
      recipient,
      verifyOrder,
      readHyperliquidSnapshot,
      readHyperliquidCarryMetrics,
      preflight,
      nowMs,
      sequence,
    });
  const runways = Object.fromEntries((observation?.margin_runways || []).map((runway) => [runway.venue_id, runway.runway_ms]));
  const runwayStatuses = Object.fromEntries((observation?.margin_runways || []).map((runway) => [runway.venue_id, runway.status]));
  const advanced = await advanceStoredCarryPosition({
    state,
    position_id: positionId,
    owner_commitment: ownerCommitment,
    event: {
      version: 1,
      event_id: `${eventBase}:verified`,
      sequence,
      type: "observation",
      observation_source: observationSource === "supervised_loop" ? "supervised_loop" : "manual",
      as_of_ms: opportunity.checked_at_ms,
      expected_net_value_bps: opportunity.projected_net_value_bps,
      economic_equivalence_id: opportunity.economic_equivalence_id,
      migration_candidates: migrationCandidates,
      contract_data_skew_ms: opportunity.contract_data_skew_ms,
      max_contract_data_skew_ms: opportunity.max_contract_data_skew_ms,
      index_price_divergence_bps: opportunity.index_price_divergence_bps,
      mark_price_divergence_bps: opportunity.mark_price_divergence_bps,
      max_index_price_divergence_bps: opportunity.max_index_price_divergence_bps,
      max_mark_price_divergence_bps: opportunity.max_mark_price_divergence_bps,
      margin_runway_ms_by_venue: runways,
      margin_runway_status_by_venue: runwayStatuses,
      capital_action_plan: capitalActionPlan,
      qualification_reasons: observation.qualification_reasons,
      transaction_broadcast: false,
    },
    now_ms: nowMs,
  });
  if (!advanced.ok || typeof readFundingSettlements !== "function") {
    return advanced.ok ? { ...advanced, observation_ok: true, observation } : advanced;
  }
  const funding = await collectStoredCarryFundingEvidence({
    state,
    ownerCommitment,
    positionId,
    venueAccess,
    recipient,
    readFundingSettlements,
    nowMs,
  });
  return { ...advanced, record: funding.record || advanced.record, observation_ok: true, observation, funding: funding.summary };
}

export async function collectStoredCarryFundingEvidence({ state, ownerCommitment, positionId, venueAccess, recipient, readFundingSettlements, nowMs, final = false }) {
  const initial = await state.getCarryPositionRecord(positionId);
  if (!initial) return { record: null, summary: { status: "position_missing" } };
  const venues = [initial.position.long_venue_id, initial.position.short_venue_id];
  const cursors = { ...(initial.value_evidence?.funding?.cursor_ms_by_venue || {}) };
  const venueStatus = {};
  const venueReads = await Promise.all(venues.map((venueId) => readVenueFundingSettlements({
    venueId,
    asset: initial.position.asset,
    access: venueAccess[venueId],
    startMs: Number(cursors[venueId] || initial.position.created_at_ms || nowMs),
    endMs: nowMs,
    recipient,
    state,
    readFundingSettlements,
  })));
  for (const read of venueReads) {
    if (!read.ok) {
      venueStatus[read.venue_id] = read.error;
      continue;
    }
    let persisted = true;
    for (const entry of read.entries) {
      const appended = await appendFundingEntryWithRetry({
        state,
        ownerCommitment,
        positionId,
        venueId: read.venue_id,
        legId: carryPositionLegId(initial.position, read.venue_id),
        row: entry.row,
        amountMicro: entry.amount_micro_usdc,
        nowMs,
      });
      if (!appended) {
        persisted = false;
        break;
      }
    }
    if (!persisted) {
      venueStatus[read.venue_id] = "funding_settlement_persistence_failed";
      continue;
    }
    const priorCursor = Number(cursors[read.venue_id] || initial.position.created_at_ms || nowMs);
    if (read.cursor_ms > priorCursor) cursors[read.venue_id] = read.cursor_ms;
    venueStatus[read.venue_id] = read.caught_up ? "current" : "history_backfill_pending";
  }
  let storedRecord = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await state.getCarryPositionRecord(positionId);
    if (!current) break;
    const allCurrent = venues.every((venueId) => venueStatus[venueId] === "current");
    const stored = await state.putCarryPositionRecord({
      ...current,
      value_evidence: {
        ...(current.value_evidence || {}),
        funding: {
          status: allCurrent && final && current.position.status === "reconciled"
            ? "complete_through_exit"
            : allCurrent ? "current" : "pending_authoritative_settlement_history",
          cursor_ms_by_venue: cursors,
          venue_status: venueStatus,
          checked_at_ms: nowMs,
        },
        costs_complete: false,
      },
    }, { expected_version: current.record_version });
    if (stored.ok) { storedRecord = stored.record; break; }
  }
  return {
    record: storedRecord ? publicRecord(storedRecord) : null,
    summary: { status: venues.every((venueId) => venueStatus[venueId] === "current") ? "current" : "pending", venue_status: venueStatus },
  };
}

async function readVenueFundingSettlements({ venueId, asset, access, startMs, endMs, recipient, state, readFundingSettlements }) {
  let cursor = startMs;
  const entries = [];
  try {
    for (let page = 0; cursor < endMs && page < 16; page += 1) {
      const pageEnd = Math.min(endMs, cursor + 7 * 86_400_000);
      const rows = await readFundingSettlements({
        body: {
          ...access,
          venue_id: venueId,
          asset,
          start_time_ms: cursor,
          end_time_ms: pageEnd,
        },
        recipient,
        state,
      });
      for (const row of Array.isArray(rows) ? rows : []) {
        const amountMicro = signedQuoteMicro(row.amount_quote);
        const quoteAsset = String(row.quote_asset || "").toUpperCase();
        const occurredAt = Number(row.occurred_at_ms);
        const settlementId = String(row.settlement_id || "").trim();
        if (amountMicro === null
          || settlementId.length === 0
          || !new Set(["USD", "USDC", "USDT"]).has(quoteAsset)
          || !Number.isSafeInteger(occurredAt)
          || occurredAt < cursor
          || occurredAt > pageEnd) throw new Error("funding_settlement_evidence_invalid");
        entries.push({ row, settlement_id: settlementId, amount_micro_usdc: amountMicro });
      }
      cursor = pageEnd;
    }
    entries.sort(compareFundingEntries);
    return {
      ok: true,
      venue_id: venueId,
      cursor_ms: cursor,
      caught_up: cursor >= endMs,
      entries,
    };
  } catch (error) {
    return {
      ok: false,
      venue_id: venueId,
      error: safeError(error),
      entries: [],
    };
  }
}

async function appendFundingEntryWithRetry({ state, ownerCommitment, positionId, venueId, legId, row, amountMicro, nowMs }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await state.getCarryPositionRecord(positionId);
    if (!current) return false;
    const settlementKey = String(row.settlement_id || "").trim();
    const settlementId = digest(`${venueId}:${settlementKey}`);
    const evidenceId = digest(`${venueId}:${settlementKey}:${row.occurred_at_ms}:${amountMicro}:${String(row.quote_asset || "").toUpperCase()}`);
    const result = await appendStoredCarryValueEntry({
      state,
      position_id: positionId,
      owner_commitment: ownerCommitment,
      entry: {
        version: 1,
        entry_id: `carry:value:funding:${settlementId.slice(0, 32)}`,
        sequence: current.value_ledger.last_sequence + 1,
        entry_type: "funding",
        direction: amountMicro < 0 ? "debit" : "credit",
        amount_micro_usdc: Math.abs(amountMicro),
        venue_id: venueId,
        leg_id: legId,
        occurred_at_ms: Number(row.occurred_at_ms),
        evidence_commitment: `carry:value:funding:evidence:${evidenceId.slice(0, 32)}`,
      },
      now_ms: nowMs,
    });
    if (result.ok) return true;
    if (result.error !== "carry_record_version_conflict") return false;
  }
  return false;
}

export function carryPositionLegId(position, venueId) {
  const side = venueId === position.long_venue_id
    ? "long"
    : venueId === position.short_venue_id ? "short" : null;
  if (side === null) throw new Error("funding_settlement_venue_outside_position");
  return `leg:carry:${digest(`${position.position_id}:${side}`).slice(0, 32)}`;
}

function compareFundingEntries(left, right) {
  const occurred = Number(left.row.occurred_at_ms) - Number(right.row.occurred_at_ms);
  if (occurred !== 0) return occurred;
  if (left.settlement_id < right.settlement_id) return -1;
  if (left.settlement_id > right.settlement_id) return 1;
  return left.amount_micro_usdc - right.amount_micro_usdc;
}

async function ownedRecord(state, positionId, ownerCommitment) {
  if (!OWNER.test(String(ownerCommitment || ""))) return denied("carry_owner_commitment_invalid");
  const record = await state.getCarryPositionRecord(String(positionId || ""));
  if (!record) return denied("carry_position_not_found");
  if (record.owner_commitment !== ownerCommitment) return denied("carry_position_owner_mismatch");
  return { ok: true, record };
}

async function storeUpdate(state, record, expectedVersion) {
  const stored = await state.putCarryPositionRecord(record, { expected_version: expectedVersion });
  return stored.ok
    ? { ok: true, duplicate: false, record: publicRecord(stored.record) }
    : publicStoredResult(stored);
}

function normalizeMonitoringContext(value, positionInput, ownerCommitment) {
  if (!value || value.version !== 1 || !value.venue_access || typeof value.venue_access !== "object") {
    return denied("carry_monitor_context_required");
  }
  const selected = [positionInput?.long_venue_id, positionInput?.short_venue_id];
  const migrationVenues = positionInput?.risk_mandate?.allow_migration === true
    && Array.isArray(positionInput.risk_mandate.migration_venue_allowlist)
    ? positionInput.risk_mandate.migration_venue_allowlist
    : [];
  const permitted = [...new Set([...selected, ...migrationVenues])];
  const venueAccess = {};
  for (const venueId of permitted) {
    const access = value.venue_access[venueId];
    if (!access || access.status !== "ready" || access.owner_commitment !== ownerCommitment) {
      if (!selected.includes(venueId)) continue;
      return denied("carry_monitor_access_invalid");
    }
    venueAccess[venueId] = {
      status: "ready",
      owner_commitment: ownerCommitment,
      account_commitment: access.account_commitment,
      vault_commitment: access.vault_commitment,
      encrypted_vault_commitment: access.encrypted_vault_commitment,
      policy_commitment: access.policy_commitment,
      encrypted_execution_vault: access.encrypted_execution_vault,
    };
  }
  return { ok: true, context: { version: 1, venue_access: venueAccess } };
}

async function evaluateMigrationCandidates({
  state,
  position,
  record,
  opportunity,
  venueAccess,
  recipient,
  verifyOrder,
  readHyperliquidSnapshot,
  readHyperliquidCarryMetrics,
  preflight,
  nowMs,
  sequence,
}) {
  const mandate = position.risk_mandate;
  const thresholdReached = Number.isSafeInteger(opportunity.projected_net_value_bps)
    && opportunity.projected_net_value_bps <= mandate.exit_net_value_bps
    && position.consecutive_exit_observations + 1 >= mandate.exit_after_consecutive_observations;
  if (mandate.allow_migration !== true || !thresholdReached) return [];
  const allowlist = Array.isArray(mandate.migration_venue_allowlist)
    ? mandate.migration_venue_allowlist.filter((venueId) => CARRY_EXECUTION_VENUES.includes(venueId) && venueAccess?.[venueId])
    : [];
  const pairs = allowlist.flatMap((longVenue) => allowlist
    .filter((shortVenue) => shortVenue !== longVenue)
    .map((shortVenue) => [longVenue, shortVenue]))
    .filter(([longVenue, shortVenue]) => longVenue !== position.long_venue_id || shortVenue !== position.short_venue_id);
  if (pairs.length === 0) return [];
  const horizonDays = String(Math.max(1, Math.ceil(Number(record.opportunity?.horizon_ms || 86_400_000) / 86_400_000)));
  const transitionCostBps = conservativeTransitionCostBps(record.opportunity, position.target_notional_micro_usdc);
  const settled = await Promise.allSettled(pairs.map(([longVenue, shortVenue], index) => preflight({
    body: {
      version: 1,
      phase: "migration",
      owner_commitment: record.owner_commitment,
      work_order_commitment: `carry_migration_${digest(`${position.position_id}:${sequence}:${index}:${nowMs}`).slice(0, 32)}`,
      asset: position.asset,
      long_venue_id: longVenue,
      short_venue_id: shortVenue,
      notional_usd: String(position.target_notional_micro_usdc / 1_000_000),
      horizon_days: horizonDays,
      risk_mandate: mandate,
      venue_access: venueAccess,
    },
    recipient,
    state,
    verifyOrder,
    readHyperliquidSnapshot,
    readHyperliquidCarryMetrics,
    now: () => nowMs,
  })));
  return settled.flatMap((outcome, index) => {
    if (outcome.status !== "fulfilled") return [];
    const result = outcome.value || {};
    const modeled = result.economic_opportunity || {};
    const [longVenue, shortVenue] = pairs[index];
    return [{
      candidate_id: `carry:migration:${digest(`${position.position_id}:${longVenue}:${shortVenue}:${nowMs}`).slice(0, 32)}`,
      asset: position.asset,
      economic_equivalence_id: modeled.economic_equivalence_id,
      long_venue_id: longVenue,
      short_venue_id: shortVenue,
      expected_net_value_bps: modeled.projected_net_value_bps,
      transition_cost_bps: transitionCostBps,
      eligible: modeled.eligible === true && result.live_creation_ready === true,
      no_submit_ready: result.no_submit_ready === true,
      transaction_broadcast: false,
      qualification_reasons: Array.isArray(result.qualification_reasons) ? result.qualification_reasons : ["migration_qualification_unverifiable"],
      checked_at_ms: modeled.checked_at_ms,
    }];
  });
}

function conservativeTransitionCostBps(opportunity, notionalMicro) {
  const tradingCost = Number(opportunity?.projected_trading_cost_micro_usdc);
  if (!Number.isSafeInteger(tradingCost) || tradingCost < 0 || !Number.isSafeInteger(notionalMicro) || notionalMicro <= 0) {
    return 10_000;
  }
  return Math.min(10_000, Math.ceil((tradingCost * 10_000) / notionalMicro));
}

function publicStoredResult(stored) {
  if (!stored?.record) return stored;
  return { ...stored, record: publicRecord(stored.record) };
}

function publicRecord(record) {
  const {
    monitoring_context: _monitoringContext,
    opportunity_authentication_material: _opportunityAuthenticationMaterial,
    ...safe
  } = record;
  return JSON.parse(JSON.stringify(safe));
}

function opportunityAuthenticationMaterial(value) {
  const { worker_authentication: _authentication, ...material } = value;
  return Object.freeze(JSON.parse(JSON.stringify(material)));
}

function publicOpportunity(value) {
  return Object.freeze({
    version: 1,
    eligible: value.eligible === true,
    reasons: Array.isArray(value.reasons) ? [...value.reasons] : [],
    asset: String(value.asset || ""),
    long_venue_id: String(value.long_venue_id || ""),
    short_venue_id: String(value.short_venue_id || ""),
    notional_micro_usdc: value.notional_micro_usdc,
    capital_committed_micro_usdc: value.capital_committed_micro_usdc,
    horizon_ms: value.horizon_ms,
    projected_gross_funding_micro_usdc: value.projected_gross_funding_micro_usdc,
    projected_funding_credit_micro_usdc: value.projected_funding_credit_micro_usdc,
    projected_funding_debit_micro_usdc: value.projected_funding_debit_micro_usdc,
    projected_trading_fee_micro_usdc: value.projected_trading_fee_micro_usdc,
    projected_slippage_micro_usdc: value.projected_slippage_micro_usdc,
    projected_gas_micro_usdc: value.projected_gas_micro_usdc,
    projected_latency_buffer_micro_usdc: value.projected_latency_buffer_micro_usdc,
    projected_trading_cost_micro_usdc: value.projected_trading_cost_micro_usdc,
    projected_capital_cost_micro_usdc: value.projected_capital_cost_micro_usdc,
    risk_buffer_micro_usdc: value.risk_buffer_micro_usdc,
    projected_net_value_micro_usdc: value.projected_net_value_micro_usdc,
    projected_net_value_bps: value.projected_net_value_bps,
    break_even_ms: value.break_even_ms,
    contract_data_skew_ms: value.contract_data_skew_ms,
    max_contract_data_skew_ms: value.max_contract_data_skew_ms,
    index_price_divergence_bps: value.index_price_divergence_bps,
    mark_price_divergence_bps: value.mark_price_divergence_bps,
    max_index_price_divergence_bps: value.max_index_price_divergence_bps,
    max_mark_price_divergence_bps: value.max_mark_price_divergence_bps,
    economic_equivalence_id: String(value.economic_equivalence_id || ""),
    contract_type: String(value.contract_type || ""),
    long_quote_asset: String(value.long_quote_asset || ""),
    short_quote_asset: String(value.short_quote_asset || ""),
    checked_at_ms: value.checked_at_ms,
    all_venues_ready: value.all_venues_ready === true,
    live_creation_ready: value.live_creation_ready === true,
    long_margin_runway_ms: value.long_margin_runway_ms,
    short_margin_runway_ms: value.short_margin_runway_ms,
  });
}

function modeledValueBreakdown(value) {
  const mapping = {
    funding_credit_micro_usdc: value?.projected_funding_credit_micro_usdc,
    funding_debit_micro_usdc: value?.projected_funding_debit_micro_usdc,
    trading_fee_micro_usdc: value?.projected_trading_fee_micro_usdc,
    slippage_micro_usdc: value?.projected_slippage_micro_usdc,
    gas_micro_usdc: value?.projected_gas_micro_usdc,
    latency_buffer_micro_usdc: value?.projected_latency_buffer_micro_usdc,
  };
  return Object.values(mapping).every((amount) => Number.isSafeInteger(amount) && amount >= 0)
    ? mapping
    : {};
}

function publicObservation(event) {
  return Object.freeze({
    observation_source: event.observation_source === "supervised_loop" ? "supervised_loop" : "manual",
    as_of_ms: event.as_of_ms,
    expected_net_value_bps: event.expected_net_value_bps,
    contract_data_skew_ms: event.contract_data_skew_ms,
    max_contract_data_skew_ms: event.max_contract_data_skew_ms,
    index_price_divergence_bps: event.index_price_divergence_bps,
    mark_price_divergence_bps: event.mark_price_divergence_bps,
    max_index_price_divergence_bps: event.max_index_price_divergence_bps,
    max_mark_price_divergence_bps: event.max_mark_price_divergence_bps,
    margin_runway_ms_by_venue: { ...(event.margin_runway_ms_by_venue || {}) },
    margin_runway_status_by_venue: { ...(event.margin_runway_status_by_venue || {}) },
    capital_action_plan: event.capital_action_plan
      ? JSON.parse(JSON.stringify(event.capital_action_plan))
      : null,
    qualification_reasons: Array.isArray(event.qualification_reasons) ? [...event.qualification_reasons] : [],
    transaction_broadcast: false,
    recorded_at_ms: event.recorded_at_ms,
  });
}

function publicReconciliationEvidence(event, nowMs) {
  return Object.freeze({
    owner_commitment: String(event.owner_commitment || ""),
    carry_position_id: String(event.carry_position_id || ""),
    gross_exposure_micro_usdc: event.gross_exposure_micro_usdc,
    open_order_count: event.open_order_count,
    account_state_checked: event.account_state_checked === true,
    transaction_broadcast: false,
    reconciliation_commitment: String(event.reconciliation_commitment || ""),
    checked_at_ms: Number.isSafeInteger(event.checked_at_ms) ? event.checked_at_ms : nowMs,
    venues: Object.freeze((Array.isArray(event.venues) ? event.venues : []).map((item) => Object.freeze({
      venue_id: String(item?.venue_id || ""),
      account_commitment: String(item?.account_commitment || ""),
      authorized: item?.authorized === true,
      flat_zero_orders: item?.flat_zero_orders === true,
      position_count: item?.position_count,
      open_order_count: item?.open_order_count,
      account_state_checked: item?.account_state_checked === true,
    }))),
  });
}

function reconciliationBinding(record) {
  const venueIds = [record.position.long_venue_id, record.position.short_venue_id];
  return {
    owner_commitment: record.owner_commitment,
    carry_position_id: record.position.position_id,
    account_commitments: Object.fromEntries(venueIds.map((venueId) => [
      venueId,
      record.monitoring_context?.venue_access?.[venueId]?.account_commitment,
    ])),
  };
}

function denied(error) {
  return { ok: false, error };
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function collateralReviewPlanCommitment(review) {
  const instructions = (items) => items.map(({
    instruction_id: _instructionId,
    expected_arrival_at_ms: _expectedArrivalAtMs,
    destination_runway_at_arrival_ms: _destinationRunwayAtArrivalMs,
    ...instruction
  }) => instruction);
  const capitalPlan = {
    ...review.capital_plan,
    proposed_reallocations: instructions(review.capital_plan.proposed_reallocations),
  };
  delete capitalPlan.checked_at_ms;
  return `0x${digest(JSON.stringify({
    owner_commitment: review.owner_commitment,
    owner_wallet_address: review.owner_wallet_address,
    max_data_age_ms: review.max_data_age_ms,
    capital_plan: capitalPlan,
    transfer_instructions: instructions(review.transfer_instructions),
    funding_instructions: instructions(review.funding_instructions),
  }))}`;
}

function safeError(error) {
  const value = String(error?.code || error?.message || "carry_monitor_unavailable");
  return /^[a-z0-9_:-]{3,120}$/.test(value) ? value : "carry_monitor_unavailable";
}

function signedQuoteMicro(value) {
  const text = String(value ?? "").trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = String(match[3] || "").padEnd(6, "0");
  let amount = BigInt(match[2]) * 1_000_000n + BigInt(fraction.slice(0, 6) || "0");
  if (fraction[6] >= "5") amount += 1n;
  if (match[1] === "-") amount = -amount;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(amount);
}

function boundedMs(value, minimum, maximum, fallback) {
  return boundedInteger(value, minimum, maximum, fallback);
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

async function mapConcurrentOrdered(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
