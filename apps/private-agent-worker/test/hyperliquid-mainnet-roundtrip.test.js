import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import {
  bytesToBase64,
  bytesToHex,
  didKeyFromVerifying,
  sealForTest,
} from "../src/crypto/envelope.js";
import {
  MAINNET_PROOF_CONFIRMATION,
  hyperliquidMainnetRoundTripEnabled,
  isHyperliquidMainnetProofWorkOrder,
  recoverHyperliquidMainnetCanary,
  runSealedHyperliquidMainnetRoundTrip,
  validateHyperliquidMainnetRoundTripRequest,
} from "../src/execution/hyperliquid-mainnet-roundtrip.js";
import { verifyHyperliquidMainnetVenueEvidence } from "../src/execution/hyperliquid-mainnet-evidence.js";
import { enforceInstructionPolicy } from "../src/execution/policy.js";
import { hyperliquidProtectionCloids } from "../src/venues/hyperliquid.js";
import { createWorkerState } from "../src/state/private-state.js";

describe("sealed Hyperliquid mainnet proof round trip", () => {
  it("requires every code-bounded live gate", () => {
    const env = {
      PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED: "true",
      PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
      PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket",
      PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "100",
      PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "500",
      PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
    };
    assert.equal(hyperliquidMainnetRoundTripEnabled(env), true);
    assert.equal(hyperliquidMainnetRoundTripEnabled({ ...env, PRIVATE_AGENT_VENUE_DRY_RUN: "true" }), false);
    assert.equal(hyperliquidMainnetRoundTripEnabled({ ...env, PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "50" }), false);
    assert.equal(hyperliquidMainnetRoundTripEnabled({ ...env, PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "101" }), false);
  });

  it("recovers a crash-armed canary flat and clears both deterministic protections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghola-mainnet-proof-hard-recovery."));
    const state = createWorkerState(dir);
    const proofWorkOrder = `hl_mainnet_investor_proof_${"e".repeat(32)}`;
    const parentCloid = await state.deriveHyperliquidCloid(`${proofWorkOrder}_entry`);
    const children = hyperliquidProtectionCloids(parentCloid);
    const openProtection = new Set(Object.values(children));
    let positionSize = "0.18";
    let flattenCalls = 0;
    let cancelCalls = 0;
    try {
      const recovery = await recoverHyperliquidMainnetCanary({
        credential: {
          network: "mainnet",
          base_url: "https://api.hyperliquid.xyz",
          account_address: `0x${"1".repeat(40)}`,
        },
        state,
        proofWorkOrder,
        fetchImpl: async (_url, init) => {
          const request = JSON.parse(String(init.body));
          if (request.type === "openOrders") {
            return Response.json([...openProtection].map((cloid) => ({ coin: "HYPE", cloid })));
          }
          return Response.json({
            assetPositions: positionSize === "0"
              ? []
              : [{ position: { coin: "HYPE", szi: positionSize, leverage: { type: "isolated", value: 1 } } }],
          });
        },
        submitRecovery: async ({ instruction }) => {
          if (instruction.operation_class === "limit_order") {
            flattenCalls += 1;
            assert.equal(instruction.order.reduce_only, true);
            positionSize = "0";
            return { status: "filled" };
          }
          cancelCalls += 1;
          const target = instruction.cancel.client_order_id;
          openProtection.delete(target);
          return cancellationReceipt(
            target,
            target === children.take_profit_cloid ? "201" : "202",
          );
        },
      });
      assert.equal(recovery.status, "recovered_safe");
      assert.equal(recovery.flat, true);
      assert.equal(recovery.open_orders, 0);
      assert.equal(recovery.protection_cleanup_exact, true);
      assert.equal(flattenCalls, 1);
      assert.equal(cancelCalls, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects recovery work orders outside the legacy and v2 proof namespaces", async () => {
    assert.equal(isHyperliquidMainnetProofWorkOrder(`hl_mainnet_investor_proof_${"e".repeat(32)}`), true);
    assert.equal(isHyperliquidMainnetProofWorkOrder(`hl_mainnet_investor_proof_v2_${"e".repeat(32)}`), true);
    assert.equal(isHyperliquidMainnetProofWorkOrder(`hl_mainnet_investor_proof_v3_${"e".repeat(32)}`), false);
    await assert.rejects(
      recoverHyperliquidMainnetCanary({
        credential: { network: "mainnet" },
        state: {},
        proofWorkOrder: `hl_mainnet_investor_proof_v3_${"e".repeat(32)}`,
      }),
      /recovery scope is invalid/u,
    );
  });

  it("persists the proof receipt and replays it after a worker-state restart without another submit", async () => {
    const fixture = await sealedFixture();
    const dir = mkdtempSync(join(tmpdir(), "ghola-mainnet-proof."));
    let positionSize = "0";
    let orderCalls = 0;
    let cancelCalls = 0;
    const instructionExpiries = new Map();
    const receipts = new Map();
    const entryCloid = `0x${"a".repeat(32)}`;
    const protectionCloids = hyperliquidProtectionCloids(entryCloid);
    const openProtection = new Set();
    const verifiedInstructions = [];
    let entryPolicyCommitment = null;
    const executeOrder = async ({ body, instruction, state: executionState }) => {
      orderCalls += 1;
      assert.ok(Date.parse(instruction.expires_at) > Date.now());
      const previousExpiry = instructionExpiries.get(body.work_order_commitment);
      if (previousExpiry) assert.equal(instruction.expires_at, previousExpiry);
      instructionExpiries.set(body.work_order_commitment, instruction.expires_at);
      const existing = receipts.get(body.work_order_commitment);
      if (existing) return structuredClone(existing);
      const entry = body.work_order_commitment.endsWith("_entry");
      await enforceInstructionPolicy({ body, instruction, session: null, state: executionState });
      if (entry) entryPolicyCommitment = body.session_policy.policy_commitment;
      positionSize = entry ? "0.18" : "0";
      if (entry) Object.values(protectionCloids).forEach((cloid) => openProtection.add(cloid));
      const oid = entry ? "101" : "102";
      const cloid = entry ? entryCloid : `0x${"b".repeat(32)}`;
      const receipt = {
        version: 1,
        status: "filled",
        work_order_commitment: body.work_order_commitment,
        fill_summary: {
          fill_count: 1,
          filled_base_size: "0.18",
          filled_notional_usd: 11,
          average_fill_price: entry ? 58.31 : 58.32,
          fee_usd: 0.004,
        },
        final_proof: {
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
          venue_order_readback_proven: true,
          venue_order_status: "filled",
          venue_order_oid: oid,
          venue_order_cloid: cloid,
          execution_configuration_proven: true,
          margin_mode: "isolated",
          leverage: 1,
          market_data_freshness_proven: true,
          market_slippage_bound_proven: true,
          action_expiry_proven: true,
          position_protection_proven: entry,
          take_profit_oid: entry ? "201" : null,
          stop_loss_oid: entry ? "202" : null,
          take_profit_cloid: entry ? protectionCloids.take_profit_cloid : null,
          stop_loss_cloid: entry ? protectionCloids.stop_loss_cloid : null,
        },
      };
      receipts.set(body.work_order_commitment, receipt);
      return structuredClone(receipt);
    };
    const fetchImpl = async (_url, init) => {
      const request = JSON.parse(String(init.body));
      if (request.type === "openOrders") {
        return Response.json([...openProtection].map((cloid) => ({ coin: "HYPE", cloid })));
      }
      return Response.json({
        assetPositions: positionSize === "0"
          ? []
          : [{ position: { coin: "HYPE", szi: positionSize, leverage: { type: "isolated", value: 1 } } }],
      });
    };
    const dependencies = {
      fetchImpl,
      executeOrder,
      readSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true }),
      verifyOrder: async ({ instruction }) => {
        verifiedInstructions.push(structuredClone(instruction));
        return verifiedNoSubmit(instruction);
      },
      buildProtection: async () => protectionPlan(),
      reconcile: async ({ body }) => structuredClone(receipts.get(body.work_order_commitment)),
      submitEmergency: async () => { throw new Error("emergency flatten must not run"); },
      submitProtectionCancel: async ({ instruction }) => {
        cancelCalls += 1;
        assert.ok(Date.parse(instruction.expires_at) > Date.now());
        const target = instruction.cancel.client_order_id;
        const oid = target === protectionCloids.take_profit_cloid ? "201" : "202";
        assert.ok(Object.values(protectionCloids).includes(target));
        openProtection.delete(target);
        return cancellationReceipt(target, oid);
      },
      verifyVenueEvidence: async () => venueEvidence(protectionCloids),
    };
    const previousMaxSlippage = process.env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS;
    process.env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS = "100";
    try {
      const firstState = createWorkerState(dir);
      const legacyPolicyCount = await firstState.incrementPolicyCount(fixture.body.policy_commitment, 1);
      assert.deepEqual(legacyPolicyCount, { ok: true, count: 1 });
      const legacyClaim = await firstState.claimExecution(
        `hl_mainnet_investor_proof_${"c".repeat(32)}`,
        {
          venue_id: "hyperliquid",
          platform_class: "hyperliquid_style_market",
          execution_mode: "byo_api_key",
          operation_class: "mainnet_roundtrip_proof",
          request_digest: "c".repeat(64),
        },
      );
      assert.equal(legacyClaim.status, "claimed");
      await firstState.markExecutionClaimReconcileRequired(
        `hl_mainnet_investor_proof_${"c".repeat(32)}`,
        legacyClaim.claim_token,
        { message: "legacy venue rejection" },
      );
      const first = await runSealedHyperliquidMainnetRoundTrip({
        body: fixture.body,
        recipient: fixture.recipient,
        state: firstState,
        ...dependencies,
      });
      const restartedState = createWorkerState(dir);
      const replay = await runSealedHyperliquidMainnetRoundTrip({
        body: fixture.body,
        recipient: fixture.recipient,
        state: restartedState,
        ...dependencies,
      });

      assert.equal(first.flat_after_exit, true);
      assert.equal(first.claim_store, "unverified");
      assert.equal(first.duplicate_entry_prevented, true);
      assert.equal(first.duplicate_exit_prevented, true);
      assert.equal(first.default_margin_mode, "isolated");
      assert.equal(first.default_leverage, 1);
      assert.equal(first.preflight_verified, true);
      assert.equal(first.exit_preflight_verified, true);
      assert.equal(first.api_wallet_authorization_verified, true);
      assert.equal(first.preflight_transaction_broadcast, false);
      assert.equal(first.preflight_action_expiry_proven, true);
      assert.equal(first.entry_order_readback_proven, true);
      assert.equal(first.exit_order_readback_proven, true);
      assert.equal(first.independent_venue_evidence_proven, true);
      assert.equal(first.venue_position_protection_proven, true);
      assert.equal(first.take_profit_cloid, protectionCloids.take_profit_cloid);
      assert.equal(first.protection_cleanup_confirmed, true);
      assert.equal(first.protection_children_terminal, true);
      assert.match(first.proof_work_order_commitment, /^hl_mainnet_investor_proof_v2_[0-9a-f]{32}$/u);
      assert.match(entryPolicyCommitment, /^hl_mainnet_investor_proof_v2_policy_[0-9a-f]{40}$/u);
      assert.notEqual(entryPolicyCommitment, fixture.body.policy_commitment);
      assert.deepEqual(await firstState.incrementPolicyCount(entryPolicyCommitment, 1), { ok: false, count: 1 });
      assert.match(first.venue_evidence_commitment, /^sha256:[0-9a-f]{64}$/);
      assert.equal(first.entry_order_reference.oid, "101");
      assert.equal(first.exit_order_reference.reduce_only, true);
      assert.equal(orderCalls, 4);
      assert.equal(cancelCalls, 2);
      assert.equal(verifiedInstructions.length, 3);
      assert.equal(verifiedInstructions[1].order.reduce_only, true);
      assert.equal(verifiedInstructions[1].order.base_size, "0.18");
      assert.equal(verifiedInstructions[1].order.quote_size, undefined);
      assert.equal(verifiedInstructions[1].order.order_type, "market");
      assert.equal(verifiedInstructions[1].position_protection, undefined);
      assert.deepEqual(replay, first);
      assert.equal(positionSize, "0");
      assert.equal(openProtection.size, 0);
    } finally {
      if (previousMaxSlippage === undefined) {
        delete process.env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS;
      } else {
        process.env.PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS = previousMaxSlippage;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reduce-only flattens when the entry response is ambiguous after broadcast", async () => {
    const fixture = await sealedFixture();
    const dir = mkdtempSync(join(tmpdir(), "ghola-mainnet-proof-recovery."));
    let positionSize = "0";
    let emergencyCalls = 0;
    let cancelCalls = 0;
    const fetchImpl = async (_url, init) => {
      const request = JSON.parse(String(init.body));
      if (request.type === "openOrders") return Response.json([]);
      return Response.json({
        assetPositions: positionSize === "0"
          ? []
          : [{ position: { coin: "HYPE", szi: positionSize, leverage: { type: "isolated", value: 1 } } }],
      });
    };
    try {
      await assert.rejects(
        runSealedHyperliquidMainnetRoundTrip({
          body: fixture.body,
          recipient: fixture.recipient,
          state: createWorkerState(dir),
          fetchImpl,
          readSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true }),
          verifyOrder: async ({ instruction }) => verifiedNoSubmit(instruction),
          buildProtection: async () => protectionPlan(),
          executeOrder: async () => {
            positionSize = "0.18";
            throw new Error("timeout after venue acceptance");
          },
          reconcile: async () => { throw new Error("reconcile must not run"); },
          verifyVenueEvidence: async () => venueEvidence(),
          submitEmergency: async ({ instruction }) => {
            emergencyCalls += 1;
            assert.equal(instruction.order.reduce_only, true);
            assert.equal(instruction.order.side, "sell");
            assert.equal(instruction.order.base_size, "0.18");
            positionSize = "0";
          },
          submitProtectionCancel: async () => {
            cancelCalls += 1;
            throw new Error("unknown child order");
          },
        }),
        /timeout after venue acceptance/,
      );
      assert.equal(emergencyCalls, 1);
      assert.equal(cancelCalls, 2);
      assert.equal(positionSize, "0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the primary failure phase when recovery cleanup also fails", async () => {
    const fixture = await sealedFixture();
    const dir = mkdtempSync(join(tmpdir(), "ghola-mainnet-proof-primary-error."));
    const entryCloid = `0x${"a".repeat(32)}`;
    const children = hyperliquidProtectionCloids(entryCloid);
    let positionSize = "0";
    let executeCalls = 0;
    let emergencyCalls = 0;
    let cancelCalls = 0;
    try {
      await assert.rejects(
        runSealedHyperliquidMainnetRoundTrip({
          body: fixture.body,
          recipient: fixture.recipient,
          state: createWorkerState(dir),
          fetchImpl: async (_url, init) => {
            const request = JSON.parse(String(init.body));
            if (request.type === "openOrders") return Response.json([]);
            return Response.json({
              assetPositions: positionSize === "0"
                ? []
                : [{ position: { coin: "HYPE", szi: positionSize, leverage: { type: "isolated", value: 1 } } }],
            });
          },
          readSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true }),
          verifyOrder: async ({ instruction }) => verifiedNoSubmit(instruction),
          buildProtection: async () => protectionPlan(),
          executeOrder: async () => {
            executeCalls += 1;
            if (executeCalls === 1) {
              positionSize = "0.18";
              return fundedReceipt({ entry: true, entryCloid, children });
            }
            throw new Error("durable replay unavailable");
          },
          reconcile: async () => { throw new Error("reconcile must not run"); },
          verifyVenueEvidence: async () => { throw new Error("evidence must not run"); },
          submitEmergency: async () => {
            emergencyCalls += 1;
            positionSize = "0";
          },
          submitProtectionCancel: async () => {
            cancelCalls += 1;
            return { status: "cancelled", final_proof: { final_venue_execution_proven: false } };
          },
        }),
        (error) => {
          assert.match(error.message, /failed during entry_replay: durable replay unavailable/);
          assert.match(error.message, /recovery also reported: .*protection cleanup failed/);
          return true;
        },
      );
      assert.equal(executeCalls, 2);
      assert.equal(emergencyCalls, 1);
      assert.equal(cancelCalls, 2);
      assert.equal(positionSize, "0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a simulated no-submit result before broadcast", async () => {
    const fixture = await sealedFixture();
    const dir = mkdtempSync(join(tmpdir(), "ghola-mainnet-proof-preflight."));
    let submitted = false;
    try {
      await assert.rejects(
        runSealedHyperliquidMainnetRoundTrip({
          body: fixture.body,
          recipient: fixture.recipient,
          state: createWorkerState(dir),
          fetchImpl: async (_url, init) => {
            const request = JSON.parse(String(init.body));
            return request.type === "openOrders"
              ? Response.json([])
              : Response.json({ assetPositions: [] });
          },
          readSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true }),
          verifyOrder: async ({ instruction }) => ({
            ...verifiedNoSubmit(instruction),
            checks: { ...verifiedNoSubmit(instruction).checks, verification_simulated: true },
          }),
          buildProtection: async () => protectionPlan(),
          executeOrder: async () => {
            submitted = true;
            throw new Error("must not submit");
          },
        }),
        /no-submit preflight is incomplete/,
      );
      assert.equal(submitted, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never certifies a confirmed entry when protection cleanup lacks terminal proof", async () => {
    const fixture = await sealedFixture();
    const dir = mkdtempSync(join(tmpdir(), "ghola-mainnet-proof-cleanup."));
    const entryCloid = `0x${"a".repeat(32)}`;
    const children = hyperliquidProtectionCloids(entryCloid);
    const receipts = new Map();
    let positionSize = "0";
    let evidenceCalls = 0;
    let cancelCalls = 0;
    try {
      await assert.rejects(runSealedHyperliquidMainnetRoundTrip({
        body: fixture.body,
        recipient: fixture.recipient,
        state: createWorkerState(dir),
        fetchImpl: async (_url, init) => {
          const request = JSON.parse(String(init.body));
          if (request.type === "openOrders") return Response.json([]);
          return Response.json({
            assetPositions: positionSize === "0"
              ? []
              : [{ position: { coin: "HYPE", szi: positionSize, leverage: { type: "isolated", value: 1 } } }],
          });
        },
        readSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true }),
        verifyOrder: async ({ instruction }) => verifiedNoSubmit(instruction),
        buildProtection: async () => protectionPlan(),
        executeOrder: async ({ body }) => {
          const existing = receipts.get(body.work_order_commitment);
          if (existing) return structuredClone(existing);
          const entry = body.work_order_commitment.endsWith("_entry");
          positionSize = entry ? "0.18" : "0";
          const receipt = fundedReceipt({ entry, entryCloid, children });
          receipts.set(body.work_order_commitment, receipt);
          return structuredClone(receipt);
        },
        reconcile: async () => { throw new Error("must not reconcile an unsafe proof"); },
        submitEmergency: async () => { throw new Error("flat position must not rebroadcast"); },
        submitProtectionCancel: async () => {
          cancelCalls += 1;
          return { status: "cancelled", final_proof: { final_venue_execution_proven: false } };
        },
        verifyVenueEvidence: async () => {
          evidenceCalls += 1;
          return venueEvidence(children);
        },
      }), /protection cleanup failed/);
      assert.equal(cancelCalls, 4);
      assert.equal(evidenceCalls, 0);
      assert.equal(positionSize, "0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("independently proves filled order identities, public fills, and final-flat state", async () => {
    const account = `0x${"1".repeat(40)}`;
    const entryCloid = `0x${"a".repeat(32)}`;
    const exitCloid = `0x${"b".repeat(32)}`;
    const takeProfitCloid = `0x${"c".repeat(32)}`;
    const stopLossCloid = `0x${"d".repeat(32)}`;
    const requests = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init.body));
      requests.push(body.type);
      if (body.type === "orderStatus") {
        if (body.oid === takeProfitCloid || body.oid === stopLossCloid) {
          return Response.json({
            status: "order",
            order: {
              order: {
                coin: "HYPE",
                side: "A",
                oid: body.oid === takeProfitCloid ? 201 : 202,
                cloid: body.oid,
                reduceOnly: true,
                isTrigger: true,
              },
              status: body.oid === stopLossCloid ? "reduceOnlyCanceled" : "canceled",
            },
          });
        }
        const entry = body.oid === entryCloid;
        return Response.json({
          status: "order",
          order: {
            order: {
              coin: "HYPE",
              side: entry ? "B" : "A",
              oid: entry ? 101 : 102,
              cloid: body.oid,
              origSz: "0.18",
              tif: "Ioc",
              reduceOnly: !entry,
            },
            status: "filled",
          },
        });
      }
      if (body.type === "userFills") {
        return Response.json([
          fundedFill({ oid: 102, cloid: exitCloid, side: "A", dir: "Close Long", time: 2, hash: `0x${"d".repeat(64)}`, tid: 12, px: "58.32" }),
          fundedFill({ oid: 101, cloid: entryCloid, side: "B", dir: "Open Long", time: 1, hash: `0x${"c".repeat(64)}`, tid: 11, px: "58.31" }),
        ]);
      }
      if (body.type === "openOrders") return Response.json([]);
      return Response.json({ assetPositions: [] });
    };
    const evidence = await verifyHyperliquidMainnetVenueEvidence({
      baseUrl: "https://api.hyperliquid.xyz",
      accountAddress: account,
      market: "HYPE",
      entry: { oid: "101", cloid: entryCloid, filled_base_size: "0.18", average_fill_price: 58.31 },
      exit: { oid: "102", cloid: exitCloid, filled_base_size: "0.18", average_fill_price: 58.32 },
      protection: {
        take_profit: { oid: "201", cloid: takeProfitCloid },
        stop_loss: { oid: "202", cloid: stopLossCloid },
      },
      expectedNotionalUsd: 11,
      fetchImpl,
      attempts: 1,
    });

    assert.equal(evidence.independently_queried, true);
    assert.equal(evidence.entry.oid, "101");
    assert.equal(evidence.exit.reduce_only, true);
    assert.equal(evidence.entry.fee_usd, 0.0045);
    assert.equal(evidence.protection_children_terminal, true);
    assert.equal(evidence.protection.stop_loss.order_status, "canceled");
    assert.equal(evidence.protection.stop_loss.venue_order_status, "reduceOnlyCanceled");
    assert.equal(evidence.flat_after_exit, true);
    assert.deepEqual(requests.sort(), [
      "clearinghouseState",
      "openOrders",
      "orderStatus",
      "orderStatus",
      "orderStatus",
      "orderStatus",
      "userFills",
    ].sort());
  });
});

function verifiedNoSubmit(instruction = { expires_at: new Date(Date.now() + 90_000).toISOString() }) {
  return {
    status: "verified_no_funds",
    checks: {
      authority_derived: true,
      api_wallet_authorized: true,
      api_wallet_not_expired: true,
      api_wallet_address: `0x${"2".repeat(40)}`,
      api_wallet_valid_until_ms: Date.now() + 24 * 60 * 60_000,
      hyperliquid_sdk_ready: true,
      hyperliquid_api_reachable: true,
      account_read_checked: true,
      order_request_built: true,
      position_protection_checked: Boolean(instruction.position_protection),
      action_expiry_checked: true,
      expires_after_ms: Date.parse(instruction.expires_at),
      transaction_broadcast: false,
      verification_simulated: false,
    },
  };
}

function protectionPlan() {
  return {
    position_protection: {
      mode: "normal_tpsl",
      trigger_source: "mark",
      take_profit_trigger_price: "60",
      stop_loss_trigger_price: "55",
      max_slippage_bps: "100",
    },
    reference: { source: "test", modeled_max_loss_bps_before_gap_risk: 200 },
  };
}

function venueEvidence(protectionCloids = hyperliquidProtectionCloids(`0x${"a".repeat(32)}`)) {
  return {
    version: 1,
    proof_kind: "hyperliquid_mainnet_public_venue_evidence_v1",
    independently_queried: true,
    entry_exit_sizes_match: true,
    entry_before_exit: true,
    reduce_only_exit_proven: true,
    position_protection_proven: true,
    protection_children_terminal: true,
    protection: {
      take_profit: {
        oid: "201",
        cloid: protectionCloids.take_profit_cloid,
        order_status: "canceled",
        reduce_only: true,
        trigger_order: true,
      },
      stop_loss: {
        oid: "202",
        cloid: protectionCloids.stop_loss_cloid,
        order_status: "canceled",
        reduce_only: true,
        trigger_order: true,
      },
    },
    transaction_hashes_distinct: true,
    flat_after_exit: true,
    open_orders_after_exit: 0,
    entry: {
      oid: "101",
      cloid: `0x${"a".repeat(32)}`,
      reduce_only: false,
      transaction_hashes: [`0x${"c".repeat(64)}`],
    },
    exit: {
      oid: "102",
      cloid: `0x${"b".repeat(32)}`,
      reduce_only: true,
      transaction_hashes: [`0x${"d".repeat(64)}`],
    },
  };
}

function cancellationReceipt(cloid, oid, { broadcast = true } = {}) {
  return {
    status: "cancelled",
    final_proof: {
      broadcast_performed: broadcast,
      final_venue_execution_proven: true,
      cancellation_readback_proven: true,
      cancellation_terminal_status: "canceled",
      venue_order_oid: oid,
      venue_order_cloid: cloid,
      action_expiry_proven: true,
      final_no_broadcast_proven: !broadcast,
    },
  };
}

function fundedReceipt({ entry, entryCloid, children }) {
  return {
    version: 1,
    status: "filled",
    fill_summary: {
      fill_count: 1,
      filled_base_size: "0.18",
      filled_notional_usd: 11,
      average_fill_price: entry ? 58.31 : 58.32,
      fee_usd: 0.004,
    },
    final_proof: {
      broadcast_performed: true,
      final_venue_execution_proven: true,
      final_fill_proven: true,
      venue_order_readback_proven: true,
      venue_order_status: "filled",
      venue_order_oid: entry ? "101" : "102",
      venue_order_cloid: entry ? entryCloid : `0x${"b".repeat(32)}`,
      execution_configuration_proven: true,
      margin_mode: "isolated",
      leverage: 1,
      market_data_freshness_proven: true,
      market_slippage_bound_proven: true,
      action_expiry_proven: true,
      position_protection_proven: entry,
      take_profit_oid: entry ? "201" : null,
      stop_loss_oid: entry ? "202" : null,
      take_profit_cloid: entry ? children.take_profit_cloid : null,
      stop_loss_cloid: entry ? children.stop_loss_cloid : null,
    },
  };
}

function fundedFill({ oid, cloid, side, dir, time, hash, tid, px }) {
  return {
    coin: "HYPE",
    oid,
    cloid,
    side,
    dir,
    time,
    hash,
    tid,
    px,
    sz: "0.18",
    crossed: true,
    fee: "0.0045",
    feeToken: "USDC",
  };
}

async function sealedFixture() {
  const recipientSecret = x25519.utils.randomPrivateKey();
  const recipient = {
    recipient_id: "phala:cvm:mainnet-proof-test",
    x25519_pub_hex: bytesToHex(x25519.getPublicKey(recipientSecret)),
    x25519_secret_hex: bytesToHex(recipientSecret),
  };
  const senderSecret = ed25519.utils.randomPrivateKey();
  const aad = [
    "ghola/hyperliquid-execution-vault-v1",
    "account:private_account_test",
    `recipient:${recipient.recipient_id}`,
    "network:mainnet",
  ].join("|");
  const wire = await sealForTest({
    recipientId: recipient.recipient_id,
    recipientX25519: x25519.getPublicKey(recipientSecret),
    senderDid: didKeyFromVerifying(ed25519.getPublicKey(senderSecret)),
    associatedData: aad,
    plaintext: {
      version: 1,
      kind: "ghola_hyperliquid_execution_vault",
      network: "mainnet",
      hyperliquid_account_address: `0x${"1".repeat(40)}`,
      api_wallet_private_key: `0x${"2".repeat(64)}`,
      agent_name: "proof-test",
    },
    signBody: async (digest) => ed25519.sign(digest, senderSecret),
  });
  const body = {
    version: 1,
    confirmation: MAINNET_PROOF_CONFIRMATION,
    execution_mode: "byo_api_key",
    account_commitment: "private_account_test",
    vault_commitment: "vault_mainnet_proof_test",
    policy_commitment: "policy_mainnet_proof_test",
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(wire),
      recipient: recipient.recipient_id,
      aad,
    },
    market: "HYPE",
    notional_usd: 11,
    slippage_bps: 100,
  };
  assert.deepEqual(validateHyperliquidMainnetRoundTripRequest(body, recipient), []);
  return { body, recipient };
}
