import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executeClaimedPrivateSubmission,
  executeHyperliquidBoundInstruction,
  reconcileHyperliquidClaim,
} from "../src/execution/private-execution.js";
import { createWorkerState } from "../src/state/private-state.js";

test("Hyperliquid reconciliation resolves an unknown submit by deterministic cloid without rebroadcast", async () => {
  const previousDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  const state = createWorkerState(mkdtempSync(join(tmpdir(), "ghola-hyperliquid-reconcile.")));
  const workOrderCommitment = "hyperliquid_unknown_submit_work_order";
  const claimContext = {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "limit_order",
    request_digest: "a".repeat(64),
  };
  let submitCount = 0;
  const execute = () => executeClaimedPrivateSubmission({
    state,
    work_order_commitment: workOrderCommitment,
    claim_context: claimContext,
    submit: async () => {
      submitCount += 1;
      throw new Error("transport closed after venue broadcast");
    },
    evidence: async () => {
      throw new Error("unreachable");
    },
  });

  try {
    await assert.rejects(execute(), /transport closed after venue broadcast/);
    assert.equal((await state.getExecutionClaimEvidence(workOrderCommitment)).status, "reconcile_required");

    let reconciledCloid = null;
    const receipt = await reconcileHyperliquidClaim({
      body: {
        work_order_commitment: workOrderCommitment,
        execution_mode: "byo_api_key",
        market: "BTC",
      },
      recipient: {},
      state,
      reconcileExecution: async ({ cloid, market }) => {
        reconciledCloid = cloid;
        assert.equal(market, "BTC");
        return {
          terminal: true,
          status: "filled",
          venue_order_reference: "oid:77",
          fills: [{ coin: "BTC", px: "63000", sz: "0.001", fee: "0.01", time: 1_786_800_000_000 }],
          final_proof: {
            version: 1,
            proof_kind: "hyperliquid_execution_proof_v1",
            venue_id: "hyperliquid",
            network: "testnet",
            status: "filled",
            terminal_status: "filled",
            broadcast_performed: true,
            final_venue_execution_proven: true,
            final_fill_proven: true,
            final_no_fill_proven: false,
          },
        };
      },
    });

    assert.match(reconciledCloid, /^0x[0-9a-f]{32}$/);
    assert.equal(receipt.status, "filled");
    assert.equal(receipt.fill_summary.fill_count, 1);
    assert.equal((await state.getIdempotency(workOrderCommitment)).receipt.result_commitment, receipt.result_commitment);

    const replay = await execute();
    assert.equal(replay.result_commitment, receipt.result_commitment);
    assert.equal(submitCount, 1);
  } finally {
    if (previousDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = previousDryRun;
  }
});

test("bound Hyperliquid execution reconciles an ambiguous submit before returning", async () => {
  let submitCount = 0;
  let reconcileCount = 0;
  const receipt = await executeHyperliquidBoundInstruction({
    body: { work_order_commitment: "bound_reconcile" },
    instruction: { version: 1, operation_class: "limit_order", order: { market: "HYPE" } },
    recipient: {},
    state: {},
    executeOrder: async () => {
      submitCount += 1;
      throw new Error("transport timeout after broadcast");
    },
    reconcileClaim: async () => {
      reconcileCount += 1;
      return {
        status: "filled",
        final_proof: {
          final_venue_execution_proven: true,
          final_fill_proven: true,
        },
      };
    },
  });
  assert.equal(receipt.status, "filled");
  assert.equal(submitCount, 1);
  assert.equal(reconcileCount, 1);
});
