import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeClaimedPrivateSubmission,
  reconcileStoredExecution,
} from "../src/execution/private-execution.js";
import {
  createSqliteWorkerState,
  createWorkerState,
  createWorkerStateAdapter,
} from "../src/state/private-state.js";

const TEMP_DIRS = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable private execution claims", () => {
  it("lets exactly one parallel caller submit a work order", async () => {
    const state = createWorkerState(tempDir());
    let submitCount = 0;
    let policyCountMutations = 0;
    let policyAmountMutations = 0;
    let reservationMutations = 0;
    let releaseSubmit;
    const submitGate = new Promise((resolve) => { releaseSubmit = resolve; });
    const execute = () => executeClaimedPrivateSubmission({
      state,
      work_order_commitment: "parallel_work_order",
      claim_context: claimContext("hyperliquid"),
      prepare: async () => {
        policyCountMutations += 1;
        await state.incrementPolicyCount("parallel_policy", 10);
        policyAmountMutations += 1;
        await state.incrementPolicyAmount("parallel_policy", 5, 100);
        await state.putOmnibusAllocation({ allocation_commitment: "parallel_allocation" });
        reservationMutations += 1;
        await state.reserveOmnibus({
          allocation_commitment: "parallel_allocation",
          work_order_commitment: "parallel_work_order",
          notional_bucket: "5",
        });
      },
      submit: async () => {
        submitCount += 1;
        await submitGate;
        return adapterResult("parallel");
      },
      evidence: finalize,
    });

    const first = execute();
    const second = execute();
    const completion = Promise.allSettled([first, second]);
    await waitFor(() => submitCount === 1);
    releaseSubmit();
    const settled = await completion;

    assert.equal(submitCount, 1);
    assert.equal(policyCountMutations, 1);
    assert.equal(policyAmountMutations, 1);
    assert.equal(reservationMutations, 1);
    assert.equal((await state.incrementPolicyCount("parallel_policy", 10)).count, 2);
    assert.equal((await state.incrementPolicyAmount("parallel_policy", 5, 100)).amount, 10);
    const omnibus = await state.getOmnibusAllocation("parallel_allocation");
    assert.deepEqual(Object.keys(omnibus.reservations), ["parallel_work_order"]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = settled.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.status, 409);
    assert.equal(rejected.reason.code, "EXECUTION_CLAIM_RECONCILE_REQUIRED");
    assert.equal(rejected.reason.message, "execution claim is unresolved; reconciliation required");
  });

  it("persists owner-only pre-submit rejection without an ambiguous claim", async () => {
    const state = createWorkerState(tempDir());
    let prepareCount = 0;
    let submitCount = 0;
    const execute = () => executeClaimedPrivateSubmission({
      state,
      work_order_commitment: "rejected_work_order",
      claim_context: claimContext("coinbase_advanced"),
      prepare: async () => {
        prepareCount += 1;
        const error = new Error("session policy order count exceeded");
        error.name = "ExecutionPolicyError";
        error.status = 429;
        throw error;
      },
      submit: async () => {
        submitCount += 1;
        return adapterResult("must_not_run");
      },
      evidence: finalize,
    });

    await assert.rejects(execute(), (error) => error.status === 429);
    await assert.rejects(
      execute(),
      (error) => error.status === 429 && error.code === "ExecutionPolicyError",
    );
    assert.equal(prepareCount, 1);
    assert.equal(submitCount, 0);
    assert.equal(await state.getExecutionAttempt("rejected_work_order"), null);
  });

  it("fails closed after a crash leaves an in-progress claim", async () => {
    const dir = tempDir();
    const beforeCrash = createWorkerState(dir);
    const claimed = await beforeCrash.claimExecution(
      "crashed_work_order",
      claimContext("coinbase_advanced"),
    );
    assert.equal(claimed.status, "claimed");
    const state = createWorkerState(dir);
    let submitCount = 0;

    await assert.rejects(
      executeClaimedPrivateSubmission({
        state,
        work_order_commitment: "crashed_work_order",
        claim_context: claimContext("coinbase_advanced"),
        submit: async () => {
          submitCount += 1;
          return adapterResult("must_not_run");
        },
        evidence: finalize,
      }),
      (error) => error.status === 409 && /reconciliation required/.test(error.message),
    );
    assert.equal(submitCount, 0);
  });

  it("keeps a connector error reconcile-required and never retries it", async () => {
    const state = createWorkerState(tempDir());
    let submitCount = 0;
    const execute = () => executeClaimedPrivateSubmission({
      state,
      work_order_commitment: "ambiguous_work_order",
      claim_context: claimContext("jupiter"),
      submit: async () => {
        submitCount += 1;
        throw new Error("connector outcome unknown");
      },
      evidence: finalize,
    });

    await assert.rejects(execute(), /connector outcome unknown/);
    await assert.rejects(execute(), (error) => error.status === 409);
    assert.equal(submitCount, 1);
    assert.equal((await state.getExecutionAttempt("ambiguous_work_order")).status, "reconcile_required");
  });

  it("persists exact connector evidence before fallible finalization", async () => {
    const state = createWorkerState(tempDir());
    const context = claimContext("coinbase_advanced");
    const exactEvidence = confirmedEvidence("finalize_failure");
    let submitCount = 0;
    let durableBeforeFinalize = false;
    const execute = () => executeClaimedPrivateSubmission({
      state,
      work_order_commitment: "finalize_failure_work_order",
      claim_context: context,
      submit: async () => {
        submitCount += 1;
        return adapterResult("finalize_failure");
      },
      evidence: async () => structuredClone(exactEvidence),
      finalize: async () => {
        const stored = await state.getExecutionClaimEvidence("finalize_failure_work_order");
        durableBeforeFinalize = stored?.status === "in_progress" &&
          stored.receipt?.provider_receipt === exactEvidence.receipt.provider_receipt;
        throw new Error("accounting failed after submit");
      },
    });

    await assert.rejects(execute(), /accounting failed after submit/);
    await assert.rejects(execute(), (error) => error.status === 409);
    assert.equal(submitCount, 1);
    assert.equal(durableBeforeFinalize, true);
    assert.equal(await state.getIdempotency("finalize_failure_work_order"), null);

    const stored = await state.getExecutionClaimEvidence("finalize_failure_work_order");
    const expectedReceipt = {
      ...exactEvidence.receipt,
      execution_request_digest: context.request_digest,
    };
    assert.equal(stored.status, "reconcile_required");
    assert.deepEqual(stored.receipt, expectedReceipt);
    assert.deepEqual(stored.attempt.provider_ref_seed, exactEvidence.attempt.provider_ref_seed);
    assert.deepEqual(stored.attempt.result_seed, exactEvidence.attempt.result_seed);
    assert.deepEqual(stored.attempt.final_proof, exactEvidence.attempt.final_proof);
    assert.equal(stored.attempt.reconciliation_failure.error_message, "accounting failed after submit");

    const reconciled = await reconcileStoredExecution({
      body: { work_order_commitment: "finalize_failure_work_order" },
      state,
      venue_id: "coinbase_advanced",
      platform_class: "coinbase_style_provider",
    });
    assert.deepEqual(reconciled, expectedReceipt);
  });

  it("retains submitted evidence when claim completion fails", async () => {
    const durableState = createWorkerState(tempDir());
    const context = claimContext("hyperliquid");
    const exactEvidence = confirmedEvidence("completion_failure");
    let completionCount = 0;
    const state = {
      ...durableState,
      async completeExecutionClaim() {
        completionCount += 1;
        throw new Error("completion write failed after submit");
      },
    };

    await assert.rejects(
      executeClaimedPrivateSubmission({
        state,
        work_order_commitment: "completion_failure_work_order",
        claim_context: context,
        submit: async () => adapterResult("completion_failure"),
        evidence: async () => structuredClone(exactEvidence),
      }),
      /completion write failed after submit/,
    );

    assert.equal(completionCount, 1);
    assert.equal(await state.getIdempotency("completion_failure_work_order"), null);
    const stored = await state.getExecutionClaimEvidence("completion_failure_work_order");
    const expectedReceipt = {
      ...exactEvidence.receipt,
      execution_request_digest: context.request_digest,
    };
    assert.equal(stored.status, "reconcile_required");
    assert.deepEqual(stored.receipt, expectedReceipt);
    assert.deepEqual(stored.attempt.provider_ref_seed, exactEvidence.attempt.provider_ref_seed);
    assert.deepEqual(stored.attempt.final_proof, exactEvidence.attempt.final_proof);
    assert.deepEqual(await reconcileStoredExecution({
      body: { work_order_commitment: "completion_failure_work_order" },
      state,
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
    }), expectedReceipt);
  });

  it("replays a completed receipt without calling the connector", async () => {
    const state = createWorkerState(tempDir());
    let submitCount = 0;
    const execute = () => executeClaimedPrivateSubmission({
      state,
      work_order_commitment: "completed_work_order",
      claim_context: claimContext("phoenix"),
      submit: async () => {
        submitCount += 1;
        return adapterResult("completed");
      },
      evidence: finalize,
    });

    const first = await execute();
    const second = await execute();
    assert.deepEqual(second, first);
    assert.equal(submitCount, 1);
    assert.equal((await state.getExecutionAttempt("completed_work_order")).status, "submitted");
  });

  it("rejects a completed work order replay with a different request digest", async () => {
    const state = createWorkerState(tempDir());
    let submitCount = 0;
    const execute = (context) => executeClaimedPrivateSubmission({
      state,
      work_order_commitment: "bound_completed_work_order",
      claim_context: context,
      submit: async () => {
        submitCount += 1;
        return adapterResult("bound_completed");
      },
      evidence: finalize,
    });

    await execute(claimContext("phoenix", "place_order", "first request"));
    await assert.rejects(
      execute(claimContext("phoenix", "place_order", "different request")),
      (error) => error.status === 409 && error.code === "EXECUTION_CLAIM_CONTEXT_MISMATCH",
    );
    assert.equal(submitCount, 1);
  });

  it("does not replay a rejection for a different request digest", async () => {
    const state = createWorkerState(tempDir());
    let prepareCount = 0;
    const execute = (context) => executeClaimedPrivateSubmission({
      state,
      work_order_commitment: "bound_rejected_work_order",
      claim_context: context,
      prepare: async () => {
        prepareCount += 1;
        throw Object.assign(new Error("request rejected"), { status: 429 });
      },
      submit: async () => adapterResult("must_not_run"),
      evidence: finalize,
    });

    await assert.rejects(execute(claimContext("jupiter", "swap", "first request")), /request rejected/);
    await assert.rejects(
      execute(claimContext("jupiter", "swap", "different request")),
      (error) => error.status === 409 && error.code === "EXECUTION_CLAIM_CONTEXT_MISMATCH",
    );
    assert.equal(prepareCount, 1);
  });

  it("does not treat a reconcile-required attempt as broadcast proof", async () => {
    const state = createWorkerState(tempDir());
    await assert.rejects(
      executeClaimedPrivateSubmission({
        state,
        work_order_commitment: "unproven_reconcile_work_order",
        claim_context: claimContext("jupiter"),
        submit: async () => {
          throw new Error("connector outcome unknown");
        },
        evidence: finalize,
      }),
      /connector outcome unknown/,
    );

    const receipt = await reconcileStoredExecution({
      body: {
        work_order_commitment: "unproven_reconcile_work_order",
        execution_mode: "user_stealth",
      },
      state,
      venue_id: "jupiter",
      platform_class: "solana_swap_aggregator",
    });
    assert.equal(receipt.status, "reconcile_required");
    assert.equal(receipt.final_proof.broadcast_performed, false);
    assert.equal(receipt.final_proof.final_venue_execution_proven, false);
    assert.equal(receipt.final_proof.final_fill_proven, false);
  });

  it("returns the durable completed receipt unchanged during reconciliation", async () => {
    const state = createWorkerState(tempDir());
    const completed = await executeClaimedPrivateSubmission({
      state,
      work_order_commitment: "cached_reconcile_work_order",
      claim_context: claimContext("phoenix"),
      submit: async () => adapterResult("cached_reconcile"),
      evidence: finalize,
    });
    const reconciled = await reconcileStoredExecution({
      body: { work_order_commitment: "cached_reconcile_work_order" },
      state,
      venue_id: "phoenix",
      platform_class: "solana_perps_market",
    });
    assert.deepEqual(reconciled, completed);
  });

  it("atomically resolves a crash-left claim from exact terminal venue proof", async () => {
    for (const state of [
      createWorkerState(tempDir()),
      createSqliteWorkerState(join(tempDir(), "resolved-worker-state.sqlite")),
    ]) {
      const context = claimContext("coinbase_advanced", "spot_limit_order", "terminal resolution");
      const claimed = await state.claimExecution("resolved_work_order", context);
      assert.equal(claimed.status, "claimed");
      const proof = {
        proof_kind: "coinbase_order_state_v1",
        broadcast_performed: true,
        final_venue_execution_proven: true,
        final_fill_proven: true,
        terminal_status: "filled",
      };
      const completed = {
        attempt: {
          status: "filled",
          execution_request_digest: context.request_digest,
          final_proof: proof,
        },
        receipt: {
          status: "filled",
          execution_request_digest: context.request_digest,
          final_proof: proof,
        },
      };
      assert.deepEqual(
        await state.resolveExecutionClaim("resolved_work_order", completed),
        completed.receipt,
      );
      assert.deepEqual(
        (await state.getIdempotency("resolved_work_order")).receipt,
        completed.receipt,
      );
      assert.deepEqual(
        await state.resolveExecutionClaim("resolved_work_order", completed),
        completed.receipt,
      );
    }
  });

  it("serializes JSON claims across adapters sharing a path", async () => {
    let document = {};
    const path = join(tempDir(), "shared-memory-state.json");
    const options = {
      path,
      hmacSecret: "11".repeat(32),
      async load() {
        await delay(2);
        return structuredClone(document);
      },
      async save(next) {
        await delay(2);
        document = structuredClone(next);
      },
    };
    const first = createWorkerStateAdapter(options);
    const second = createWorkerStateAdapter(options);

    const claims = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 === 0 ? first : second).claimExecution("shared_work_order", claimContext("jupiter"))),
    );
    assert.equal(claims.filter((claim) => claim.status === "claimed").length, 1);
    assert.equal(claims.filter((claim) => claim.status === "reconcile_required").length, 23);
  });

  it("claims atomically across SQLite adapters", async () => {
    const dbPath = join(tempDir(), "worker-state.sqlite");
    const first = createSqliteWorkerState(dbPath);
    const second = createSqliteWorkerState(dbPath);
    const claims = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 === 0 ? first : second).claimExecution("sqlite_work_order", claimContext("hyperliquid"))),
    );

    assert.equal(claims.filter((claim) => claim.status === "claimed").length, 1);
    assert.equal(claims.filter((claim) => claim.status === "reconcile_required").length, 23);
  });

  it("routes all four submit functions through claims and leaves verification claim-free", () => {
    const sourcePath = fileURLToPath(new URL("../src/execution/private-execution.js", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");
    for (const name of [
      "executeHyperliquidOrder",
      "executeCoinbaseOrder",
      "executeSolanaPerpsOrder",
      "executeJupiterSwapOrder",
    ]) {
      const implementation = functionSource(source, name);
      assert.match(implementation, /boundCachedExecutionReceipt\(/);
      assert.doesNotMatch(implementation, /if \(cached\?\.receipt\) return cached\.receipt/);
      const claimIndex = implementation.indexOf("executeClaimedPrivateSubmission(");
      assert.notEqual(claimIndex, -1);
      const firstPolicyIndex = implementation.indexOf("enforceInstructionPolicy(");
      const lastPolicyIndex = implementation.lastIndexOf("enforceInstructionPolicy(");
      assert.ok(firstPolicyIndex < claimIndex);
      assert.ok(claimIndex < lastPolicyIndex);
    }
    const coinbase = functionSource(source, "executeCoinbaseOrder");
    assert.ok(coinbase.indexOf("executeClaimedPrivateSubmission(") < coinbase.indexOf("reserveOmnibus("));
    for (const name of [
      "verifyHyperliquidOrderNoSubmit",
      "verifyCoinbaseOrderNoSubmit",
      "verifySolanaPerpsOrderNoSubmit",
      "verifyJupiterSwapNoSubmit",
    ]) {
      assert.doesNotMatch(functionSource(source, name), /claimExecution|executeClaimedPrivateSubmission/);
    }
  });

  it("uses an insert-on-conflict ownership primitive for Postgres claims", () => {
    const sourcePath = fileURLToPath(new URL("../src/state/private-state.js", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");
    assert.match(
      source,
      /INSERT INTO worker_execution_claims[\s\S]*?ON CONFLICT \(work_order_commitment\) DO NOTHING[\s\S]*?RETURNING claim_json/,
    );
  });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "ghola-execution-claim-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function claimContext(venueId, operationClass = "place_order", requestSeed = null) {
  return {
    venue_id: venueId,
    platform_class: "test_venue",
    execution_mode: "dry_run",
    operation_class: operationClass,
    request_digest: createHash("sha256")
      .update(String(requestSeed || `${venueId}:${operationClass}`))
      .digest("hex"),
  };
}

function adapterResult(seed) {
  return {
    status: "submitted",
    provider_ref_seed: { seed },
    result_seed: { seed },
    fills: [],
    final_proof: null,
  };
}

function confirmedEvidence(seed) {
  const finalProof = {
    proof_kind: "provider_receipt_v1",
    broadcast_performed: true,
    final_venue_execution_proven: true,
    final_fill_proven: false,
  };
  return {
    attempt: {
      status: "submitted",
      provider_ref_seed: { order_id: `provider_${seed}` },
      result_seed: { status: "accepted", seed },
      fills: [],
      final_proof: finalProof,
    },
    receipt: {
      status: "submitted",
      provider_receipt: `receipt_${seed}`,
      final_proof: finalProof,
    },
  };
}

async function finalize(result) {
  return {
    attempt: { status: result.status, provider_ref_seed: result.provider_ref_seed },
    receipt: { status: result.status, result: result.result_seed },
  };
}

function functionSource(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} is present`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await delay(1);
  }
  throw new Error("condition was not reached");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
