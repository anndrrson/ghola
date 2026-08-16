import type { GholaMarketFrame } from "./ghola-market-chart";
import { fundingMaxAgeMs, inspectCanonicalFundingRate } from "./market-funding-rate";
import { terminalFrameMatchesSelection, type TerminalMarketVenue } from "./terminal-market-identity";
import type { UnifiedLiveMarketState } from "./unified-live-market";

export type TerminalFundingProductClass = "perpetual" | "spot";
export type TerminalFundingSide = "buy" | "sell";
export type TerminalFundingDirection = "pays" | "receives" | "neutral";
export type TerminalFundingSource = "unified_live" | "synthetic";

export type TerminalFundingLiveState = Pick<
  UnifiedLiveMarketState,
  "status" | "frame" | "loading" | "stale" | "error" | "lastUpdateAt"
>;

export interface TerminalFundingCarryInput {
  frame: GholaMarketFrame | null;
  marketState: TerminalFundingLiveState;
  source: TerminalFundingSource;
  selection: {
    venue: TerminalMarketVenue;
    network: string;
    market: string;
    interval: string;
  };
  productClass: TerminalFundingProductClass;
  side: TerminalFundingSide;
  notionalUsd: unknown;
  nowMs?: number;
}

export type TerminalFundingRateSignal =
  | {
      available: true;
      rateFraction: number;
      ratePercent: number;
      rateBps: number;
      updatedAtMs: number;
      expiresAtMs: number;
    }
  | {
      available: false;
      reason: string;
    };

export type TerminalFundingCarryPreview =
  | {
      available: true;
      position: "LONG" | "SHORT";
      direction: TerminalFundingDirection;
      reportedRate: number;
      rateFraction: number;
      ratePercent: number;
      signedCarryUsd: number;
      absoluteCarryUsd: number;
      intervalLabel: "reported funding interval";
      intervalDurationSeconds: null;
      nextSettlementAt: null;
    }
  | {
      available: false;
      position: "LONG" | "SHORT";
      reason: string;
    };

export function terminalFundingCarryPreviewEqual(
  left: TerminalFundingCarryPreview,
  right: TerminalFundingCarryPreview,
) {
  if (left.available !== right.available || left.position !== right.position) return false;
  if (!left.available || !right.available) {
    return !left.available && !right.available && left.reason === right.reason;
  }
  return left.direction === right.direction
    && left.reportedRate === right.reportedRate
    && left.rateFraction === right.rateFraction
    && left.ratePercent === right.ratePercent
    && left.signedCarryUsd === right.signedCarryUsd
    && left.absoluteCarryUsd === right.absoluteCarryUsd
    && left.intervalLabel === right.intervalLabel
    && left.intervalDurationSeconds === right.intervalDurationSeconds
    && left.nextSettlementAt === right.nextSettlementAt;
}

/** Certified perpetual funding rate, independent of the staged order size. */
export function deriveTerminalFundingRateSignal(
  input: Omit<TerminalFundingCarryInput, "side" | "notionalUsd">,
): TerminalFundingRateSignal {
  const unavailable = (reason: string): TerminalFundingRateSignal => ({
    available: false,
    reason,
  });
  if (input.productClass === "spot" || input.selection.venue === "coinbase") {
    return unavailable("Spot markets do not have perpetual funding carry.");
  }
  if (input.source !== "unified_live") {
    return unavailable("Synthetic market data cannot project funding carry.");
  }
  const frame = input.frame;
  if (!frame || input.marketState.frame !== frame) {
    return unavailable("The exact unified live frame is unavailable.");
  }
  if (!terminalFrameMatchesSelection(frame, input.selection)) {
    return unavailable("The funding frame does not match the selected market identity.");
  }
  const frameNetwork = canonicalNetwork(frame.network);
  const selectedNetwork = canonicalNetwork(input.selection.network);
  if (!frameNetwork || !selectedNetwork || frameNetwork !== selectedNetwork) {
    return unavailable("The funding frame does not match the selected network identity.");
  }
  const transportUsable = input.marketState.status === "live" ||
    input.marketState.status === "fallback_polling";
  if (
    input.marketState.loading ||
    input.marketState.stale ||
    input.marketState.error != null ||
    !transportUsable ||
    frame.stale ||
    !frame.fetchedAt ||
    input.marketState.lastUpdateAt !== frame.fetchedAt
  ) {
    return unavailable("A fresh unified live funding snapshot is required.");
  }
  if (frame.fundingRate == null || frame.fundingRate.trim() === "") {
    return unavailable("The selected venue did not report a funding rate.");
  }
  if (frame.venue !== "hyperliquid" && frame.venue !== "phoenix") {
    return unavailable("The selected venue has no trusted funding contract.");
  }
  const funding = inspectCanonicalFundingRate({
    rate: frame.fundingRate,
    unit: frame.fundingRateUnit,
    source: frame.fundingRateSource,
    timeBasis: frame.fundingRateTimeBasis,
    updatedAt: frame.fundingRateUpdatedAt,
    venue: frame.venue,
  }, input.nowMs ?? Date.now());
  if (!funding) {
    return unavailable("Fresh funding unit, source, time basis, and update time are required.");
  }
  return {
    available: true,
    rateFraction: funding.rateFraction,
    ratePercent: funding.rateFraction * 100,
    rateBps: funding.rateFraction * 10_000,
    updatedAtMs: funding.updatedAtMs,
    expiresAtMs: funding.updatedAtMs + fundingMaxAgeMs(funding.source),
  };
}

/** Informational snapshot projection. It never authorizes or blocks execution. */
export function deriveTerminalFundingCarry(
  input: TerminalFundingCarryInput,
): TerminalFundingCarryPreview {
  return projectTerminalFundingCarry({
    funding: deriveTerminalFundingRateSignal(input),
    productClass: input.productClass,
    side: input.side,
    notionalUsd: input.notionalUsd,
  });
}

export function projectTerminalFundingCarry(input: {
  funding: TerminalFundingRateSignal;
  productClass: TerminalFundingProductClass;
  side: TerminalFundingSide;
  notionalUsd: unknown;
}): TerminalFundingCarryPreview {
  const position = input.side === "buy" ? "LONG" : "SHORT";
  const unavailable = (reason: string): TerminalFundingCarryPreview => ({
    available: false,
    position,
    reason,
  });

  if (input.productClass === "spot") {
    return unavailable("Spot markets do not have perpetual funding carry.");
  }
  const notionalUsd = finitePositive(input.notionalUsd);
  if (notionalUsd == null) {
    return unavailable("Set a positive finite order notional to project funding carry.");
  }
  const funding = input.funding;
  if (!funding.available) return unavailable(funding.reason);
  const rateFraction = funding.rateFraction;
  const reportedRate = rateFraction;

  // Positive funding convention: longs pay shorts. Positive signed carry is
  // cash received by the selected position; negative is cash paid.
  const projected = notionalUsd * rateFraction * (input.side === "buy" ? -1 : 1);
  if (!Number.isFinite(projected)) {
    return unavailable("The funding carry projection is not finite.");
  }
  const signedCarryUsd = Object.is(projected, -0) ? 0 : projected;
  const direction: TerminalFundingDirection = signedCarryUsd > 0
    ? "receives"
    : signedCarryUsd < 0
      ? "pays"
      : "neutral";

  return {
    available: true,
    position,
    direction,
    reportedRate,
    rateFraction,
    ratePercent: funding.ratePercent,
    signedCarryUsd,
    absoluteCarryUsd: Math.abs(signedCarryUsd),
    intervalLabel: "reported funding interval",
    intervalDurationSeconds: null,
    nextSettlementAt: null,
  };
}

function finitePositive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function canonicalNetwork(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "mainnet" || normalized === "testnet" ? normalized : null;
}
