import { describe, expect, it } from "vitest";
import { carryPrivatePrimeSummary } from "./carry-private-prime-readiness";

const NOW = 1_800_000_000_000;

describe("private-prime readiness", () => {
  it("shows one compact pre-broadcast status only from complete worker proof", () => {
    expect(carryPrivatePrimeSummary(proof(), NOW)).toEqual({
      status: "ready",
      value: "5/5 DATA · 3/3 EXEC · ROUTES",
      detail: "PRE-BROADCAST · CAPITAL READY · OWNER CONTROLLED",
      tone: "good",
    });
  });

  it("shows a connected but unfunded fleet without claiming tradable readiness", () => {
    expect(carryPrivatePrimeSummary(proof({
      ready: false,
      reasons: ["opening_capital_shortfall"],
      three_venue_execution: { ...proof().three_venue_execution, capital_ready: false },
    }), NOW)).toEqual({
      status: "blocked",
      value: "5/5 DATA · 3/3 EXEC · ROUTES",
      detail: "OWNER CAPITAL REQUIRED",
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
      value: "5/5 DATA · 3/3 EXEC · ROUTES",
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
      value: "5/5 DATA · 3/3 EXEC · NO ROUTES",
      detail: "ROUTES UNVERIFIED",
      tone: "bad",
    });
  });
});

function proof(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: "ghola_private_prime_no_submit_readiness",
    ready: true,
    proof_level: "pre_broadcast_readiness",
    owner_commitment: "owner_commitment_0001",
    asset: "BTC",
    checked_at_ms: NOW,
    expires_at_ms: NOW + 60_000,
    five_venue_shadow: { ready: true, venue_count: 5 },
    three_venue_execution: {
      ready: true,
      venue_ids: ["hyperliquid", "lighter", "aster"],
      capital_ready: true,
    },
    collateral_route_observation: {
      configured: true,
      verified: true,
      route_count: 2,
      available_route_count: 2,
      checked_at_ms: NOW,
      expires_at_ms: NOW + 30_000,
      evidence_commitment: "carry:transfer-routes:evidence:abcdef123456",
      read_only: true,
      owner_approval_required: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      automatic_transfer_permitted: false,
    },
    supervision: { ready: true, status: "healthy" },
    live_paired_lifecycle_proven: false,
    owner_only_funding: true,
    owner_only_transfers: true,
    owner_only_withdrawals: true,
    transaction_broadcast: false,
    reasons: [],
    evidence_commitment: "carry:private-prime:abcdef123456",
    ...overrides,
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
