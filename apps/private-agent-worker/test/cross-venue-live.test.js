import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLiveCrossVenueAdapter, crossVenueCommonBaseSize } from "../src/execution/cross-venue-live.js";
import { createWorkerState } from "../src/state/private-state.js";

const OLD_ENV = { ...process.env };

describe("live cross-venue adapter", () => {
  let dir;
  let state;

  beforeEach(async () => {
    process.env = {
      ...OLD_ENV,
      PRIVATE_AGENT_VENUE_DRY_RUN: "false",
      PRIVATE_AGENT_CROSS_VENUE_PAIR: "hyperliquid:backpack",
      PRIVATE_AGENT_CROSS_VENUE_MAX_NOTIONAL_USD: "11",
      PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
      PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "tiny_fill",
      PRIVATE_AGENT_BACKPACK_LIVE_MODE: "tiny_live",
      PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD: "11",
    };
    dir = await mkdtemp(join(tmpdir(), "ghola-cross-venue-"));
    state = createWorkerState(dir);
  });

  afterEach(async () => {
    process.env = { ...OLD_ENV };
    await rm(dir, { recursive: true, force: true });
  });

  it("fails readiness closed when either exact venue credential is unavailable", () => {
    const venues = fakeVenues();
    venues.loadBackpackCredential = () => { throw new Error("missing"); };
    const readiness = createLiveCrossVenueAdapter({ state, venues }).readiness();
    assert.equal(readiness.ready, false);
    assert.ok(readiness.reason_codes.includes("backpack_cross_venue_credential_unavailable"));
  });

  it("preflights and submits each exact leg once under a durable child claim", async () => {
    const calls = { verify: [], submit: [] };
    const venues = fakeVenues({
      verifyHyperliquid: async ({ instruction }) => { calls.verify.push(`hl:${instruction.order.market}`); },
      verifyBackpack: async ({ instruction }) => { calls.verify.push(`bp:${instruction.order.market}`); },
      submitHyperliquid: async ({ cloid }) => {
        calls.submit.push(`hl:${cloid}`);
        return {
          status: "filled",
          provider_ref_seed: { cloid, oid: 71 },
          fills: [{ oid: 71, px: "200", sz: "0.05" }],
          final_proof: fillProof("hyperliquid"),
        };
      },
      submitBackpack: async ({ clientOrderId }) => {
        calls.submit.push(`bp:${clientOrderId}`);
        return { status: "submitted", provider_ref_seed: { client_order_id: clientOrderId }, fills: [] };
      },
    });
    const adapter = createLiveCrossVenueAdapter({ state, venues, sleep: async () => {} });
    const plan = execution();
    await Promise.all(plan.legs.map((leg) => adapter.preflight({ plan, leg })));
    const first = await Promise.all(plan.legs.map((leg) => adapter.submit({ plan, leg })));
    const replay = await Promise.all(plan.legs.map((leg) => adapter.submit({ plan, leg })));

    assert.deepEqual(calls.verify.sort(), ["bp:SOL_USDC_PERP", "hl:SOL"]);
    assert.equal(calls.submit.length, 2);
    assert.deepEqual(first.map((leg) => leg.filled_notional_micro_usdc), [10_000_000, 10_000_000]);
    assert.deepEqual(replay, first);
    assert.equal((await state.getExecutionClaimEvidence(plan.legs[0].leg_id)).status, "completed");
    assert.equal((await state.getExecutionClaimEvidence(plan.legs[1].leg_id)).status, "completed");
  });

  it("derives one exact venue-compatible SOL base size inside both notional bounds", () => {
    const plan = execution();
    plan.legs[0].limit_price = "75.76";
    plan.legs[1].limit_price = "75.71";
    assert.equal(crossVenueCommonBaseSize(plan), "0.14");
    plan.matched_notional_micro_usdc = 10_000_000;
    assert.throws(() => crossVenueCommonBaseSize(plan), /no_common_base_size/);
  });

  it("recovers crash-left leg claims from venue truth without rebroadcasting", async () => {
    let terminal = false;
    let broadcasts = 0;
    const terminalResult = (venueId) => terminal ? {
      terminal: true,
      status: "filled",
      filled_notional_micro_usdc: 10_000_000,
      filled_base_size: "0.05",
      venue_order_reference: `${venueId}:recovered`,
      fills: [{ price: "200", quantity: "0.05" }],
      final_proof: fillProof(venueId),
    } : {
      terminal: false,
      status: "unknown",
      filled_notional_micro_usdc: 0,
      filled_base_size: "0",
      venue_order_reference: null,
      fills: [],
      final_proof: null,
    };
    const venues = fakeVenues({
      submitHyperliquid: async () => { broadcasts += 1; return { status: "submitted", fills: [] }; },
      submitBackpack: async () => { broadcasts += 1; return { status: "submitted", fills: [] }; },
      reconcileHyperliquid: async () => terminalResult("hyperliquid"),
      reconcileBackpack: async () => terminalResult("backpack"),
    });
    const adapter = createLiveCrossVenueAdapter({ state, venues, sleep: async () => {} });
    const plan = execution();
    const results = await Promise.allSettled(plan.legs.map((leg) => adapter.submit({ plan, leg })));
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.equal(broadcasts, 2);
    assert.ok((await state.getExecutionClaimEvidence(plan.legs[0].leg_id)).receipt);
    assert.ok((await state.getExecutionClaimEvidence(plan.legs[1].leg_id)).receipt);

    terminal = true;
    const recovered = await adapter.reconcile({ plan });
    assert.equal(recovered.terminal, true);
    assert.equal(recovered.phase, "complete");
    assert.equal(broadcasts, 2);
    assert.equal((await state.getExecutionClaimEvidence(plan.legs[0].leg_id)).status, "completed");
    assert.equal((await state.getExecutionClaimEvidence(plan.legs[1].leg_id)).status, "completed");
  });

  it("rejects Phoenix and non-equivalent products before any venue call", async () => {
    const adapter = createLiveCrossVenueAdapter({ state, venues: fakeVenues() });
    const plan = execution();
    plan.legs[1] = { ...plan.legs[1], venue_id: "phoenix", symbol: "SOL-PERP" };
    await assert.rejects(() => adapter.preflight({ plan, leg: plan.legs[0] }), /pair_unsupported/);
  });

  it("durably closes both matched legs reduce-only and proves both accounts flat", async () => {
    const positions = { hyperliquid: "0.05", backpack: "-0.05" };
    const submitted = [];
    const venues = fakeVenues({
      readHyperliquidState: async () => account(positions.hyperliquid),
      readBackpackState: async () => account(positions.backpack),
      submitHyperliquid: async ({ instruction, cloid }) => {
        submitted.push({ venue: "hyperliquid", order: instruction.order });
        positions.hyperliquid = "0";
        return {
          status: "filled",
          provider_ref_seed: { cloid, oid: 81 },
          fills: [{ oid: 81, px: "199.5", sz: "0.05" }],
          final_proof: fillProof("hyperliquid"),
        };
      },
      submitBackpack: async ({ instruction, clientOrderId }) => {
        submitted.push({ venue: "backpack", order: instruction.order });
        positions.backpack = "0";
        return { status: "submitted", provider_ref_seed: { client_order_id: clientOrderId }, fills: [] };
      },
      reconcileBackpack: async () => ({
        terminal: true,
        status: "filled",
        filled_notional_micro_usdc: 10_025_000,
        filled_base_size: "0.05",
        venue_order_reference: "backpack:close",
        fills: [],
        final_proof: fillProof("backpack"),
      }),
    });
    const adapter = createLiveCrossVenueAdapter({ state, venues, sleep: async () => {} });
    const plan = execution();
    const evidence = completedParentEvidence(plan);
    const first = await adapter.close({ plan, evidence });
    const replay = await adapter.close({ plan, evidence });

    assert.equal(first.status, "closed");
    assert.equal(first.final_proof.final_flat_proven, true);
    assert.equal(replay.status, "closed");
    assert.equal(submitted.length, 2);
    assert.ok(submitted.every((call) => call.order.reduce_only === true));
    assert.ok(submitted.every((call) => call.order.order_type === "market"));
    assert.deepEqual(positions, { hyperliquid: "0", backpack: "0" });
  });
});

function execution() {
  return {
    version: 1,
    execution_id: `consumer_cross_venue_execution_${"a".repeat(48)}`,
    owner_commitment: "owner_cross_venue_live_test",
    opportunity_commitment: "ghola_opportunity_cross_venue_live_test",
    market: "SOL-USD",
    matched_notional_micro_usdc: 11_000_000,
    risk_budget: {
      max_unhedged_notional_micro_usdc: 11_000_000,
      max_hedge_slippage_bps: 25,
      max_hedge_duration_ms: 5_000,
      max_unwind_loss_micro_usdc: 250_000,
      max_daily_loss_micro_usdc: 5_000_000,
    },
    legs: [
      { leg_id: "consumer_cross_leg_hyperliquid_live", venue_id: "hyperliquid", side: "buy", symbol: "SOL", limit_price: "200", target_notional_micro_usdc: 11_000_000, target_base_size: "0.05", order_type: "ioc_limit" },
      { leg_id: "consumer_cross_leg_backpack_live", venue_id: "backpack", side: "sell", symbol: "SOL_USDC_PERP", limit_price: "200", target_notional_micro_usdc: 11_000_000, target_base_size: "0.05", order_type: "ioc_limit" },
    ],
  };
}

function fakeVenues(overrides = {}) {
  return {
    hyperliquidAccountRefs: () => [{ credential_ref: "hl-mainnet", network: "mainnet", market_allowlist: ["SOL"] }],
    loadHyperliquidCredential: () => ({ network: "mainnet", account_address: `0x${"1".repeat(40)}`, api_wallet_private_key: `0x${"2".repeat(64)}` }),
    loadBackpackCredential: () => ({ venueId: "backpack", network: "mainnet", apiKey: "key", privateSeed: new Uint8Array(32), allowedSymbols: ["SOL_USDC_PERP"], maxOrderNotionalUsd: 11 }),
    readHyperliquidState: async () => account("0"),
    readBackpackState: async () => account("0"),
    readHyperliquidBook: async () => ({ bid: 199.9, ask: 200.1 }),
    readBackpackBook: async () => ({ bid: 199.8, ask: 200.2 }),
    verifyHyperliquid: async () => ({ status: "verified_no_funds" }),
    verifyBackpack: async () => ({ status: "verified_no_funds" }),
    submitHyperliquid: async ({ cloid }) => ({ status: "filled", provider_ref_seed: { cloid, oid: 1 }, fills: [{ oid: 1, px: "200", sz: "0.05" }], final_proof: fillProof("hyperliquid") }),
    submitBackpack: async () => ({ status: "submitted", fills: [] }),
    reconcileHyperliquid: async () => ({ terminal: true, status: "filled", filled_notional_micro_usdc: 10_000_000, filled_base_size: "0.05", venue_order_reference: "hyperliquid:1", fills: [], final_proof: fillProof("hyperliquid") }),
    reconcileBackpack: async () => ({ terminal: true, status: "filled", filled_notional_micro_usdc: 10_000_000, filled_base_size: "0.05", venue_order_reference: "backpack:1", fills: [], final_proof: fillProof("backpack") }),
    ...overrides,
  };
}

function account(position_size) {
  return { status: "ready_to_trade", position_size, open_order_count: 0 };
}

function completedParentEvidence(plan) {
  return {
    status: "completed",
    receipt: {
      status: "complete",
      report: {
        phase: "complete",
        legs: plan.legs.map((leg) => ({
          leg_id: leg.leg_id,
          status: "filled",
          filled_notional_micro_usdc: 10_000_000,
          filled_base_size: "0.05",
        })),
        repair_fills: [],
      },
    },
  };
}

function fillProof(venueId) {
  return {
    version: 1,
    proof_kind: `${venueId}_execution_proof_v1`,
    terminal_status: "filled",
    venue_id: venueId,
    network: "mainnet",
    broadcast_performed: true,
    final_venue_execution_proven: true,
    final_fill_proven: true,
    checked_at: new Date().toISOString(),
  };
}
