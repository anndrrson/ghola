import type { TerminalLiveAccountView } from "./terminal-live-account";
import {
  terminalLiveAccountOrderEventKey,
  type TerminalLiveAccountOrderEvent,
} from "./terminal-live-account-events";

export type TerminalLiveOrderReconciliationStatus =
  | "unavailable"
  | "clear"
  | "limited"
  | "pending"
  | "conflict";

export interface TerminalLiveOrderReconciliationItem {
  code: "terminal_snapshot_conflict" | "identity_conflict" | "working_event_ahead" | "unknown_event_ahead" | "terminal_event_ahead";
  orderHandleCommitment: string;
  market: string;
  detail: string;
  blocksExposureIncrease: boolean;
}

export interface TerminalLiveOrderReconciliation {
  status: TerminalLiveOrderReconciliationStatus;
  blocksExposureIncrease: boolean;
  summary: string;
  matchedOrderCount: number;
  snapshotOnlyOrderCount: number;
  hiddenItemCount: number;
  items: readonly TerminalLiveOrderReconciliationItem[];
}

const ITEM_LIMIT = 6;
const TERMINAL_STATUSES = new Set(["canceled", "cancelled", "closed", "expired", "filled", "rejected"]);
const WORKING_STATUSES = new Set(["accepted", "new", "open", "partially-filled", "partially_filled", "pending", "placed", "resting", "triggered", "working"]);

/** Reconciles only causally comparable privacy commitments; missing bounded history is never presented as proof. */
export function deriveTerminalLiveOrderReconciliation(view: TerminalLiveAccountView): TerminalLiveOrderReconciliation {
  const snapshotAtMs = Date.parse(view.lastCheckedAt ?? "");
  if (view.status !== "live" || !Number.isFinite(snapshotAtMs)) {
    return result("unavailable", [], 0, view.openOrders.length, "Current snapshot and lifecycle evidence are required.");
  }

  const latestByCommitment = newestEvents(view.orderEvents);
  const openByCommitment = new Map(view.openOrders.map((order) => [order.order_handle_commitment, order]));
  const items: TerminalLiveOrderReconciliationItem[] = [];
  let matchedOrderCount = 0;
  let snapshotOnlyOrderCount = 0;

  for (const order of view.openOrders) {
    const event = latestByCommitment.get(order.order_handle_commitment);
    if (!event) {
      snapshotOnlyOrderCount += 1;
      continue;
    }
    matchedOrderCount += 1;
    if (event.market !== order.market || (event.side !== "unknown" && order.side !== "unknown" && event.side !== order.side)) {
      items.push(issue("identity_conflict", event, "One order commitment resolves to different market or side identities.", true));
      continue;
    }
    const eventAtMs = Date.parse(event.timeBucket);
    if (eventAtMs <= snapshotAtMs && TERMINAL_STATUSES.has(event.status)) {
      items.push(issue("terminal_snapshot_conflict", event, `Snapshot still reports this order open after a ${event.status} lifecycle event.`, true));
    } else if (eventAtMs > snapshotAtMs && TERMINAL_STATUSES.has(event.status)) {
      items.push(issue("terminal_event_ahead", event, `A newer ${event.status} event is awaiting snapshot confirmation.`, false));
    }
  }

  for (const event of latestByCommitment.values()) {
    if (openByCommitment.has(event.orderHandleCommitment)) continue;
    const eventAtMs = Date.parse(event.timeBucket);
    if (eventAtMs <= snapshotAtMs || TERMINAL_STATUSES.has(event.status)) continue;
    if (WORKING_STATUSES.has(event.status)) {
      items.push(issue("working_event_ahead", event, `A newer ${event.status} event is not yet present in the account snapshot.`, true));
    } else {
      items.push(issue("unknown_event_ahead", event, `A newer unclassified “${event.status}” event is not yet present in the account snapshot.`, true));
    }
  }

  items.sort((left, right) => Number(right.blocksExposureIncrease) - Number(left.blocksExposureIncrease)
    || left.market.localeCompare(right.market)
    || left.orderHandleCommitment.localeCompare(right.orderHandleCommitment)
    || left.code.localeCompare(right.code));
  const blockingCount = items.filter((item) => item.blocksExposureIncrease).length;
  if (blockingCount) {
    const status = items.some((item) => item.code === "terminal_snapshot_conflict" || item.code === "identity_conflict") ? "conflict" : "pending";
    return result(status, items, matchedOrderCount, snapshotOnlyOrderCount, `${blockingCount} unresolved order-state hazard${blockingCount === 1 ? "" : "s"} blocks new exposure.`);
  }
  if (items.length) {
    return result("pending", items, matchedOrderCount, snapshotOnlyOrderCount, "Newer terminal events are awaiting the next account snapshot.");
  }
  if (view.openOrders.length && snapshotOnlyOrderCount === view.openOrders.length) {
    return result("limited", [], matchedOrderCount, snapshotOnlyOrderCount, "Open orders are snapshot-certified; bounded lifecycle history does not cover them.");
  }
  return result("clear", [], matchedOrderCount, snapshotOnlyOrderCount, view.openOrders.length ? "Snapshot and lifecycle state show no causal conflicts." : "No open or newer unresolved order state is reported.");
}

function newestEvents(events: readonly TerminalLiveAccountOrderEvent[]) {
  const latest = new Map<string, TerminalLiveAccountOrderEvent>();
  for (const event of events) {
    const current = latest.get(event.orderHandleCommitment);
    if (!current || compareEvent(event, current) > 0) latest.set(event.orderHandleCommitment, event);
  }
  return latest;
}

function compareEvent(left: TerminalLiveAccountOrderEvent, right: TerminalLiveAccountOrderEvent) {
  return Date.parse(left.timeBucket) - Date.parse(right.timeBucket)
    || left.observedAtMs - right.observedAtMs
    || terminalLiveAccountOrderEventKey(left).localeCompare(terminalLiveAccountOrderEventKey(right));
}

function issue(
  code: TerminalLiveOrderReconciliationItem["code"],
  event: TerminalLiveAccountOrderEvent,
  detail: string,
  blocksExposureIncrease: boolean,
): TerminalLiveOrderReconciliationItem {
  return { code, orderHandleCommitment: event.orderHandleCommitment, market: event.market, detail, blocksExposureIncrease };
}

function result(
  status: TerminalLiveOrderReconciliationStatus,
  allItems: readonly TerminalLiveOrderReconciliationItem[],
  matchedOrderCount: number,
  snapshotOnlyOrderCount: number,
  summary: string,
): TerminalLiveOrderReconciliation {
  const items = allItems.slice(0, ITEM_LIMIT);
  return {
    status,
    blocksExposureIncrease: allItems.some((item) => item.blocksExposureIncrease),
    summary,
    matchedOrderCount,
    snapshotOnlyOrderCount,
    hiddenItemCount: Math.max(0, allItems.length - items.length),
    items,
  };
}
