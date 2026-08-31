import { describe, expect, it } from "vitest";
import {
  carryPrivatePrimeEvidenceCommitment,
  carryPrivatePrimeSummary,
} from "./carry-private-prime-readiness";

const NOW = 1_800_000_000_000;

describe("private-prime readiness", () => {
  it("shows one compact pre-broadcast status only from complete worker proof", () => {
    expect(carryPrivatePrimeSummary(proof(), NOW)).toEqual({
      status: "pending",
      value: "5/5 DATA · 3/3 EXEC · 3/3 REC · 6/6 ROUTES",
      detail: "QUALIFIED · NO-SUBMIT ONLY · LIVE PAIRED PROOF REQUIRED",
      tone: "warn",
    });
  });

  it("shows capital-free no-submit readiness without claiming live-entry readiness", () => {
    expect(carryPrivatePrimeSummary(proof({
      reasons: ["opening_capital_shortfall"],
      three_venue_execution: { ...proof().three_venue_execution, capital_ready: false },
    }), NOW)).toEqual({
      status: "pending",
      value: "5/5 DATA · 3/3 EXEC · 3/3 REC · 6/6 ROUTES",
      detail: "QUALIFIED · NO-SUBMIT · OWNER CAPITAL REQUIRED FOR LIVE ENTRY",
      tone: "warn",
    });
  });

  it("shows live paired proof only from complete worker lifecycle evidence", () => {
    expect(carryPrivatePrimeSummary(proof({
      proof_level: "live_paired_lifecycle",
      live_paired_lifecycle_proven: true,
      paired_lifecycle: pairedLifecycle(),
    }), NOW)).toEqual({
      status: "ready",
      value: "5/5 DATA · 3/3 EXEC · 3/3 REC · 6/6 ROUTES",
      detail: "LIVE · NET +$0.000034 · ΔMODEL −$0.000166 · FUND +$0.000050 · PNL +$0.000010 · COST −$0.000026 · FLAT",
      tone: "good",
    });
  });

  it("rejects stale or overstated evidence", () => {
    expect(carryPrivatePrimeSummary(proof({ expires_at_ms: NOW }), NOW).status).toBe("invalid");
    expect(carryPrivatePrimeSummary(proof({ live_paired_lifecycle_proven: true }), NOW).status).toBe("invalid");
    expect(carryPrivatePrimeSummary(proof({
      proof_level: "live_paired_lifecycle",
      live_paired_lifecycle_proven: true,
      paired_lifecycle: pairedLifecycle({ final_flat_zero_orders: false }),
    }), NOW).status).toBe("invalid");
    expect(carryPrivatePrimeSummary(proof({
      proof_level: "live_paired_lifecycle",
      live_paired_lifecycle_proven: true,
      paired_lifecycle: pairedLifecycle({ realized_net_value_micro_usdc: null }),
    }), NOW).status).toBe("invalid");
    expect(carryPrivatePrimeSummary(proof({
      proof_level: "live_paired_lifecycle",
      live_paired_lifecycle_proven: true,
      paired_lifecycle: pairedLifecycle({ creation_input_evidence_commitment: null }),
    }), NOW).status).toBe("invalid");
    expect(carryPrivatePrimeSummary(proof({
      proof_level: "live_paired_lifecycle",
      live_paired_lifecycle_proven: true,
      paired_lifecycle: pairedLifecycle({
        value_attribution: lifecycleValueAttribution({ fees_micro_usdc: 19 }),
      }),
    }), NOW).status).toBe("invalid");
    expect(carryPrivatePrimeSummary(proof({
      proof_level: "live_paired_lifecycle",
      live_paired_lifecycle_proven: true,
      expires_at_ms: NOW + 60_000,
      paired_lifecycle: pairedLifecycle({ expires_at_ms: NOW + 30_000 }),
    }), NOW).status).toBe("invalid");
  });

  it("rejects an aggregate with a recomputable-looking but mismatched commitment", () => {
    const tampered = proof();
    tampered.asset = "ETH";
    expect(carryPrivatePrimeSummary(tampered, NOW).status).toBe("invalid");
  });

  it("rejects a no-submit aggregate relabeled as ready for live users", () => {
    expect(carryPrivatePrimeSummary(proof({ ready_for_live_users: true }), NOW).status).toBe("invalid");
  });

  it("rejects capital blockers that contradict the committed execution state", () => {
    expect(carryPrivatePrimeSummary(proof({ reasons: ["opening_capital_shortfall"] }), NOW).status).toBe("invalid");
  });

  it("rejects private-prime readiness after supervision becomes stale", () => {
    expect(carryPrivatePrimeSummary(proof({ expires_at_ms: NOW + 5_001 }), NOW).status).toBe("invalid");
    expect(carryPrivatePrimeSummary(proof(), NOW + 5_001).status).toBe("invalid");
  });

  it("does not treat a configured probe as verified collateral routing", () => {
    expect(carryPrivatePrimeSummary(proof({
      ready: false,
      reasons: ["collateral_route_evidence_unverified"],
      collateral_route_observation: {
        ...proof().collateral_route_observation,
        verified: false,
        route_count: 0,
        available_route_count: 0,
        checked_at_ms: null,
        expires_at_ms: null,
        evidence_commitment: null,
      },
    }), NOW)).toEqual({
      status: "blocked",
      value: "5/5 DATA · 3/3 EXEC · 3/3 REC · 0/6 ROUTES",
      detail: "ROUTES UNVERIFIED",
      tone: "bad",
    });
  });

  it("blocks private-prime readiness when any directed collateral route is missing", () => {
    expect(carryPrivatePrimeSummary(proof({
      ready: false,
      reasons: ["collateral_route_coverage_incomplete"],
      collateral_route_observation: {
        ...proof().collateral_route_observation,
        route_count: 6,
        required_route_count: 6,
        available_route_count: 5,
        complete_directed_coverage: false,
      },
    }), NOW)).toEqual({
      status: "blocked",
      value: "5/5 DATA · 3/3 EXEC · 3/3 REC · 5/6 ROUTES",
      detail: "ROUTE COVERAGE INCOMPLETE",
      tone: "bad",
    });
  });

  it("rejects recovery coverage that permits ambiguous retries", () => {
    expect(carryPrivatePrimeSummary(proof({
      ready: false,
      reasons: ["three_venue_recovery_unproven"],
      failure_recovery: {
        ...proof().failure_recovery,
        policy: {
          ambiguous_submission: "retry",
          partial_fill: "exact_quantity_reduce_only",
          worker_restart: "reconcile_before_action",
        },
      },
    }), NOW)).toEqual({
      status: "blocked",
      value: "5/5 DATA · 3/3 EXEC · 0/3 REC · 6/6 ROUTES",
      detail: "RECOVERY UNPROVEN",
      tone: "bad",
    });
  });

  it("rejects recovery labels backed only by unproven adapter registration", () => {
    expect(carryPrivatePrimeSummary(proof({
      ready: false,
      reasons: ["three_venue_recovery_unproven"],
      failure_recovery: {
        ...proof().failure_recovery,
        ready: false,
        venue_ids: ["hyperliquid"],
        reasons: ["carry_recovery_qualification_unproven:lighter", "carry_recovery_qualification_unproven:aster"],
      },
    }), NOW)).toEqual({
      status: "blocked",
      value: "5/5 DATA · 3/3 EXEC · 0/3 REC · 6/6 ROUTES",
      detail: "RECOVERY UNPROVEN",
      tone: "bad",
    });
  });
});

function proof(overrides: Record<string, unknown> = {}) {
  const material = {
    version: 1,
    kind: "ghola_private_prime_no_submit_readiness",
    ready: true,
    proof_level: "pre_broadcast_readiness",
    owner_commitment: "owner_commitment_0001",
    asset: "BTC",
    checked_at_ms: NOW,
    expires_at_ms: NOW + 5_000,
    five_venue_shadow: { ready: true, venue_count: 5 },
    three_venue_execution: {
      ready: true,
      venue_ids: ["hyperliquid", "lighter", "aster"],
      capital_ready: true,
    },
    failure_recovery: {
      ready: true,
      venue_ids: ["hyperliquid", "lighter", "aster"],
      reasons: [],
      policy: {
        ambiguous_submission: "freeze_reconcile_never_retry",
        partial_fill: "exact_quantity_reduce_only",
        worker_restart: "reconcile_before_action",
      },
    },
    collateral_route_observation: {
      configured: true,
      verified: true,
      route_count: 6,
      required_route_count: 6,
      available_route_count: 6,
      complete_directed_coverage: true,
      checked_at_ms: NOW,
      expires_at_ms: NOW + 30_000,
      evidence_commitment: "carry:transfer-routes:evidence:abcdef123456",
      read_only: true,
      owner_approval_required: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
    },
    supervision: {
      ready: true,
      status: "healthy",
      checked_at_ms: NOW,
      evidence_commitment: `carry:supervision:evidence:${"c".repeat(64)}`,
    },
    live_paired_lifecycle_proven: false,
    owner_only_funding: true,
    owner_only_transfers: true,
    owner_only_withdrawals: true,
    transaction_broadcast: false,
    reasons: [],
    no_submit_ready: false,
    ready_for_live_users: false,
    live_launch_blockers: [] as string[],
    ...overrides,
  };
  const noSubmitReady = material.ready === true;
  const capitalReady = material.three_venue_execution
    && typeof material.three_venue_execution === "object"
    && !Array.isArray(material.three_venue_execution)
    && material.three_venue_execution.capital_ready === true;
  const liveReady = noSubmitReady
    && capitalReady
    && material.proof_level === "live_paired_lifecycle"
    && material.live_paired_lifecycle_proven === true;
  material.no_submit_ready = noSubmitReady;
  material.ready_for_live_users = liveReady;
  material.live_launch_blockers = [
    ...(Array.isArray(material.reasons) ? material.reasons : []),
    ...(liveReady ? [] : ["live_paired_lifecycle_unproven"]),
  ];
  if ("ready_for_live_users" in overrides) material.ready_for_live_users = Boolean(overrides.ready_for_live_users);
  return {
    ...material,
    evidence_commitment: carryPrivatePrimeEvidenceCommitment(material),
  };
}

function pairedLifecycle(overrides: Record<string, unknown> = {}) {
  return {
    verified: true,
    position_id: "carry:position:live:0001",
    asset: "BTC",
    venue_ids: ["hyperliquid", "aster"],
    verified_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 86_400_000,
    account_bindings_verified: true,
    live_entry_exit_proven: true,
    supervised_monitoring_proven: true,
    final_flat_zero_orders: true,
    value_ledger_finalized: true,
    realized_net_value_micro_usdc: 34,
    value_attribution: lifecycleValueAttribution(),
    ambiguity_retry_count: 0,
    owner_only_funding: true,
    owner_only_transfers: true,
    owner_only_withdrawals: true,
    transaction_broadcast: false,
    creation_input_evidence_commitment: `carry:creation-inputs:${"c".repeat(64)}`,
    worker_material_commitment: `carry:release:material:${"a".repeat(64)}`,
    evidence_commitment: `carry:lifecycle-proof:evidence:${"b".repeat(64)}`,
    ...overrides,
  };
}

function lifecycleValueAttribution(realizedOverrides: Record<string, unknown> = {}) {
  return {
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
      ...realizedOverrides,
    },
    realized_total_cost_micro_usdc: 26,
    variance_from_modeled_micro_usdc: -166,
  };
}
