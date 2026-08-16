import { describe, expect, it } from "vitest";
import type { TerminalRouteCandidate, TerminalRouteDecision } from "./terminal-route-decision";
import {
  deriveTerminalAllInRouteModel,
  emptyTerminalRouteCostPolicy,
  inspectTerminalRouteCostPolicy,
  mergeTerminalRouteCostPolicies,
  resetTerminalRouteCostPolicy,
  serializeTerminalRouteCostPolicy,
  terminalRouteCostAssumption,
  terminalRouteCostEvidence,
  terminalRouteCostPolicyNextExpiry,
  terminalRouteCostPolicyStorageKey,
  TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS,
  updateTerminalRouteCostPolicy,
} from "./terminal-route-cost-policy";

describe("terminal route cost policy", () => {
  it("lets local friction reverse a gross buy ranking", () => {
    let policy = updateTerminalRouteCostPolicy({ policy: emptyTerminalRouteCostPolicy(), venue: "phoenix", field: "feeBps", value: 20, nowMs: 1 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "hyperliquid", field: "feeBps", value: 2, nowMs: 2 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "phoenix", field: "bufferBps", value: 0, nowMs: 3 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "hyperliquid", field: "bufferBps", value: 0, nowMs: 4 });
    const model = deriveTerminalAllInRouteModel({ decision: decision("buy"), policy, selectedVenue: "hyperliquid", nowMs: 4 });

    expect(model.rows.map((row) => row.candidate.venue)).toEqual(["hyperliquid", "phoenix"]);
    expect(model.best?.candidate.venue).toBe("hyperliquid");
    expect(model.bestPeer?.candidate.venue).toBe("phoenix");
    expect(model.improvementBps).toBe(0);
    expect(model.improvementUsd).toBe(0);
    expect(model.rows.find((row) => row.candidate.venue === "phoenix")).toMatchObject({ feeBps: 20 });
    expect(model.rows.find((row) => row.candidate.venue === "phoenix")?.frictionUsd).toBeCloseTo(0.1998);
  });

  it("ranks sells by higher net proceeds and reports full-fill savings", () => {
    let policy = updateTerminalRouteCostPolicy({ policy: emptyTerminalRouteCostPolicy(), venue: "hyperliquid", field: "feeBps", value: 20, nowMs: 1 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "phoenix", field: "bufferBps", value: 1, nowMs: 2 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "hyperliquid", field: "bufferBps", value: 0, nowMs: 3 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "phoenix", field: "feeBps", value: 0, nowMs: 4 });
    const value = decision("sell", [
      candidate({ venue: "hyperliquid", rank: 1, vwap: 100.1, filledNotionalUsd: 100.1 }),
      candidate({ venue: "phoenix", rank: 2, vwap: 100, filledNotionalUsd: 100 }),
    ]);
    const model = deriveTerminalAllInRouteModel({ decision: value, policy, selectedVenue: "hyperliquid", nowMs: 4 });

    expect(model.best?.candidate.venue).toBe("phoenix");
    expect(model.improvementBps).toBeGreaterThan(0);
    expect(model.improvementUsd).toBeGreaterThan(0);
  });

  it("never lets cheaper friction outrank materially better visible fill", () => {
    let policy = updateTerminalRouteCostPolicy({ policy: emptyTerminalRouteCostPolicy(), venue: "phoenix", field: "feeBps", value: 500, nowMs: 1 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "phoenix", field: "bufferBps", value: 0, nowMs: 2 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "hyperliquid", field: "feeBps", value: 0, nowMs: 3 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "hyperliquid", field: "bufferBps", value: 0, nowMs: 4 });
    const value = decision("buy", [
      candidate({ venue: "hyperliquid", rank: 2, fillPct: 50, status: "partial" }),
      candidate({ venue: "phoenix", rank: 1, fillPct: 100, status: "full" }),
    ]);
    expect(deriveTerminalAllInRouteModel({ decision: value, policy, selectedVenue: "hyperliquid", nowMs: 4 }).best?.candidate.venue).toBe("phoenix");
  });

  it("merges concurrent venue fields and converges deterministic ties", () => {
    const base = emptyTerminalRouteCostPolicy();
    const left = updateTerminalRouteCostPolicy({ policy: base, venue: "hyperliquid", field: "feeBps", value: 3, nowMs: 10 });
    const right = updateTerminalRouteCostPolicy({ policy: base, venue: "phoenix", field: "bufferBps", value: 8, nowMs: 11 });
    const merged = mergeTerminalRouteCostPolicies(left, right);
    expect(terminalRouteCostAssumption(merged, "hyperliquid")).toEqual({ feeBps: 3, bufferBps: 0 });
    expect(terminalRouteCostAssumption(merged, "phoenix")).toEqual({ feeBps: 0, bufferBps: 8 });
    expect(mergeTerminalRouteCostPolicies(left, right)).toEqual(mergeTerminalRouteCostPolicies(right, left));
  });

  it("distinguishes explicit zero cost evidence from untouched defaults", () => {
    const empty = inspectTerminalRouteCostPolicy(null);
    expect(terminalRouteCostEvidence(empty, "hyperliquid", 2)).toMatchObject({ status: "missing", feeConfigured: false, bufferConfigured: false });
    let policy = updateTerminalRouteCostPolicy({ policy: emptyTerminalRouteCostPolicy(), venue: "hyperliquid", field: "feeBps", value: 0, nowMs: 1 });
    expect(terminalRouteCostEvidence({ status: "ready", policy, raw: serializeTerminalRouteCostPolicy(policy) }, "hyperliquid", 2)).toMatchObject({ status: "missing", feeConfigured: true, bufferConfigured: false, feeCurrent: true });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "hyperliquid", field: "bufferBps", value: 0, nowMs: 2 });
    expect(terminalRouteCostEvidence({ status: "ready", policy, raw: serializeTerminalRouteCostPolicy(policy) }, "hyperliquid", 2)).toEqual({ status: "ready", feeBps: 0, bufferBps: 0, feeConfigured: true, bufferConfigured: true, feeCurrent: true, bufferCurrent: true, feeUpdatedAtMs: 1, bufferUpdatedAtMs: 2, ageMs: 1, expiresAtMs: 1 + TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS + 1 });
    expect(terminalRouteCostEvidence({ status: "blocked", policy: null, raw: "bad" }, "hyperliquid", 2).status).toBe("blocked");
  });

  it("expires the oldest cost field and exposes the exact next boundary", () => {
    const feeAt = 1_000;
    const bufferAt = 2_000;
    let policy = updateTerminalRouteCostPolicy({ policy: emptyTerminalRouteCostPolicy(), venue: "hyperliquid", field: "feeBps", value: 3, nowMs: feeAt });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "hyperliquid", field: "bufferBps", value: 4, nowMs: bufferAt });
    const inspection = { status: "ready" as const, policy, raw: serializeTerminalRouteCostPolicy(policy) };
    const expiry = feeAt + TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS + 1;
    expect(terminalRouteCostPolicyNextExpiry(policy, feeAt)).toBe(expiry);
    expect(terminalRouteCostEvidence(inspection, "hyperliquid", expiry - 1)).toMatchObject({ status: "ready", feeCurrent: true, bufferCurrent: true });
    expect(terminalRouteCostEvidence(inspection, "hyperliquid", expiry)).toMatchObject({ status: "expired", feeCurrent: false, bufferCurrent: true, expiresAtMs: expiry });
    expect(deriveTerminalAllInRouteModel({ decision: decision("buy"), policy, selectedVenue: "hyperliquid", nowMs: expiry }).status).toBe("unavailable");
  });

  it("fails closed on future-dated cost evidence", () => {
    let policy = updateTerminalRouteCostPolicy({ policy: emptyTerminalRouteCostPolicy(), venue: "hyperliquid", field: "feeBps", value: 3, nowMs: 50_000 });
    policy = updateTerminalRouteCostPolicy({ policy, venue: "hyperliquid", field: "bufferBps", value: 4, nowMs: 50_001 });
    expect(terminalRouteCostEvidence({ status: "ready", policy, raw: serializeTerminalRouteCostPolicy(policy) }, "hyperliquid", 1_000).status).toBe("invalid");
  });

  it("withholds all-in rankings until every compared venue has explicit evidence", () => {
    const partial = updateTerminalRouteCostPolicy({ policy: emptyTerminalRouteCostPolicy(), venue: "hyperliquid", field: "feeBps", value: 0, nowMs: 1 });
    expect(deriveTerminalAllInRouteModel({ decision: decision("buy"), policy: partial, selectedVenue: "hyperliquid", nowMs: 1 }).status).toBe("unavailable");
  });

  it("preserves corrupt bytes and supports an explicit monotonic reset", () => {
    expect(inspectTerminalRouteCostPolicy("{broken")).toMatchObject({ status: "blocked", raw: "{broken", policy: null });
    const policy = updateTerminalRouteCostPolicy({ policy: emptyTerminalRouteCostPolicy(), venue: "coinbase", field: "feeBps", value: 12, nowMs: 10 });
    const reset = resetTerminalRouteCostPolicy(11);
    expect(mergeTerminalRouteCostPolicies(policy, reset)).toEqual(reset);
    expect(inspectTerminalRouteCostPolicy(serializeTerminalRouteCostPolicy(policy))).toMatchObject({ status: "ready", policy: { venues: { coinbase: { feeBps: 12 } } } });
  });

  it("rejects invalid scopes, assumptions, and current-version shapes", () => {
    expect(terminalRouteCostPolicyStorageKey("device_guest")).toBe("ghola.terminal-route-cost.v1:device_guest");
    expect(terminalRouteCostPolicyStorageKey(`subject_${"a".repeat(32)}`)).not.toBeNull();
    expect(terminalRouteCostPolicyStorageKey("subject_bad")).toBeNull();
    expect(() => updateTerminalRouteCostPolicy({ policy: emptyTerminalRouteCostPolicy(), venue: "coinbase", field: "feeBps", value: 501 })).toThrow();
    expect(inspectTerminalRouteCostPolicy(JSON.stringify({ version: 1, clearedAt: 0, venues: { bad: {} } })).status).toBe("blocked");
  });
});

function decision(side: "buy" | "sell", candidates?: TerminalRouteCandidate[]): TerminalRouteDecision {
  const values = candidates ?? [
    candidate({ venue: "phoenix", rank: 1, vwap: 99.9, filledNotionalUsd: 99.9 }),
    candidate({ venue: "hyperliquid", rank: 2, vwap: 100, filledNotionalUsd: 100 }),
  ];
  return { status: "full_available", blocker: null, side, requestedNotionalUsd: 100, limitPrice: 101, candidates: values, exclusions: [], best: values[0] ?? null };
}

function candidate(overrides: Partial<TerminalRouteCandidate> = {}): TerminalRouteCandidate {
  return {
    rank: 1,
    venue: "phoenix",
    product: "SOL-PERP",
    productClass: "perpetual",
    network: "mainnet",
    status: "full",
    fillPct: 100,
    vwap: 100,
    impactBps: 2,
    filledNotionalUsd: 100,
    unfilledNotionalUsd: 0,
    worstPrice: 100,
    levelsConsumed: 1,
    bookAgeMs: 100,
    bookObservedAt: "2026-08-13T12:00:00.000Z",
    fetchedAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}
