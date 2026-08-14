import { describe, expect, it } from "vitest";
import {
  TERMINAL_PLAN_MUTATION_LOCK_MESSAGE,
  terminalCommandMutatesTradePlan,
  terminalPlanMutationDecision,
} from "./terminal-plan-mutation-lock";

describe("terminalPlanMutationDecision", () => {
  it("allows edits only while no live request owns the plan", () => {
    expect(terminalPlanMutationDecision(false)).toEqual({ allowed: true });
    expect(terminalPlanMutationDecision(true)).toEqual({
      allowed: false,
      blocker: "live_execution_in_flight",
      message: TERMINAL_PLAN_MUTATION_LOCK_MESSAGE,
    });
  });

  it("classifies every command that changes execution intent or context", () => {
    for (const type of [
      "select_venue",
      "select_market",
      "select_interval",
      "select_side",
      "set_notional",
      "set_slippage",
      "toggle_replay",
      "stage_entry_price",
      "stage_safe_sized_entry",
      "cycle_slippage",
      "reset_plan_levels",
    ] as const) {
      expect(terminalCommandMutatesTradePlan(type), type).toBe(true);
    }
    for (const type of ["open_ticket", "open_chart", "fit_chart", "toggle_book", "open_execution_analytics"] as const) {
      expect(terminalCommandMutatesTradePlan(type), type).toBe(false);
    }
  });
});
