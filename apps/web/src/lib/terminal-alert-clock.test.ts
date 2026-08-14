import { describe, expect, it } from "vitest";
import { defaultTerminalAlertRules } from "./terminal-alerts";
import {
  advanceTerminalAlertAgeSnapshot,
  terminalAlertNextAgeThresholdAt,
} from "./terminal-alert-clock";

describe("terminal alert clock", () => {
  it("advances only exact age metrics without mutating the source snapshot", () => {
    const snapshot = { price: 100, market_age_ms: 500, book_age_ms: 1_000, trades_age_ms: null };
    const advanced = advanceTerminalAlertAgeSnapshot({ snapshot, capturedAtMs: 10_000, nowMs: 12_500 });
    expect(advanced).toEqual({ price: 100, market_age_ms: 3_000, book_age_ms: 3_500, trades_age_ms: null });
    expect(snapshot).toEqual({ price: 100, market_age_ms: 500, book_age_ms: 1_000, trades_age_ms: null });
  });

  it("fails age metrics closed on time regression", () => {
    expect(advanceTerminalAlertAgeSnapshot({
      snapshot: { price: 100, book_age_ms: 1_000 },
      capturedAtMs: 10_000,
      nowMs: 9_999,
    })).toEqual({ price: 100, book_age_ms: null });
  });

  it("schedules the earliest future enabled above-threshold age crossing", () => {
    const rules = defaultTerminalAlertRules(null);
    expect(terminalAlertNextAgeThresholdAt({
      rules,
      snapshot: { market_age_ms: 10_000, book_age_ms: 19_000, trades_age_ms: 5_000 },
      capturedAtMs: 100_000,
      nowMs: 100_000,
    })).toBe(101_000);
    expect(terminalAlertNextAgeThresholdAt({
      rules: rules.map((rule) => ({ ...rule, enabled: false })),
      snapshot: { book_age_ms: 19_000 },
      capturedAtMs: 100_000,
      nowMs: 100_000,
    })).toBeNull();
  });
});
