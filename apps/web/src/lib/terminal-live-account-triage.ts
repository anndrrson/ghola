import type { TerminalLiveAccountView } from "./terminal-live-account";

export type TerminalLiveAccountTriageSeverity = "critical" | "blocked" | "warning" | "clear";

export interface TerminalLiveAccountTriageItem {
  code: string;
  severity: Exclude<TerminalLiveAccountTriageSeverity, "clear">;
  label: string;
  detail: string;
  market: string | null;
}

export interface TerminalLiveAccountTriage {
  severity: TerminalLiveAccountTriageSeverity;
  items: TerminalLiveAccountTriageItem[];
  hiddenItemCount: number;
}

const ITEM_LIMIT = 6;
const SEVERITY_RANK: Record<Exclude<TerminalLiveAccountTriageSeverity, "clear">, number> = {
  critical: 0,
  blocked: 1,
  warning: 2,
};

/** Ranks only claims explicitly supported by the privacy-bucketed account view. */
export function deriveTerminalLiveAccountTriage(view: TerminalLiveAccountView): TerminalLiveAccountTriage {
  const items: TerminalLiveAccountTriageItem[] = [];
  const add = (
    code: string,
    severity: TerminalLiveAccountTriageItem["severity"],
    label: string,
    detail: string,
    market: string | null = null,
  ) => items.push({ code, severity, label, detail, market });

  if (view.status !== "live") {
    add("account_evidence_not_current", "blocked", "Evidence not current", "Refresh the exact account stream before relying on retained rows.");
  }
  if (view.positionsTruncated) {
    add("positions_truncated", "blocked", "Positions outside view", `${view.positionTotalCount - view.positions.length} position row${view.positionTotalCount - view.positions.length === 1 ? " is" : "s are"} hidden by the privacy row bound.`);
  }
  if (view.openOrdersTruncated) {
    add("orders_truncated", "blocked", "Orders outside view", `${view.openOrderTotalCount - view.openOrders.length} order row${view.openOrderTotalCount - view.openOrders.length === 1 ? " is" : "s are"} hidden by the privacy row bound.`);
  }
  if (view.accountStatus !== "ready_to_trade") {
    add("account_not_ready", "blocked", "Account not ready", `Verified account status is ${view.accountStatus?.replaceAll("_", " ") ?? "unknown"}.`);
  }
  if (view.accountSource === "none" || view.accountSource == null) {
    add("account_source_missing", "blocked", "Account source missing", "No verified live-account source is attached to this view.");
  }
  if (view.equityBucket !== "ready") {
    add("equity_not_ready", "blocked", "Equity not ready", `Verified equity bucket is ${view.equityBucket ?? "unknown"}.`);
  }
  if (!view.tradingEnabled) {
    add("trading_disabled", "blocked", "Trading disabled", "The current verified account snapshot does not permit trading.");
  }
  if (view.marginUtilizationBucket === "90%+") {
    add("margin_critical", "critical", "Margin use 90%+", "Exposure is in the highest reported margin-utilization bucket.");
  } else if (view.marginUtilizationBucket === "unknown") {
    add("margin_unknown", "blocked", "Margin unknown", "Margin utilization cannot be verified from the current snapshot.");
  } else if (view.marginUtilizationBucket === "75-90%") {
    add("margin_warning", "warning", "Margin use 75–90%", "Account margin utilization is elevated.");
  }

  for (const position of view.positions) {
    const distance = position.liquidation_distance_bucket;
    if (distance === "at_or_beyond") {
      add(`liquidation:${position.position_commitment}`, "critical", `${position.market} at/beyond liquidation`, "The reported liquidation-distance bucket is at or beyond the liquidation level.", position.market);
    } else if (distance === "<2%") {
      add(`liquidation:${position.position_commitment}`, "critical", `${position.market} liquidation <2%`, "The reported liquidation-distance bucket is under 2%.", position.market);
    } else if (distance === "unknown") {
      add(`liquidation:${position.position_commitment}`, "blocked", `${position.market} liquidation unknown`, "Liquidation distance cannot be verified for this position.", position.market);
    } else if (distance === "2-5%") {
      add(`liquidation:${position.position_commitment}`, "warning", `${position.market} liquidation 2–5%`, "The position is in the 2–5% liquidation-distance bucket.", position.market);
    }
  }

  const exposureOrders = view.openOrders.filter((order) => !order.reduce_only);
  if (exposureOrders.length) {
    add(
      "working_exposure_orders",
      "blocked",
      `${exposureOrders.length} exposure order${exposureOrders.length === 1 ? "" : "s"} working`,
      "Privacy-bucketed loss cannot be bounded exactly while exposure-increasing orders are open.",
      exposureOrders.length === 1 ? exposureOrders[0]?.market ?? null : null,
    );
  }

  items.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    || (left.market ?? "").localeCompare(right.market ?? "")
    || left.code.localeCompare(right.code));
  const visible = items.slice(0, ITEM_LIMIT);
  return {
    severity: visible[0]?.severity ?? "clear",
    items: visible,
    hiddenItemCount: Math.max(0, items.length - visible.length),
  };
}
