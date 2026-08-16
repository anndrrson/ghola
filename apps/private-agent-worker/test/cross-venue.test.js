import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCrossVenueCoordinator,
  resetCrossVenueCoordinatorForTests,
  validateCrossVenueExecutionRequest,
} from "../src/execution/cross-venue.js";

describe("coordinated cross-venue execution", () => {
  it("validates two opposite, matched IOC legs and bounded risk", () => {
    const plan = execution();
    assert.deepEqual(validateCrossVenueExecutionRequest(plan), []);
    assert.ok(validateCrossVenueExecutionRequest({ ...plan, legs: [plan.legs[0], plan.legs[0]] }).includes("leg venues must be distinct"));
    assert.ok(validateCrossVenueExecutionRequest({
      ...plan,
      risk_budget: { ...plan.risk_budget, max_hedge_slippage_bps: 101 },
    }).includes("hedge slippage budget is invalid"));
  });

  it("submits both legs concurrently and repairs residual exposure", async () => {
    resetCrossVenueCoordinatorForTests();
    const state = memoryState();
    const reports = [];
    const submitted = [];
    const coordinator = createCrossVenueCoordinator({
      state,
      adapter: {
        durable_claims: true,
        readiness: () => ({ ready: true, reason_codes: [] }),
        preflight: async () => ({ ok: true }),
        submit: async ({ leg }) => {
          submitted.push(leg.leg_id);
          return {
            filled_notional_micro_usdc: leg.side === "buy" ? 5_000_000 : 4_000_000,
            venue_order_reference: `${leg.venue_id}:order`,
          };
        },
        hedge: async ({ notional_micro_usdc }) => ({
          filled_notional_micro_usdc: notional_micro_usdc,
          venue_order_reference: "hyperliquid:hedge",
          slippage_bps: 8,
        }),
        unwind: async () => { throw new Error("unwind_should_not_run"); },
        cancel: async () => ({ ok: true }),
        reconcile: async () => ({ terminal: false }),
        close: async () => ({ terminal: false }),
      },
      callback: async (payload) => { reports.push(payload.report); },
    });
    const accepted = await coordinator.submit(execution());
    assert.equal(accepted.ok, true);
    await waitFor(() => reports.some((report) => report.phase === "complete"));
    assert.equal(submitted.length, 2);
    assert.deepEqual(reports.map((report) => report.sequence), [1, 2, 3, 4]);
    assert.equal(reports.at(-1).phase, "complete");
    assert.equal(reports.at(-1).legs[0].filled_notional_micro_usdc, 5_000_000);
    assert.equal(reports.at(-1).legs[1].filled_notional_micro_usdc, 4_000_000);
    assert.equal(reports.at(-1).repair_fills[0].side, "sell");
    assert.equal(reports.at(-1).repair_fills[0].filled_notional_micro_usdc, 1_000_000);

    const replay = await coordinator.submit(execution());
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, 200);
    assert.equal(submitted.length, 2);
    assert.equal((await state.getExecutionClaimEvidence(execution().execution_id)).status, "completed");
  });

  it("uses one durable parent claim across concurrent coordinators", async () => {
    resetCrossVenueCoordinatorForTests();
    const state = memoryState();
    const tasks = [];
    let submitCalls = 0;
    const adapter = durableAdapter({
      submit: async ({ leg }) => {
        submitCalls += 1;
        return {
          filled_notional_micro_usdc: leg.target_notional_micro_usdc,
          venue_order_reference: `${leg.venue_id}:filled`,
        };
      },
    });
    const options = {
      state,
      adapter,
      callback: async () => {},
      schedule: (task) => tasks.push(task),
    };
    const first = await createCrossVenueCoordinator(options).submit(execution());
    const duplicate = await createCrossVenueCoordinator(options).submit(execution());
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 409);
    assert.equal(tasks.length, 1);
    assert.equal(submitCalls, 0);
    await tasks[0]();
    assert.equal(submitCalls, 2);
  });

  it("treats equal base fills as hedged even when venue fill notionals differ", async () => {
    resetCrossVenueCoordinatorForTests();
    const state = memoryState();
    const reports = [];
    let repairCalls = 0;
    const coordinator = createCrossVenueCoordinator({
      state,
      adapter: durableAdapter({
        submit: async ({ leg }) => ({
          filled_notional_micro_usdc: leg.side === "buy" ? 4_900_000 : 5_100_000,
          filled_base_size: "0.05",
          venue_order_reference: `${leg.venue_id}:filled`,
        }),
        hedge: async () => { repairCalls += 1; throw new Error("must_not_repair"); },
        unwind: async () => { repairCalls += 1; throw new Error("must_not_repair"); },
      }),
      callback: async (payload) => { reports.push(payload.report); },
    });
    const plan = execution();
    plan.legs = plan.legs.map((leg) => ({ ...leg, target_base_size: "0.05" }));
    assert.equal((await coordinator.submit(plan)).status, 202);
    await waitFor(() => reports.some((report) => report.phase === "complete"));
    assert.equal(repairCalls, 0);
  });

  it("resolves a crash-left parent claim from terminal venue evidence after restart", async () => {
    resetCrossVenueCoordinatorForTests();
    const state = memoryState();
    const tasks = [];
    const first = createCrossVenueCoordinator({
      state,
      adapter: durableAdapter(),
      callback: async () => {},
      schedule: (task) => tasks.push(task),
    });
    assert.equal((await first.submit(execution())).status, 202);
    assert.equal(tasks.length, 1);

    resetCrossVenueCoordinatorForTests();
    let liveSubmits = 0;
    const restarted = createCrossVenueCoordinator({
      state,
      adapter: durableAdapter({
        submit: async () => { liveSubmits += 1; throw new Error("must_not_submit"); },
        reconcile: async ({ plan }) => ({
          terminal: true,
          phase: "complete",
          legs: plan.legs.map((leg) => ({
            leg_id: leg.leg_id,
            status: "filled",
            filled_notional_micro_usdc: leg.target_notional_micro_usdc,
            venue_order_reference: `${leg.venue_id}:recovered`,
          })),
          final_proof: {
            version: 1,
            proof_kind: "cross_venue_reconciled_execution_v1",
            terminal_status: "complete",
            atomic: false,
            broadcast_performed: true,
            final_venue_execution_proven: true,
            final_fill_proven: true,
            checked_at: new Date().toISOString(),
          },
        }),
      }),
      callback: async () => {},
    });
    const recovered = await restarted.submit(execution());
    assert.equal(recovered.ok, true);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.replayed, true);
    assert.equal(liveSubmits, 0);
    assert.equal((await state.getExecutionClaimEvidence(execution().execution_id)).status, "completed");
  });

  it("claims a matched-pair close once and replays the proved flat receipt", async () => {
    resetCrossVenueCoordinatorForTests();
    const state = memoryState();
    const tasks = [];
    let closeCalls = 0;
    const plan = execution();
    const coordinator = createCrossVenueCoordinator({
      state,
      adapter: durableAdapter({
        close: async ({ plan: closePlan }) => {
          closeCalls += 1;
          return {
            terminal: true,
            status: "closed",
            legs: closePlan.legs.map((leg) => ({ ...leg, status: "filled" })),
            final_proof: { final_flat_proven: true },
          };
        },
      }),
      callback: async () => {},
      schedule: (task) => tasks.push(task),
    });
    assert.equal((await coordinator.submit(plan)).status, 202);
    await tasks[0]();

    const first = await coordinator.close(plan);
    const replay = await coordinator.close(plan);
    assert.equal(first.status, 200);
    assert.equal(first.replayed, false);
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, true);
    assert.equal(closeCalls, 1);
  });

  it("does not pretend execution is available without every durable adapter control", async () => {
    const coordinator = createCrossVenueCoordinator({
      state: memoryState(),
      adapter: null,
      callback: async () => {},
    });
    const result = await coordinator.submit(execution());
    assert.equal(result.ok, false);
    assert.equal(result.error, "cross_venue_durable_adapter_unavailable");
  });
});

function durableAdapter(overrides = {}) {
  return {
    durable_claims: true,
    readiness: () => ({ ready: true, reason_codes: [] }),
    preflight: async () => ({ ok: true }),
    submit: async ({ leg }) => ({
      filled_notional_micro_usdc: leg.target_notional_micro_usdc,
      venue_order_reference: `${leg.venue_id}:filled`,
    }),
    hedge: async ({ notional_micro_usdc, preferred_venue_id }) => ({
      venue_id: preferred_venue_id,
      filled_notional_micro_usdc: notional_micro_usdc,
      venue_order_reference: `${preferred_venue_id}:hedge`,
      slippage_bps: 1,
    }),
    unwind: async ({ notional_micro_usdc, venue_id }) => ({
      venue_id,
      filled_notional_micro_usdc: notional_micro_usdc,
      venue_order_reference: `${venue_id}:unwind`,
    }),
    cancel: async () => ({ ok: true }),
    reconcile: async () => ({ terminal: false }),
    close: async () => ({ terminal: false }),
    ...overrides,
  };
}

function execution() {
  const executionId = `consumer_cross_venue_execution_${"a".repeat(48)}`;
  return {
    version: 1,
    execution_id: executionId,
    owner_commitment: "owner_cross_venue_test",
    opportunity_commitment: "ghola_opportunity_cross_venue_test",
    market: "SOL-USD",
    matched_notional_micro_usdc: 5_000_000,
    risk_budget: {
      max_unhedged_notional_micro_usdc: 5_000_000,
      max_hedge_slippage_bps: 25,
      max_hedge_duration_ms: 5_000,
      max_unwind_loss_micro_usdc: 250_000,
      max_daily_loss_micro_usdc: 5_000_000,
    },
    legs: [
      {
        leg_id: "consumer_cross_leg_buy_test",
        venue_id: "hyperliquid",
        side: "buy",
        symbol: "SOL",
        limit_price: "150",
        target_notional_micro_usdc: 5_000_000,
        order_type: "ioc_limit",
      },
      {
        leg_id: "consumer_cross_leg_sell_test",
        venue_id: "phoenix",
        side: "sell",
        symbol: "SOL-PERP",
        limit_price: "151",
        target_notional_micro_usdc: 5_000_000,
        order_type: "ioc_limit",
      },
    ],
  };
}

function memoryState() {
  const claims = new Map();
  const receipts = new Map();
  return {
    async claimExecution(id, context) {
      const receipt = receipts.get(id);
      const existing = claims.get(id);
      if (receipt) {
        return receipt.execution_request_digest === context.request_digest
          ? { status: "completed", receipt }
          : { status: "context_mismatch" };
      }
      if (existing) {
        return existing.context.request_digest === context.request_digest
          ? { status: "reconcile_required" }
          : { status: "context_mismatch" };
      }
      const claim = { status: "in_progress", claim_token: `token_${id}`, context };
      claims.set(id, claim);
      return { status: "claimed", claim_token: claim.claim_token, claim };
    },
    async recordExecutionClaimEvidence(id, token, evidence) {
      const claim = claims.get(id);
      assert.equal(claim?.claim_token, token);
      assert.equal(evidence.attempt.execution_request_digest, claim.context.request_digest);
      claim.attempt = structuredClone(evidence.attempt);
      claim.receipt = structuredClone(evidence.receipt);
      return evidence.receipt;
    },
    async completeExecutionClaim(id, token, evidence) {
      const claim = claims.get(id);
      assert.equal(claim?.claim_token, token);
      claim.status = "completed";
      claim.attempt = structuredClone(evidence.attempt);
      claim.receipt = structuredClone(evidence.receipt);
      receipts.set(id, claim.receipt);
      return claim.receipt;
    },
    async markExecutionClaimReconcileRequired(id, token, failure, evidence) {
      const claim = claims.get(id);
      if (!claim || claim.claim_token !== token) return { ok: false };
      claim.status = "reconcile_required";
      claim.failure = failure;
      if (evidence) {
        claim.attempt = structuredClone(evidence.attempt);
        claim.receipt = structuredClone(evidence.receipt);
      }
      return { ok: true };
    },
    async getExecutionClaimEvidence(id) {
      const claim = claims.get(id);
      if (!claim) return null;
      return structuredClone({
        status: claim.status,
        context: claim.context,
        attempt: claim.attempt || null,
        receipt: claim.receipt || null,
      });
    },
    async resolveExecutionClaim(id, evidence) {
      const claim = claims.get(id);
      if (!claim || claim.context.request_digest !== evidence.receipt.execution_request_digest) {
        throw new Error("claim_conflict");
      }
      claim.status = "completed";
      claim.attempt = structuredClone(evidence.attempt);
      claim.receipt = structuredClone(evidence.receipt);
      receipts.set(id, claim.receipt);
      return claim.receipt;
    },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_not_reached");
}
