import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  adverseExecutionSlippageE6Bps,
  appendCarryValueLedgerEntry,
  advanceCarryPosition,
  calculateMarginRunway,
  canonicalCarryCommitmentJson,
  cashflowValuationEvidenceMessage,
  carryCreationOpportunityAuthenticationMessage,
  carryPortfolioValueAuthenticationMessage,
  carryReleaseMaterialAuthenticationMessage,
  carryPrivatePrimeWorkerAuthenticationMessage,
  carryCollateralReviewMessage,
  carryRiskMandateMessage,
  compileCarryCapitalActionPlan,
  compileCarryCollateralReview,
  compileCarryPortfolioCapitalPlan,
  compileCarryPortfolioValueReport,
  compileCarryMigrationProposal,
  convertSignedCashflowToMicroUsdc,
  createCarryPosition,
  createCarryValueLedger,
  evaluateCarryOpportunity,
  estimatePerpDepthExecution,
  finalizeCarryValueLedger,
  normalizeCarryRiskMandateAuthorization,
  normalizeCarryRiskMandatePayload,
  normalizeCarryCollateralReviewPayload,
  normalizeCarryCollateralReviewAuthorization,
  normalizeCarryLifecycleValueAttribution,
  normalizeCashflowValuation,
  normalizePerpContractSpec,
  sha256HexUtf8,
  venueAdapterCapability,
} from "../index.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const OPPORTUNITY_EVIDENCE = `carry:creation-opportunity:evidence:${"a".repeat(64)}`;

function costOperationEvidence({ phase, venueId, legId, noFill, executionEvidenceCommitment = null }) {
  const executionEvidence = executionEvidenceCommitment || `carry:value:evidence:${phase}:${venueId}`;
  const terminalMaterial = noFill
    ? {
      version: 1,
      evidence_kind: "saga_terminal_no_fill_v1",
      phase,
      venue_id: venueId,
      leg_id: legId,
      work_order_commitment: `carry:work:${phase}:${venueId}`,
      provider_ref_commitment: null,
      saga_id: `carry:saga:${venueId}:0001`,
      saga_status: "failed_no_fill",
      saga_terminal_reason: null,
      submission_status: "failed",
      cancel_confirmed: false,
      terminal: true,
      filled_micro_usdc: 0,
      network_transaction_submitted: false,
      transfer_operation_requested: false,
    }
    : {
      version: 1,
      evidence_kind: "provider_terminal_execution_v1",
      phase,
      venue_id: venueId,
      leg_id: legId,
      work_order_commitment: `carry:work:${phase}:${venueId}`,
      provider_ref_commitment: `carry:provider:${phase}:${venueId}`,
      result_commitment: `carry:result:${phase}:${venueId}`,
      execution_evidence_commitment: executionEvidence,
      terminal_status: "filled",
      network_transaction_submitted: false,
      transfer_operation_requested: false,
    };
  const terminalEvidenceCommitment = `carry:cost-terminal-evidence:${sha256HexUtf8(canonicalCarryCommitmentJson(terminalMaterial))}`;
  const terminalEvidence = { ...terminalMaterial, evidence_commitment: terminalEvidenceCommitment };
  const material = {
    version: 1,
    evidence_kind: noFill
      ? "terminal_saga_no_fill_cost_scope_v1"
      : "terminal_provider_order_cost_scope_v1",
    phase,
    venue_id: venueId,
    leg_id: legId,
    source_evidence_commitments: noFill
      ? [terminalEvidenceCommitment]
      : [executionEvidence, terminalEvidenceCommitment].sort(),
    work_order_commitment: `carry:work:${phase}:${venueId}`,
    provider_ref_commitment: noFill ? null : `carry:provider:${phase}:${venueId}`,
    result_commitment: noFill ? null : `carry:result:${phase}:${venueId}`,
    terminal_evidence_commitment: terminalEvidenceCommitment,
    terminal_evidence: terminalEvidence,
    saga_id: noFill ? `carry:saga:${venueId}:0001` : null,
    saga_status: noFill ? "failed_no_fill" : null,
    submission_status: noFill ? "failed" : null,
    cancel_confirmed: false,
    terminal_no_fill: noFill,
    separate_network_fee_charged: false,
    transfer_operation_requested: false,
  };
  return {
    ...material,
    evidence_commitment: `carry:cost-operation-evidence:${sha256HexUtf8(canonicalCarryCommitmentJson(material))}`,
  };
}

function costProof({ category, phase, venueId, legId, operationEvidence, entries = [], noFill = false }) {
  const sourceEvidence = entries.length > 0
    ? [...new Set(entries.map((entry) => entry.evidence_commitment))].sort()
    : [operationEvidence.evidence_commitment];
  const zeroInvariant = category === "gas"
    ? { kind: "venue_order_api", network_transaction_submitted: false }
    : category === "transfer_fee"
      ? { kind: "no_transfer_operation", transfer_operation_requested: false }
      : { kind: "terminal_no_fill", terminal_order_status: "no_fill", filled_quantity_e8: 0 };
  const material = noFill || entries.length === 0
    ? {
      version: 1,
      phase,
      venue_id: venueId,
      leg_id: legId,
      category,
      status: "verified_zero",
      amount_micro_usdc: 0,
      proof_kind: category === "gas"
        ? "venue_order_api_no_network_transaction_v1"
        : category === "transfer_fee"
          ? "carry_execution_no_transfer_operation_v1"
          : "terminal_no_fill_zero_cost_v1",
      ledger_entry_ids: [],
      source_evidence_commitments: sourceEvidence,
      zero_invariant: zeroInvariant,
    }
    : {
      version: 1,
      phase,
      venue_id: venueId,
      leg_id: legId,
      category,
      status: "exact",
      amount_micro_usdc: entries.reduce((sum, entry) => category === "trading_fee" && entry.entry_type === "rebate"
        ? sum - entry.amount_micro_usdc : sum + entry.amount_micro_usdc, 0),
      proof_kind: "terminal_execution_exact_v1",
      ledger_entry_ids: entries.map((entry) => entry.entry_id),
      source_evidence_commitments: sourceEvidence,
      zero_invariant: null,
    };
  return {
    ...material,
    evidence_commitment: `carry:cost-proof:${sha256HexUtf8(canonicalCarryCommitmentJson(material))}`,
  };
}

function costManifest({ ledger, lifecycleKind = "aborted_entry_recovery" }) {
  const specs = lifecycleKind === "normal"
    ? [
      ["entry", "hyperliquid", "carry:leg:long"],
      ["entry", "lighter", "carry:leg:short"],
      ["exit", "hyperliquid", "carry:leg:long"],
      ["exit", "lighter", "carry:leg:short"],
    ]
    : [
      ["entry", "hyperliquid", "carry:leg:long"],
      ["entry", "lighter", "carry:leg:short"],
    ];
  const operations = specs.map(([phase, venueId, legId]) => {
    const phaseEntries = (ledger.entries || []).filter((entry) => entry.venue_id === venueId
      && entry.leg_id === legId && entry.entry_id.includes(`:portfolio:${phase}:`));
    const fees = phaseEntries.filter((entry) => ["trading_fee", "rebate"].includes(entry.entry_type));
    const slippage = phaseEntries.filter((entry) => entry.entry_type === "slippage");
    const gas = phaseEntries.filter((entry) => entry.entry_type === "gas");
    const transferFees = phaseEntries.filter((entry) => entry.entry_type === "transfer_fee");
    const noFill = lifecycleKind === "aborted_entry_recovery";
    const executionEvidenceCommitment = fees[0]?.evidence_commitment || slippage[0]?.evidence_commitment || null;
    const operationEvidence = costOperationEvidence({
      phase,
      venueId,
      legId,
      noFill,
      executionEvidenceCommitment,
    });
    return {
      operation_id: `carry:cost:${phase}:${venueId}`,
      phase,
      venue_id: venueId,
      leg_id: legId,
      operation_evidence: operationEvidence,
      costs: {
        trading_fee: costProof({ category: "trading_fee", phase, venueId, legId, operationEvidence, entries: fees, noFill }),
        slippage: costProof({ category: "slippage", phase, venueId, legId, operationEvidence, entries: slippage, noFill }),
        gas: costProof({ category: "gas", phase, venueId, legId, operationEvidence, entries: gas }),
        transfer_fee: costProof({ category: "transfer_fee", phase, venueId, legId, operationEvidence, entries: transferFees }),
      },
    };
  }).sort((left, right) => left.operation_id.localeCompare(right.operation_id));
  const material = {
    version: 1,
    position_id: ledger.position_id,
    status: "complete",
    lifecycle_kind: lifecycleKind,
    operations,
  };
  return {
    ...material,
    manifest_commitment: `carry:cost-manifest:${sha256HexUtf8(canonicalCarryCommitmentJson(material))}`,
  };
}

test("canonicalizes Carry proof material identically across runtimes", () => {
  assert.equal(
    canonicalCarryCommitmentJson({ z: 3, a: { y: 2, x: 1 }, omitted: undefined, rows: [{ b: 2, a: 1 }] }),
    '{"a":{"x":1,"y":2},"rows":[{"a":1,"b":2}],"z":3}',
  );
});

test("pure SHA-256 matches the standard vector and Node for canonical commitments", () => {
  assert.equal(sha256HexUtf8("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const value of ["", "Ghola 🛡️", canonicalCarryCommitmentJson({ z: 2, a: [1, "x"] })]) {
    assert.equal(sha256HexUtf8(value), createHash("sha256").update(value).digest("hex"));
  }
});

test("binds private-prime worker authentication to the exact request and expiring proof", () => {
  assert.equal(
    carryPrivatePrimeWorkerAuthenticationMessage({
      route_path: "/carry/readiness",
      owner_commitment: "owner_commitment_0001",
      asset: "BTC",
      operation_class: "readiness_read",
      work_order_commitment: "carry_readiness_0001",
      evidence_commitment: `carry:private-prime:${"a".repeat(40)}`,
      checked_at_ms: NOW,
      expires_at_ms: NOW + 5_000,
    }),
    `{"asset":"BTC","checked_at_ms":${NOW},"domain":"ghola-carry-private-prime-worker-authentication-v1","evidence_commitment":"carry:private-prime:${"a".repeat(40)}","expires_at_ms":${NOW + 5_000},"operation_class":"readiness_read","owner_commitment":"owner_commitment_0001","route_path":"/carry/readiness","version":1,"work_order_commitment":"carry_readiness_0001"}`,
  );
});

test("binds Carry creation economics to the owner and exact deterministic opportunity", () => {
  assert.equal(
    carryCreationOpportunityAuthenticationMessage({
      owner_commitment: "owner_commitment_0001",
      opportunity: { asset: "BTC", projected_net_value_micro_usdc: 123 },
      checked_at_ms: NOW,
      expires_at_ms: NOW + 30_000,
    }),
    `{"checked_at_ms":${NOW},"domain":"ghola-carry-creation-opportunity-authentication-v1","expires_at_ms":${NOW + 30_000},"opportunity":{"asset":"BTC","projected_net_value_micro_usdc":123},"owner_commitment":"owner_commitment_0001","version":1}`,
  );
});

test("binds portfolio value proof to the owner, request, and exact replayed report", () => {
  assert.equal(
    carryPortfolioValueAuthenticationMessage({
      route_path: "/carry/positions/value-report",
      owner_commitment: "owner_commitment_0001",
      owner_capital_budget_micro_usdc: 0,
      max_data_age_ms: 30_000,
      minimum_transfer_arrival_buffer_ms: 300_000,
      report_commitment: `carry:portfolio-value-report:${"a".repeat(64)}`,
      checked_at_ms: NOW,
      expires_at_ms: NOW + 30_000,
    }),
    `{"checked_at_ms":${NOW},"domain":"ghola-carry-portfolio-value-authentication-v1","expires_at_ms":${NOW + 30_000},"max_data_age_ms":30000,"minimum_transfer_arrival_buffer_ms":300000,"owner_capital_budget_micro_usdc":0,"owner_commitment":"owner_commitment_0001","report_commitment":"carry:portfolio-value-report:${"a".repeat(64)}","route_path":"/carry/positions/value-report","version":1}`,
  );
});

test("binds release material proof to its owner, position, and exact worker material", () => {
  const message = carryReleaseMaterialAuthenticationMessage({
    route_path: "/carry/positions/release-evidence",
    owner_commitment: "owner_commitment_0001",
    position_id: "carry:position:0001",
    material_commitment: `carry:release-response:${"a".repeat(64)}`,
    checked_at_ms: 1_800_000_000_000,
    expires_at_ms: 1_800_000_030_000,
  });
  assert.equal(message, canonicalCarryCommitmentJson({
    version: 1,
    domain: "ghola-carry-release-material-authentication-v1",
    route_path: "/carry/positions/release-evidence",
    owner_commitment: "owner_commitment_0001",
    position_id: "carry:position:0001",
    material_commitment: `carry:release-response:${"a".repeat(64)}`,
    checked_at_ms: 1_800_000_000_000,
    expires_at_ms: 1_800_000_030_000,
  }));
});

test("estimates executable price from full depth and fails closed on insufficient liquidity", () => {
  const sufficient = estimatePerpDepthExecution({
    side: "buy",
    depth_levels: [
      { price_e8: 10_000_000_000, size_e8: 100_000_000 },
      { price_e8: 10_200_000_000, size_e8: 100_000_000 },
    ],
    fallback_price_e8: 10_000_000_000,
    target_notional_micro_usdc: 150_000_000,
  });
  assert.equal(sufficient.status, "sufficient");
  assert.equal(sufficient.displayed_notional_micro_usdc, 202_000_000);
  assert.ok(sufficient.execution_price_e8 > 10_000_000_000);
  assert.ok(sufficient.execution_price_e8 < 10_200_000_000);

  const insufficient = estimatePerpDepthExecution({
    side: "sell",
    depth_levels: [{ price_e8: 10_000_000_000, size_e8: 10_000_000 }],
    target_notional_micro_usdc: 150_000_000,
  });
  assert.equal(insufficient.status, "insufficient");
  assert.equal(insufficient.displayed_notional_micro_usdc, 10_000_000);
});

test("measures only adverse execution slippage", () => {
  assert.equal(adverseExecutionSlippageE6Bps({
    side: "buy",
    mark_price_e8: 10_000_000_000,
    execution_price_e8: 10_100_000_000,
  }), 100_000_000);
  assert.equal(adverseExecutionSlippageE6Bps({
    side: "sell",
    mark_price_e8: 10_000_000_000,
    execution_price_e8: 10_100_000_000,
  }), 0);
});

function contract(venueId, fundingRate, overrides = {}) {
  const shadow = venueAdapterCapability(venueId, "perp_shadow");
  return {
    version: 1,
    venue_id: venueId,
    contract_id: `contract:${venueId}:btc`,
    economic_equivalence_id: "carry:btc-usd-linear",
    asset: "BTC",
    market: "BTC-USD",
    quote_asset: "USD",
    collateral_asset: "USDC",
    funding_settlement_asset: "USDC",
    fee_settlement_asset: "USDC",
    asset_valuations: [cashflowValuation("USD")],
    contract_type: "linear_perp",
    mark_price_e8: 6_000_000_000_000,
    index_price_e8: 6_000_000_000_000,
    funding_rate_bps_per_interval: fundingRate,
    funding_interval_ms: 8 * HOUR,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    initial_margin_bps: 1_000,
    maintenance_margin_bps: 500,
    liquidation_fee_bps: 0,
    margin_model: shadow.margin_model,
    liquidation_model: shadow.liquidation_model,
    minimum_notional_micro_usdc: 10_000_000,
    quantity_step_e8: 1_000,
    price_tick_e8: 100_000,
    as_of_ms: NOW - 500,
    ...overrides,
  };
}

function cashflowValuation(sourceAsset, overrides = {}) {
  const commitmentDigit = sourceAsset === "USD" ? "a" : sourceAsset === "USDT" ? "b" : "c";
  const boundSourceAmountMicro = overrides.bound_source_amount_micro ?? null;
  const boundValueMicroUsdc = boundSourceAmountMicro === null
    ? null
    : boundSourceAmountMicro > 0
      ? Number(BigInt(boundSourceAmountMicro) * BigInt(overrides.credit_rate_e8 ?? 100_000_000) / 100_000_000n)
      : -Number((BigInt(Math.abs(boundSourceAmountMicro)) * BigInt(overrides.debit_rate_e8 ?? 100_000_000) + 99_999_999n) / 100_000_000n);
  const valuation = {
    version: 1,
    source_asset: sourceAsset,
    valuation_asset: "USDC",
    verified: true,
    credit_rate_e8: 100_000_000,
    debit_rate_e8: 100_000_000,
    observed_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 30_000,
    evidence_source: "attested:stablecoin-book:v1",
    evidence_commitment: `carry:cashflow-valuation:evidence:${commitmentDigit.repeat(64)}`,
    ...(boundValueMicroUsdc === null ? {} : { bound_value_micro_usdc: boundValueMicroUsdc }),
    ...overrides,
  };
  return {
    ...valuation,
    evidence_message: overrides.evidence_message ?? cashflowValuationEvidenceMessage(valuation),
  };
}

function runway(venueId, overrides = {}) {
  return {
    ...calculateMarginRunway({
    version: 1,
    venue_id: venueId,
    equity_micro_usdc: 2_500_000_000,
    maintenance_margin_micro_usdc: 500_000_000,
    safety_buffer_micro_usdc: 500_000_000,
    position_notional_micro_usdc: 10_000_000_000,
    stress_loss_bps_per_hour: 50,
    funding_debit_bps_per_interval: 0,
    funding_interval_ms: 8 * HOUR,
    owner_transfer_latency_ms: HOUR,
    owner_response_buffer_ms: HOUR,
    liquidation_distance_bps: 2_500,
    liquidation_distance_verified: true,
    liquidation_distance_source: "venue_position_snapshot",
    minimum_liquidation_distance_bps: 1_000,
    as_of_ms: NOW,
    ...overrides,
    }),
    account_commitment: overrides.account_commitment || `account:${venueId}:0001`,
    account_state_commitment: overrides.account_state_commitment || `carry:account-state:${venueId}:0001`,
  };
}

function transferRoute(overrides = {}) {
  return {
    version: 1,
    route_id: "carry:transfer-route:lighter-hyperliquid:0001",
    evidence_source: "attested_worker",
    evidence_commitment: "carry:transfer-routes:evidence:0001",
    evidence_checked_at_ms: NOW,
    worker_image_digest: `sha256:${"a".repeat(64)}`,
    from_account_commitment: "account:lighter:0001",
    from_venue_id: "lighter",
    to_account_commitment: "account:hyperliquid:0001",
    to_venue_id: "hyperliquid",
    source_adapter_id: "lighter_arbitrum_usdc_v1",
    destination_adapter_id: "hyperliquid_arbitrum_usdc_v1",
    source_account_state_commitment: "carry:account-state:lighter:0001",
    destination_account_state_commitment: "carry:account-state:hyperliquid:0001",
    quote_commitment: "carry:transfer-quote:0001",
    valuation_asset: "USD",
    source_collateral_asset: "USDC",
    destination_collateral_asset: "USDC",
    conversion_required: false,
    status: "available",
    quote_verified: true,
    all_in_fee_verified: true,
    valuation_basis_verified: true,
    conversion_quote_verified: true,
    conversion_rate_e8: 100_000_000,
    minimum_transfer_micro_usdc: 0,
    maximum_transfer_micro_usdc: 1_000_000_000,
    withdrawal_fee_micro_usdc: 1_000,
    deposit_fee_micro_usdc: 0,
    conversion_fee_micro_usdc: 0,
    conversion_slippage_micro_usdc: 0,
    fee_micro_usdc: 1_000,
    estimated_latency_ms: 30 * 60_000,
    as_of_ms: NOW,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    ...overrides,
  };
}

function costs() {
  return {
    entry_fee_bps: 2,
    exit_fee_bps: 2,
    entry_slippage_bps: 1,
    exit_slippage_bps: 1,
    latency_penalty_bps: 0,
    gas_micro_usdc: 0,
  };
}

function position() {
  const input = {
    version: 1,
    position_id: "carry:position:0001",
    mandate_id: "carry:mandate:0001",
    asset: "BTC",
    long_venue_id: "hyperliquid",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000_000,
    opportunity_evidence_commitment: OPPORTUNITY_EVIDENCE,
    risk_mandate: {
      min_expected_net_benefit_bps: 5,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 6 * HOUR,
      max_hedge_error_micro_usdc: 1_000,
      max_data_age_ms: 30_000,
      max_contract_data_skew_ms: 2_000,
      max_index_price_divergence_bps: 25,
      max_mark_price_divergence_bps: 50,
      allow_migration: true,
    },
  };
  return createCarryPosition({
    ...input,
    mandate_authorization: mandateAuthorization(input),
    now_ms: NOW,
  });
}

function mandateAuthorization(input, overrides = {}) {
  const signedMandate = normalizeCarryRiskMandatePayload({
    version: 1,
    kind: "ghola_carry_risk_mandate",
    strategy_id: "delta_neutral_carry_v1",
    network: "mainnet",
    owner_commitment: "owner:carry:core:0001",
    owner_wallet_address: `0x${"11".repeat(20)}`,
    position_id: input.position_id,
    mandate_id: input.mandate_id,
    asset: input.asset,
    long_venue_id: input.long_venue_id,
    short_venue_id: input.short_venue_id,
    target_notional_micro_usdc: input.target_notional_micro_usdc,
    ...(input.opportunity_evidence_commitment ? {
      opportunity_evidence_commitment: input.opportunity_evidence_commitment,
    } : {}),
    risk_mandate: input.risk_mandate,
    ...(input.migration_parent_position_id ? {
      migration_parent_position_id: input.migration_parent_position_id,
      migration_candidate_id: input.migration_candidate_id,
    } : {}),
    issued_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 30 * DAY,
    ...overrides,
  });
  return normalizeCarryRiskMandateAuthorization({
    version: 1,
    signed_mandate: signedMandate,
    signature: `0x${"22".repeat(65)}`,
    mandate_commitment: `0x${"33".repeat(32)}`,
  });
}

function migrationPosition(riskOverrides = {}) {
  const input = {
    version: 1,
    position_id: "carry:position:migration:0001",
    mandate_id: "carry:mandate:migration:0001",
    asset: "BTC",
    long_venue_id: "hyperliquid",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000_000,
    risk_mandate: {
      min_expected_net_benefit_bps: 5,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 6 * HOUR,
      max_hedge_error_micro_usdc: 1_000,
      max_data_age_ms: 30_000,
      max_contract_data_skew_ms: 2_000,
      max_index_price_divergence_bps: 25,
      max_mark_price_divergence_bps: 50,
      min_migration_improvement_bps: 10,
      migration_venue_allowlist: ["hyperliquid", "lighter", "aster"],
      allow_migration: true,
      ...riskOverrides,
    },
  };
  const authorization = mandateAuthorization(input);
  return {
    current: createCarryPosition({ ...input, mandate_authorization: authorization, now_ms: NOW }),
    authorization,
  };
}

function migrationCandidate(candidateId, longVenue, shortVenue, expectedNetBps, transitionCostBps) {
  return {
    candidate_id: candidateId,
    asset: "BTC",
    economic_equivalence_id: "carry:btc-usd-linear",
    long_venue_id: longVenue,
    short_venue_id: shortVenue,
    expected_net_value_bps: expectedNetBps,
    transition_cost_bps: transitionCostBps,
    eligible: true,
    no_submit_ready: true,
    transaction_broadcast: false,
    qualification_reasons: [],
    checked_at_ms: NOW,
  };
}

function event(sequence, type, overrides = {}) {
  return { version: 1, event_id: `event:${String(sequence).padStart(4, "0")}`, sequence, type, ...overrides };
}

function contractObservation(overrides = {}) {
  return {
    contract_data_skew_ms: 0,
    max_contract_data_skew_ms: 2_000,
    index_price_divergence_bps: 0,
    mark_price_divergence_bps: 0,
    max_index_price_divergence_bps: 25,
    max_mark_price_divergence_bps: 50,
    margin_runway_status_by_venue: { hyperliquid: "healthy", lighter: "healthy" },
    ...fundingObservation(NOW),
    ...overrides,
  };
}

function fundingObservation(sourceAsOfMs, suffix = 0) {
  return {
    funding_observation_commitment: `carry:funding:current:${String(suffix).padStart(64, "0")}`,
    funding_source_observed_at_ms_by_venue: {
      hyperliquid: sourceAsOfMs,
      lighter: sourceAsOfMs,
    },
  };
}

function activePositionForObservation() {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  return advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
      first_exposure_at_ms: NOW + 1,
    }),
    now_ms: NOW + 2,
  }).position;
}

test("authoritative entry exposure requires explicit per-venue exchange fill boundaries", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  const result = advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
      first_exposure_observed_at_ms: NOW + 2,
      exposure_boundary_provenance: "authoritative_exchange_fill_time",
    }),
    now_ms: NOW + 3,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "carry_exposure_boundary_venue_binding_invalid");
});

test("normalizes CashflowValuationV1 and rounds signed values conservatively", () => {
  const valuation = normalizeCashflowValuation(cashflowValuation("USDT", {
    credit_rate_e8: 99_999_999,
    debit_rate_e8: 100_000_001,
  }));
  assert.equal(valuation.conversion_required, true);
  assert.equal(convertSignedCashflowToMicroUsdc({ amount_micro: 1, valuation }), 0);
  assert.equal(convertSignedCashflowToMicroUsdc({ amount_micro: -1, valuation }), -2);
  assert.equal(convertSignedCashflowToMicroUsdc({ amount_micro: 0, valuation }), 0);
  const bound = cashflowValuation("USDT", {
    bound_source_amount_micro: -1_000_001,
    bound_value_micro_usdc: -1_010_002,
    debit_rate_e8: 101_000_099,
  });
  assert.equal(convertSignedCashflowToMicroUsdc({ amount_micro: -1_000_001, valuation: bound }), -1_010_002);
  assert.throws(
    () => convertSignedCashflowToMicroUsdc({ amount_micro: -1_000_000, valuation: bound }),
    /cashflow_valuation_bound_amount_mismatch/,
  );
  assert.throws(() => normalizeCashflowValuation({
    ...cashflowValuation("USDT"),
    credit_rate_e8: 100_000_001,
    debit_rate_e8: 99_999_999,
  }), /cashflow_valuation_spread_invalid/);
  assert.throws(() => normalizeCashflowValuation({
    ...cashflowValuation("USDC"),
    credit_rate_e8: 99_999_999,
  }), /cashflow_valuation_identity_invalid/);
});

test("rejects contradictory or value-changing USDC identity evidence", () => {
  assert.throws(() => normalizeCashflowValuation(cashflowValuation("USDC", {
    bound_source_amount_micro: 500_000,
    bound_value_micro_usdc: 500_001,
  })), /cashflow_valuation_identity_bound_value_invalid/);
  assert.throws(() => normalizeCashflowValuation({
    ...cashflowValuation("USDC"),
    conversion_required: true,
  }), /cashflow_valuation_conversion_flag_invalid/);
  assert.throws(() => normalizeCashflowValuation({
    ...cashflowValuation("USDC"),
    evidence_payload: { unbound: true },
  }), /cashflow_valuation_identity_payload_invalid/);
  assert.throws(() => normalizeCashflowValuation({
    ...cashflowValuation("USDT"),
    conversion_required: false,
  }), /cashflow_valuation_conversion_flag_invalid/);
});

test("binds explicit fee and funding settlement assets to verified USDC valuations", () => {
  const normalized = normalizePerpContractSpec(contract("hyperliquid", 1));
  assert.equal(normalized.funding_settlement_asset, "USDC");
  assert.equal(normalized.fee_settlement_asset, "USDC");
  assert.equal(normalized.valuation_asset, "USDC");
  assert.equal(normalized.asset_valuations.USD.verified, true);
  assert.equal(normalized.asset_valuations.USDC.conversion_required, false);

  assert.throws(() => normalizePerpContractSpec(contract("hyperliquid", 1, {
    asset_valuations: [],
  })), /contract_asset_valuation_missing/);
  assert.throws(() => normalizePerpContractSpec(contract("hyperliquid", 1, {
    funding_settlement_asset: "USDT",
  })), /contract_asset_valuation_missing/);
  const usdtFunding = normalizePerpContractSpec(contract("hyperliquid", 1, {
    funding_settlement_asset: "USDT",
    asset_valuations: [cashflowValuation("USD"), cashflowValuation("USDT")],
  }));
  assert.equal(usdtFunding.asset_valuations.USDT.conversion_required, true);
  assert.throws(() => normalizePerpContractSpec(contract("hyperliquid", 1, {
    asset_valuations: [cashflowValuation("USDT")],
  })), /contract_asset_valuation_unbound/);
  assert.throws(() => normalizePerpContractSpec(contract("hyperliquid", 1, {
    asset_valuations: [cashflowValuation("USD", {
      expires_at_ms: NOW - 500,
    })],
  })), /contract_asset_valuation_stale/);
  assert.throws(() => normalizePerpContractSpec(contract("hyperliquid", 1, {
    asset_valuations: [cashflowValuation("USD", { verified: false })],
  })), /cashflow_valuation_unverified/);
  const committed = cashflowValuation("USD");
  assert.throws(() => normalizePerpContractSpec(contract("hyperliquid", 1, {
    asset_valuations: [{ ...committed, credit_rate_e8: 99_999_999 }],
  })), /cashflow_valuation_evidence_message/);

  const identityOnly = normalizePerpContractSpec(contract("hyperliquid", 1, {
    quote_asset: "USDC",
    asset_valuations: [],
  }));
  assert.deepEqual(Object.keys(identityOnly.asset_valuations), ["USDC"]);
});

test("fails opportunity evaluation before economics when valuation evidence expires", () => {
  assert.throws(() => evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1, {
      asset_valuations: [cashflowValuation("USD", {
        observed_at_ms: NOW - 2_000,
        expires_at_ms: NOW - 100,
      })],
      as_of_ms: NOW - 500,
    }),
    short_contract: contract("lighter", 4),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    min_expected_net_benefit_bps: 5,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  }), /carry_cashflow_valuation_stale/);
});

test("models carry after funding, round-trip costs, capital cost, risk buffer, and break-even", () => {
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1),
    short_contract: contract("lighter", 4),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    min_expected_net_benefit_bps: 5,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.eligible, true);
  assert.equal(
    result.projected_trading_fee_micro_usdc
      + result.projected_slippage_micro_usdc
      + result.projected_gas_micro_usdc
      + result.projected_latency_buffer_micro_usdc,
    result.projected_trading_cost_micro_usdc,
  );
  assert.equal(
    result.projected_funding_credit_micro_usdc - result.projected_funding_debit_micro_usdc,
    result.projected_gross_funding_micro_usdc,
  );
  assert.equal(result.projected_gross_funding_micro_usdc, 63_000_000);
  assert.equal(result.projected_trading_cost_micro_usdc, 12_000_000);
  assert.equal(result.projected_capital_cost_micro_usdc, 2_800_000);
  assert.equal(result.risk_buffer_micro_usdc, 3_000_000);
  assert.equal(result.projected_net_value_micro_usdc, 45_200_000);
  assert.ok(result.break_even_ms > DAY && result.break_even_ms < 2 * DAY);
});

test("converts each leg's modeled funding, fees, and slippage through its settlement valuation", () => {
  const usdtValuation = cashflowValuation("USDT", {
    credit_rate_e8: 98_000_000,
    debit_rate_e8: 102_000_000,
  });
  const input = {
    version: 1,
    long_contract: contract("hyperliquid", 1, {
      quote_asset: "USDT",
      funding_settlement_asset: "USDT",
      fee_settlement_asset: "USDT",
      asset_valuations: [usdtValuation],
    }),
    short_contract: contract("lighter", 4, {
      quote_asset: "USDC",
      asset_valuations: [],
    }),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    min_expected_net_benefit_bps: 0,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  };
  const result = evaluateCarryOpportunity(input);
  assert.equal(result.projected_long_funding_source_amount_micro, -21_000_000);
  assert.equal(result.projected_short_funding_source_amount_micro, 84_000_000);
  assert.equal(result.projected_long_funding_micro_usdc, -21_420_000);
  assert.equal(result.projected_short_funding_micro_usdc, 84_000_000);
  assert.equal(result.projected_gross_funding_micro_usdc, 62_580_000);
  assert.equal(result.projected_trading_fee_micro_usdc, 8_080_000);
  assert.equal(result.projected_slippage_micro_usdc, 4_040_000);
  assert.equal(result.projected_net_value_micro_usdc, 44_660_000);

  assert.throws(() => evaluateCarryOpportunity({
    ...input,
    long_contract: contract("hyperliquid", 1, {
      quote_asset: "USDT",
      funding_settlement_asset: "USDT",
      fee_settlement_asset: "USDT",
      asset_valuations: [cashflowValuation("USDT", {
        credit_rate_e8: 98_000_000,
        debit_rate_e8: 102_000_000,
        bound_source_amount_micro: -1,
      })],
    }),
  }), /valuation_amount_mismatch/);
});

test("prices collateral basis stress separately from the base risk buffer", () => {
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1),
    short_contract: contract("lighter", 4),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    collateral_basis_risk_bps: 50,
    min_expected_net_benefit_bps: 5,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.base_risk_buffer_micro_usdc, 3_000_000);
  assert.equal(result.collateral_basis_risk_micro_usdc, 50_000_000);
  assert.equal(result.risk_buffer_micro_usdc, 53_000_000);
  assert.equal(result.collateral_basis_risk_bps, 50);
});

test("binds venue liquidation models and prices liquidation fees into risk", () => {
  const input = {
    version: 1,
    long_contract: contract("hyperliquid", 1, { liquidation_fee_bps: 5 }),
    short_contract: contract("lighter", 4, { liquidation_fee_bps: 7 }),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    min_expected_net_benefit_bps: 0,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  };
  const result = evaluateCarryOpportunity(input);
  assert.equal(result.liquidation_fee_risk_micro_usdc, 12_000_000);
  assert.equal(result.risk_buffer_micro_usdc, 15_000_000);
  assert.equal(result.long_liquidation_model, venueAdapterCapability("hyperliquid", "perp_shadow").liquidation_model);
  assert.throws(() => evaluateCarryOpportunity({
    ...input,
    long_contract: { ...input.long_contract, liquidation_model: "unverified_liquidation_model" },
  }), /contract_risk_model_mismatch/);
});

test("fails margin runway closed without verified open-position liquidation distance", () => {
  const result = calculateMarginRunway({
    version: 1,
    venue_id: "hyperliquid",
    equity_micro_usdc: 2_500_000_000,
    maintenance_margin_micro_usdc: 500_000_000,
    safety_buffer_micro_usdc: 500_000_000,
    position_notional_micro_usdc: 10_000_000_000,
    stress_loss_bps_per_hour: 50,
    funding_debit_bps_per_interval: 0,
    funding_interval_ms: 8 * HOUR,
    owner_transfer_latency_ms: HOUR,
    owner_response_buffer_ms: HOUR,
    position_open: true,
    liquidation_distance_bps: 2_500,
    liquidation_distance_verified: false,
    liquidation_distance_source: "unverified_position_snapshot",
    minimum_liquidation_distance_bps: 1_000,
    as_of_ms: NOW,
  });
  assert.equal(result.status, "breached");
  assert.equal(result.liquidation_distance_verified, false);
  const missingSource = calculateMarginRunway({
    ...result,
    version: 1,
    equity_micro_usdc: 2_500_000_000,
    maintenance_margin_micro_usdc: 500_000_000,
    safety_buffer_micro_usdc: 500_000_000,
    position_notional_micro_usdc: 10_000_000_000,
    stress_loss_bps_per_hour: 50,
    funding_debit_bps_per_interval: 0,
    funding_interval_ms: 8 * HOUR,
    owner_transfer_latency_ms: HOUR,
    owner_response_buffer_ms: HOUR,
    liquidation_distance_verified: true,
    liquidation_distance_source: null,
  });
  assert.equal(missingSource.status, "breached");
  assert.equal(missingSource.liquidation_distance_verified, false);
});

test("preserves sub-basis-point funding precision", () => {
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 0, { funding_rate_e12_per_interval: 5_000_000 }),
    short_contract: contract("lighter", 0, { funding_rate_e12_per_interval: 25_000_000 }),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: { ...costs(), entry_fee_bps: 0, exit_fee_bps: 0, entry_slippage_bps: 0, exit_slippage_bps: 0 },
    short_costs: { ...costs(), entry_fee_bps: 0, exit_fee_bps: 0, entry_slippage_bps: 0, exit_slippage_bps: 0 },
    capital_cost_bps_per_day: 0,
    risk_buffer_bps: 0,
    min_expected_net_benefit_bps: 0,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.projected_gross_funding_micro_usdc, 4_200_000);
  assert.equal(result.eligible, true);
});

test("preserves account-specific sub-basis-point fee precision", () => {
  const preciseCosts = {
    entry_fee_e6_bps: 1_050_000,
    exit_fee_e6_bps: 1_050_000,
    entry_slippage_bps: 0,
    exit_slippage_bps: 0,
    latency_penalty_bps: 0,
    gas_micro_usdc: 0,
  };
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1, { taker_fee_e6_bps: 1_050_000 }),
    short_contract: contract("lighter", 4, { taker_fee_e6_bps: 1_050_000 }),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: preciseCosts,
    short_costs: preciseCosts,
    capital_cost_bps_per_day: 0,
    risk_buffer_bps: 0,
    min_expected_net_benefit_bps: 0,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.projected_trading_cost_micro_usdc, 4_200_000);
});

test("preserves sub-basis-point slippage precision", () => {
  const preciseCosts = {
    entry_fee_e6_bps: 0,
    exit_fee_e6_bps: 0,
    entry_slippage_e6_bps: 105_000,
    exit_slippage_e6_bps: 105_000,
    latency_penalty_bps: 0,
    gas_micro_usdc: 0,
  };
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1),
    short_contract: contract("lighter", 4),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: preciseCosts,
    short_costs: preciseCosts,
    capital_cost_bps_per_day: 0,
    risk_buffer_bps: 0,
    min_expected_net_benefit_bps: 0,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.projected_trading_cost_micro_usdc, 420_000);
});

test("rejects a false carry spread built from cross-venue observations outside the skew budget", () => {
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1, { as_of_ms: NOW - 500 }),
    short_contract: contract("lighter", 4, { as_of_ms: NOW - 5_000 }),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    min_expected_net_benefit_bps: 5,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.contract_data_skew_ms, 4_500);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("contract_data_skew_exceeded"));
});

test("rejects same-ticker contracts whose index or mark basis exceeds equivalence budgets", () => {
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1),
    short_contract: contract("lighter", 4, {
      index_price_e8: 6_030_000_000_000,
      mark_price_e8: 6_060_000_000_000,
    }),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    min_expected_net_benefit_bps: 5,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
    max_index_price_divergence_bps: 25,
    max_mark_price_divergence_bps: 50,
  });
  assert.equal(result.index_price_divergence_bps, 50);
  assert.equal(result.mark_price_divergence_bps, 100);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("index_price_divergence_exceeded"));
  assert.ok(result.reasons.includes("mark_price_divergence_exceeded"));
});

test("margin runway exposes owner response risk without granting transfer authority", () => {
  const healthy = runway("hyperliquid");
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.runway_ms, 30 * HOUR);
  assert.equal(healthy.automatic_transfer_permitted, false);

  const critical = runway("hyperliquid", {
    equity_micro_usdc: 1_050_000_000,
    maintenance_margin_micro_usdc: 500_000_000,
    safety_buffer_micro_usdc: 500_000_000,
  });
  assert.equal(critical.status, "critical");
  assert.equal(critical.owner_action_required, true);
});

test("capital planner quantifies the minimum owner top-up without transfer authority", () => {
  const current = activePositionForObservation();
  const plan = compileCarryCapitalActionPlan({
    version: 1,
    position: current,
    margin_runways: [
      runway("hyperliquid", {
        equity_micro_usdc: 1_350_000_000,
        maintenance_margin_micro_usdc: 500_000_000,
        safety_buffer_micro_usdc: 500_000_000,
        owner_transfer_latency_ms: 2 * HOUR,
        owner_response_buffer_ms: 2 * HOUR,
      }),
      runway("lighter"),
    ],
    now_ms: NOW,
  });
  assert.equal(plan.status, "owner_action_required");
  assert.equal(plan.recommended_action, "owner_collateral_review");
  assert.equal(plan.minimum_additional_collateral_micro_usdc, 50_000_014);
  assert.deepEqual(plan.legs.map((leg) => leg.recommended_action), ["owner_fund_venue", "none"]);
  assert.equal(plan.proposal_only, true);
  assert.equal(plan.transaction_broadcast, false);
  assert.equal(plan.automatic_transfer_permitted, false);
});

test("portfolio capital planner aggregates shared accounts and proposes owner-only reallocation", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [
      runway("hyperliquid", {
        equity_micro_usdc: 1_350_000_000,
        maintenance_margin_micro_usdc: 500_000_000,
        safety_buffer_micro_usdc: 500_000_000,
        owner_transfer_latency_ms: 2 * HOUR,
        owner_response_buffer_ms: 2 * HOUR,
      }),
      runway("lighter"),
    ],
    now_ms: NOW,
  });
  const secondPlan = {
    ...positionPlan,
    position_id: "carry:position:0002",
    minimum_additional_collateral_micro_usdc: 25_000_000,
    legs: positionPlan.legs.map((leg) => leg.venue_id === "hyperliquid"
      ? {
          ...leg,
          runway_ms: 3 * HOUR,
          minimum_additional_collateral_micro_usdc: 25_000_000,
        }
      : leg),
  };
  const plan = compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 40_000_000,
    transfer_routes: [transferRoute()],
    position_plans: [positionPlan, secondPlan],
  });
  assert.equal(plan.status, "owner_action_required");
  assert.equal(plan.position_count, 2);
  assert.equal(plan.account_count, 2);
  assert.equal(plan.total_requested_micro_usdc, 450_000_028);
  assert.equal(plan.total_potential_releasable_micro_usdc, 900_000_000);
  assert.equal(plan.total_proposed_internal_reallocation_micro_usdc, 450_000_028);
  assert.equal(plan.net_new_owner_capital_requested_micro_usdc, 0);
  assert.equal(plan.total_proposed_allocation_micro_usdc, 0);
  assert.equal(plan.total_uncovered_shortfall_micro_usdc, 0);
  assert.deepEqual(plan.allocations[0].position_ids, ["carry:position:0001", "carry:position:0002"]);
  assert.equal(plan.allocations[0].proposed_internal_reallocation_micro_usdc, 450_000_028);
  assert.equal(plan.proposed_reallocations[0].from_venue_id, "lighter");
  assert.equal(plan.proposed_reallocations[0].to_venue_id, "hyperliquid");
  assert.equal(plan.proposed_reallocations[0].amount_micro_usdc, 450_000_028);
  assert.equal(plan.proposed_reallocations[0].gross_debit_micro_usdc, 450_001_028);
  assert.equal(plan.proposed_reallocations[0].route_verified, true);
  assert.equal(plan.proposed_reallocations[0].expected_arrival_at_ms, NOW + 30 * 60_000);
  assert.equal(
    plan.proposed_reallocations[0].destination_runway_at_arrival_ms,
    plan.proposed_reallocations[0].destination_runway_deadline_at_ms
      - plan.proposed_reallocations[0].expected_arrival_at_ms,
  );
  assert.equal(plan.total_proposed_internal_reallocation_fees_micro_usdc, 1_000);
  assert.equal(plan.owner_transfer_approval_required, true);
  assert.equal(plan.owner_approval_required, true);
  assert.equal(plan.proposal_only, true);
  assert.equal(plan.transaction_broadcast, false);
  assert.equal(plan.automatic_transfer_permitted, false);
});

test("portfolio capital planner never treats an unverified or late transfer as rescued margin", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [
      runway("hyperliquid", {
        equity_micro_usdc: 1_350_000_000,
        maintenance_margin_micro_usdc: 500_000_000,
        safety_buffer_micro_usdc: 500_000_000,
        owner_transfer_latency_ms: 2 * HOUR,
        owner_response_buffer_ms: 2 * HOUR,
      }),
      runway("lighter"),
    ],
    now_ms: NOW,
  });
  const missingRoute = compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 0,
    position_plans: [positionPlan],
  });
  assert.equal(missingRoute.total_proposed_internal_reallocation_micro_usdc, 0);
  assert.equal(missingRoute.net_new_owner_capital_requested_micro_usdc, missingRoute.total_requested_micro_usdc);
  assert.equal(missingRoute.routeable_capital_optimization_available, false);
  assert.ok(missingRoute.transfer_route_failures.some((reason) => reason.startsWith("transfer_route_missing:")));

  assert.throws(() => compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 0,
    transfer_routes: [transferRoute({ evidence_source: "browser" })],
    position_plans: [positionPlan],
  }), /carry_transfer_route_evidence_source/);

  const staleAccountRoute = compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 0,
    transfer_routes: [transferRoute({
      source_account_state_commitment: "carry:account-state:lighter:stale",
    })],
    position_plans: [positionPlan],
  });
  assert.equal(staleAccountRoute.total_proposed_internal_reallocation_micro_usdc, 0);
  assert.equal(staleAccountRoute.transfer_route_failures[0].startsWith("transfer_route_missing:"), true);

  const lateRoute = compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    minimum_transfer_arrival_buffer_ms: HOUR,
    owner_capital_budget_micro_usdc: 0,
    transfer_routes: [transferRoute({ estimated_latency_ms: 7 * HOUR })],
    position_plans: [positionPlan],
  });
  assert.equal(lateRoute.total_proposed_internal_reallocation_micro_usdc, 0);
  assert.deepEqual(lateRoute.transfer_route_failures, [
    "transfer_route_arrival_unsafe:carry:transfer-route:lighter-hyperliquid:0001",
  ]);
});

test("portfolio capital planner quarantines stale evidence and allocates nothing", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [
      runway("hyperliquid", {
        equity_micro_usdc: 1_350_000_000,
        maintenance_margin_micro_usdc: 500_000_000,
        safety_buffer_micro_usdc: 500_000_000,
        owner_transfer_latency_ms: 2 * HOUR,
        owner_response_buffer_ms: 2 * HOUR,
      }),
      runway("lighter"),
    ],
    now_ms: NOW,
  });
  const plan = compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW + 30_001,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 100_000_000,
    position_plans: [positionPlan],
  });
  assert.equal(plan.status, "quarantined");
  assert.equal(plan.recommended_action, "reconcile_only");
  assert.equal(plan.total_proposed_allocation_micro_usdc, 0);
  assert.equal(plan.unallocated_owner_capital_micro_usdc, 100_000_000);
  assert.deepEqual(plan.stale_position_ids, ["carry:position:0001"]);
});

test("portfolio capital planner rejects any plan that weakens owner-only authority", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
  });
  assert.throws(() => compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 0,
    position_plans: [{ ...positionPlan, automatic_transfer_permitted: true }],
  }), /carry_portfolio_capital_position_authority_boundary/);
});

test("portfolio capital planner rejects one account commitment claimed by multiple venues", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
  });
  const sharedAccountPlan = {
    ...positionPlan,
    legs: positionPlan.legs.map((leg) => leg.venue_id === "lighter"
      ? { ...leg, account_commitment: "account:hyperliquid:0001" }
      : leg),
  };
  assert.throws(() => compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 0,
    position_plans: [sharedAccountPlan],
  }), /carry_portfolio_capital_account_venue_mismatch/);
});

test("portfolio capital planner rejects conflicting account states at the same observation time", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
  });
  const conflictingPlan = {
    ...positionPlan,
    position_id: "carry:position:0002",
    legs: positionPlan.legs.map((leg) => leg.venue_id === "lighter"
      ? { ...leg, account_state_commitment: "carry:account-state:lighter:conflict" }
      : leg),
  };
  assert.throws(() => compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 0,
    position_plans: [positionPlan, conflictingPlan],
  }), /carry_portfolio_capital_account_state_ambiguous/);
});

test("collateral review binds exact owner-only moves without authorizing fund movement", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [
      runway("hyperliquid", {
        equity_micro_usdc: 1_350_000_000,
        maintenance_margin_micro_usdc: 500_000_000,
        safety_buffer_micro_usdc: 500_000_000,
        owner_transfer_latency_ms: 2 * HOUR,
        owner_response_buffer_ms: 2 * HOUR,
      }),
      runway("lighter"),
    ],
    now_ms: NOW,
  });
  const review = compileCarryCollateralReview({
    version: 1,
    owner_commitment: "owner:commitment:0001",
    owner_wallet_address: "0x1111111111111111111111111111111111111111",
    review_id: "carry:review:0001",
    now_ms: NOW,
    expires_at_ms: NOW + 10 * 60_000,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 0,
    transfer_routes: [transferRoute()],
    position_plans: [positionPlan],
  });
  assert.equal(review.status, "signature_required");
  assert.equal(review.max_data_age_ms, 30_000);
  assert.equal(review.owner_signature_required, true);
  assert.equal(review.transfer_instructions.length, 1);
  assert.equal(review.transfer_instructions[0].from_venue_id, "lighter");
  assert.equal(review.transfer_instructions[0].to_venue_id, "hyperliquid");
  assert.equal(review.transfer_instructions[0].route_verified, true);
  assert.equal(review.transfer_instructions[0].fee_micro_usdc, 1_000);
  assert.equal(review.execution_authorized, false);
  assert.equal(review.fund_movement_authorized, false);
  assert.equal(review.transaction_broadcast, false);
  assert.match(carryCollateralReviewMessage(review), /^Ghola Carry collateral review v1\n/);
  const message = carryCollateralReviewMessage(review);
  const authorization = normalizeCarryCollateralReviewAuthorization({
    version: 1,
    signed_review: review,
    signature: `0x${"11".repeat(65)}`,
    review_commitment: `0x${"22".repeat(32)}`,
  });
  assert.equal(authorization.signed_review.review_id, review.review_id);
  assert.throws(() => normalizeCarryCollateralReviewPayload({
    ...review,
    execution_authorized: true,
  }), /carry_collateral_review_authority_boundary/);
  assert.throws(() => normalizeCarryCollateralReviewPayload({
    ...review,
    transfer_instructions: [{
      ...review.transfer_instructions[0],
      amount_micro_usdc: review.transfer_instructions[0].amount_micro_usdc + 1,
    }],
  }), /carry_collateral_review_transfer_net_mismatch|carry_collateral_review_instruction_plan_mismatch/);
});

test("collateral review exposes no instruction when capital evidence is stale", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
  });
  const review = compileCarryCollateralReview({
    version: 1,
    owner_commitment: "owner:commitment:0001",
    review_id: "carry:review:stale:0001",
    now_ms: NOW + 30_001,
    expires_at_ms: NOW + 30_001 + 10 * 60_000,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 100_000_000,
    position_plans: [positionPlan],
  });
  assert.equal(review.status, "blocked");
  assert.equal(review.owner_signature_status, "blocked");
  assert.deepEqual(review.transfer_instructions, []);
  assert.deepEqual(review.funding_instructions, []);
});

test("capital planner quarantines stale evidence and permits reconciliation only", () => {
  const current = activePositionForObservation();
  const plan = compileCarryCapitalActionPlan({
    version: 1,
    position: current,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW + 30_001,
  });
  assert.equal(plan.status, "quarantined");
  assert.equal(plan.recommended_action, "reconcile_only");
  assert.equal(plan.reconciliation_required, true);
  assert.equal(plan.reduce_only_exit_required, false);
  assert.equal(plan.owner_funding_required, false);
  assert.equal(plan.minimum_additional_collateral_micro_usdc, 0);
  assert.ok(plan.reasons.includes("margin_data_stale:hyperliquid"));
  assert.equal(plan.automatic_transfer_permitted, false);
});

test("capital planner prioritizes an expired signed mandate over stale evidence", () => {
  const current = activePositionForObservation();
  const plan = compileCarryCapitalActionPlan({
    version: 1,
    position: current,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW + 30 * DAY,
  });
  assert.equal(plan.status, "exit_required");
  assert.equal(plan.recommended_action, "reduce_only_exit");
  assert.equal(plan.reduce_only_exit_required, true);
  assert.equal(plan.reconciliation_required, false);
  assert.ok(plan.reasons.includes("risk_mandate_expired"));
  assert.equal(plan.transaction_broadcast, false);
});

test("capital planner rejects evidence that could grant automatic transfer authority", () => {
  const current = activePositionForObservation();
  assert.throws(() => compileCarryCapitalActionPlan({
    version: 1,
    position: current,
    margin_runways: [
      { ...runway("hyperliquid"), automatic_transfer_permitted: true },
      runway("lighter"),
    ],
    now_ms: NOW,
  }), /carry_capital_automatic_transfer_forbidden/);
});

test("legacy signed mandates remain verifiable without newly added contract-limit fields", () => {
  const input = {
    version: 1,
    kind: "ghola_carry_risk_mandate",
    strategy_id: "delta_neutral_carry_v1",
    network: "mainnet",
    owner_commitment: "owner:carry:legacy:0001",
    owner_wallet_address: `0x${"11".repeat(20)}`,
    position_id: "carry:position:legacy:0001",
    mandate_id: "carry:mandate:legacy:0001",
    asset: "BTC",
    long_venue_id: "hyperliquid",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000,
    risk_mandate: {
      min_expected_net_benefit_bps: 5,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 6 * HOUR,
      max_hedge_error_micro_usdc: 1_000,
      max_data_age_ms: 30_000,
      allow_migration: false,
    },
    issued_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 30 * DAY,
  };
  const normalized = normalizeCarryRiskMandatePayload(input);
  assert.equal(Object.hasOwn(normalized.risk_mandate, "max_contract_data_skew_ms"), false);
  assert.equal(Object.hasOwn(normalized, "opportunity_evidence_commitment"), false);
  assert.equal(carryRiskMandateMessage(input).includes("max_contract_data_skew_ms"), false);
});

test("an owner mandate is bound to the exact worker-signed Carry opportunity", () => {
  const input = {
    version: 1,
    position_id: "carry:position:opportunity-bound:0001",
    mandate_id: "carry:mandate:opportunity-bound:0001",
    asset: "BTC",
    long_venue_id: "hyperliquid",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000,
    opportunity_evidence_commitment: OPPORTUNITY_EVIDENCE,
    risk_mandate: position().risk_mandate,
  };
  const authorization = mandateAuthorization(input);
  assert.throws(
    () => createCarryPosition({
      ...input,
      opportunity_evidence_commitment: `carry:creation-opportunity:evidence:${"b".repeat(64)}`,
      mandate_authorization: authorization,
      now_ms: NOW,
    }),
    (error) => error?.code === "carry_mandate_position_mismatch",
  );
});

test("a replacement Carry Position is cryptographically bound to its migration parent and candidate", () => {
  const input = {
    version: 1,
    position_id: "carry:position:migration:replacement:0001",
    mandate_id: "carry:mandate:migration:replacement:0001",
    migration_parent_position_id: "carry:position:migration:0001",
    migration_candidate_id: "carry:migration:aster:0001",
    asset: "BTC",
    long_venue_id: "aster",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000_000,
    risk_mandate: migrationPosition().current.risk_mandate,
  };
  const authorization = mandateAuthorization(input);
  const replacement = createCarryPosition({ ...input, mandate_authorization: authorization, now_ms: NOW });
  assert.equal(replacement.migration_parent_position_id, input.migration_parent_position_id);
  assert.equal(replacement.migration_candidate_id, input.migration_candidate_id);
  assert.throws(
    () => createCarryPosition({
      ...input,
      migration_candidate_id: "carry:migration:tampered:0001",
      mandate_authorization: authorization,
      now_ms: NOW,
    }),
    (error) => error?.code === "carry_mandate_position_mismatch",
  );
});

test("two confirmed carry flips trigger a deterministic reduce-only exit", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
      first_exposure_at_ms: NOW + 1,
    }),
    now_ms: NOW + 2,
  }).position;
  assert.equal(current.long_filled_micro_usdc, 10_000_000_000);
  assert.equal(current.short_filled_micro_usdc, 10_000_000_000);
  assert.equal(current.hedge_error_micro_usdc, 0);
  current = advanceCarryPosition({
    position: current,
    event: event(3, "observation", {
      ...contractObservation(fundingObservation(NOW + 3, 3)),
      as_of_ms: NOW + 3,
      expected_net_value_bps: -1,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 3,
  }).position;
  assert.equal(current.status, "active");
  current = advanceCarryPosition({
    position: current,
    event: event(4, "observation", {
      ...contractObservation(fundingObservation(NOW + 4, 4)),
      as_of_ms: NOW + 4,
      expected_net_value_bps: -1,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 4,
  }).position;
  assert.equal(current.status, "exiting");
  assert.deepEqual(current.next_actions, ["reduce_only_close_both_legs"]);
});

test("new wrapper timestamps cannot manufacture confirmations from replayed funding sources", () => {
  let current = activePositionForObservation();
  const observation = (sequence, asOfMs, sourceAsOfMs, suffix) => event(sequence, "observation", {
    ...contractObservation(fundingObservation(sourceAsOfMs, suffix)),
    as_of_ms: asOfMs,
    expected_net_value_bps: -1,
    margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
  });
  current = advanceCarryPosition({
    position: current,
    event: observation(3, NOW + 3, NOW + 3, 3),
    now_ms: NOW + 3,
  }).position;
  assert.equal(current.consecutive_exit_observations, 1);
  current = advanceCarryPosition({
    position: current,
    event: observation(4, NOW + 4, NOW + 3, 3),
    now_ms: NOW + 4,
  }).position;
  assert.equal(current.status, "active");
  assert.equal(current.consecutive_exit_observations, 1);
  current = advanceCarryPosition({
    position: current,
    event: observation(5, NOW + 5, NOW + 5, 5),
    now_ms: NOW + 5,
  }).position;
  assert.equal(current.status, "exiting");
  assert.equal(current.consecutive_exit_observations, 2);
});

test("changed funding commitment without newer source evidence freezes", () => {
  let current = activePositionForObservation();
  const observe = (sequence, suffix) => event(sequence, "observation", {
    ...contractObservation(fundingObservation(NOW + 3, suffix)),
    as_of_ms: NOW + sequence,
    expected_net_value_bps: -1,
    margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
  });
  current = advanceCarryPosition({ position: current, event: observe(3, 3), now_ms: NOW + 3 }).position;
  current = advanceCarryPosition({ position: current, event: observe(4, 4), now_ms: NOW + 4 }).position;
  assert.equal(current.status, "frozen");
  assert.equal(current.terminal_reason, "funding_observation_evidence_mismatch");
  assert.equal(current.retry_permitted, false);
});

test("migration compiler selects only the best fresh route inside the signed venue allowlist", () => {
  const { current, authorization } = migrationPosition();
  const result = compileCarryMigrationProposal({
    version: 1,
    position: current,
    mandate_authorization: authorization,
    economic_equivalence_id: "carry:btc-usd-linear",
    current_expected_net_value_bps: -2,
    candidates: [
      migrationCandidate("carry:migration:aster:0001", "hyperliquid", "aster", 20, 4),
      migrationCandidate("carry:migration:aster:0002", "lighter", "aster", 30, 3),
      migrationCandidate("carry:migration:same:0001", "hyperliquid", "lighter", 100, 0),
    ],
    now_ms: NOW,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.proposal_only, true);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.requires_reconciled_flat_transition, true);
  assert.equal(result.selected_candidate.candidate_id, "carry:migration:aster:0002");
  assert.equal(result.selected_candidate.projected_improvement_bps, 29);
  assert.ok(result.candidates.find((candidate) => candidate.candidate_id === "carry:migration:same:0001").reasons.includes("route_unchanged"));
});

test("migration compiler fails closed for unsigned, stale, or unqualified destinations", () => {
  const { current, authorization } = migrationPosition({
    migration_venue_allowlist: ["hyperliquid", "lighter"],
  });
  const result = compileCarryMigrationProposal({
    version: 1,
    position: current,
    mandate_authorization: authorization,
    economic_equivalence_id: "carry:btc-usd-linear",
    current_expected_net_value_bps: -2,
    candidates: [{
      ...migrationCandidate("carry:migration:blocked:0001", "hyperliquid", "aster", 50, 1),
      checked_at_ms: NOW - 30_001,
      no_submit_ready: false,
    }],
    now_ms: NOW,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.selected_candidate, null);
  const candidate = result.candidates[0];
  assert.ok(candidate.reasons.includes("venue_outside_signed_allowlist"));
  assert.ok(candidate.reasons.includes("candidate_not_execution_qualified"));
  assert.ok(candidate.reasons.includes("candidate_stale"));
});

test("a qualified migration closes the old route first and persists an owner-signature request", () => {
  let { current } = migrationPosition();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
      first_exposure_at_ms: NOW + 1,
    }),
    now_ms: NOW + 2,
  }).position;
  for (const sequence of [3, 4]) {
    current = advanceCarryPosition({
      position: current,
      event: event(sequence, "observation", {
        ...contractObservation(fundingObservation(NOW + sequence, sequence)),
        as_of_ms: NOW + sequence,
        expected_net_value_bps: -2,
        economic_equivalence_id: "carry:btc-usd-linear",
        migration_candidates: [migrationCandidate(
          "carry:migration:durable:0001",
          "lighter",
          "aster",
          20,
          4,
        )],
        margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
      }),
      now_ms: NOW + sequence,
    }).position;
  }
  assert.equal(current.status, "exiting");
  assert.deepEqual(current.next_actions, ["reduce_only_close_both_legs"]);
  assert.equal(current.pending_migration.status, "awaiting_flat_exit");
  assert.equal(current.pending_migration.selected_candidate.short_venue_id, "aster");
  assert.equal(current.pending_migration.transaction_broadcast, false);
  current = advanceCarryPosition({
    position: current,
    event: event(5, "exit_reconciled", { gross_exposure_micro_usdc: 0, open_order_count: 0 }),
    now_ms: NOW + 5,
  }).position;
  assert.equal(current.status, "reconciled");
  assert.equal(current.terminal_reason, "reconciled_flat_migration_ready");
  assert.deepEqual(current.next_actions, ["request_owner_signed_migration"]);
  assert.equal(current.pending_migration.status, "owner_signature_required");
});

test("one margin runway breach triggers an immediate reduce-only exit", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
      first_exposure_at_ms: NOW + 1,
    }),
    now_ms: NOW + 2,
  }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(3, "observation", {
      ...contractObservation(),
      as_of_ms: NOW + 3,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 3,
  }).position;
  assert.equal(current.status, "exiting");
  assert.equal(current.terminal_reason, "margin_runway_below_mandate");
  assert.deepEqual(current.next_actions, ["reduce_only_close_both_legs"]);
});

test("signed contract skew and basis limits trigger immediate reduce-only exits", () => {
  for (const [metrics, reason] of [
    [contractObservation({ contract_data_skew_ms: 2_001 }), "contract_data_skew_outside_mandate"],
    [contractObservation({ index_price_divergence_bps: 26 }), "contract_basis_outside_mandate"],
  ]) {
    const result = advanceCarryPosition({
      position: activePositionForObservation(),
      event: event(3, "observation", {
        ...metrics,
        as_of_ms: NOW + 3,
        expected_net_value_bps: 100,
        margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
      }),
      now_ms: NOW + 3,
    });
    assert.equal(result.position.status, "exiting");
    assert.equal(result.position.terminal_reason, reason);
    assert.deepEqual(result.position.next_actions, ["reduce_only_close_both_legs"]);
  }
});

test("missing contract-equivalence evidence freezes without retry", () => {
  const result = advanceCarryPosition({
    position: activePositionForObservation(),
    event: event(3, "observation", {
      as_of_ms: NOW + 3,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 3,
  });
  assert.equal(result.position.status, "frozen");
  assert.equal(result.position.terminal_reason, "contract_equivalence_unverifiable");
  assert.equal(result.position.retry_permitted, false);
});

test("an unverifiable null margin runway triggers an immediate reduce-only exit", () => {
  const result = advanceCarryPosition({
    position: activePositionForObservation(),
    event: event(3, "observation", {
      ...contractObservation({ margin_runway_status_by_venue: undefined }),
      as_of_ms: NOW + 3,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: null, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 3,
  });
  assert.equal(result.position.status, "exiting");
  assert.equal(result.position.terminal_reason, "margin_runway_unverifiable");
  assert.deepEqual(result.position.next_actions, ["reduce_only_close_both_legs"]);
});

test("a numeric margin runway without verified status triggers an immediate reduce-only exit", () => {
  const result = advanceCarryPosition({
    position: activePositionForObservation(),
    event: event(3, "observation", {
      ...contractObservation({ margin_runway_status_by_venue: undefined }),
      as_of_ms: NOW + 3,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 3,
  });
  assert.equal(result.position.status, "exiting");
  assert.equal(result.position.terminal_reason, "margin_runway_unverifiable");
  assert.deepEqual(result.position.next_actions, ["reduce_only_close_both_legs"]);
});

test("a verified healthy null runway represents zero modeled burn, not missing evidence", () => {
  const result = advanceCarryPosition({
    position: activePositionForObservation(),
    event: event(3, "observation", {
      ...contractObservation(),
      as_of_ms: NOW + 3,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: null, lighter: 30 * HOUR },
      margin_runway_status_by_venue: { hyperliquid: "healthy", lighter: "healthy" },
    }),
    now_ms: NOW + 3,
  });
  assert.equal(result.position.status, "active");
  assert.equal(result.position.terminal_reason, null);
});

test("a warning cannot relabel a null margin runway as verified infinity", () => {
  const result = advanceCarryPosition({
    position: activePositionForObservation(),
    event: event(3, "observation", {
      ...contractObservation(),
      as_of_ms: NOW + 3,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: null, lighter: 30 * HOUR },
      margin_runway_status_by_venue: { hyperliquid: "warning", lighter: "healthy" },
    }),
    now_ms: NOW + 3,
  });
  assert.equal(result.position.status, "exiting");
  assert.equal(result.position.terminal_reason, "margin_runway_unverifiable");
  assert.deepEqual(result.position.next_actions, ["reduce_only_close_both_legs"]);
});

test("an expired signed mandate permits only a reduce-only exit", () => {
  const active = activePositionForObservation();
  const result = advanceCarryPosition({
    position: active,
    event: event(3, "observation", {
      ...contractObservation(),
      as_of_ms: NOW + 31 * DAY,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 31 * DAY,
  });
  assert.equal(result.position.status, "exiting");
  assert.equal(result.position.terminal_reason, "risk_mandate_expired");
  assert.deepEqual(result.position.next_actions, ["reduce_only_close_both_legs"]);
});

test("ambiguous submission freezes and permits reconciliation, never retry", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  const ambiguous = event(2, "submission_ambiguous");
  const result = advanceCarryPosition({ position: current, event: ambiguous, now_ms: NOW + 2 });
  assert.equal(result.position.status, "frozen");
  assert.equal(result.position.retry_permitted, false);
  assert.deepEqual(result.position.next_actions, ["reconcile_only"]);
  const duplicate = advanceCarryPosition({ position: result.position, event: ambiguous, now_ms: NOW + 3 });
  assert.equal(duplicate.duplicate, true);
});

test("legacy active inventory migration freezes for manual exit", () => {
  const active = activePositionForObservation();
  const result = advanceCarryPosition({
    position: active,
    event: event(3, "inventory_expectation_migration_required"),
    now_ms: NOW + 3,
  });
  assert.equal(result.ok, true);
  assert.equal(result.position.status, "frozen");
  assert.equal(result.position.retry_permitted, false);
  assert.equal(result.position.terminal_reason, "inventory_expectation_migration_required");
  assert.deepEqual(result.position.next_actions, ["reconcile_only", "manual_exit_required"]);
});

test("only a restart-frozen entry can complete from durable reconciliation", () => {
  let opening = position();
  opening = advanceCarryPosition({
    position: opening,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  const restarted = advanceCarryPosition({
    position: opening,
    event: event(2, "restart_detected"),
    now_ms: NOW + 2,
  }).position;
  const recovered = advanceCarryPosition({
    position: restarted,
    event: event(3, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
      first_exposure_at_ms: NOW + 1,
    }),
    now_ms: NOW + 3,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.position.status, "active");
  assert.equal(recovered.position.terminal_reason, null);
  assert.deepEqual(recovered.position.next_actions, ["monitor_carry_and_margin"]);

  let unavailable = activePositionForObservation();
  unavailable = advanceCarryPosition({
    position: unavailable,
    event: event(3, "observation_unavailable"),
    now_ms: NOW + 3,
  }).position;
  const denied = advanceCarryPosition({
    position: unavailable,
    event: event(4, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
      first_exposure_at_ms: NOW + 1,
    }),
    now_ms: NOW + 4,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "carry_event_not_allowed_in_state");
  assert.equal(denied.position.status, "frozen");
  assert.equal(denied.position.terminal_reason, "observation_unavailable");
});

test("restart-frozen reconciliation never reactivates exposure after mandate expiry", () => {
  let opening = position();
  opening = advanceCarryPosition({
    position: opening,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  const restarted = advanceCarryPosition({
    position: opening,
    event: event(2, "restart_detected"),
    now_ms: NOW + 2,
  }).position;
  const expiresAtMs = restarted.mandate_authorization.signed_mandate.expires_at_ms;
  const recovered = advanceCarryPosition({
    position: restarted,
    event: event(3, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
      first_exposure_at_ms: NOW + 1,
    }),
    now_ms: expiresAtMs,
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.position.status, "exiting");
  assert.equal(recovered.position.terminal_reason, "risk_mandate_expired");
  assert.deepEqual(recovered.position.next_actions, ["cancel_open_orders", "reduce_only_close_filled_exposure"]);
  assert.equal(recovered.position.long_filled_micro_usdc, 10_000_000_000);
  assert.equal(recovered.position.short_filled_micro_usdc, 10_000_000_000);
});

test("an unavailable monitoring observation quarantines order submission but accepts fresh evidence", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
      first_exposure_at_ms: NOW + 1,
    }),
    now_ms: NOW + 2,
  }).position;
  const result = advanceCarryPosition({
    position: current,
    event: event(3, "observation_unavailable"),
    now_ms: NOW + 3,
  });
  assert.equal(result.ok, true);
  assert.equal(result.position.status, "frozen");
  assert.equal(result.position.retry_permitted, false);
  assert.deepEqual(result.position.next_actions, ["reconcile_only"]);

  const recovered = advanceCarryPosition({
    position: result.position,
    event: event(4, "observation", {
      ...contractObservation({ ...fundingObservation(NOW + 4, 4) }),
      as_of_ms: NOW + 4,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 4,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.position.status, "active");
  assert.equal(recovered.position.terminal_reason, null);
  assert.deepEqual(recovered.position.next_actions, ["monitor_carry_and_margin"]);
});

test("a proven no-fill entry terminates flat without an exit order", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  const result = advanceCarryPosition({
    position: current,
    event: event(2, "entry_failed_no_fill"),
    now_ms: NOW + 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.position.status, "reconciled");
  assert.deepEqual(result.position.next_actions, []);
  assert.equal(result.position.terminal_reason, "entry_failed_no_fill");
});

test("exit is complete only when exposure is flat and open orders are zero", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  current = advanceCarryPosition({ position: current, event: event(2, "submission_ambiguous"), now_ms: NOW + 2 }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(3, "reconciliation_complete", { known_flat: false, open_order_count: 1 }),
    now_ms: NOW + 3,
  }).position;
  const notFlat = advanceCarryPosition({
    position: current,
    event: event(4, "exit_reconciled", { gross_exposure_micro_usdc: 0, open_order_count: 1 }),
    now_ms: NOW + 4,
  }).position;
  assert.equal(notFlat.status, "exiting");
  const residual = advanceCarryPosition({
    position: notFlat,
    event: event(5, "exit_reconciled", { gross_exposure_micro_usdc: 1, open_order_count: 0 }),
    now_ms: NOW + 5,
  }).position;
  assert.equal(residual.status, "exiting");
  const flat = advanceCarryPosition({
    position: residual,
    event: event(6, "exit_reconciled", { gross_exposure_micro_usdc: 0, open_order_count: 0 }),
    now_ms: NOW + 6,
  }).position;
  assert.equal(flat.status, "reconciled");
  assert.deepEqual(flat.next_actions, []);
  assert.equal(flat.long_filled_micro_usdc, 0);
  assert.equal(flat.short_filled_micro_usdc, 0);
  assert.equal(flat.hedge_error_micro_usdc, 0);
});

test("value ledger reports realized net after every cost and deduplicates evidence", () => {
  let ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 30_000_000,
      trading_cost_micro_usdc: 10_000_000,
      capital_cost_micro_usdc: 2_000_000,
      risk_buffer_micro_usdc: 3_000_000,
      funding_credit_micro_usdc: 30_000_000,
      funding_debit_micro_usdc: 0,
      trading_fee_micro_usdc: 8_000_000,
      slippage_micro_usdc: 1_500_000,
      gas_micro_usdc: 0,
      latency_buffer_micro_usdc: 500_000,
    },
    now_ms: NOW,
  });
  const entries = [
    ["funding", "credit", 31_000_000],
    ["trading_fee", "debit", 8_000_000],
    ["slippage", "debit", 1_500_000],
    ["capital_cost", "debit", 2_000_000],
  ];
  for (const [index, [entryType, direction, amount]] of entries.entries()) {
    const result = appendCarryValueLedgerEntry({
      ledger,
      entry: {
        version: 1,
        entry_id: `value:entry:${index + 1}`,
        sequence: index + 1,
        entry_type: entryType,
        direction,
        amount_micro_usdc: amount,
        ...(entryType === "funding" ? {
          source_amount_micro: direction === "credit" ? amount : -amount,
          source_amount_decimal: String((direction === "credit" ? amount : -amount) / 1_000_000),
          source_amount_scale: 0,
          source_asset: "USDC",
          valued_at_ms: NOW + index + 1,
          cashflow_valuation: cashflowValuation("USDC"),
        } : {}),
        venue_id: index < 2 ? "hyperliquid" : null,
        leg_id: index < 2 ? "carry:leg:long" : null,
        occurred_at_ms: NOW + index + 1,
        evidence_commitment: `value:evidence:${index + 1}`,
      },
      now_ms: NOW + index + 1,
    });
    assert.equal(result.ok, true);
    ledger = result.ledger;
  }
  assert.equal(ledger.modeled.net_value_micro_usdc, 15_000_000);
  assert.equal(ledger.realized.net_value_micro_usdc, 19_500_000);
  assert.equal(ledger.realized.variance_from_modeled_micro_usdc, 4_500_000);
  assert.equal(ledger.realized.attribution.status, "accruing");
  assert.equal(ledger.realized.attribution.funding_micro_usdc, 1_000_000);
  assert.equal(ledger.realized.attribution.trading_fee_micro_usdc, 0);
  assert.equal(ledger.realized.attribution.slippage_micro_usdc, 0);
  assert.equal(ledger.realized.attribution.net_value_micro_usdc, 4_500_000);
  assert.equal(ledger.realized.by_venue.hyperliquid.net_value_micro_usdc, 23_000_000);
  const duplicate = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:4",
      sequence: 4,
      entry_type: "capital_cost",
      direction: "debit",
      amount_micro_usdc: 2_000_000,
      venue_id: null,
      leg_id: null,
      occurred_at_ms: NOW + 4,
      evidence_commitment: "value:evidence:4",
    },
    now_ms: NOW + 10,
  });
  assert.equal(duplicate.duplicate, true);
});

test("lifecycle value attribution reconciles modeled and realized economics", () => {
  const attribution = normalizeCarryLifecycleValueAttribution({
    modeled: {
      gross_funding_micro_usdc: 400,
      total_cost_micro_usdc: 200,
      expected_net_micro_usdc: 200,
    },
    realized: {
      contract_pnl_micro_usdc: 10,
      funding_micro_usdc: 50,
      fees_micro_usdc: 20,
      slippage_micro_usdc: 5,
      gas_micro_usdc: 0,
      capital_cost_micro_usdc: 1,
      transfer_fees_micro_usdc: 0,
      rebates_micro_usdc: 0,
      net_value_micro_usdc: 34,
    },
    variance_from_modeled_micro_usdc: -166,
  });
  assert.equal(attribution.realized_total_cost_micro_usdc, 26);
  assert.equal(attribution.realized.net_value_micro_usdc, 34);
  assert.equal(attribution.variance_from_modeled_micro_usdc, -166);
  assert.equal(Object.isFrozen(attribution.realized), true);
});

test("lifecycle value attribution rejects inconsistent or unsafe economics", () => {
  const valid = {
    modeled: {
      gross_funding_micro_usdc: 400,
      total_cost_micro_usdc: 200,
      expected_net_micro_usdc: 200,
    },
    realized: {
      contract_pnl_micro_usdc: 10,
      funding_micro_usdc: 50,
      fees_micro_usdc: 20,
      slippage_micro_usdc: 5,
      gas_micro_usdc: 0,
      capital_cost_micro_usdc: 1,
      transfer_fees_micro_usdc: 0,
      rebates_micro_usdc: 0,
      net_value_micro_usdc: 34,
    },
    variance_from_modeled_micro_usdc: -166,
  };
  assert.throws(
    () => normalizeCarryLifecycleValueAttribution({
      ...valid,
      modeled: { ...valid.modeled, expected_net_micro_usdc: 201 },
    }),
    /carry_lifecycle_value_modeled_mismatch/,
  );
  assert.throws(
    () => normalizeCarryLifecycleValueAttribution({
      ...valid,
      realized: { ...valid.realized, fees_micro_usdc: 19 },
    }),
    /carry_lifecycle_value_realized_mismatch/,
  );
  assert.throws(
    () => normalizeCarryLifecycleValueAttribution({ ...valid, variance_from_modeled_micro_usdc: -165 }),
    /carry_lifecycle_value_variance_mismatch/,
  );
  assert.throws(
    () => normalizeCarryLifecycleValueAttribution({
      ...valid,
      realized: { ...valid.realized, fees_micro_usdc: -1 },
    }),
    /carry_lifecycle_value_realized_fees_invalid/,
  );
  assert.throws(
    () => normalizeCarryLifecycleValueAttribution({
      modeled: {
        gross_funding_micro_usdc: Number.MAX_SAFE_INTEGER,
        total_cost_micro_usdc: 0,
        expected_net_micro_usdc: Number.MAX_SAFE_INTEGER,
      },
      realized: {
        ...valid.realized,
        contract_pnl_micro_usdc: Number.MAX_SAFE_INTEGER,
        funding_micro_usdc: 1,
      },
      variance_from_modeled_micro_usdc: 0,
    }),
    /carry_lifecycle_value_realized_gross_overflow/,
  );
});

test("value ledger rejects modeled component totals that do not reconcile", () => {
  assert.throws(() => createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 5,
      capital_cost_micro_usdc: 0,
      risk_buffer_micro_usdc: 0,
      funding_credit_micro_usdc: 10,
      funding_debit_micro_usdc: 0,
      trading_fee_micro_usdc: 2,
      slippage_micro_usdc: 2,
      gas_micro_usdc: 0,
      latency_buffer_micro_usdc: 0,
    },
    now_ms: NOW,
  }), /carry_value_modeled_trading_breakdown_mismatch/);
});

test("value ledger rejects a reused evidence claim under a new entry id", () => {
  let ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 2,
      capital_cost_micro_usdc: 1,
      risk_buffer_micro_usdc: 1,
    },
    now_ms: NOW,
  });
  const first = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:claim:1",
      sequence: 1,
      entry_type: "trading_fee",
      direction: "debit",
      amount_micro_usdc: 2,
      venue_id: "hyperliquid",
      leg_id: "carry:leg:long",
      occurred_at_ms: NOW + 1,
      evidence_commitment: "value:evidence:claim:1",
    },
    now_ms: NOW + 1,
  });
  assert.equal(first.ok, true);
  ledger = first.ledger;
  const replayedClaim = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:claim:2",
      sequence: 2,
      entry_type: "trading_fee",
      direction: "debit",
      amount_micro_usdc: 2,
      venue_id: "hyperliquid",
      leg_id: "carry:leg:long",
      occurred_at_ms: NOW + 2,
      evidence_commitment: "value:evidence:claim:1",
    },
    now_ms: NOW + 2,
  });
  assert.equal(replayedClaim.ok, false);
  assert.equal(replayedClaim.error, "carry_value_evidence_claim_reused");
  assert.equal(replayedClaim.ledger.realized.net_value_micro_usdc, -2);
});

test("value ledger rejects a conflicting replay under the same entry id", () => {
  let ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 2,
      capital_cost_micro_usdc: 1,
      risk_buffer_micro_usdc: 1,
    },
    now_ms: NOW,
  });
  const first = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:stable:1",
      sequence: 1,
      entry_type: "funding",
      direction: "credit",
      amount_micro_usdc: 10,
      source_amount_micro: 10,
      source_amount_decimal: "0.00001",
      source_amount_scale: 5,
      source_asset: "USDC",
      valued_at_ms: NOW + 1,
      cashflow_valuation: cashflowValuation("USDC"),
      venue_id: "hyperliquid",
      leg_id: "carry:leg:long",
      occurred_at_ms: NOW + 1,
      evidence_commitment: "value:evidence:stable:1",
    },
    now_ms: NOW + 1,
  });
  assert.equal(first.ok, true);
  ledger = first.ledger;
  const exactReplay = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:stable:1",
      sequence: 2,
      entry_type: "funding",
      direction: "credit",
      amount_micro_usdc: 10,
      source_amount_micro: 10,
      source_amount_decimal: "0.00001",
      source_amount_scale: 5,
      source_asset: "USDC",
      valued_at_ms: NOW + 1,
      cashflow_valuation: cashflowValuation("USDC"),
      venue_id: "hyperliquid",
      leg_id: "carry:leg:long",
      occurred_at_ms: NOW + 1,
      evidence_commitment: "value:evidence:stable:1",
    },
    now_ms: NOW + 2,
  });
  assert.equal(exactReplay.ok, true);
  assert.equal(exactReplay.duplicate, true);
  assert.equal(exactReplay.ledger.last_sequence, 1);
  const conflicting = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:stable:1",
      sequence: 2,
      entry_type: "funding",
      direction: "credit",
      amount_micro_usdc: 11,
      source_amount_micro: 11,
      source_amount_decimal: "0.000011",
      source_amount_scale: 6,
      source_asset: "USDC",
      valued_at_ms: NOW + 2,
      cashflow_valuation: cashflowValuation("USDC"),
      venue_id: "hyperliquid",
      leg_id: "carry:leg:long",
      occurred_at_ms: NOW + 1,
      evidence_commitment: "value:evidence:stable:changed",
    },
    now_ms: NOW + 2,
  });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.error, "carry_value_entry_replay_mismatch");
  assert.equal(conflicting.ledger.realized.funding_credit_micro_usdc, 10);
});

test("funding ledger binds native settlement value to fresh conservative conversion evidence", () => {
  const newLedger = () => createCarryValueLedger({
    version: 1,
    position_id: "carry:position:valuation:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 2,
      capital_cost_micro_usdc: 1,
      risk_buffer_micro_usdc: 1,
    },
    now_ms: NOW,
  });
  const valuation = cashflowValuation("USDT", {
    bound_source_amount_micro: 1_000_000,
    credit_rate_e8: 99_000_000,
    debit_rate_e8: 101_000_000,
  });
  const entry = {
    version: 1,
    entry_id: "value:entry:valuation:1",
    sequence: 1,
    entry_type: "funding",
    direction: "credit",
    amount_micro_usdc: 990_000,
    source_amount_micro: 1_000_000,
    source_amount_decimal: "1.00000000",
    source_amount_scale: 8,
    source_asset: "USDT",
    valued_at_ms: NOW + 1,
    cashflow_valuation: valuation,
    venue_id: "aster",
    leg_id: "carry:leg:short",
    occurred_at_ms: NOW + 1,
    evidence_commitment: "value:evidence:valuation:1",
  };
  const credited = appendCarryValueLedgerEntry({ ledger: newLedger(), entry, now_ms: NOW + 1 });
  assert.equal(credited.ok, true);
  assert.equal(credited.ledger.entries[0].source_amount_micro, 1_000_000);
  assert.equal(credited.ledger.entries[0].source_asset, "USDT");
  assert.equal(credited.ledger.entries[0].cashflow_valuation.evidence_commitment, valuation.evidence_commitment);

  const mismatch = appendCarryValueLedgerEntry({
    ledger: newLedger(),
    entry: { ...entry, amount_micro_usdc: 1_000_000 },
    now_ms: NOW + 1,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, "carry_value_funding_conversion_mismatch");

  const missing = appendCarryValueLedgerEntry({
    ledger: newLedger(),
    entry: { ...entry, cashflow_valuation: undefined },
    now_ms: NOW + 1,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "cashflow_valuation_required");

  const stale = appendCarryValueLedgerEntry({
    ledger: newLedger(),
    entry,
    now_ms: NOW + 30_000,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "carry_value_funding_valuation_stale");

  const debited = appendCarryValueLedgerEntry({
    ledger: newLedger(),
    entry: {
      ...entry,
      entry_id: "value:entry:valuation:2",
      direction: "debit",
      amount_micro_usdc: 1_010_000,
      source_amount_micro: -1_000_000,
      source_amount_decimal: "-1.00000000",
      cashflow_valuation: cashflowValuation("USDT", {
        bound_source_amount_micro: -1_000_000,
        credit_rate_e8: 99_000_000,
        debit_rate_e8: 101_000_000,
      }),
      evidence_commitment: "value:evidence:valuation:2",
    },
    now_ms: NOW + 1,
  });
  assert.equal(debited.ok, true);
  assert.equal(debited.ledger.realized.funding_debit_micro_usdc, 1_010_000);
});

function settlementLedger() {
  const ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:settlement:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 2,
      capital_cost_micro_usdc: 1,
      risk_buffer_micro_usdc: 1,
    },
    now_ms: NOW,
  });
  return appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:settlement:slippage",
      sequence: 1,
      entry_type: "slippage",
      direction: "debit",
      amount_micro_usdc: 20_000,
      venue_id: "aster",
      leg_id: "leg:settlement:aster",
      occurred_at_ms: NOW,
      evidence_commitment: "value:evidence:settlement:slippage",
    },
    now_ms: NOW,
  }).ledger;
}

function settlementPnlComponent({
  venueId,
  sourceAsset,
  sourceAmountMicro,
  convertedAmountMicroUsdc,
  valuation,
}) {
  return {
    venue_id: venueId,
    source_asset: sourceAsset,
    source_amount_micro: sourceAmountMicro,
    source_amount_decimal: sourceAmountMicro === 1_000_000
      ? "1.000000"
      : sourceAmountMicro === -500_000
        ? "-0.500000"
        : sourceAmountMicro === -490_000
          ? "-0.490000"
          : String(sourceAmountMicro),
    source_amount_scale: [1_000_000, -500_000, -490_000].includes(sourceAmountMicro) ? 6 : 0,
    converted_amount_micro_usdc: convertedAmountMicroUsdc,
    valued_at_ms: NOW + 1,
    cashflow_valuation: valuation,
  };
}

function exactSettlementEntry(overrides = {}) {
  const usdtValuation = cashflowValuation("USDT", {
    bound_source_amount_micro: 1_000_000,
    credit_rate_e8: 99_000_000,
    debit_rate_e8: 101_000_000,
  });
  const usdcValuation = cashflowValuation("USDC", {
    bound_source_amount_micro: -500_000,
  });
  return {
    version: 1,
    entry_id: "value:entry:settlement:1",
    sequence: 2,
    entry_type: "settlement_adjustment",
    direction: "credit",
    amount_micro_usdc: 510_000,
    venue_id: null,
    leg_id: null,
    occurred_at_ms: NOW + 1,
    evidence_commitment: "value:evidence:settlement:1",
    pnl_components: [
      settlementPnlComponent({
        venueId: "aster",
        sourceAsset: "USDT",
        sourceAmountMicro: 1_000_000,
        convertedAmountMicroUsdc: 990_000,
        valuation: usdtValuation,
      }),
      settlementPnlComponent({
        venueId: "lighter",
        sourceAsset: "USDC",
        sourceAmountMicro: -500_000,
        convertedAmountMicroUsdc: -500_000,
        valuation: usdcValuation,
      }),
    ],
    slippage_reversal_micro_usdc: 20_000,
    ...overrides,
  };
}

test("settlement adjustment converts exact-bound venue PnL independently and accepts exact replay", () => {
  const entry = exactSettlementEntry();
  const appended = appendCarryValueLedgerEntry({
    ledger: settlementLedger(),
    entry,
    now_ms: NOW + 1,
  });
  assert.equal(appended.ok, true);
  assert.equal(appended.ledger.realized.settlement_adjustment_micro_usdc, 510_000);
  assert.deepEqual(
    appended.ledger.entries[1].pnl_components.map((component) => ({
      venue_id: component.venue_id,
      source_asset: component.source_asset,
      source_amount_micro: component.source_amount_micro,
      converted_amount_micro_usdc: component.converted_amount_micro_usdc,
      bound_source_amount_micro: component.cashflow_valuation.bound_source_amount_micro,
    })),
    [
      {
        venue_id: "aster",
        source_asset: "USDT",
        source_amount_micro: 1_000_000,
        converted_amount_micro_usdc: 990_000,
        bound_source_amount_micro: 1_000_000,
      },
      {
        venue_id: "lighter",
        source_asset: "USDC",
        source_amount_micro: -500_000,
        converted_amount_micro_usdc: -500_000,
        bound_source_amount_micro: -500_000,
      },
    ],
  );

  const replay = appendCarryValueLedgerEntry({
    ledger: appended.ledger,
    entry: { ...entry, sequence: 2 },
    now_ms: NOW + 2,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.ledger.last_sequence, 2);
});

test("settlement adjustment fails closed on mismatched, stale, or tampered PnL evidence", () => {
  const entry = exactSettlementEntry();
  const boundMismatch = appendCarryValueLedgerEntry({
    ledger: settlementLedger(),
    entry: {
      ...entry,
      pnl_components: [
        {
          ...entry.pnl_components[0],
          cashflow_valuation: cashflowValuation("USDT", {
            bound_source_amount_micro: 999_999,
            credit_rate_e8: 99_000_000,
            debit_rate_e8: 101_000_000,
          }),
        },
        entry.pnl_components[1],
      ],
    },
    now_ms: NOW + 1,
  });
  assert.equal(boundMismatch.ok, false);
  assert.equal(boundMismatch.error, "carry_value_settlement_pnl_conversion_mismatch");

  const convertedMismatch = appendCarryValueLedgerEntry({
    ledger: settlementLedger(),
    entry: {
      ...entry,
      pnl_components: [
        { ...entry.pnl_components[0], converted_amount_micro_usdc: 990_001 },
        entry.pnl_components[1],
      ],
    },
    now_ms: NOW + 1,
  });
  assert.equal(convertedMismatch.ok, false);
  assert.equal(convertedMismatch.error, "carry_value_settlement_pnl_conversion_mismatch");

  const missingVenue = appendCarryValueLedgerEntry({
    ledger: settlementLedger(),
    entry: { ...entry, pnl_components: [entry.pnl_components[0]] },
    now_ms: NOW + 1,
  });
  assert.equal(missingVenue.ok, false);
  assert.equal(missingVenue.error, "carry_value_settlement_pnl_components");

  const decimalMismatch = appendCarryValueLedgerEntry({
    ledger: settlementLedger(),
    entry: {
      ...entry,
      pnl_components: [
        { ...entry.pnl_components[0], source_amount_decimal: "999.000000" },
        entry.pnl_components[1],
      ],
    },
    now_ms: NOW + 1,
  });
  assert.equal(decimalMismatch.ok, false);
  assert.equal(decimalMismatch.error, "carry_value_settlement_pnl_source_scale");

  const stale = appendCarryValueLedgerEntry({
    ledger: settlementLedger(),
    entry,
    now_ms: NOW + 30_000,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "carry_value_settlement_valuation_stale");

  const first = appendCarryValueLedgerEntry({
    ledger: settlementLedger(),
    entry,
    now_ms: NOW + 1,
  });
  assert.equal(first.ok, true);
  const tamperedReplay = appendCarryValueLedgerEntry({
    ledger: first.ledger,
    entry: {
      ...entry,
      sequence: 2,
      pnl_components: [
        settlementPnlComponent({
          venueId: "aster",
          sourceAsset: "USDT",
          sourceAmountMicro: 1_000_000,
          convertedAmountMicroUsdc: 980_000,
          valuation: cashflowValuation("USDT", {
            bound_source_amount_micro: 1_000_000,
            credit_rate_e8: 98_000_000,
            debit_rate_e8: 102_000_000,
          }),
        }),
        settlementPnlComponent({
          venueId: "lighter",
          sourceAsset: "USDC",
          sourceAmountMicro: -490_000,
          convertedAmountMicroUsdc: -490_000,
          valuation: cashflowValuation("USDC", {
            bound_source_amount_micro: -490_000,
          }),
        }),
      ],
    },
    now_ms: NOW + 1,
  });
  assert.equal(tamperedReplay.ok, false);
  assert.equal(tamperedReplay.error, "carry_value_entry_replay_mismatch");
});

test("settlement adjustment binds the slippage reversal to the signed ledger amount", () => {
  const entry = exactSettlementEntry();
  const invalidReversal = appendCarryValueLedgerEntry({
    ledger: settlementLedger(),
    entry: { ...entry, slippage_reversal_micro_usdc: 20_001 },
    now_ms: NOW + 1,
  });
  assert.equal(invalidReversal.ok, false);
  assert.equal(invalidReversal.error, "carry_value_settlement_adjustment_mismatch");

  const invalidAmount = appendCarryValueLedgerEntry({
    ledger: settlementLedger(),
    entry: { ...entry, amount_micro_usdc: 510_001 },
    now_ms: NOW + 1,
  });
  assert.equal(invalidAmount.ok, false);
  assert.equal(invalidAmount.error, "carry_value_settlement_adjustment_mismatch");

  const coherentButIncompleteReversal = appendCarryValueLedgerEntry({
    ledger: settlementLedger(),
    entry: { ...entry, slippage_reversal_micro_usdc: 19_999, amount_micro_usdc: 509_999 },
    now_ms: NOW + 1,
  });
  assert.equal(coherentButIncompleteReversal.ok, false);
  assert.equal(coherentButIncompleteReversal.error, "carry_value_settlement_slippage_reversal_mismatch");
});

test("rebates can only credit realized value", () => {
  const ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 2,
      capital_cost_micro_usdc: 1,
      risk_buffer_micro_usdc: 1,
    },
    now_ms: NOW,
  });
  const invalid = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:rebate:1",
      sequence: 1,
      entry_type: "rebate",
      direction: "debit",
      amount_micro_usdc: 2,
      venue_id: "lighter",
      leg_id: "carry:leg:short",
      occurred_at_ms: NOW + 1,
      evidence_commitment: "value:evidence:rebate:1",
    },
    now_ms: NOW + 1,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "carry_value_rebate_must_be_credit");
});

test("value ledger finalizes only with flat exposure, zero orders, and complete costs", () => {
  const ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 2,
      capital_cost_micro_usdc: 1,
      risk_buffer_micro_usdc: 1,
    },
    now_ms: NOW,
  });
  const rejected = finalizeCarryValueLedger({
    ledger,
    evidence: {
      gross_exposure_micro_usdc: 0,
      open_order_count: 1,
      costs_complete: true,
      reconciliation_commitment: "reconcile:proof:0001",
    },
    now_ms: NOW + 1,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "carry_value_final_open_orders_nonzero");
  const finalized = finalizeCarryValueLedger({
    ledger,
    evidence: {
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      costs_complete: true,
      cost_manifest: costManifest({ ledger }),
      reconciliation_commitment: "reconcile:proof:0001",
    },
    now_ms: NOW + 2,
  });
  assert.equal(finalized.ok, true, finalized.error);
  assert.equal(finalized.ledger.status, "finalized");
});

test("cost completeness rejects boolean-only and canonical-proof tampering", () => {
  const ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:cost-proof",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 2,
      capital_cost_micro_usdc: 1,
      risk_buffer_micro_usdc: 1,
    },
    now_ms: NOW,
  });
  const evidence = {
    gross_exposure_micro_usdc: 0,
    open_order_count: 0,
    costs_complete: true,
    reconciliation_commitment: "reconcile:cost-proof:0001",
  };
  assert.equal(finalizeCarryValueLedger({ ledger, evidence, now_ms: NOW + 1 }).error, "carry_value_cost_manifest_required");

  const valid = costManifest({ ledger });
  const regexOnly = structuredClone(valid);
  regexOnly.manifest_commitment = `carry:cost-manifest:${"f".repeat(64)}`;
  assert.equal(
    finalizeCarryValueLedger({ ledger, evidence: { ...evidence, cost_manifest: regexOnly }, now_ms: NOW + 1 }).error,
    "carry_value_cost_manifest_commitment_mismatch",
  );

  const rebound = structuredClone(valid);
  rebound.operations[0].costs.gas.source_evidence_commitments[0] = "carry:tampered:source:0001";
  const reboundMaterial = {
    version: 1,
    position_id: rebound.position_id,
    status: "complete",
    lifecycle_kind: rebound.lifecycle_kind,
    operations: rebound.operations,
  };
  rebound.manifest_commitment = `carry:cost-manifest:${sha256HexUtf8(canonicalCarryCommitmentJson(reboundMaterial))}`;
  assert.equal(
    finalizeCarryValueLedger({ ledger, evidence: { ...evidence, cost_manifest: rebound }, now_ms: NOW + 1 }).error,
    "carry_value_cost_zero_proof_source_unbound",
  );

  const invariantTamper = structuredClone(valid);
  invariantTamper.operations[0].costs.transfer_fee.zero_invariant.transfer_operation_requested = true;
  assert.equal(
    finalizeCarryValueLedger({ ledger, evidence: { ...evidence, cost_manifest: invariantTamper }, now_ms: NOW + 1 }).error,
    "carry_value_cost_zero_invariant_invalid",
  );

  const terminalTamper = structuredClone(valid);
  terminalTamper.operations[0].operation_evidence.terminal_evidence.saga_status = "unwound";
  assert.equal(
    finalizeCarryValueLedger({ ledger, evidence: { ...evidence, cost_manifest: terminalTamper }, now_ms: NOW + 1 }).error,
    "carry_value_cost_terminal_evidence_commitment_mismatch",
  );
});

test("exact gas and transfer costs stay phase-scoped and cannot be replayed", () => {
  let ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:phase-costs",
    modeled: {
      gross_funding_micro_usdc: 100,
      trading_cost_micro_usdc: 40,
      capital_cost_micro_usdc: 0,
      risk_buffer_micro_usdc: 0,
    },
    now_ms: NOW,
  });
  const byId = new Map();
  for (const phase of ["entry", "exit"]) {
    for (const [venueId, legId] of [["hyperliquid", "carry:leg:long"], ["lighter", "carry:leg:short"]]) {
      const executionEvidence = `carry:value:evidence:${phase}:${venueId}`;
      for (const [suffix, entryType, amount, evidence] of [
        ["fee", "trading_fee", 1, executionEvidence],
        ["slippage", "slippage", 2, executionEvidence],
        ["gas", "gas", phase === "entry" ? 3 : 4, `carry:gas:evidence:${phase}:${venueId}`],
        ["transfer", "transfer_fee", phase === "entry" ? 5 : 6, `carry:transfer:evidence:${phase}:${venueId}`],
      ]) {
        const entry = {
          version: 1,
          entry_id: `carry:value:portfolio:${phase}:${venueId}:${suffix}`,
          sequence: ledger.last_sequence + 1,
          entry_type: entryType,
          direction: "debit",
          amount_micro_usdc: amount,
          venue_id: venueId,
          leg_id: legId,
          occurred_at_ms: NOW + ledger.last_sequence + 1,
          evidence_commitment: evidence,
        };
        const appended = appendCarryValueLedgerEntry({ ledger, entry, now_ms: entry.occurred_at_ms });
        assert.equal(appended.ok, true, appended.error);
        ledger = appended.ledger;
        byId.set(entry.entry_id, entry);
      }
    }
  }
  const manifest = costManifest({ ledger, lifecycleKind: "normal" });
  const evidence = {
    gross_exposure_micro_usdc: 0,
    open_order_count: 0,
    costs_complete: true,
    cost_manifest: manifest,
    reconciliation_commitment: "reconcile:phase-costs:0001",
  };
  assert.equal(finalizeCarryValueLedger({ ledger, evidence, now_ms: NOW + 100 }).ok, true);
  const entryGasId = "carry:value:portfolio:entry:hyperliquid:gas";
  const forged = structuredClone(manifest);
  const exitOperation = forged.operations.find((operation) => operation.phase === "exit"
    && operation.venue_id === "hyperliquid");
  exitOperation.costs.gas = costProof({
    category: "gas",
    phase: "exit",
    venueId: "hyperliquid",
    legId: "carry:leg:long",
    operationEvidence: exitOperation.operation_evidence,
    entries: [byId.get(entryGasId)],
  });
  const forgedMaterial = {
    version: 1,
    position_id: forged.position_id,
    status: "complete",
    lifecycle_kind: forged.lifecycle_kind,
    operations: forged.operations,
  };
  forged.manifest_commitment = `carry:cost-manifest:${sha256HexUtf8(canonicalCarryCommitmentJson(forgedMaterial))}`;
  assert.equal(
    finalizeCarryValueLedger({ ledger, evidence: { ...evidence, cost_manifest: forged }, now_ms: NOW + 100 }).error,
    "carry_value_cost_manifest_entry_reused",
  );
});

test("portfolio value report separates finalized after-cost proof from accruing estimates", () => {
  const openLedger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:value:open",
    modeled: {
      gross_funding_micro_usdc: 100,
      trading_cost_micro_usdc: 20,
      capital_cost_micro_usdc: 10,
      risk_buffer_micro_usdc: 5,
    },
    now_ms: NOW,
  });
  let finalizedLedger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:value:final",
    modeled: {
      gross_funding_micro_usdc: 200,
      trading_cost_micro_usdc: 70,
      capital_cost_micro_usdc: 10,
      risk_buffer_micro_usdc: 0,
    },
    now_ms: NOW,
  });
  const entries = [
    { entryType: "funding", direction: "credit", amount: 200, evidence: "value:evidence:portfolio:funding", venue: "hyperliquid", leg: "carry:leg:long", phase: "funding" },
    { entryType: "trading_fee", direction: "debit", amount: 20, evidence: "value:evidence:portfolio:entry:hyperliquid", venue: "hyperliquid", leg: "carry:leg:long", phase: "entry" },
    { entryType: "slippage", direction: "debit", amount: 5, evidence: "value:evidence:portfolio:entry:hyperliquid", venue: "hyperliquid", leg: "carry:leg:long", phase: "entry" },
    { entryType: "trading_fee", direction: "debit", amount: 10, evidence: "value:evidence:portfolio:entry:lighter", venue: "lighter", leg: "carry:leg:short", phase: "entry" },
    { entryType: "slippage", direction: "debit", amount: 5, evidence: "value:evidence:portfolio:entry:lighter", venue: "lighter", leg: "carry:leg:short", phase: "entry" },
    { entryType: "trading_fee", direction: "debit", amount: 10, evidence: "value:evidence:portfolio:exit:hyperliquid", venue: "hyperliquid", leg: "carry:leg:long", phase: "exit" },
    { entryType: "slippage", direction: "debit", amount: 5, evidence: "value:evidence:portfolio:exit:hyperliquid", venue: "hyperliquid", leg: "carry:leg:long", phase: "exit" },
    { entryType: "trading_fee", direction: "debit", amount: 10, evidence: "value:evidence:portfolio:exit:lighter", venue: "lighter", leg: "carry:leg:short", phase: "exit" },
    { entryType: "slippage", direction: "debit", amount: 5, evidence: "value:evidence:portfolio:exit:lighter", venue: "lighter", leg: "carry:leg:short", phase: "exit" },
    { entryType: "capital_cost", direction: "debit", amount: 10, evidence: "value:evidence:portfolio:capital", venue: "lighter", leg: "carry:leg:short", phase: "capital" },
  ];
  for (const [index, { entryType, direction, amount, evidence, venue: venueId, leg: legId, phase }] of entries.entries()) {
    const appended = appendCarryValueLedgerEntry({
      ledger: finalizedLedger,
      entry: {
        version: 1,
        entry_id: `value:entry:portfolio:${phase}:${index + 1}`,
        sequence: index + 1,
        entry_type: entryType,
        direction,
        amount_micro_usdc: amount,
        ...(entryType === "funding" ? {
          source_amount_micro: direction === "credit" ? amount : -amount,
          source_amount_decimal: "0.0002",
          source_amount_scale: 4,
          source_asset: "USDC",
          valued_at_ms: NOW + index + 1,
          cashflow_valuation: cashflowValuation("USDC"),
        } : {}),
        venue_id: venueId,
        leg_id: legId,
        occurred_at_ms: NOW + index + 1,
        evidence_commitment: evidence,
      },
      now_ms: NOW + index + 1,
    });
    assert.equal(appended.ok, true);
    finalizedLedger = appended.ledger;
  }
  const finalized = finalizeCarryValueLedger({
    ledger: finalizedLedger,
    evidence: {
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      costs_complete: true,
      cost_manifest: costManifest({ ledger: finalizedLedger, lifecycleKind: "normal" }),
      reconciliation_commitment: "reconcile:portfolio:value:0001",
    },
    now_ms: NOW + 10,
  });
  assert.equal(finalized.ok, true, finalized.error);
  const report = compileCarryPortfolioValueReport({
    version: 1,
    now_ms: NOW + 10,
    position_values: [
      {
        position_id: "carry:position:value:open",
        position_status: "active",
        target_notional_micro_usdc: 10_000_000,
        value_ledger: openLedger,
      },
      {
        position_id: "carry:position:value:final",
        position_status: "reconciled",
        target_notional_micro_usdc: 20_000_000,
        value_ledger: finalized.ledger,
        value_boundary_authoritative: true,
        exposure_boundary_provenance: "authoritative_exchange_fill_time",
      },
    ],
    capital_evidence: {
      status: "ready",
      plan: {
        kind: "ghola_carry_portfolio_capital_plan",
        total_requested_micro_usdc: 25,
        total_potential_releasable_micro_usdc: 15,
        total_proposed_internal_reallocation_micro_usdc: 15,
        net_new_owner_capital_requested_micro_usdc: 10,
        total_proposed_allocation_micro_usdc: 0,
        total_uncovered_shortfall_micro_usdc: 10,
        owner_transfer_approval_required: true,
        owner_funding_approval_required: false,
        proposal_only: true,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
        owner_only_operations: ["fund", "transfer", "withdraw"],
      },
    },
  });
  assert.equal(report.value_proof_status, "mixed");
  assert.equal(report.authoritative_finalized_position_count, 1);
  assert.equal(report.finalized_value_provenance, "authoritative_exchange_fill_time");
  assert.equal(report.real_value_verified, true);
  assert.equal(report.valuation_asset, "USDC");
  assert.equal(report.funding_valuation_basis, "usdc_equivalent_at_ledger_ingestion");
  assert.equal(report.modeled.net_value_micro_usdc, 185);
  assert.equal(report.finalized_after_costs.net_value_micro_usdc, 120);
  assert.equal(report.finalized_after_costs.variance_from_modeled_micro_usdc, 0);
  assert.equal(report.unfinalized.modeled_net_value_micro_usdc, 65);
  assert.equal(report.capital_efficiency.potential_new_cash_avoided_micro_usdc, 15);
  assert.equal(report.capital_efficiency.new_owner_cash_requested_micro_usdc, 10);
  assert.equal(report.proposal_only, true);
  assert.equal(report.transaction_broadcast, false);
  assert.equal(report.automatic_transfer_permitted, false);
});

test("portfolio value report rejects duplicate, tampered, or fund-moving evidence", () => {
  const ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:value:guard",
    modeled: {
      gross_funding_micro_usdc: 100,
      trading_cost_micro_usdc: 20,
      capital_cost_micro_usdc: 10,
      risk_buffer_micro_usdc: 5,
    },
    now_ms: NOW,
  });
  const position = {
    position_id: "carry:position:value:guard",
    position_status: "active",
    target_notional_micro_usdc: 10_000_000,
    value_ledger: ledger,
  };
  const incompleteCapital = {
    status: "incomplete",
    missing_position_ids: ["carry:position:value:guard"],
  };
  assert.throws(() => compileCarryPortfolioValueReport({
    version: 1,
    now_ms: NOW + 1,
    position_values: [position, position],
    capital_evidence: incompleteCapital,
  }), /carry_portfolio_value_report_duplicate_position/);
  assert.throws(() => compileCarryPortfolioValueReport({
    version: 1,
    now_ms: NOW + 1,
    position_values: [{
      ...position,
      value_ledger: {
        ...ledger,
        realized: { ...ledger.realized, net_value_micro_usdc: 1 },
      },
    }],
    capital_evidence: incompleteCapital,
  }), /carry_portfolio_value_ledger_replay_mismatch/);
  assert.throws(() => compileCarryPortfolioValueReport({
    version: 1,
    now_ms: NOW + 1,
    position_values: [{
      ...position,
      value_ledger: {
        ...ledger,
        entries: [{
          version: 1,
          entry_id: "carry:value:tampered:0001",
          sequence: 1,
          entry_type: "trading_fee",
          direction: "debit",
          amount_micro_usdc: 1,
          venue_id: "hyperliquid",
          leg_id: "carry:leg:long",
          occurred_at_ms: NOW,
          evidence_commitment: "carry:value:evidence:tampered:0001",
        }],
        processed_entry_ids: ["carry:value:tampered:0001"],
        processed_claim_ids: ["carry:value:evidence:tampered:0001|trading_fee|hyperliquid|carry:leg:long|none|none|none|none|none|none|none|none"],
        last_sequence: 1,
      },
    }],
    capital_evidence: incompleteCapital,
  }), /carry_portfolio_value_ledger_replay_mismatch/);
  assert.throws(() => compileCarryPortfolioValueReport({
    version: 1,
    now_ms: NOW + 1,
    position_values: [position],
    capital_evidence: {
      status: "ready",
      plan: {
        kind: "ghola_carry_portfolio_capital_plan",
        proposal_only: true,
        transaction_broadcast: true,
        automatic_transfer_permitted: false,
      },
    },
  }), /carry_portfolio_value_capital_authority_boundary/);
});
