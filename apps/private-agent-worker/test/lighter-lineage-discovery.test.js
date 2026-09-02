import assert from "node:assert/strict";
import test from "node:test";
import {
  lighterBoundLineageEligibility,
  lighterLineageDiscoveryEligibility,
  persistLighterBoundReconciliation,
  persistLighterDiscoveredLineage,
} from "../src/execution/private-execution.js";
import {
  lighterClientOrderIndex,
  lighterOrderFingerprint,
} from "../src/venues/lighter.js";

const TARGET = "work:lighter:lineage-discovery:0001";
const ACCOUNT = "account:lighter:lineage-discovery:0001";
const CLIENT_INDEX = lighterClientOrderIndex(TARGET);
const FINGERPRINT = lighterOrderFingerprint({
  operation_class: "limit_order",
  order: {
    market: "BTC",
    side: "buy",
    base_size: "0.01",
    limit_price: "1000",
    reduce_only: false,
    tif: "Ioc",
  },
}, CLIENT_INDEX, { submittedAtMs: 1_800_000_000_000 });

function attempt(overrides = {}) {
  return {
    venue_id: "lighter",
    account_commitment: ACCOUNT,
    submit_count: 1,
    ambiguity_retry_count: 0,
    provider_ref_seed: {
      venue: "lighter",
      client_order_index: CLIENT_INDEX,
      pending: true,
      submitted_order_fingerprint: FINGERPRINT,
    },
    result_seed: { kind: "lighter_submission_ambiguous" },
    status: "ambiguous",
    ...overrides,
  };
}

test("accepts known Lighter lineage only when every durable identifier matches", () => {
  const known = attempt({
    status: "open",
    provider_ref_seed: {
      ...attempt().provider_ref_seed,
      order_index: "88",
      pending: false,
    },
  });
  const check = (overrides = {}) => lighterBoundLineageEligibility({
    attempt: known,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    expectedOrderIndex: "88",
    expectedClientOrderIndex: CLIENT_INDEX,
    expectedOrderFingerprint: FINGERPRINT,
    accountCommitment: ACCOUNT,
    ...overrides,
  });
  assert.equal(check().eligible, true);
  assert.equal(check({ expectedOrderIndex: "89" }).eligible, false);
  assert.equal(check({ expectedClientOrderIndex: CLIENT_INDEX + 1 }).eligible, false);
  assert.equal(check({ reconcileMarket: "ETH" }).eligible, false);
  assert.equal(check({ expectedOrderFingerprint: { ...FINGERPRINT, price: "999" } }).eligible, false);
});

function eligibility(value = attempt(), overrides = {}) {
  return lighterLineageDiscoveryEligibility({
    attempt: value,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    ...overrides,
  });
}

test("allows Lighter lineage discovery only from an exact durable ambiguous submission", () => {
  assert.equal(eligibility().eligible, true);
  assert.equal(eligibility(attempt({
    status: "pending",
    result_seed: { kind: "lighter_submission_pending" },
  })).eligible, true);

  const rejected = [
    attempt({ venue_id: "aster" }),
    attempt({ status: "open", result_seed: { kind: "lighter_submission_ambiguous" } }),
    attempt({ submit_count: 0 }),
    attempt({ submit_count: 2 }),
    attempt({ ambiguity_retry_count: 1 }),
    attempt({ result_seed: { kind: "lighter_submission_pending" } }),
    attempt({ account_commitment: "account:other" }),
    attempt({ provider_ref_seed: { ...attempt().provider_ref_seed, pending: false } }),
    attempt({ provider_ref_seed: { ...attempt().provider_ref_seed, order_index: "88" } }),
    attempt({ provider_ref_seed: { ...attempt().provider_ref_seed, client_order_index: CLIENT_INDEX + 1 } }),
    attempt({ provider_ref_seed: {
      ...attempt().provider_ref_seed,
      submitted_order_fingerprint: { ...FINGERPRINT, price: "999" },
    } }),
  ];
  for (const value of rejected) assert.equal(eligibility(value).eligible, false);
  assert.equal(eligibility(attempt(), { reconcileMarket: "ETH" }).eligible, false);
  assert.equal(eligibility(attempt(), { targetWorkOrderCommitment: "" }).eligible, false);
});

test("persists a uniquely proven Lighter provider index onto the original attempt", async () => {
  const original = attempt();
  const stored = new Map([[TARGET, original]]);
  const writes = [];
  const state = {
    getExecutionAttempt: async (key) => stored.get(key) || null,
    compareAndSetExecutionAttempt: async (key, expected, value) => {
      if (stored.get(key) !== expected) return { ok: false, existing: stored.get(key) };
      writes.push(key);
      stored.set(key, value);
      return { ok: true, attempt: value };
    },
  };
  const eligible = eligibility(original);
  const result = {
    status: "open",
    provider_ref_seed: {
      venue: "lighter",
      client_order_index: CLIENT_INDEX,
      order_index: "88",
      submitted_order_fingerprint: FINGERPRINT,
    },
    result_seed: { kind: "lighter_exact_reconcile", status: "open" },
    fills: [],
    final_proof: {
      status: "open",
      proof_kind: "lighter_client_order_index_reconciliation_v1",
      venue_id: "lighter",
      target_client_order_matched: true,
      submitted_order_fingerprint_matched: true,
      target_identifier_collision: false,
      venue_order_lineage_matched: true,
      original_order_target_matched: true,
      original_order_broadcast_proven: true,
      query_broadcast: false,
      broadcast_performed: false,
    },
    reconciliation: { reconcileOnly: true, submission_retry_count: 0 },
  };

  const persisted = await persistLighterDiscoveredLineage({
    state,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    eligibility: eligible,
    result,
  });
  assert.deepEqual(writes, [TARGET]);
  assert.equal(persisted.provider_ref_seed.order_index, "88");
  assert.equal(persisted.provider_ref_seed.pending, false);
  assert.equal(persisted.submit_count, 1);
  assert.equal(persisted.ambiguity_retry_count, 0);
  assert.equal(persisted.status, "open");
});

test("does not persist unproven or conflicting discovered Lighter lineage", async () => {
  const original = attempt();
  let stored = original;
  let writes = 0;
  const state = {
    getExecutionAttempt: async () => stored,
    compareAndSetExecutionAttempt: async (_key, expected, value) => {
      if (stored !== expected) return { ok: false, existing: stored };
      writes += 1;
      stored = value;
      return { ok: true, attempt: value };
    },
  };
  const eligible = eligibility(original);
  const unproven = await persistLighterDiscoveredLineage({
    state,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    eligibility: eligible,
    result: {
      status: "outcome_unknown",
      provider_ref_seed: {
        venue: "lighter",
        client_order_index: CLIENT_INDEX,
        order_index: "88",
        submitted_order_fingerprint: FINGERPRINT,
      },
      result_seed: { kind: "lighter_exact_reconcile", status: "outcome_unknown" },
      final_proof: { target_client_order_matched: false, broadcast_performed: false },
      reconciliation: { reconcileOnly: true, submission_retry_count: 0 },
    },
  });
  assert.equal(unproven, null);
  assert.equal(writes, 0);

  stored = attempt({
    provider_ref_seed: { ...attempt().provider_ref_seed, order_index: "99", pending: false },
    status: "open",
  });
  await assert.rejects(persistLighterDiscoveredLineage({
    state,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    eligibility: eligible,
    result: {
      status: "open",
      provider_ref_seed: {
        venue: "lighter",
        client_order_index: CLIENT_INDEX,
        order_index: "88",
        submitted_order_fingerprint: FINGERPRINT,
      },
      result_seed: { kind: "lighter_exact_reconcile", status: "open" },
      fills: [],
      final_proof: {
        status: "open",
        proof_kind: "lighter_client_order_index_reconciliation_v1",
        venue_id: "lighter",
        target_client_order_matched: true,
        submitted_order_fingerprint_matched: true,
        target_identifier_collision: false,
        venue_order_lineage_matched: true,
        original_order_target_matched: true,
        original_order_broadcast_proven: true,
        query_broadcast: false,
        broadcast_performed: false,
      },
      reconciliation: { reconcileOnly: true, submission_retry_count: 0 },
    },
  }), (error) => error.code === "submission_ambiguous");
  assert.equal(writes, 0);
});

test("fails closed when a concurrent writer changes Lighter lineage", async () => {
  const original = attempt();
  const state = {
    getExecutionAttempt: async () => original,
    compareAndSetExecutionAttempt: async () => ({
      ok: false,
      existing: attempt({
        provider_ref_seed: { ...attempt().provider_ref_seed, order_index: "99", pending: false },
        status: "open",
      }),
    }),
  };
  await assert.rejects(persistLighterDiscoveredLineage({
    state,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    eligibility: eligibility(original),
    result: {
      status: "open",
      provider_ref_seed: {
        venue: "lighter",
        client_order_index: CLIENT_INDEX,
        order_index: "88",
        submitted_order_fingerprint: FINGERPRINT,
      },
      result_seed: { kind: "lighter_exact_reconcile", status: "open" },
      fills: [],
      final_proof: {
        status: "open",
        proof_kind: "lighter_client_order_index_reconciliation_v1",
        venue_id: "lighter",
        target_client_order_matched: true,
        submitted_order_fingerprint_matched: true,
        target_identifier_collision: false,
        venue_order_lineage_matched: true,
        original_order_target_matched: true,
        original_order_broadcast_proven: true,
        query_broadcast: false,
        broadcast_performed: false,
      },
      reconciliation: { reconcileOnly: true, submission_retry_count: 0 },
    },
  }), (error) => error.code === "submission_ambiguous");
});

test("requires durable exact proof before treating a discovered index as idempotent", async () => {
  const current = attempt({
    status: "open",
    provider_ref_seed: {
      ...attempt().provider_ref_seed,
      order_index: "88",
      pending: false,
    },
  });
  const state = {
    getExecutionAttempt: async () => current,
    compareAndSetExecutionAttempt: async () => {
      throw new Error("must not write");
    },
  };
  await assert.rejects(persistLighterDiscoveredLineage({
    state,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    eligibility: eligibility(),
    result: exactResult(),
  }), (error) => error.code === "submission_ambiguous");
});

test("atomically persists known Lighter reconciliation and rejects stale writers", async () => {
  const expected = attempt({
    status: "open",
    provider_ref_seed: {
      ...attempt().provider_ref_seed,
      order_index: "88",
      pending: false,
    },
  });
  const bound = lighterBoundLineageEligibility({
    attempt: expected,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    expectedOrderIndex: "88",
    expectedClientOrderIndex: CLIENT_INDEX,
    expectedOrderFingerprint: FINGERPRINT,
    accountCommitment: ACCOUNT,
  });
  let current = expected;
  const state = {
    compareAndSetExecutionAttempt: async (_key, prior, next) => {
      if (current !== prior) return { ok: false, existing: current };
      current = next;
      return { ok: true, attempt: next };
    },
  };
  const persisted = await persistLighterBoundReconciliation({
    state,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    expectedAttempt: expected,
    boundEligibility: bound,
    result: exactResult(),
  });
  assert.equal(persisted.provider_ref_seed.order_index, "88");
  await assert.rejects(persistLighterBoundReconciliation({
    state,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    expectedAttempt: expected,
    boundEligibility: bound,
    result: exactResult(),
  }), (error) => error.code === "submission_ambiguous");

  const terminal = {
    ...expected,
    status: "filled",
  };
  const terminalBound = lighterBoundLineageEligibility({
    attempt: terminal,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    expectedOrderIndex: "88",
    expectedClientOrderIndex: CLIENT_INDEX,
    expectedOrderFingerprint: FINGERPRINT,
    accountCommitment: ACCOUNT,
  });
  await assert.rejects(persistLighterBoundReconciliation({
    state: { compareAndSetExecutionAttempt: async () => { throw new Error("must not write"); } },
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    expectedAttempt: terminal,
    boundEligibility: terminalBound,
    result: exactResult(),
  }), (error) => error.code === "submission_ambiguous");
});

test("never regresses terminal proof, fill evidence, or partial status", async () => {
  const fill = {
    size: "0.01",
    quote_size: "10",
    price: "1000",
    fee: "0.001",
    fee_asset: "USDC",
    executed_at_ms: 1_800_000_000_100,
  };
  const completeFilled = durableAttempt(exactResult({
    status: "filled",
    filledBaseSize: "0.01",
    fills: [fill],
    terminalProofComplete: true,
  }));
  const incompleteFilled = exactResult({
    status: "filled",
    filledBaseSize: "0.01",
    fills: [{ ...fill, fee: null, fee_asset: null, executed_at_ms: null }],
  });
  const partial = durableAttempt(exactResult({
    status: "partially_filled",
    filledBaseSize: "0.005",
    fills: [{ ...fill, size: "0.005", quote_size: "5" }],
  }));
  let writes = 0;
  const noWriteState = {
    compareAndSetExecutionAttempt: async () => {
      writes += 1;
      throw new Error("must not write");
    },
  };
  for (const [expectedAttempt, result] of [
    [completeFilled, incompleteFilled],
    [partial, exactResult()],
  ]) {
    await assert.rejects(persistLighterBoundReconciliation({
      state: noWriteState,
      targetWorkOrderCommitment: TARGET,
      reconcileMarket: "BTC",
      accountCommitment: ACCOUNT,
      expectedAttempt,
      boundEligibility: boundEligibilityFor(expectedAttempt),
      result,
    }), (error) => error.code === "submission_ambiguous");
  }
  assert.equal(writes, 0);
});

test("upgrades stronger same-index discovery evidence exactly once", async () => {
  const original = attempt();
  let current = durableAttempt(exactResult());
  let compareAndSetCalls = 0;
  let advances = 0;
  const state = {
    getExecutionAttempt: async () => current,
    compareAndSetExecutionAttempt: async (_key, expected, value) => {
      if (current !== expected) return { ok: false, existing: current };
      compareAndSetCalls += 1;
      if (value !== expected) advances += 1;
      current = value;
      return { ok: true, attempt: value };
    },
  };
  const fill = {
    size: "0.01",
    quote_size: "10",
    price: "1000",
    fee: "0.001",
    fee_asset: "USDC",
    executed_at_ms: 1_800_000_000_100,
  };
  const filled = exactResult({
    status: "filled",
    filledBaseSize: "0.01",
    fills: [fill],
    terminalProofComplete: true,
  });
  const persisted = await persistLighterDiscoveredLineage({
    state,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    eligibility: eligibility(original),
    result: filled,
  });
  assert.equal(persisted.status, "filled");
  assert.equal(advances, 1);

  const stale = await persistLighterDiscoveredLineage({
    state,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    eligibility: eligibility(original),
    result: exactResult(),
  });
  assert.equal(stale.status, "filled");
  assert.equal(advances, 1);
  assert.equal(compareAndSetCalls, 2);
});

test("treats checked-at-only same-index evidence as idempotent", async () => {
  const original = attempt();
  const current = durableAttempt(exactResult({ checkedAt: "2026-01-01T00:00:00.000Z" }));
  let compareAndSetCalls = 0;
  const state = {
    getExecutionAttempt: async () => current,
    compareAndSetExecutionAttempt: async (_key, expected, value) => {
      compareAndSetCalls += 1;
      assert.equal(expected, current);
      assert.equal(value, current);
      return { ok: true, attempt: current };
    },
  };
  const persisted = await persistLighterDiscoveredLineage({
    state,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    eligibility: eligibility(original),
    result: exactResult({ checkedAt: "2026-01-01T00:01:00.000Z" }),
  });
  assert.equal(persisted, current);
  assert.equal(compareAndSetCalls, 1);
});

test("atomically rejects equivalent evidence after a concurrent terminal advance", async () => {
  const current = durableAttempt(exactResult());
  const terminal = durableAttempt(exactResult({
    status: "cancelled",
    terminalProofComplete: true,
  }));
  await assert.rejects(persistLighterBoundReconciliation({
    state: {
      compareAndSetExecutionAttempt: async (_key, expected, value) => {
        assert.equal(expected, current);
        assert.equal(value, current);
        return { ok: false, existing: terminal };
      },
    },
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    expectedAttempt: current,
    boundEligibility: boundEligibilityFor(current),
    result: exactResult({ checkedAt: "2026-01-01T00:01:00.000Z" }),
  }), (error) => error.code === "submission_ambiguous");
});

test("enriches an aggregate terminal fill without changing its exact totals", async () => {
  const aggregateFill = {
    size: "0.01",
    quote_size: "10",
    price: "1000",
    fee: null,
    fee_asset: null,
    executed_at_ms: null,
  };
  const current = durableAttempt(exactResult({
    status: "filled",
    filledBaseSize: "0.01",
    fills: [aggregateFill],
  }));
  const authenticatedFills = [
    {
      size: "0.004",
      quote_size: "4",
      price: "1000",
      fee: "0.0004",
      fee_asset: "USDC",
      executed_at_ms: 1_800_000_000_100,
    },
    {
      size: "0.006",
      quote_size: "6",
      price: "1000",
      fee: "0.0006",
      fee_asset: "USDC",
      executed_at_ms: 1_800_000_000_100,
    },
  ];
  let stored = current;
  const persisted = await persistLighterBoundReconciliation({
    state: {
      compareAndSetExecutionAttempt: async (_key, expected, value) => {
        assert.equal(expected, stored);
        stored = value;
        return { ok: true, attempt: value };
      },
    },
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    accountCommitment: ACCOUNT,
    expectedAttempt: current,
    boundEligibility: boundEligibilityFor(current),
    result: exactResult({
      status: "filled",
      filledBaseSize: "0.01",
      fills: authenticatedFills,
      terminalProofComplete: true,
    }),
  });
  assert.equal(persisted.final_proof.target_fill_set_complete, true);
  assert.equal(persisted.fills.length, 2);
});

function boundEligibilityFor(value) {
  return lighterBoundLineageEligibility({
    attempt: value,
    targetWorkOrderCommitment: TARGET,
    reconcileMarket: "BTC",
    expectedOrderIndex: "88",
    expectedClientOrderIndex: CLIENT_INDEX,
    expectedOrderFingerprint: FINGERPRINT,
    accountCommitment: ACCOUNT,
  });
}

function durableAttempt(result, overrides = {}) {
  return attempt({
    ...result,
    provider_ref_seed: {
      ...attempt().provider_ref_seed,
      ...result.provider_ref_seed,
      pending: false,
    },
    ...overrides,
  });
}

function exactResult({
  status = "open",
  filledBaseSize = "0",
  fills = [],
  terminalProofComplete = false,
  checkedAt = "2026-01-01T00:00:00.000Z",
} = {}) {
  const hasFill = filledBaseSize !== "0";
  const terminal = status === "filled" || status === "cancelled";
  const firstFill = hasFill ? 1_800_000_000_100 : null;
  const feeEvidenceCommitment = terminalProofComplete ? `sha256:${"a".repeat(64)}` : null;
  return {
    status,
    provider_ref_seed: {
      venue: "lighter",
      client_order_index: CLIENT_INDEX,
      order_index: "88",
      submitted_order_fingerprint: FINGERPRINT,
    },
    result_seed: {
      kind: "lighter_exact_reconcile",
      status,
      fee_exact: terminalProofComplete,
      fee_evidence_commitment: feeEvidenceCommitment,
    },
    fills,
    final_proof: {
      version: 1,
      status,
      proof_kind: "lighter_client_order_index_reconciliation_v1",
      venue_id: "lighter",
      target_client_order_matched: true,
      submitted_order_fingerprint_matched: true,
      target_identifier_collision: false,
      venue_order_lineage_matched: true,
      original_order_target_matched: true,
      original_order_broadcast_proven: true,
      query_broadcast: false,
      broadcast_performed: false,
      final_venue_execution_proven: terminal && terminalProofComplete,
      final_fill_proven: status === "filled" && terminalProofComplete,
      target_fill_set_complete: terminal && terminalProofComplete,
      filled_base_size: filledBaseSize,
      average_fill_price: hasFill ? "1000" : "0",
      fee_exact: terminalProofComplete,
      fee_quote_amount: terminalProofComplete ? hasFill ? "0.001" : "0" : null,
      fee_asset: terminalProofComplete ? "USDC" : null,
      fee_evidence_kind: terminalProofComplete
        ? hasFill ? "lighter_authenticated_order_trades_fee_v1" : "lighter_terminal_zero_fill_v1"
        : null,
      fee_evidence_commitment: feeEvidenceCommitment,
      fee_evidence_trade_count: terminalProofComplete ? fills.length : null,
      fee_evidence_pagination_complete: terminalProofComplete,
      fee_evidence_incomplete_reason: terminalProofComplete ? null : "trade_totals_incomplete",
      first_fill_at_ms: terminalProofComplete ? firstFill : null,
      last_fill_at_ms: terminalProofComplete ? firstFill : null,
      fill_times_authoritative: hasFill && terminalProofComplete,
      fill_time_provenance: hasFill && terminalProofComplete
        ? "lighter_authenticated_order_trades_timestamp_v1"
        : null,
      open_order_count: status === "open" || status === "partially_filled" ? 1 : 0,
      checked_at: checkedAt,
    },
    reconciliation: { reconcileOnly: true, submission_retry_count: 0 },
  };
}
