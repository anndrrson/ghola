import { describe, expect, it } from "vitest";
import { searchTerminalCommands, terminalCommandCatalog } from "./terminal-command";

describe("terminal command palette", () => {
  it("provides unique professional workstation actions", () => {
    const commands = terminalCommandCatalog();
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
    expect(commands.length).toBeGreaterThanOrEqual(25);
    expect(commands.find((command) => command.id === "reset-plan-levels")?.shortcut).toBeUndefined();
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "study-orderFlow" }),
      expect.objectContaining({ id: "study-multiTimeframe" }),
      expect.objectContaining({ id: "toggle-book", shortcut: "D", command: { type: "toggle_book" } }),
      expect.objectContaining({ id: "toggle-replay", shortcut: "R", command: { type: "toggle_replay" } }),
      expect.objectContaining({ id: "focus-chart", shortcut: "C", command: { type: "open_chart" } }),
      expect.objectContaining({ id: "alerts", shortcut: "L", command: { type: "open_alerts" } }),
      expect.objectContaining({ id: "paper", shortcut: "P", command: { type: "open_paper" } }),
      expect.objectContaining({ id: "ticket", shortcut: "O", command: { type: "open_ticket" } }),
      expect.objectContaining({ id: "risk-desk", command: { type: "open_risk_desk" } }),
      expect.objectContaining({ id: "scanner", shortcut: "W", command: { type: "open_scanner" } }),
      expect.objectContaining({ id: "execution-analytics", command: { type: "open_execution_analytics" } }),
      expect.objectContaining({ id: "route-check", command: { type: "open_route_check" } }),
      expect.objectContaining({ id: "plan-book", command: { type: "open_plan_book" } }),
      expect.objectContaining({ id: "reconnect-market", command: { type: "reconnect_market" } }),
      expect.objectContaining({ id: "depth-ladder", command: { type: "set_depth_view", view: "ladder" } }),
      expect.objectContaining({ id: "depth-book", command: { type: "set_depth_view", view: "book" } }),
      expect.objectContaining({ id: "focus-notional", shortcut: "N", command: { type: "focus_ticket_field", field: "notional" } }),
      expect.objectContaining({ id: "focus-entry", shortcut: "E", command: { type: "focus_ticket_field", field: "entry" } }),
      expect.objectContaining({ id: "focus-invalidation", shortcut: "I", command: { type: "focus_ticket_field", field: "invalidation" } }),
      expect.objectContaining({ id: "focus-risk-budget", shortcut: "G", command: { type: "focus_ticket_field", field: "risk_budget" } }),
      expect.objectContaining({ id: "entry-auto", shortcut: "U", command: { type: "stage_entry_price", mode: "auto" } }),
      expect.objectContaining({ id: "entry-join", shortcut: "J", command: { type: "stage_entry_price", mode: "join" } }),
      expect.objectContaining({ id: "entry-cross", shortcut: "X", command: { type: "stage_entry_price", mode: "cross" } }),
      expect.objectContaining({ id: "entry-safe-join", shortcut: "Shift+J", command: { type: "stage_safe_sized_entry", mode: "join" } }),
      expect.objectContaining({ id: "entry-safe-cross", shortcut: "Shift+X", command: { type: "stage_safe_sized_entry", mode: "cross" } }),
      expect.objectContaining({ id: "cycle-slippage", shortcut: "V", command: { type: "cycle_slippage" } }),
      expect.objectContaining({ id: "reset-plan-levels", command: { type: "reset_plan_levels" } }),
    ]));
  });

  it("ranks exact and prefix matches before keyword matches", () => {
    expect(searchTerminalCommands("market sol")[0]).toMatchObject({ id: "market-SOL" });
    expect(searchTerminalCommands("depth").map((command) => command.id)).toEqual(expect.arrayContaining(["chart-depth", "depth-ladder", "depth-book"]));
    expect(searchTerminalCommands("liquidity ladder")[0]).toMatchObject({ id: "depth-ladder" });
    expect(searchTerminalCommands("classic book")[0]).toMatchObject({ id: "depth-book" });
    expect(searchTerminalCommands("replay")[0]).toMatchObject({ id: "toggle-replay" });
    expect(searchTerminalCommands("focus live chart")[0]).toMatchObject({ id: "focus-chart" });
    expect(searchTerminalCommands("portfolio risk")[0]).toMatchObject({ id: "risk-desk" });
    expect(searchTerminalCommands("order entry")[0]).toMatchObject({ id: "ticket" });
    expect(searchTerminalCommands("watchlist")[0]).toMatchObject({ id: "scanner" });
    expect(searchTerminalCommands("fill fees")[0]).toMatchObject({ id: "execution-analytics" });
    expect(searchTerminalCommands("compatible routes")[0]).toMatchObject({ id: "route-check" });
    expect(searchTerminalCommands("saved plans")[0]).toMatchObject({ id: "plan-book" });
    expect(searchTerminalCommands("retry websocket")[0]).toMatchObject({ id: "reconnect-market" });
    expect(searchTerminalCommands("acknowledge unread")[0]).toMatchObject({ id: "alerts" });
    expect(searchTerminalCommands("focus limit")[0]).toMatchObject({ id: "focus-entry" });
    expect(searchTerminalCommands("loss budget")[0]).toMatchObject({ id: "focus-risk-budget" });
    expect(searchTerminalCommands("reset auto")[0]).toMatchObject({ id: "reset-plan-levels" });
    expect(searchTerminalCommands("join bbo")[0]).toMatchObject({ id: "entry-join" });
    expect(searchTerminalCommands("risk size cross")[0]).toMatchObject({ id: "entry-safe-cross" });
  });

  it("handles empty, missing, and bounded queries deterministically", () => {
    expect(searchTerminalCommands("", terminalCommandCatalog(), 3)).toHaveLength(3);
    expect(searchTerminalCommands("does-not-exist")).toEqual([]);
    expect(searchTerminalCommands("chart", terminalCommandCatalog(), 2)).toHaveLength(2);
  });
});
