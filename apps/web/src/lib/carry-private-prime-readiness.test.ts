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

  it("rejects stale or overstated evidence", () => {
    expect(carryPrivatePrimeSummary(proof({ expires_at_ms: NOW }), NOW).status).toBe("invalid");
    expect(carryPrivatePrimeSummary(proof({ live_paired_lifecycle_proven: true }), NOW).status).toBe("invalid");
  });
});

function proof(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: "ghola_private_prime_no_submit_readiness",
    ready: true,
    proof_level: "pre_broadcast_readiness",
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
      read_only: true,
      owner_approval_required: true,
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
