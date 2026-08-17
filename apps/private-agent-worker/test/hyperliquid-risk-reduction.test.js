import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  closeSealedHyperliquidPosition,
  HYPERLIQUID_CLOSE_CONFIRMATION,
  killAndFlatHyperliquidSession,
} from "../src/execution/hyperliquid-risk-reduction.js";
import {
  controlAutopilotSession,
  resetAutopilotExecutionControlsForTests,
} from "../src/execution/autopilot.js";

describe("Hyperliquid risk reduction", () => {
  it("resolves the exact venue position and submits only a reduce-only bounded IOC", async () => {
    let positionSize = "0.25";
    const instructions = [];
    const report = await closeSealedHyperliquidPosition({
      body: closeBody(),
      recipient: { recipient_id: "recipient_close" },
      state: {},
      resolveCredential: async () => ({ network: "mainnet" }),
      readState: async () => ({
        positions: positionSize === "0" ? [] : [{ market: "HYPE", position_size: positionSize, position_value: "10.5" }],
        open_orders: [],
        checked_at: new Date().toISOString(),
      }),
      executeRiskReduction: async ({ instruction }) => {
        instructions.push(instruction);
        positionSize = "0";
        return filledReceipt("101", "0x11111111111111111111111111111111");
      },
      sleep: async () => {},
    });

    assert.equal(instructions.length, 1);
    assert.deepEqual(instructions[0].order, {
      market: "HYPE",
      side: "sell",
      base_size: "0.25",
      size_mode: "base",
      order_type: "market",
      tif: "Ioc",
      post_only: false,
      reduce_only: true,
      max_slippage_bps: "50",
      live_order_mode: "tiny_fill",
      margin_mode: "isolated",
      leverage: 1,
    });
    assert.equal(report.market_flat, true);
    assert.equal(report.final_flat_proven, true);
    assert.equal(report.closes[0].venue_order_oid, "101");
    assert.equal(report.closes[0].fill_count_bucket, "1");
    assert.match(report.closes[0].fill_evidence_commitment, /^hl_fill_evidence_[0-9a-f]{64}$/u);
    assert.equal("fill_summary" in report.closes[0], false);
    assert.equal(JSON.stringify(report).includes("filled_base_size"), false);
  });

  it("cancels every observed order before reduce-only closes and proves final-flat", async () => {
    let positions = [{ market: "HYPE", position_size: "-0.25", position_value: "10.5" }];
    let orders = [{ market: "HYPE", oid: "202", cloid: null }];
    const sequence = [];
    const session = {
      autopilot_session_id: "autopilot_kill_flat",
      owner_commitment: "owner_kill_flat",
      control_epoch: 3,
      session_policy: {
        execution_network: "mainnet",
        market_allowlist: ["HYPE-USD"],
        max_slippage_bps: 50,
        policy_commitment: "policy_kill_flat",
      },
      venue_access: {
        hyperliquid: {
          status: "ready",
          account_commitment: "account_kill_flat",
          execution_mode: "byo_api_key",
          vault_commitment: "vault_kill_flat",
          encrypted_execution_vault: { recipient: "recipient_kill_flat" },
        },
      },
    };
    const report = await killAndFlatHyperliquidSession({
      session,
      recipient: { recipient_id: "recipient_kill_flat" },
      state: {},
      resolveCredential: async () => ({ network: "mainnet" }),
      readState: async () => ({ positions, open_orders: orders, checked_at: new Date().toISOString() }),
      executeRiskReduction: async ({ instruction }) => {
        sequence.push(instruction.operation_class);
        if (instruction.operation_class === "cancel") {
          orders = [];
          return cancelledReceipt("202");
        }
        assert.equal(orders.length, 0, "close must happen after cancellation readback");
        assert.equal(instruction.order.side, "buy");
        assert.equal(instruction.order.reduce_only, true);
        positions = [];
        return filledReceipt("303", "0x22222222222222222222222222222222");
      },
      sleep: async () => {},
    });

    assert.deepEqual(sequence, ["cancel", "limit_order"]);
    assert.equal(report.cancellations_terminal, true);
    assert.equal(report.reduce_only_exit_proven, true);
    assert.equal(report.account_flat, true);
    assert.equal(report.open_order_count, 0);
    assert.equal(report.final_flat_proven, true);
    assert.match(report.evidence_commitment, /^hl_risk_evidence_[0-9a-f]{64}$/u);
  });

  it("latches execution off before kill-and-flat and durably acknowledges venue evidence", async () => {
    const { state, events, session } = controlState();
    const result = await controlAutopilotSession({
      sessionId: session.autopilot_session_id,
      action: "kill_and_flat",
      state,
      recipient: { recipient_id: "recipient_control" },
      killAndFlat: async ({ session: latched }) => {
        assert.equal(latched.execution_enabled, false);
        assert.equal(latched.control_latch.action, "kill_and_flat");
        return flatEvidence();
      },
    });

    assert.equal(result.session.status, "killed");
    assert.equal(result.session.execution_enabled, false);
    assert.equal(result.session.control_latch, null);
    assert.equal(result.session.final_flat_evidence.final_flat_proven, true);
    assert.equal(events.some((event) => event.type === "venue_reconcile" && event.data.final_flat_proven === true), true);
    assert.equal(result.event.data.evidence_commitment, "hl_risk_evidence_control");
    resetAutopilotExecutionControlsForTests();
  });

  it("keeps execution disabled and refuses acknowledgement when final-flat proof fails", async () => {
    const { state, events, session } = controlState();
    await assert.rejects(() => controlAutopilotSession({
      sessionId: session.autopilot_session_id,
      action: "kill_and_flat",
      state,
      recipient: { recipient_id: "recipient_control" },
      killAndFlat: async () => {
        const error = new Error("venue final state unavailable");
        error.code = "final_state_unavailable";
        throw error;
      },
    }), /venue final state unavailable/u);

    const stored = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(stored.status, "risk_halted");
    assert.equal(stored.execution_enabled, false);
    assert.equal(stored.control_latch.action, "kill_and_flat");
    assert.equal(events.some((event) => event.type === "risk_reject" && event.data.final_flat_proven === false), true);

    const retry = await controlAutopilotSession({
      sessionId: session.autopilot_session_id,
      action: "kill_and_flat",
      state,
      recipient: { recipient_id: "recipient_control" },
      killAndFlat: async ({ session: retrySession }) => {
        assert.equal(retrySession.execution_enabled, false);
        assert.equal(retrySession.status, "risk_halted");
        assert.equal(retrySession.control_epoch, stored.control_epoch + 1);
        return flatEvidence();
      },
    });
    assert.equal(retry.session.status, "killed");
    assert.equal(retry.session.execution_enabled, false);
    assert.equal(retry.session.control_epoch, stored.control_epoch + 1);
    resetAutopilotExecutionControlsForTests();
  });

  it("uses fresh replay-protected work orders when a partial-fill kill-and-flat is retried", async () => {
    let positions = [{ market: "HYPE", position_size: "0.25", position_value: "10.5" }];
    const workOrders = [];
    const session = killFlatSession();
    const run = (controlEpoch) => killAndFlatHyperliquidSession({
      session: { ...session, control_epoch: controlEpoch },
      recipient: { recipient_id: "recipient_kill_flat" },
      state: {},
      resolveCredential: async () => ({ network: "mainnet" }),
      readState: async () => ({ positions, open_orders: [], checked_at: new Date().toISOString() }),
      executeRiskReduction: async ({ body }) => {
        workOrders.push(body.work_order_commitment);
        positions = controlEpoch === 1
          ? [{ market: "HYPE", position_size: "0.10", position_value: "4.2" }]
          : [];
        return filledReceipt(String(400 + workOrders.length), `0x${String(workOrders.length).padStart(32, "0")}`);
      },
      sleep: async () => {},
    });

    await assert.rejects(() => run(1), /remains open/u);
    const firstAttemptOrders = [...workOrders];
    assert.equal(firstAttemptOrders.length, 3);

    const report = await run(2);
    const retryOrders = workOrders.slice(firstAttemptOrders.length);
    assert.equal(report.final_flat_proven, true);
    assert.equal(retryOrders.length, 1);
    assert.equal(firstAttemptOrders.some((workOrder) => retryOrders.includes(workOrder)), false);
    assert.notEqual(report.root_work_order_commitment, firstAttemptOrders[0].split("_close_")[0]);
  });
});

function closeBody() {
  return {
    version: 1,
    confirmation: HYPERLIQUID_CLOSE_CONFIRMATION,
    idempotency_key: "close_hype_0001",
    execution_mode: "byo_api_key",
    owner_commitment: "owner_close",
    account_commitment: "account_close",
    vault_commitment: "vault_close",
    policy_commitment: "policy_close",
    market: "HYPE",
    encrypted_execution_vault: { recipient: "recipient_close" },
    session_policy: {
      execution_network: "mainnet",
      market_allowlist: ["HYPE-USD"],
      max_slippage_bps: 50,
      policy_commitment: "policy_close",
    },
  };
}

function filledReceipt(oid, cloid) {
  return {
    status: "filled",
    fill_summary: { fill_count: 1, filled_base_size: "0.25", filled_notional_usd: 10.5 },
    final_proof: {
      broadcast_performed: true,
      final_venue_execution_proven: true,
      final_fill_proven: true,
      venue_order_readback_proven: true,
      market_data_freshness_proven: true,
      market_slippage_bound_proven: true,
      action_expiry_proven: true,
      venue_order_oid: oid,
      venue_order_cloid: cloid,
    },
  };
}

function cancelledReceipt(oid) {
  return {
    status: "cancelled",
    final_proof: {
      final_venue_execution_proven: true,
      cancellation_readback_proven: true,
      cancellation_terminal_status: "canceled",
      action_expiry_proven: true,
      venue_order_oid: oid,
    },
  };
}

function controlState() {
  const events = [];
  let session = {
    version: 2,
    autopilot_session_id: "autopilot_control_kill_flat",
    owner_commitment: "owner_control",
    status: "running",
    execution_enabled: true,
    control_epoch: 0,
    control_latch: null,
    session_policy: {
      venue_allowlist: ["hyperliquid"],
      market_allowlist: ["HYPE-USD"],
      max_slippage_bps: 50,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    venue_access: { hyperliquid: { status: "ready" } },
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const state = {
    getAutopilotSession: async () => structuredClone(session),
    putAutopilotSession: async (next) => {
      session = structuredClone(next);
      return structuredClone(session);
    },
    appendAutopilotEvent: async (_sessionId, event) => {
      events.push(structuredClone(event));
      return event;
    },
  };
  return { state, events, session };
}

function killFlatSession() {
  return {
    autopilot_session_id: "autopilot_retry_kill_flat",
    owner_commitment: "owner_kill_flat",
    session_policy: {
      execution_network: "mainnet",
      market_allowlist: ["HYPE-USD"],
      max_slippage_bps: 50,
      policy_commitment: "policy_kill_flat",
    },
    venue_access: {
      hyperliquid: {
        status: "ready",
        account_commitment: "account_kill_flat",
        execution_mode: "byo_api_key",
        vault_commitment: "vault_kill_flat",
        encrypted_execution_vault: { recipient: "recipient_kill_flat" },
      },
    },
  };
}

function flatEvidence() {
  return {
    cancellations: [{ terminal_status: "canceled" }],
    closes: [{ reduce_only: true }],
    root_work_order_commitment: "hl_kill_flat_control",
    evidence_commitment: "hl_risk_evidence_control",
    final_flat_proven: true,
    reconciled_at: new Date().toISOString(),
  };
}
