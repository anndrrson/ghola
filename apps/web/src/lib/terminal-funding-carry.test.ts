import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import {
  deriveTerminalFundingCarry,
  deriveTerminalFundingRateSignal,
  projectTerminalFundingCarry,
  terminalFundingCarryPreviewEqual,
  type TerminalFundingCarryInput,
} from "./terminal-funding-carry";

describe("terminal funding carry", () => {
  it("compares rendered carry semantics independently of object identity", () => {
    const preview = projectTerminalFundingCarry({
      funding: deriveTerminalFundingRateSignal(liveInput()),
      productClass: "perpetual",
      side: "buy",
      notionalUsd: 100,
    });
    expect(terminalFundingCarryPreviewEqual(preview, { ...preview })).toBe(true);
    expect(terminalFundingCarryPreviewEqual(preview, {
      available: false,
      position: "LONG",
      reason: "unavailable",
    })).toBe(false);
  });

  it("exposes a certified signed funding-rate signal without depending on ticket size", () => {
    const input = liveInput({ fundingRate: "-0.000125", notionalUsd: 0 });
    const signal = deriveTerminalFundingRateSignal(input);

    expect(signal).toMatchObject({
      available: true,
      rateFraction: -0.000125,
      ratePercent: -0.0125,
      rateBps: -1.25,
      updatedAtMs: Date.parse("2026-08-12T12:00:00.000Z"),
      expiresAtMs: Date.parse("2026-08-12T12:00:10.000Z"),
    });
    expect(deriveTerminalFundingCarry(input).available).toBe(false);
  });

  it("withholds the alert signal when funding provenance is stale or synthetic", () => {
    const stale = liveInput({ nowMs: Date.parse("2026-08-12T12:00:11.000Z") });
    expect(deriveTerminalFundingRateSignal(stale).available).toBe(false);
    expect(deriveTerminalFundingRateSignal({ ...liveInput(), source: "synthetic" }).available).toBe(false);
  });

  it.each([
    ["buy", "0.0001", -0.1, "pays"],
    ["sell", "0.0001", 0.1, "receives"],
    ["buy", "-0.0002", 0.2, "receives"],
    ["sell", "-0.0002", -0.2, "pays"],
    ["buy", "0", 0, "neutral"],
    ["sell", "0", 0, "neutral"],
  ] as const)("projects %s carry at rate %s", (side, fundingRate, expectedUsd, direction) => {
    const input = liveInput({ side, fundingRate, notionalUsd: 1_000 });
    const preview = deriveTerminalFundingCarry(input);

    expect(preview.available).toBe(true);
    if (!preview.available) return;
    expect(preview.signedCarryUsd).toBeCloseTo(expectedUsd);
    expect(preview.absoluteCarryUsd).toBeCloseTo(Math.abs(expectedUsd));
    expect(preview.direction).toBe(direction);
    expect(preview.position).toBe(side === "buy" ? "LONG" : "SHORT");
  });

  it("uses Phoenix's canonical decimal fraction without converting it again", () => {
    const frame = marketFrame({
      venue: "phoenix",
      product: "SOL-PERP",
      fundingRate: "0.000021",
      fundingRateUnit: "decimal_fraction",
      fundingRateSource: "phoenix_rest_funding_history",
      fundingRateTimeBasis: "venue_event_time",
      fundingRateUpdatedAt: "2026-08-12T12:00:00.000Z",
    });
    const preview = deriveTerminalFundingCarry(liveInput({
      frame,
      venue: "phoenix",
      market: "SOL",
      side: "sell",
      notionalUsd: 1_000,
      nowMs: Date.parse("2026-08-12T12:01:00.000Z"),
    }));

    expect(preview.available).toBe(true);
    if (!preview.available) return;
    expect(preview.ratePercent).toBeCloseTo(0.0021);
    expect(preview.signedCarryUsd).toBeCloseTo(0.021);
    expect(preview.intervalDurationSeconds).toBeNull();
    expect(preview.nextSettlementAt).toBeNull();
  });

  it.each([
    ["spot", (input: TerminalFundingCarryInput) => ({ ...input, productClass: "spot" as const })],
    ["Coinbase", (input: TerminalFundingCarryInput) => ({
      ...input,
      productClass: "perpetual" as const,
      selection: { ...input.selection, venue: "coinbase" as const },
    })],
    ["synthetic source", (input: TerminalFundingCarryInput) => ({ ...input, source: "synthetic" as const })],
    ["stale controller", (input: TerminalFundingCarryInput) => ({
      ...input,
      marketState: { ...input.marketState, stale: true, status: "stale" as const },
    })],
    ["missing rate", (input: TerminalFundingCarryInput) => ({
      ...input,
      ...withFrame(input, { fundingRate: null }),
    })],
    ["nonfinite rate", (input: TerminalFundingCarryInput) => {
      const frame = { ...input.frame!, fundingRate: "Infinity" };
      return { ...input, frame, marketState: { ...input.marketState, frame } };
    }],
    ["invalid notional", (input: TerminalFundingCarryInput) => ({ ...input, notionalUsd: 0 })],
    ["identity mismatch", (input: TerminalFundingCarryInput) => ({
      ...input,
      selection: { ...input.selection, market: "ETH" },
    })],
    ["network mismatch", (input: TerminalFundingCarryInput) => ({
      ...input,
      selection: { ...input.selection, network: "testnet" },
    })],
    ["unknown unit", (input: TerminalFundingCarryInput) => {
      const frame = { ...input.frame!, fundingRateUnit: undefined };
      return { ...input, frame, marketState: { ...input.marketState, frame } };
    }],
    ["missing provenance", (input: TerminalFundingCarryInput) => ({
      ...input,
      ...withFrame(input, { fundingRateSource: null }),
    })],
    ["source mismatch", (input: TerminalFundingCarryInput) => ({
      ...input,
      ...withFrame(input, { fundingRateSource: "phoenix_rest_funding_history" }),
    })],
    ["time-basis mismatch", (input: TerminalFundingCarryInput) => ({
      ...input,
      ...withFrame(input, { fundingRateTimeBasis: "venue_event_time" }),
    })],
    ["stale funding clock", (input: TerminalFundingCarryInput) => ({
      ...input,
      nowMs: Date.parse("2026-08-12T12:00:11.000Z"),
    })],
  ])("fails closed for %s", (_label, mutate) => {
    expect(deriveTerminalFundingCarry(mutate(liveInput())).available).toBe(false);
  });

  it.each([
    ["hyperliquid_rest_asset_context_received", "received_at", 120_001],
    ["hyperliquid_ws_active_asset_context_received", "received_at", 10_001],
    ["phoenix_rest_funding_history", "venue_event_time", 7_200_001],
    ["phoenix_ws_market_stats", "venue_event_time", 10_001],
  ] as const)("expires %s on its source-specific clock", (source, basis, ageMs) => {
    const updatedAtMs = Date.parse("2026-08-12T12:00:00.000Z");
    const phoenix = source.startsWith("phoenix");
    const frame = marketFrame({
      venue: phoenix ? "phoenix" : "hyperliquid",
      product: phoenix ? "SOL-PERP" : "BTC",
      fundingRateSource: source,
      fundingRateTimeBasis: basis,
      fundingRateUpdatedAt: new Date(updatedAtMs).toISOString(),
    });
    const input = liveInput({
      frame,
      venue: phoenix ? "phoenix" : "hyperliquid",
      market: phoenix ? "SOL" : "BTC",
      nowMs: updatedAtMs + ageMs,
    });

    expect(deriveTerminalFundingCarry(input).available).toBe(false);
  });
});

function liveInput(overrides: {
  frame?: GholaMarketFrame;
  venue?: "hyperliquid" | "phoenix" | "coinbase";
  market?: string;
  side?: "buy" | "sell";
  fundingRate?: string;
  notionalUsd?: number;
  nowMs?: number;
} = {}): TerminalFundingCarryInput {
  const frame = overrides.frame ?? marketFrame({ fundingRate: overrides.fundingRate });
  return {
    frame,
    source: "unified_live",
    productClass: "perpetual",
    side: overrides.side ?? "buy",
    notionalUsd: overrides.notionalUsd ?? 100,
    nowMs: overrides.nowMs ?? Date.parse("2026-08-12T12:00:05.000Z"),
    selection: {
      venue: overrides.venue ?? "hyperliquid",
      network: "mainnet",
      market: overrides.market ?? "BTC",
      interval: "5m",
    },
    marketState: {
      status: "live",
      frame,
      loading: false,
      stale: false,
      error: null,
      lastUpdateAt: frame.fetchedAt,
    },
  };
}

function marketFrame(overrides: Partial<GholaMarketFrame> = {}): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    network: "mainnet",
    product: "BTC",
    interval: "5m",
    fetchedAt: "2026-08-12T12:00:00.000Z",
    stale: false,
    mid: "100",
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 20,
    markPrice: "100",
    oraclePrice: "100",
    fundingRate: "0.0001",
    fundingRateUnit: "decimal_fraction",
    fundingRateSource: "hyperliquid_ws_active_asset_context_received",
    fundingRateTimeBasis: "received_at",
    fundingRateUpdatedAt: "2026-08-12T12:00:00.000Z",
    openInterest: "1000",
    dayVolume: "10000",
    candles: [],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
    ...overrides,
  };
}

function withFrame(
  input: TerminalFundingCarryInput,
  overrides: Partial<GholaMarketFrame>,
): Pick<TerminalFundingCarryInput, "frame" | "marketState"> {
  const frame = { ...input.frame!, ...overrides };
  return { frame, marketState: { ...input.marketState, frame } };
}
