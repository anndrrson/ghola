export const TERMINAL_PLAN_MUTATION_LOCK_MESSAGE =
  "Plan editing is locked until the current live execution request settles. The dispatched plan remains unchanged.";

export type TerminalPlanMutationDecision =
  | { allowed: true }
  | { allowed: false; blocker: "live_execution_in_flight"; message: string };

export function terminalPlanMutationDecision(
  liveExecutionInFlight: boolean,
): TerminalPlanMutationDecision {
  return liveExecutionInFlight
    ? {
        allowed: false,
        blocker: "live_execution_in_flight",
        message: TERMINAL_PLAN_MUTATION_LOCK_MESSAGE,
      }
    : { allowed: true };
}

const COMMAND_MUTATES_PLAN = {
  select_venue: true,
  select_market: true,
  select_interval: true,
  select_side: true,
  set_notional: true,
  set_slippage: true,
  set_chart_mode: false,
  toggle_study: false,
  toggle_book: false,
  set_depth_view: false,
  fit_chart: false,
  toggle_replay: true,
  open_chart: false,
  open_alerts: false,
  open_paper: false,
  open_ticket: false,
  open_risk_desk: false,
  open_scanner: false,
  open_execution_analytics: false,
  open_route_check: false,
  open_plan_book: false,
  reconnect_market: false,
  focus_ticket_field: false,
  stage_entry_price: true,
  stage_safe_sized_entry: true,
  cycle_slippage: true,
  reset_plan_levels: true,
} as const satisfies Record<TerminalCommand["type"], boolean>;

export function terminalCommandMutatesTradePlan(commandType: TerminalCommand["type"]): boolean {
  return COMMAND_MUTATES_PLAN[commandType];
}
import type { TerminalCommand } from "./terminal-command";
