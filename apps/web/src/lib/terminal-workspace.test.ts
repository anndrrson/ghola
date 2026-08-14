import { describe, expect, it } from "vitest";
import {
  defaultTerminalWorkspace,
  inspectTerminalWorkspace,
  parseTerminalWorkspace,
  serializeTerminalWorkspace,
  terminalWorkspaceStorageKey,
  terminalWorkspaceConcurrentConflict,
  validateTerminalWorkspace,
  TERMINAL_MARKET_RAIL_WIDTH_PX,
  TERMINAL_SIDE_COLUMNS_MAX_PX,
  TERMINAL_TICKET_WIDTH_PX,
} from "./terminal-workspace";

describe("terminal workspace", () => {
  it("uses exact guest/account namespaces and fails closed for malformed scopes", () => {
    const left = `subject_${"a".repeat(32)}`;
    const right = `subject_${"b".repeat(32)}`;
    expect(terminalWorkspaceStorageKey(left)).not.toBe(terminalWorkspaceStorageKey(right));
    expect(terminalWorkspaceStorageKey("device_guest")).toBe("ghola.terminal-workspace.v2:device_guest");
    expect(terminalWorkspaceStorageKey("subject_short")).toBeNull();
  });

  it("round trips the bounded workstation state", () => {
    const workspace = { ...defaultTerminalWorkspace(), chartMode: "compare" as const, chartStudies: ["vwap", "orderFlow"] as Array<"vwap" | "orderFlow">, notionalUsd: 13.47, bookOpen: false, bookView: "book" as const, marketRailWidthPx: 312, ticketWidthPx: 432 };
    expect(parseTerminalWorkspace(serializeTerminalWorkspace(workspace))).toEqual(workspace);
  });

  it("bounds integer desktop column widths and defaults older workspaces", () => {
    const legacy: Record<string, unknown> = { ...defaultTerminalWorkspace() };
    delete legacy.marketRailWidthPx;
    delete legacy.ticketWidthPx;
    expect(validateTerminalWorkspace(legacy)).toMatchObject({
      marketRailWidthPx: TERMINAL_MARKET_RAIL_WIDTH_PX.default,
      ticketWidthPx: TERMINAL_TICKET_WIDTH_PX.default,
    });
    expect(validateTerminalWorkspace({ ...legacy, marketRailWidthPx: 239 })).toBeNull();
    expect(validateTerminalWorkspace({ ...legacy, ticketWidthPx: 481 })).toBeNull();
    expect(validateTerminalWorkspace({ ...legacy, ticketWidthPx: 400.5 })).toBeNull();
    expect(validateTerminalWorkspace({
      ...legacy,
      marketRailWidthPx: TERMINAL_MARKET_RAIL_WIDTH_PX.max,
      ticketWidthPx: TERMINAL_SIDE_COLUMNS_MAX_PX - TERMINAL_MARKET_RAIL_WIDTH_PX.max + 1,
    })).toBeNull();
  });

  it("persists cent-denominated risk sizing and rejects unsupported precision", () => {
    expect(validateTerminalWorkspace({ ...defaultTerminalWorkspace(), notionalUsd: 7.25 })?.notionalUsd).toBe(7.25);
    expect(validateTerminalWorkspace({ ...defaultTerminalWorkspace(), notionalUsd: 7.251 })).toBeNull();
  });

  it("rejects unsupported market and network combinations", () => {
    expect(validateTerminalWorkspace({ ...defaultTerminalWorkspace(), venue: "phoenix", market: "BTC" })).toBeNull();
    expect(validateTerminalWorkspace({ ...defaultTerminalWorkspace(), venue: "coinbase", network: "testnet" })).toBeNull();
  });

  it("rejects unsafe or malformed persistence", () => {
    expect(parseTerminalWorkspace("not json")).toBeNull();
    expect(validateTerminalWorkspace({ ...defaultTerminalWorkspace(), notionalUsd: 1_000_000 })).toBeNull();
    expect(validateTerminalWorkspace({ ...defaultTerminalWorkspace(), riskBudgetUsd: -1 })).toBeNull();
    expect(validateTerminalWorkspace({ ...defaultTerminalWorkspace(), slippageBps: 999 })).toBeNull();
    expect(validateTerminalWorkspace({ ...defaultTerminalWorkspace(), bookOpen: "yes" })).toBeNull();
    expect(validateTerminalWorkspace({ ...defaultTerminalWorkspace(), chartStudies: ["clairvoyance"] })).toBeNull();
  });

  it("distinguishes absent workspace state from preserved unreadable bytes", () => {
    expect(inspectTerminalWorkspace(null)).toEqual({ status: "absent", workspace: null, raw: null });
    expect(inspectTerminalWorkspace("{broken-workspace")).toEqual({
      status: "blocked",
      workspace: null,
      raw: "{broken-workspace",
    });
    const futureVersion = JSON.stringify({ ...defaultTerminalWorkspace(), version: 99 });
    expect(inspectTerminalWorkspace(futureVersion)).toEqual({
      status: "blocked",
      workspace: null,
      raw: futureVersion,
    });
    const raw = serializeTerminalWorkspace(defaultTerminalWorkspace());
    expect(inspectTerminalWorkspace(raw)).toEqual({
      status: "ready",
      workspace: defaultTerminalWorkspace(),
      raw,
    });
  });

  it("loads older v1 workspaces with the conservative risk-budget default", () => {
    const legacy: Record<string, unknown> = { ...defaultTerminalWorkspace() };
    delete legacy.riskBudgetUsd;
    delete legacy.bookView;
    delete legacy.targetRewardMultiple;
    expect(validateTerminalWorkspace(legacy)?.riskBudgetUsd).toBe(1);
    expect(validateTerminalWorkspace(legacy)?.bookView).toBe("ladder");
    expect(validateTerminalWorkspace(legacy)?.targetRewardMultiple).toBe(2);
    expect(validateTerminalWorkspace({ ...legacy, targetRewardMultiple: 2.5 })).toBeNull();
  });

  it("loads older v1 workspaces with VWAP and deduplicates bounded studies", () => {
    const legacy: Record<string, unknown> = { ...defaultTerminalWorkspace() };
    delete legacy.chartStudies;
    expect(validateTerminalWorkspace(legacy)?.chartStudies).toEqual(["vwap"]);
    expect(validateTerminalWorkspace({ ...legacy, chartStudies: ["vwap", "vwap", "structure"] })?.chartStudies).toEqual(["vwap", "structure"]);
  });

  it("preserves the opt-in multi-timeframe context study", () => {
    const workspace = {
      ...defaultTerminalWorkspace(),
      chartStudies: ["vwap", "multiTimeframe"] as Array<"vwap" | "multiTimeframe">,
    };

    expect(parseTerminalWorkspace(serializeTerminalWorkspace(workspace))?.chartStudies).toEqual([
      "vwap",
      "multiTimeframe",
    ]);
  });

  it("distinguishes sequential synchronization from divergent cross-tab edits", () => {
    const base = defaultTerminalWorkspace();
    const local = { ...base, notionalUsd: 25 };
    const remote = { ...base, interval: "15m" as const };
    const previousValue = serializeTerminalWorkspace(base);

    expect(terminalWorkspaceConcurrentConflict({ local: base, previousValue, incoming: remote })).toBe(false);
    expect(terminalWorkspaceConcurrentConflict({ local, previousValue, incoming: remote })).toBe(true);
    expect(terminalWorkspaceConcurrentConflict({ local: remote, previousValue, incoming: remote })).toBe(false);
  });
});
