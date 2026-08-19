import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeClaimedPrivateSubmission } from "../src/execution/private-execution.js";
import { createPostgresWorkerState } from "../src/state/private-state.js";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.PRIVATE_AGENT_TEST_POSTGRES_URL || "";
const fixture = new URL("../scripts/fixtures/postgres-claim-process.mjs", import.meta.url);

describe("live Postgres execution claims", { skip: !databaseUrl }, () => {
  it("admits one claimant across independent worker processes", async () => {
    const workOrder = unique("parallel");
    const digest = sha256(workOrder);
    const results = await Promise.all(Array.from({ length: 12 }, async () => {
      const { stdout } = await execFileAsync(process.execPath, [fixture.pathname, databaseUrl, workOrder, digest]);
      return JSON.parse(stdout);
    }));

    assert.equal(results.filter((result) => result.status === "claimed").length, 1);
    assert.equal(results.filter((result) => result.status === "reconcile_required").length, 11);
  });

  it("keeps a crash-left claim unresolved after a process restart", async () => {
    const workOrder = unique("crash");
    const digest = sha256(workOrder);
    const first = JSON.parse((await execFileAsync(process.execPath, [fixture.pathname, databaseUrl, workOrder, digest])).stdout);
    const restarted = JSON.parse((await execFileAsync(process.execPath, [fixture.pathname, databaseUrl, workOrder, digest])).stdout);

    assert.equal(first.status, "claimed");
    assert.equal(restarted.status, "reconcile_required");
  });

  it("replays a completed receipt without a duplicate submit after restart", async () => {
    const workOrder = unique("complete");
    const requestDigest = sha256(workOrder);
    const context = {
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
      execution_mode: "testnet",
      operation_class: "perp_limit_order",
      request_digest: requestDigest,
    };
    let submitCount = 0;
    const firstState = createPostgresWorkerState(databaseUrl, { driver: "pg" });
    const first = await executeClaimedPrivateSubmission({
      state: firstState,
      work_order_commitment: workOrder,
      claim_context: context,
      submit: async () => {
        submitCount += 1;
        return { status: "submitted", provider_ref_seed: { oid: workOrder }, result_seed: { accepted: true } };
      },
      evidence: async (result) => ({
        attempt: {
          status: result.status,
          provider_ref_seed: result.provider_ref_seed,
          execution_request_digest: requestDigest,
        },
        receipt: {
          status: result.status,
          provider_ref_commitment: `provider_${workOrder}`,
          execution_request_digest: requestDigest,
        },
      }),
    });
    await firstState.close();

    const restartedState = createPostgresWorkerState(databaseUrl, { driver: "pg" });
    const replay = await executeClaimedPrivateSubmission({
      state: restartedState,
      work_order_commitment: workOrder,
      claim_context: context,
      submit: async () => {
        submitCount += 1;
        throw new Error("duplicate submit");
      },
      evidence: async () => { throw new Error("duplicate evidence"); },
    });
    await restartedState.close();

    assert.equal(submitCount, 1);
    assert.deepEqual(replay, first);
  });

  it("atomically resolves a crash-left claim from exact terminal venue proof", async () => {
    const workOrder = unique("resolve");
    const requestDigest = sha256(workOrder);
    const context = {
      venue_id: "coinbase_advanced",
      platform_class: "coinbase_style_provider",
      execution_mode: "byo_api_key",
      operation_class: "spot_limit_order",
      request_digest: requestDigest,
    };
    const crashedState = createPostgresWorkerState(databaseUrl, { driver: "pg" });
    const claim = await crashedState.claimExecution(workOrder, context);
    assert.equal(claim.status, "claimed");
    await crashedState.close();

    const restartedState = createPostgresWorkerState(databaseUrl, { driver: "pg" });
    const receipt = {
      version: 1,
      venue_id: "coinbase_advanced",
      status: "filled",
      work_order_commitment: workOrder,
      execution_request_digest: requestDigest,
      final_proof: {
        final_venue_execution_proven: true,
        final_fill_proven: true,
        terminal_status: "filled",
        provider_order_id: `provider_${workOrder}`,
      },
    };
    const resolved = await restartedState.resolveExecutionClaim(workOrder, {
      attempt: {
        status: "filled",
        execution_request_digest: requestDigest,
        provider_ref_seed: { order_id: receipt.final_proof.provider_order_id },
      },
      receipt,
    });
    assert.deepEqual(resolved, receipt);
    await restartedState.close();

    const replayState = createPostgresWorkerState(databaseUrl, { driver: "pg" });
    const replay = await replayState.claimExecution(workOrder, context);
    await replayState.close();
    assert.equal(replay.status, "completed");
    assert.deepEqual(replay.receipt, receipt);
  });

  it("upgrades completed nonterminal evidence once and keeps the first terminal receipt immutable", async () => {
    const workOrder = unique("terminal_cas");
    const requestDigest = sha256(workOrder);
    const context = {
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
      execution_mode: "byo_api_key",
      operation_class: "limit_order",
      request_digest: requestDigest,
    };
    const initialState = createPostgresWorkerState(databaseUrl, { driver: "pg" });
    const claim = await initialState.claimExecution(workOrder, context);
    assert.equal(claim.status, "claimed");
    const submitted = {
      attempt: {
        status: "submitted",
        execution_request_digest: requestDigest,
      },
      receipt: {
        status: "submitted",
        execution_request_digest: requestDigest,
        final_proof: {
          final_venue_execution_proven: true,
          final_fill_proven: false,
          final_no_fill_proven: false,
          final_no_broadcast_proven: false,
        },
      },
    };
    await initialState.recordExecutionClaimEvidence(workOrder, claim.claim_token, submitted);
    assert.deepEqual(
      await initialState.completeExecutionClaim(workOrder, claim.claim_token, submitted),
      submitted.receipt,
    );
    await initialState.close();

    const filled = terminalCompletion(requestDigest, "filled");
    const noFill = terminalCompletion(requestDigest, "cancelled");
    const first = createPostgresWorkerState(databaseUrl, { driver: "pg" });
    const second = createPostgresWorkerState(databaseUrl, { driver: "pg" });
    const [firstResult, secondResult] = await Promise.all([
      first.resolveExecutionClaim(workOrder, filled),
      second.resolveExecutionClaim(workOrder, noFill),
    ]);
    assert.deepEqual(firstResult, secondResult);
    assert.ok([filled.receipt.status, noFill.receipt.status].includes(firstResult.status));

    const losingCompletion = firstResult.status === filled.receipt.status ? noFill : filled;
    assert.deepEqual(await first.resolveExecutionClaim(workOrder, losingCompletion), firstResult);
    assert.deepEqual((await second.getIdempotency(workOrder)).receipt, firstResult);
    assert.deepEqual((await second.getExecutionClaimEvidence(workOrder)).receipt, firstResult);
    await Promise.all([first.close(), second.close()]);
  });

  it("enforces first-use policy amounts as numbers", async () => {
    const state = createPostgresWorkerState(databaseUrl, { driver: "pg" });
    const key = unique("policy_amount");
    try {
      assert.deepEqual(await state.incrementPolicyAmount(key, 26, 100), { ok: true, amount: 26 });
      assert.deepEqual(await state.incrementPolicyAmount(key, 74, 100), { ok: true, amount: 100 });
      assert.deepEqual(await state.incrementPolicyAmount(key, 0.01, 100), { ok: false, amount: 100 });
    } finally {
      await state.close();
    }
  });
});

function unique(label) {
  return `postgres_${label}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function terminalCompletion(requestDigest, status) {
  const filled = status === "filled";
  const proof = {
    proof_kind: "hyperliquid_execution_proof_v1",
    venue_id: "hyperliquid",
    broadcast_performed: true,
    final_venue_execution_proven: true,
    final_fill_proven: filled,
    final_no_fill_proven: !filled,
    final_no_broadcast_proven: false,
    terminal_status: status,
  };
  return {
    attempt: { status, execution_request_digest: requestDigest, final_proof: proof },
    receipt: { status, execution_request_digest: requestDigest, final_proof: proof },
  };
}
