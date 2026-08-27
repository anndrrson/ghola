import { createHash } from "node:crypto";
import { readCarryVenueQualification } from "./carry-qualification.js";
import { verifyCarryRiskMandateAuthorization } from "./carry-mandate.js";
import { carryPositionLegId } from "./carry-positions.js";
import { assessCarryFlatReconciliation } from "./carry-reconciliation.js";
import { readCarryShadowQualification } from "./carry-shadow-qualification.js";

export async function buildCompletedCarryReleaseMaterial({
  state,
  owner_commitment: ownerCommitment,
  position_id: positionId,
  env = process.env,
  now_ms: nowMs = Date.now(),
}) {
  const record = await state?.getCarryPositionRecord?.(String(positionId || ""));
  if (!record) return denied("carry_position_not_found");
  if (record.owner_commitment !== ownerCommitment) return denied("carry_position_owner_mismatch");
  const mandate = await verifyCarryRiskMandateAuthorization({
    owner_commitment: ownerCommitment,
    position_input: record.position,
    now_ms: record.position?.created_at_ms,
  });
  if (!mandate.ok) return denied("carry_release_signed_mandate_unproven");
  if (record.position?.status !== "reconciled") return denied("carry_release_position_not_reconciled");
  if (record.value_ledger?.status !== "finalized" || record.value_evidence?.costs_complete !== true) {
    return denied("carry_release_value_ledger_incomplete");
  }
  const contractEquivalence = releaseContractEquivalence(record.opportunity);
  if (!contractEquivalence.ok) return contractEquivalence;
  const shadowQualification = await readCarryShadowQualification({
    state,
    now_ms: nowMs,
    env,
  });
  if (!shadowQualification.ready || !shadowQualification.release_bound) {
    return denied("carry_release_shadow_qualification_unproven");
  }
  const finalState = record.final_reconciliation_evidence;
  const pair = [record.position.long_venue_id, record.position.short_venue_id];
  const accountCommitments = Object.fromEntries(pair.map((venueId) => [
    venueId,
    record.monitoring_context?.venue_access?.[venueId]?.account_commitment,
  ]));
  const finalAssessment = assessCarryFlatReconciliation({
    evidence: finalState,
    venue_ids: pair,
    owner_commitment: record.owner_commitment,
    carry_position_id: record.position.position_id,
    account_commitments: accountCommitments,
  });
  if (!finalAssessment.flat) return denied("carry_release_final_state_unproven");
  const [entrySaga, exitSaga] = await Promise.all([
    state.getMultiLegSaga?.(record.entry_saga_id),
    state.getMultiLegSaga?.(record.exit_saga_id),
  ]);
  if (entrySaga?.status !== "reconciled" || exitSaga?.status !== "reconciled") {
    return denied("carry_release_sagas_not_reconciled");
  }
  const events = Array.isArray(record.lifecycle_events) ? record.lifecycle_events : [];
  if (events.some((event) => ["submission_ambiguous", "recovery_failed"].includes(event?.type))) {
    return denied("carry_release_ambiguous_or_recovered_lifecycle");
  }
  const observations = events.filter((event) => event?.type === "observation" && positiveInteger(event.recorded_at_ms));
  if (observations.length === 0) return denied("carry_release_monitoring_evidence_missing");
  const supervisedObservations = observations.filter((event) => event?.observation_source === "supervised_loop");
  if (supervisedObservations.length === 0) return denied("carry_release_supervised_monitoring_missing");
  if (supervisedObservations.length < 2) return denied("carry_release_supervised_monitoring_insufficient");
  const latestObservation = supervisedObservations.at(-1);
  const runwayStatuses = latestObservation.margin_runway_status_by_venue || {};
  const runwayValues = latestObservation.margin_runway_ms_by_venue || {};
  const validRunwayStatuses = new Set(["healthy", "warning", "critical", "breached"]);
  if (pair.some((venueId) => !Object.hasOwn(runwayValues, venueId) || !validRunwayStatuses.has(runwayStatuses[venueId]))) {
    return denied("carry_release_margin_runway_evidence_missing");
  }
  const qualifications = await Promise.all(pair.map((venueId) => readCarryVenueQualification({
    state,
    venue_id: venueId,
    now_ms: nowMs,
    env,
  })));
  if (!qualifications.every((qualification) => qualification.proven === true)) {
    return denied("carry_release_qualification_unproven");
  }
  const [entryLegs, exitLegs] = await Promise.all([
    materialLegs({ state, saga: entrySaga, record, phase: "entry" }),
    materialLegs({ state, saga: exitSaga, record, phase: "exit" }),
  ]);
  if (!entryLegs.ok) return entryLegs;
  if (!exitLegs.ok) return exitLegs;
  const exitRequest = [...events].reverse().find((event) => event?.type === "manual_exit_requested");
  const entryReconciledAt = entrySaga.updated_at_ms;
  const monitoringEndedAt = latestObservation.recorded_at_ms;
  if (monitoringEndedAt <= entryReconciledAt) return denied("carry_release_monitoring_period_missing");
  const exitRequestedAt = exitRequest?.recorded_at_ms || exitSaga.created_at_ms;
  if (!positiveInteger(exitRequestedAt) || exitRequestedAt < monitoringEndedAt) {
    return denied("carry_release_exit_timestamp_invalid");
  }

  const material = {
    version: 1,
    kind: "ghola_cross_venue_carry_mainnet_lifecycle_proof",
    network: "mainnet",
    request: { ambiguity_retry_performed: false },
    position: {
      position_id: record.position.position_id,
      asset: record.position.asset,
      target_notional_micro_usdc: record.position.target_notional_micro_usdc,
      long_venue_id: record.position.long_venue_id,
      short_venue_id: record.position.short_venue_id,
      created_at: iso(record.position.created_at_ms),
    },
    contract_equivalence: contractEquivalence.evidence,
    shadow_qualification: {
      proven: true,
      image_digest: shadowQualification.image_digest,
      checked_at: iso(shadowQualification.checked_at_ms),
      venues: shadowQualification.venues,
      assets: shadowQualification.assets,
      requested_assets: shadowQualification.requested_assets,
      required_samples: shadowQualification.required_samples,
      completed_samples: shadowQualification.completed_samples,
      duration_ms: shadowQualification.duration_ms,
      expected_snapshots_per_sample: shadowQualification.expected_snapshots_per_sample,
      sample_commitments: shadowQualification.sample_commitments,
      transaction_broadcast: false,
      evidence_commitment: shadowQualification.evidence_commitment,
    },
    mandate: {
      policy_commitment: mandate.authorization.mandate_commitment,
      signed_mandate: mandate.authorization.signed_mandate,
      owner_signature: mandate.authorization.signature,
      ai_execution_authority: false,
      funding_owner_only: true,
      transfers_owner_only: true,
      withdrawals_owner_only: true,
    },
    qualification: {
      venues: qualifications.map((qualification) => ({
        venue_id: qualification.venue_id,
        proven: true,
        adapter_id: qualification.adapter_id,
        image_digest: qualification.image_digest,
        source: qualification.source,
        no_submit_ready: true,
        transaction_broadcast: false,
        evidence_commitment: qualification.evidence_commitment || `qualification:${qualification.venue_id}:registry`,
      })),
    },
    entry: {
      started_at: iso(entrySaga.created_at_ms),
      reconciled_at: iso(entrySaga.updated_at_ms),
      legs: entryLegs.legs,
    },
    monitoring: {
      started_at: iso(entryReconciledAt),
      ended_at: iso(monitoringEndedAt),
      observation_count: supervisedObservations.length,
      funding_flip_checks: supervisedObservations.length,
      supervision: {
        mode: "attested_worker_loop",
        automatic_observation_count: supervisedObservations.length,
        first_automatic_observed_at: iso(supervisedObservations[0].recorded_at_ms),
        last_automatic_observed_at: iso(monitoringEndedAt),
        transaction_broadcast: false,
      },
      margin_runways: pair.map((venueId) => ({
        venue_id: venueId,
        status: runwayStatuses[venueId],
        runway_ms: runwayValues[venueId],
        stale: false,
      })),
    },
    exit: {
      reason: exitRequest ? "manual" : "risk_mandate",
      requested_at: iso(exitRequestedAt),
      reconciled_at: iso(exitSaga.updated_at_ms),
      legs: exitLegs.legs,
    },
    final_state: {
      owner_commitment: record.owner_commitment,
      carry_position_id: record.position.position_id,
      checked_at: iso(finalState.checked_at_ms),
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      venues: finalAssessment.venues.map((item) => ({
        venue_id: item.venue_id,
        account_commitment: item.account_commitment,
        authorized: true,
        flat_zero_orders: true,
        nonzero_position_count: item.position_count,
        open_order_count: item.open_order_count,
        account_state_checked: true,
      })),
    },
    value_ledger: releaseValueLedger(record),
  };
  material.worker_material_commitment = workerMaterialCommitment(material);
  return { ok: true, material };
}

async function materialLegs({ state, saga, record, phase }) {
  const legs = [];
  for (const sagaLeg of saga.legs || []) {
    const context = saga.execution_context?.legs?.find((item) => item.leg_id === sagaLeg.leg_id);
    if (!context) return denied(`carry_release_${phase}_context_missing:${sagaLeg.venue_id}`);
    const [cached, attempt] = await Promise.all([
      state.getIdempotency?.(context.work_order_commitment),
      state.getExecutionAttempt?.(context.work_order_commitment),
    ]);
    const receipt = cached?.receipt || attempt || null;
    const expectedAccountCommitment = record.monitoring_context?.venue_access?.[sagaLeg.venue_id]?.account_commitment;
    if (!expectedAccountCommitment || receipt?.account_commitment !== expectedAccountCommitment) {
      return denied(`carry_release_${phase}_account_binding_mismatch:${sagaLeg.venue_id}`);
    }
    const proof = receipt?.final_proof || attempt?.final_proof || null;
    if (attempt?.submit_count !== 1 || attempt?.ambiguity_retry_count !== 0) {
      return denied(`carry_release_${phase}_submission_count_unproven:${sagaLeg.venue_id}`);
    }
    if (proof?.target_client_order_matched !== true || proof?.final_venue_execution_proven !== true || !positiveDecimal(proof?.filled_base_size)) {
      return denied(`carry_release_${phase}_terminal_proof_missing:${sagaLeg.venue_id}`);
    }
    const ledgerEntries = record.value_ledger.entries || [];
    const executionLedgerEntries = ledgerEntries.filter((entry) => entry.leg_id === sagaLeg.leg_id);
    const fundingLegId = carryPositionLegId(record.position, sagaLeg.venue_id);
    const fundingLedgerEntries = phase === "entry"
      ? ledgerEntries.filter((entry) => entry.entry_type === "funding"
        && entry.venue_id === sagaLeg.venue_id
        && entry.leg_id === fundingLegId)
      : [];
    legs.push({
      venue_id: sagaLeg.venue_id,
      account_commitment: expectedAccountCommitment,
      side: context.instruction?.order?.side,
      reduce_only: context.instruction?.order?.reduce_only === true,
      client_order_commitment: receipt?.provider_ref_commitment || providerCommitment(attempt?.provider_ref_seed),
      submit_count: attempt.submit_count,
      ambiguity_retry_count: attempt.ambiguity_retry_count,
      target_client_order_matched: true,
      final_venue_execution_proven: true,
      filled_base_size: String(proof.filled_base_size),
      funding_micro_usdc: sumSignedEntries(fundingLedgerEntries, "funding"),
      fee_micro_usdc: sumEntries(executionLedgerEntries, "trading_fee"),
      slippage_micro_usdc: sumEntries(executionLedgerEntries, "slippage"),
      receipt_commitment: receipt?.result_commitment || `receipt:${digest(JSON.stringify(proof))}`,
    });
  }
  return legs.length === 2 ? { ok: true, legs } : denied(`carry_release_${phase}_legs_missing`);
}

function releaseValueLedger(record) {
  const ledger = record.value_ledger;
  const modeled = ledger.modeled;
  const realized = ledger.realized;
  const contractPnl = Number(record.value_evidence?.realized_economics?.contract_pnl_micro_usdc || 0);
  return {
    finalized: ledger.status === "finalized",
    complete_costs: record.value_evidence?.costs_complete === true,
    modeled: {
      gross_funding_micro_usdc: modeled.gross_funding_micro_usdc,
      total_cost_micro_usdc: modeled.trading_cost_micro_usdc + modeled.capital_cost_micro_usdc + modeled.risk_buffer_micro_usdc,
      expected_net_micro_usdc: modeled.net_value_micro_usdc,
    },
    realized: {
      contract_pnl_micro_usdc: contractPnl,
      funding_micro_usdc: realized.funding_credit_micro_usdc - realized.funding_debit_micro_usdc,
      fees_micro_usdc: realized.trading_fee_micro_usdc,
      slippage_micro_usdc: realized.slippage_micro_usdc,
      gas_micro_usdc: realized.gas_micro_usdc,
      capital_cost_micro_usdc: realized.capital_cost_micro_usdc,
      transfer_fees_micro_usdc: realized.transfer_fee_micro_usdc,
      rebates_micro_usdc: realized.rebate_micro_usdc,
      net_value_micro_usdc: realized.net_value_micro_usdc,
    },
    evidence_commitment: record.final_reconciliation_evidence.reconciliation_commitment,
  };
}

function releaseContractEquivalence(opportunity) {
  const values = [
    opportunity?.contract_data_skew_ms,
    opportunity?.max_contract_data_skew_ms,
    opportunity?.index_price_divergence_bps,
    opportunity?.mark_price_divergence_bps,
    opportunity?.max_index_price_divergence_bps,
    opportunity?.max_mark_price_divergence_bps,
  ];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)
    || !positiveInteger(opportunity?.checked_at_ms)
    || !/^[A-Za-z0-9:_-]{8,180}$/.test(String(opportunity?.economic_equivalence_id || ""))
    || opportunity?.contract_type !== "linear_perp"
    || !["USD", "USDC", "USDT"].includes(opportunity?.long_quote_asset)
    || !["USD", "USDC", "USDT"].includes(opportunity?.short_quote_asset)) {
    return denied("carry_release_contract_equivalence_evidence_missing");
  }
  if (opportunity.contract_data_skew_ms > opportunity.max_contract_data_skew_ms
    || opportunity.index_price_divergence_bps > opportunity.max_index_price_divergence_bps
    || opportunity.mark_price_divergence_bps > opportunity.max_mark_price_divergence_bps) {
    return denied("carry_release_contract_equivalence_exceeded");
  }
  return {
    ok: true,
    evidence: {
      verified: true,
      checked_at: iso(opportunity.checked_at_ms),
      economic_equivalence_id: opportunity.economic_equivalence_id,
      contract_type: opportunity.contract_type,
      long_quote_asset: opportunity.long_quote_asset,
      short_quote_asset: opportunity.short_quote_asset,
      contract_data_skew_ms: opportunity.contract_data_skew_ms,
      max_contract_data_skew_ms: opportunity.max_contract_data_skew_ms,
      index_price_divergence_bps: opportunity.index_price_divergence_bps,
      mark_price_divergence_bps: opportunity.mark_price_divergence_bps,
      max_index_price_divergence_bps: opportunity.max_index_price_divergence_bps,
      max_mark_price_divergence_bps: opportunity.max_mark_price_divergence_bps,
    },
  };
}

function workerMaterialCommitment(material) {
  const payload = { ...material };
  delete payload.worker_material_commitment;
  return `carry:release:material:${digest(stableJson(payload))}`;
}

function providerCommitment(value) {
  return `provider:${digest(JSON.stringify(value || null))}`;
}

function sumEntries(entries, type) {
  return entries.filter((entry) => entry.entry_type === type && entry.direction === "debit")
    .reduce((sum, entry) => sum + Number(entry.amount_micro_usdc || 0), 0);
}

function sumSignedEntries(entries, type) {
  return entries.filter((entry) => entry.entry_type === type)
    .reduce((sum, entry) => sum + (entry.direction === "credit" ? 1 : -1) * Number(entry.amount_micro_usdc || 0), 0);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function iso(value) {
  return new Date(value).toISOString();
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveDecimal(value) {
  return /^\d+(?:\.\d+)?$/.test(String(value || "")) && Number(value) > 0;
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function denied(error) {
  return { ok: false, error };
}
