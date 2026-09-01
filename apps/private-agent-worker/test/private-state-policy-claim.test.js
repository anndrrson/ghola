import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSqliteWorkerState,
  createWorkerState,
} from "../src/state/private-state.js";

function attempt(status) {
  return { status, submit_count: status === "armed" ? 1 : 0 };
}

function usage(overrides = {}) {
  return {
    allowed_attempt: attempt("armed"),
    denied_attempt: attempt("failed_no_submit"),
    counts: [{ key: "orders:test", max_count: 10, error: "count denied", status: 429 }],
    amounts: [{ key: "notional:test", amount: 5, max_amount: 100, error: "amount denied", status: 400 }],
    ...overrides,
  };
}

function readJsonState(dir) {
  return JSON.parse(readFileSync(join(dir, "private-agent-execution-state-v1.json"), "utf8"));
}

test("atomic policy claim rolls back every quota charge when a later quota denies", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-policy-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);

  const seeded = await state.claimExecutionAttemptWithPolicyUsage("work-seed", usage());
  assert.equal(seeded.ok, true);

  const denied = await state.claimExecutionAttemptWithPolicyUsage("work-denied", usage({
    counts: [{ key: "orders:test", max_count: 10, error: "count denied", status: 429 }],
    amounts: [{ key: "notional:test", amount: 96, max_amount: 100, error: "amount denied", status: 400 }],
  }));
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "policy_denied");
  assert.equal(denied.denied.type, "amount");
  assert.equal(denied.denied.key, "notional:test");
  assert.equal(denied.denied.error, "amount denied");

  const persisted = readJsonState(dir);
  assert.equal(persisted.policy_counts["orders:test"].count, 1);
  assert.equal(persisted.policy_amounts["notional:test"].amount, 5);
  assert.equal(persisted.execution_attempts["work-denied"].status, "failed_no_submit");
});

test("duplicate concurrent atomic claims charge quota exactly once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-policy-duplicate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);

  const results = await Promise.all([
    state.claimExecutionAttemptWithPolicyUsage("work-duplicate", usage()),
    state.claimExecutionAttemptWithPolicyUsage("work-duplicate", usage()),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === "attempt_exists").length, 1);

  const persisted = readJsonState(dir);
  assert.equal(persisted.policy_counts["orders:test"].count, 1);
  assert.equal(persisted.policy_amounts["notional:test"].amount, 5);
});

test("a policy-proven no-submit attempt rearms once after quota permits and preserves lineage", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-policy-rearm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const work = "work-policy-rearm";
  const deniedInput = usage({
    denied_attempt: {
      status: "failed_no_submit",
      submit_count: 0,
      ambiguity_retry_count: 0,
      final_proof: null,
      result_seed: { kind: "lighter_policy_failed_no_submit" },
    },
    counts: [{ key: "orders:rearm", max_count: 0, error: "count denied", status: 429 }],
    amounts: [{ key: "notional:rearm", amount: 5, max_amount: 100 }],
  });
  const denied = await state.claimExecutionAttemptWithPolicyUsage(work, deniedInput);
  assert.equal(denied.reason, "policy_denied");
  assert.equal(denied.attempt.policy_denial.key, "orders:rearm");

  const stillDenied = await state.claimExecutionAttemptWithPolicyUsage(work, {
    ...deniedInput,
    rearm_failed_no_submit: true,
  });
  assert.equal(stillDenied.reason, "policy_denied");
  assert.equal(stillDenied.attempt.status, "failed_no_submit");
  let persisted = readJsonState(dir);
  assert.equal(persisted.policy_counts["orders:rearm"], undefined);
  assert.equal(persisted.policy_amounts["notional:rearm"], undefined);

  const allowedInput = usage({
    allowed_attempt: {
      status: "pending",
      submit_count: 1,
      ambiguity_retry_count: 0,
      final_proof: null,
      result_seed: { kind: "lighter_submission_pending" },
    },
    counts: [{ key: "orders:rearm", max_count: 1 }],
    amounts: [{ key: "notional:rearm", amount: 5, max_amount: 100 }],
    rearm_failed_no_submit: true,
  });
  const results = await Promise.all([
    state.claimExecutionAttemptWithPolicyUsage(work, allowedInput),
    state.claimExecutionAttemptWithPolicyUsage(work, allowedInput),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === "attempt_exists").length, 1);

  persisted = readJsonState(dir);
  assert.equal(persisted.policy_counts["orders:rearm"].count, 1);
  assert.equal(persisted.policy_amounts["notional:rearm"].amount, 5);
  assert.equal(persisted.execution_attempts[work].status, "pending");
  assert.equal(persisted.execution_attempts[work].policy_rearm_count, 1);
  assert.equal(persisted.execution_attempts[work].policy_rearm_lineage.length, 1);
  assert.equal(persisted.execution_attempts[work].policy_rearm_lineage[0].status, "failed_no_submit");
  assert.equal(persisted.execution_attempts[work].policy_rearm_lineage[0].policy_denial.key, "orders:rearm");
});

test("ambiguous attempts can never use the policy no-submit rearm", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-policy-no-ambiguity-rearm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  const work = "work-ambiguous";
  await state.putExecutionAttempt(work, {
    status: "ambiguous",
    submit_count: 1,
    ambiguity_retry_count: 0,
    result_seed: { kind: "lighter_submission_ambiguous" },
  });

  const result = await state.claimExecutionAttemptWithPolicyUsage(work, usage({
    rearm_failed_no_submit: true,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "attempt_exists");
  const persisted = readJsonState(dir);
  assert.equal(persisted.execution_attempts[work].status, "ambiguous");
  assert.equal(persisted.policy_counts["orders:test"], undefined);
  assert.equal(persisted.policy_amounts["notional:test"], undefined);

  await state.putExecutionAttempt("work-prior-ambiguity", {
    status: "failed_no_submit",
    submit_count: 0,
    ambiguity_retry_count: 1,
    final_proof: null,
    result_seed: { kind: "lighter_policy_failed_no_submit" },
  });
  const disguisedAmbiguity = await state.claimExecutionAttemptWithPolicyUsage(
    "work-prior-ambiguity",
    usage({ rearm_failed_no_submit: true }),
  );
  assert.equal(disguisedAmbiguity.reason, "attempt_exists");
  assert.equal((await state.getExecutionAttempt("work-prior-ambiguity")).ambiguity_retry_count, 1);
});

test("SQLite serializes competing quota claims across adapter instances", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-policy-sqlite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "worker.sqlite");
  const first = createSqliteWorkerState(dbPath);
  const second = createSqliteWorkerState(dbPath);
  const constrained = usage({
    counts: [{ key: "orders:shared", max_count: 1, error: "shared count denied", status: 429 }],
    amounts: [],
  });

  const results = await Promise.all([
    first.claimExecutionAttemptWithPolicyUsage("work-a", constrained),
    second.claimExecutionAttemptWithPolicyUsage("work-b", constrained),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === "policy_denied").length, 1);
  const deniedWork = results[0].reason === "policy_denied" ? "work-a" : "work-b";
  assert.equal((await first.getExecutionAttempt(deniedWork)).status, "failed_no_submit");

  const duplicateResults = await Promise.all([
    first.claimExecutionAttemptWithPolicyUsage("work-duplicate", usage({
      counts: [{ key: "orders:duplicate", max_count: 2 }],
      amounts: [],
    })),
    second.claimExecutionAttemptWithPolicyUsage("work-duplicate", usage({
      counts: [{ key: "orders:duplicate", max_count: 2 }],
      amounts: [],
    })),
  ]);
  assert.equal(duplicateResults.filter((result) => result.ok).length, 1);
  assert.equal(duplicateResults.filter((result) => result.reason === "attempt_exists").length, 1);
});
