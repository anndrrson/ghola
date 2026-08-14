import { describe, expect, it } from "vitest";
import { parseTerminalDecimalDraft, terminalDecimalDraftBlockerLabel } from "./terminal-decimal-draft";

const USD = { min: 1, max: 100, maxFractionDigits: 2 };

describe("terminal decimal draft", () => {
  it.each([
    ["25", 25],
    ["25.5", 25.5],
    ["25.50", 25.5],
    ["$25.50", 25.5],
    [".99", 0.99],
  ])("parses %s without changing magnitude", (raw, expected) => {
    expect(parseTerminalDecimalDraft(raw, { ...USD, min: 0 })).toEqual({ status: "valid", value: expected });
  });

  it.each(["", ".", "25."])("preserves incomplete draft %j", (raw) => {
    expect(parseTerminalDecimalDraft(raw, USD).status).toBe("incomplete");
  });

  it.each([
    ["25.501", "precision_exceeded"],
    ["2e1", "format_invalid"],
    ["1,000", "format_invalid"],
    ["-2", "format_invalid"],
    ["0.99", "below_minimum"],
    ["100.01", "above_maximum"],
  ])("rejects %s as %s", (raw, blocker) => {
    expect(parseTerminalDecimalDraft(raw, USD)).toEqual({ status: "invalid", blocker });
  });

  it("describes bounds and precision", () => {
    expect(terminalDecimalDraftBlockerLabel("precision_exceeded", USD)).toBe("Use at most 2 decimal places.");
    expect(terminalDecimalDraftBlockerLabel("above_maximum", USD)).toBe("Maximum 100.");
  });
});
