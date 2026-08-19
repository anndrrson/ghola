import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("expired crash-left Hyperliquid claim resolves exact unknownOid proof without any submit", async () => {
  const previousDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  const state = createWorkerState(mkdtempSync(join(tmpdir(), "ghola-hyperliquid-no-broadcast.")));
  const workOrderCommitment = "hyperliquid_crash_before_submit_work_order";
  const claimContext = {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "limit_order",
    request_digest: "8".repeat(64),
    market: "HYPE",
  };
  const expiresAt = "2026-08-19T12:00:00.000Z";
  const observedAt = [
    expiresAt,
    "2026-08-19T12:00:31.000Z",
  ];
  const reconciledCloids = [];
  let reconciliationCount = 0;
  let submitCount = 0;

  try {
    assert.equal((await state.claimExecution(workOrderCommitment, claimContext)).status, "claimed");

    const reconcile = () => reconcileHyperliquidClaim({
      body: {
        work_order_commitment: workOrderCommitment,
        execution_mode: "byo_api_key",
        encrypted_execution_instruction_bundle: "test-only-resolver",
        market: "HYPE",
      },
      recipient: {},
      state,
      resolveInstruction: async () => ({
        expires_at: expiresAt,
        order: { market: "HYPE" },
      }),
      reconcileExecution: async ({ cloid, market }) => {
        assert.equal(market, "HYPE");
        reconciledCloids.push(cloid);
        const checkedAt = observedAt[reconciliationCount];
        reconciliationCount += 1;
        return {
          terminal: false,
          status: "unknownOid",
          exact_unknown_oid: true,
          checked_at: checkedAt,
          venue_order_reference: null,
          fills: [],
          final_proof: null,
        };
      },
    });

    const pending = await reconcile();
    assert.equal(pending.status, "unknownOid");
    assert.equal((await state.getExecutionClaimEvidence(workOrderCommitment)).status, "in_progress");

    const terminal = await reconcile();
    assert.equal(terminal.status, "no_submit");
    assert.equal(terminal.final_proof.final_no_broadcast_proven, true);
    assert.equal(terminal.final_proof.broadcast_performed, false);
    assert.equal(reconciliationCount, 2);
    assert.equal(new Set(reconciledCloids).size, 1);
    assert.match(reconciledCloids[0], /^0x[0-9a-f]{32}$/);

    const evidence = await state.getExecutionClaimEvidence(workOrderCommitment);
    assert.equal(evidence.status, "completed");
    assert.equal(evidence.no_broadcast_probe.observation_count, 2);
    assert.equal(evidence.no_broadcast_probe.first_observed_at, observedAt[0]);
    assert.equal(evidence.no_broadcast_probe.last_observed_at, observedAt[1]);

    const terminalReplay = await reconcile();
    assert.equal(terminalReplay.result_commitment, terminal.result_commitment);
    assert.equal(reconciliationCount, 2);

    const claimReplay = await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: workOrderCommitment,
      claim_context: claimContext,
      submit: async () => {
        submitCount += 1;
        throw new Error("resolved claim must never rebroadcast");
      },
      evidence: async () => { throw new Error("resolved claim must replay receipt"); },
    });
    assert.equal(claimReplay.result_commitment, terminal.result_commitment);
    assert.equal(submitCount, 0);
  } finally {
    if (previousDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = previousDryRun;
  }
});

test("Hyperliquid reconciliation durably resolves native IOC no-fill status", async () => {
  const previousDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  const state = createWorkerState(mkdtempSync(join(tmpdir(), "ghola-hyperliquid-no-fill-reconcile.")));
  const workOrderCommitment = "hyperliquid_ioc_no_fill_work_order";
  const claimContext = {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "limit_order",
    request_digest: "9".repeat(64),
  };
  let submitCount = 0;
  try {
    await assert.rejects(executeClaimedPrivateSubmission({
      state,
      work_order_commitment: workOrderCommitment,
      claim_context: claimContext,
      submit: async () => {
        submitCount += 1;
        throw new Error("venue response was ambiguous after order call");
      },
      evidence: async () => { throw new Error("unreachable"); },
    }), /venue response was ambiguous/);

    const receipt = await reconcileHyperliquidClaim({
      body: {
        work_order_commitment: workOrderCommitment,
        execution_mode: "byo_api_key",
        market: "HYPE",
      },
      recipient: {},
      state,
      reconcileExecution: async ({ cloid }) => ({
        terminal: true,
        status: "rejected",
        venue_order_reference: "oid:518475952921",
        fills: [],
        final_proof: {
          version: 1,
          proof_kind: "hyperliquid_execution_proof_v1",
          venue_id: "hyperliquid",
          network: "mainnet",
          status: "iocCancelRejected",
          terminal_status: "iocCancelRejected",
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: false,
          final_no_fill_proven: true,
          venue_order_readback_proven: true,
          venue_order_status: "iocCancelRejected",
          venue_order_oid: "518475952921",
          venue_order_cloid: cloid,
        },
      }),
    });

    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.final_proof.final_no_fill_proven, true);
    assert.equal((await state.getExecutionClaimEvidence(workOrderCommitment)).status, "completed");
    const replay = await reconcileHyperliquidClaim({
      body: { work_order_commitment: workOrderCommitment },
      recipient: {},
      state,
      reconcileExecution: async () => { throw new Error("terminal no-fill must replay"); },
    });
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

test("Hyperliquid reconciliation upgrades a completed nonterminal receipt without rebroadcast", async () => {
  const previousDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  const state = createWorkerState(mkdtempSync(join(tmpdir(), "ghola-hyperliquid-completed-reconcile.")));
  const workOrderCommitment = "hyperliquid_completed_nonterminal_work_order";
  const claimContext = {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "limit_order",
    request_digest: "b".repeat(64),
  };
  let submitCount = 0;
  let reconcileCount = 0;

  try {
    const submitted = await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: workOrderCommitment,
      claim_context: claimContext,
      submit: async () => {
        submitCount += 1;
        return { status: "submitted" };
      },
      evidence: async () => ({
        attempt: {
          status: "submitted",
          provider_ref_seed: { cloid: "0x" + "1".repeat(32) },
          result_seed: { market: "BTC" },
        },
        receipt: {
          version: 1,
          platform_class: "hyperliquid_style_market",
          execution_mode: "byo_api_key",
          status: "submitted",
          work_order_commitment: workOrderCommitment,
          result_commitment: "nonterminal_result_commitment",
          final_proof: {
            proof_kind: "hyperliquid_execution_proof_v1",
            venue_id: "hyperliquid",
            final_venue_execution_proven: true,
            final_fill_proven: false,
            final_no_fill_proven: false,
          },
        },
      }),
    });
    assert.equal(submitted.status, "submitted");

    const reconciled = await reconcileHyperliquidClaim({
      body: {
        work_order_commitment: workOrderCommitment,
        execution_mode: "byo_api_key",
        market: "BTC",
      },
      recipient: {},
      state,
      reconcileExecution: async () => {
        reconcileCount += 1;
        return {
          terminal: true,
          status: "filled",
          venue_order_reference: "oid:88",
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
    assert.equal(reconciled.status, "filled");
    assert.equal(reconciled.fill_summary.fill_count, 1);
    assert.equal(submitCount, 1);
    assert.equal(reconcileCount, 1);

    const replay = await reconcileHyperliquidClaim({
      body: { work_order_commitment: workOrderCommitment },
      recipient: {},
      state,
      reconcileExecution: async () => {
        reconcileCount += 1;
        throw new Error("terminal receipt should be replayed");
      },
    });
    assert.equal(replay.result_commitment, reconciled.result_commitment);
    assert.equal(reconcileCount, 1);
  } finally {
    if (previousDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = previousDryRun;
  }
});

test("Hyperliquid reconciliation rejects cross-scope replay before terminal cache replay", async () => {
  const previousDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  const state = createWorkerState(mkdtempSync(join(tmpdir(), "ghola-hyperliquid-bound-reconcile.")));
  const workOrderCommitment = "live_trade_work_order_" + "1".repeat(48);
  const binding = {
    reconciliation_binding_version: 1,
    owner_commitment: "owner_commitment_bound",
    account_commitment: "account_commitment_bound",
    vault_commitment: "vault_commitment_bound",
    policy_commitment: "vault_policy_commitment_bound",
    order_policy_commitment: "order_policy_commitment_bound",
    plan_digest: `sha256:${"2".repeat(64)}`,
    request_commitment: "request_commitment_bound",
    market: "HYPE",
    original_request_digest: `sha256:${"3".repeat(64)}`,
    sealed_request_digest: createHash("sha256").update("{}").digest("hex"),
  };
  const claimContext = {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "limit_order",
    request_digest: "4".repeat(64),
    ...binding,
  };
  const reconcileBody = {
    version: 1,
    reconciliation_binding_version: 1,
    owner_commitment: binding.owner_commitment,
    account_commitment: binding.account_commitment,
    vault_commitment: binding.vault_commitment,
    policy_commitment: binding.policy_commitment,
    order_policy_commitment: binding.order_policy_commitment,
    plan_digest: binding.plan_digest,
    request_commitment: binding.request_commitment,
    original_request_digest: binding.original_request_digest,
    original_operation_class: "limit_order",
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "reconcile",
    work_order_commitment: workOrderCommitment,
    market: binding.market,
  };
  let reconcileCount = 0;
  try {
    await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: workOrderCommitment,
      claim_context: claimContext,
      submit: async () => ({ status: "submitted" }),
      evidence: async () => ({
        attempt: { status: "submitted", provider_ref_seed: {}, result_seed: { market: "HYPE" } },
        receipt: {
          version: 1,
          platform_class: "hyperliquid_style_market",
          execution_mode: "byo_api_key",
          status: "submitted",
          work_order_commitment: workOrderCommitment,
          result_commitment: "bound_nonterminal_result",
          final_proof: {
            proof_kind: "hyperliquid_execution_proof_v1",
            venue_id: "hyperliquid",
            final_venue_execution_proven: true,
            final_fill_proven: false,
            final_no_fill_proven: false,
          },
        },
      }),
    });
    const persisted = await state.getExecutionClaimEvidence(workOrderCommitment);
    assert.deepEqual(
      Object.fromEntries(Object.keys(binding).map((key) => [key, persisted.context[key]])),
      binding,
    );

    const reconcile = (body) => reconcileHyperliquidClaim({
      body,
      recipient: {},
      state,
      reconcileExecution: async () => {
        reconcileCount += 1;
        return {
          terminal: true,
          status: "filled",
          venue_order_reference: "oid:99",
          fills: [{ coin: "HYPE", px: "42", sz: "0.1", fee: "0.01", time: 1_786_800_000_000 }],
          final_proof: {
            version: 1,
            proof_kind: "hyperliquid_execution_proof_v1",
            venue_id: "hyperliquid",
            network: "mainnet",
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
    const terminal = await reconcile(reconcileBody);
    assert.equal(terminal.status, "filled");
    assert.equal(reconcileCount, 1);

    for (const field of [
      "owner_commitment",
      "venue_id",
      "platform_class",
      "execution_mode",
      "account_commitment",
      "vault_commitment",
      "policy_commitment",
      "order_policy_commitment",
      "plan_digest",
      "request_commitment",
      "market",
      "original_request_digest",
      "original_operation_class",
    ]) {
      await assert.rejects(reconcile({ ...reconcileBody, [field]: `${reconcileBody[field]}_cross_scope` }), (error) => {
        assert.equal(error.code, "EXECUTION_CLAIM_CONTEXT_MISMATCH");
        assert.equal(error.status, 409);
        return true;
      });
    }
    assert.equal(reconcileCount, 1);
  } finally {
    if (previousDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = previousDryRun;
  }
});
