import type { TerminalLiveAccountView } from "./terminal-live-account";
import { terminalLiveAccountSubjectScopeValid } from "./terminal-live-account-stream";
import { deriveTerminalLiveOrderReconciliation } from "./terminal-live-order-reconciliation";

export type TerminalLiveAccountRiskStatus =
  | "not_applicable"
  | "checking"
  | "blocked"
  | "warning"
  | "safe";

export interface TerminalLiveAccountRiskDecision {
  identityKey: string;
  status: TerminalLiveAccountRiskStatus;
  allowed: boolean;
  reason: string;
  nearestLiquidationDistance: TerminalLiveAccountView["nearestLiquidationDistance"];
  accountStreamCurrent: boolean;
  accountStreamObservedAtMs: number | null;
}

export interface TerminalLiveAccountRiskInput {
  authenticated: boolean;
  subjectScope: string | null;
  selectedVenue: string;
  expectedNetwork: "mainnet" | "testnet";
  market: string;
  reduceOnly: boolean;
  view: TerminalLiveAccountView | null;
}

export function terminalLiveAccountRiskIdentity(input: Omit<TerminalLiveAccountRiskInput, "view">) {
  return [
    terminalLiveAccountSubjectScopeValid(input.subjectScope) ? input.subjectScope : "subject_unavailable",
    input.authenticated ? "authenticated" : "signed_out",
    input.selectedVenue,
    input.expectedNetwork,
    input.market.trim().toUpperCase(),
    input.reduceOnly ? "reduce_only" : "exposure_increasing",
  ].join(":");
}

export function deriveTerminalLiveAccountRisk(
  input: TerminalLiveAccountRiskInput,
): TerminalLiveAccountRiskDecision {
  const identityKey = terminalLiveAccountRiskIdentity(input);
  const accountStreamCurrent = Boolean(
    terminalLiveAccountSubjectScopeValid(input.subjectScope) &&
    input.view?.status === "live" &&
    input.view.network === input.expectedNetwork,
  );
  const finish = (
    status: TerminalLiveAccountRiskStatus,
    allowed: boolean,
    reason: string,
    nearestLiquidationDistance: TerminalLiveAccountView["nearestLiquidationDistance"],
  ) => decision(
    identityKey,
    status,
    allowed,
    reason,
    nearestLiquidationDistance,
    accountStreamCurrent,
    accountStreamCurrent ? input.view?.streamObservedAtMs ?? null : null,
  );
  if (input.selectedVenue !== "hyperliquid") {
    return finish("not_applicable", true, "Hyperliquid portfolio interlock is not applicable to this venue.", null);
  }
  if (!input.authenticated) {
    return finish("checking", false, "Sign in to verify the exact Hyperliquid portfolio before live submit.", null);
  }
  if (!terminalLiveAccountSubjectScopeValid(input.subjectScope)) {
    return finish("blocked", false, "Live submit blocked until the authenticated account context is verified.", null);
  }
  if (!input.view || input.view.status !== "live" || input.view.network !== input.expectedNetwork) {
    return finish("blocked", false, "Live submit blocked until the exact Hyperliquid account stream is verified and current.", input.view?.nearestLiquidationDistance ?? null);
  }
  if (input.reduceOnly) {
    return finish("safe", true, "Exit-only order permitted with a current account stream; server-side reduction checks still apply.", input.view.nearestLiquidationDistance);
  }
  const orderReconciliation = deriveTerminalLiveOrderReconciliation(input.view);
  if (orderReconciliation.blocksExposureIncrease) {
    return finish("blocked", false, `Exposure increase blocked: ${orderReconciliation.summary}`, input.view.nearestLiquidationDistance);
  }
  if (input.view.positionsTruncated || input.view.openOrdersTruncated) {
    return finish("blocked", false, "Exposure increase blocked: the account has positions or orders outside the bounded live view.", input.view.nearestLiquidationDistance);
  }
  if (input.view.accountStatus !== "ready_to_trade") {
    return finish("blocked", false, "Exposure increase blocked: the account is not ready to trade.", input.view.nearestLiquidationDistance);
  }
  if (input.view.accountSource === "none") {
    return finish("blocked", false, "Exposure increase blocked: no verified account source is attached.", input.view.nearestLiquidationDistance);
  }
  if (input.view.equityBucket !== "ready") {
    return finish("blocked", false, "Exposure increase blocked: verified account equity is unavailable or below the live-trading threshold.", input.view.nearestLiquidationDistance);
  }
  if (input.view.marginUtilizationBucket === "unknown") {
    return finish("blocked", false, "Exposure increase blocked: account margin utilization is unavailable.", input.view.nearestLiquidationDistance);
  }
  if (input.view.marginUtilizationBucket === "90%+") {
    return finish("blocked", false, "Exposure increase blocked: account margin utilization is at least 90%.", input.view.nearestLiquidationDistance);
  }
  if (!input.view.tradingEnabled) {
    return finish("blocked", false, "Live submit blocked because the verified account snapshot does not report trading enabled.", input.view.nearestLiquidationDistance);
  }
  if (input.view.positions.some((position) => position.liquidation_distance_bucket === "unknown")) {
    return finish("blocked", false, "Exposure increase blocked: liquidation distance is unknown for an open position.", input.view.nearestLiquidationDistance);
  }
  if (input.view.positions.some((position) => position.liquidation_distance_bucket === "at_or_beyond" || position.liquidation_distance_bucket === "<2%")) {
    return finish("blocked", false, "Exposure increase blocked: an open position is at or within 2% of liquidation.", input.view.nearestLiquidationDistance);
  }
  const workingExposureOrders = input.view.openOrders.filter((order) => !order.reduce_only).length;
  if (workingExposureOrders > 0) {
    return finish(
      "blocked",
      false,
      `Exposure increase blocked: ${workingExposureOrders} exposure-increasing order${workingExposureOrders === 1 ? " is" : "s are"} already working and cannot be included exactly in the privacy-bucketed loss budget. Cancel externally or wait for completion; reduce-only exits remain available.`,
      input.view.nearestLiquidationDistance,
    );
  }
  const liquidationWarning = input.view.positions.some((position) => position.liquidation_distance_bucket === "2-5%");
  const marginWarning = input.view.marginUtilizationBucket === "75-90%";
  if (liquidationWarning || marginWarning) {
    const reasons = [
      liquidationWarning ? "an open position is within 2–5% of liquidation" : null,
      marginWarning ? "account margin utilization is 75–90%" : null,
    ].filter(Boolean).join("; ");
    return finish("warning", true, `Caution: ${reasons}.`, input.view.nearestLiquidationDistance);
  }
  return finish("safe", true, input.view.positions.length === 0
    ? "Current account stream reports no open positions."
    : "Current account stream reports no critical liquidation proximity.", input.view.nearestLiquidationDistance);
}

export function terminalLiveAccountRiskDecisionEqual(
  left: TerminalLiveAccountRiskDecision | null,
  right: TerminalLiveAccountRiskDecision,
) {
  return Boolean(left &&
    left.identityKey === right.identityKey &&
    left.status === right.status &&
    left.allowed === right.allowed &&
    left.reason === right.reason &&
    left.nearestLiquidationDistance === right.nearestLiquidationDistance &&
    left.accountStreamCurrent === right.accountStreamCurrent);
}

function decision(
  identityKey: string,
  status: TerminalLiveAccountRiskStatus,
  allowed: boolean,
  reason: string,
  nearestLiquidationDistance: TerminalLiveAccountView["nearestLiquidationDistance"],
  accountStreamCurrent: boolean,
  accountStreamObservedAtMs: number | null,
): TerminalLiveAccountRiskDecision {
  return { identityKey, status, allowed, reason, nearestLiquidationDistance, accountStreamCurrent, accountStreamObservedAtMs };
}
