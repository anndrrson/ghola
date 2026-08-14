import { describe, expect, it } from "vitest";
import {
  createPaperTradingState,
  paperPositionKey,
  placePaperOrder,
  serializePaperTradingState,
  type PaperMark,
  type PaperPosition,
  type PaperTradingState,
} from "./paper-trading-engine";
import type { GholaMarketFrame } from "./ghola-market-chart";
import {
  createTerminalPaperMarkRefreshRequest,
  deriveTerminalPaperRiskDesk,
  resolveTerminalPaperMarketTarget,
  restoreTerminalPaperPositionMark,
  terminalPaperMarkRefreshComplete,
} from "./terminal-paper-risk-desk";

const NOW = "2026-08-12T12:00:30.000Z";
const FRESH = "2026-08-12T12:00:20.000Z";
const STALE = "2026-08-12T11:58:00.000Z";

describe("terminal paper risk desk", () => {
  it("derives concentration, directional exposure, P&L, limits, and symmetric shocks", () => {
    const state = portfolio([
      position("hyperliquid", "BTC-PERP", 2, 100, 5, 1),
      position("phoenix", "ETH-USD", -3, 50, -2, 0.5),
    ], [
      mark("hyperliquid", "BTC-PERP", 110, FRESH),
      mark("phoenix", "ETH-USD", 40, FRESH),
    ]);
    state.risk_control = {
      ...state.risk_control,
      session_start_equity_usd: 10_100,
      session_peak_equity_usd: 10_200,
      last_equity_usd: 10_000,
    };
    const before = structuredClone(state);

    const desk = deriveTerminalPaperRiskDesk(state, { now: NOW, maxAgeMs: 30_000 });

    expect(state).toEqual(before);
    expect(desk).toMatchObject({
      portfolioFullyPriced: true,
      openPositionCount: 2,
      pricedPositionCount: 2,
      unpricedPositionCount: 0,
      markCoveragePct: 100,
      grossNotionalUsd: 340,
      netNotionalUsd: 100,
      longNotionalUsd: 220,
      shortNotionalUsd: 120,
      riskControlStatus: "armed",
    });
    expect(desk.netBiasPct).toBeCloseTo(100 / 340 * 100);
    expect(desk.largestConcentrationPct).toBeCloseTo(220 / 340 * 100);
    expect(desk.positions[0]).toMatchObject({
      product: "BTC-PERP",
      side: "long",
      grossNotionalUsd: 220,
      signedNotionalUsd: 220,
      pnlUsd: 24,
    });
    expect(desk.positions[0].riskContributionPct).toBeCloseTo(220 / 340 * 100);
    expect(desk.positions[1]).toMatchObject({
      product: "ETH-USD",
      side: "short",
      grossNotionalUsd: 120,
      signedNotionalUsd: -120,
      pnlUsd: 27.5,
    });
    expect(desk.sessionLossUsd).toBeCloseTo(48.5);
    expect(desk.sessionLossUtilizationPct).toBeCloseTo(24.25);
    expect(desk.drawdownUsd).toBeCloseTo(148.5);
    expect(desk.drawdownUtilizationPct).toBeCloseTo(49.5);
    expect(desk.scenarios.find((scenario) => scenario.shockPct === -5)).toMatchObject({
      pnlChangeUsd: -5,
      stressedEquityUsd: 10_046.5,
      partial: false,
    });
    expect(desk.scenarios.find((scenario) => scenario.shockPct === 5)).toMatchObject({
      pnlChangeUsd: 5,
      stressedEquityUsd: 10_056.5,
      partial: false,
    });
  });

  it("excludes stale and missing marks and labels every shock total partial", () => {
    const state = portfolio([
      position("hyperliquid", "BTC-PERP", 1, 100),
      position("phoenix", "ETH-USD", 2, 50),
      position("coinbase", "SOL-USD", -4, 25),
    ], [
      mark("hyperliquid", "BTC-PERP", 105, FRESH),
      mark("phoenix", "ETH-USD", 60, STALE),
    ]);

    const desk = deriveTerminalPaperRiskDesk(state, { now: NOW, maxAgeMs: 30_000 });

    expect(desk).toMatchObject({
      portfolioFullyPriced: false,
      pricedPositionCount: 1,
      unpricedPositionCount: 2,
      grossNotionalUsd: 105,
      netNotionalUsd: 105,
    });
    expect(desk.markCoveragePct).toBeCloseTo(100 / 3);
    expect(desk.positions.map((position) => position.markStatus)).toEqual(["fresh", "missing", "stale"]);
    expect(desk.positions.filter((position) => position.markStatus !== "fresh").every((position) =>
      position.grossNotionalUsd == null && position.riskContributionPct == null && position.pnlUsd == null)).toBe(true);
    expect(desk.scenarios.every((scenario) => scenario.partial && scenario.stressedEquityUsd == null)).toBe(true);
    expect(desk.scenarios.find((scenario) => scenario.shockPct === -2)?.pnlChangeUsd).toBe(-2.1);
  });

  it("is flat-safe without claiming mark coverage", () => {
    const desk = deriveTerminalPaperRiskDesk(createPaperTradingState({ now: NOW }), { now: NOW, maxAgeMs: 30_000 });

    expect(desk).toMatchObject({
      portfolioFullyPriced: true,
      openPositionCount: 0,
      grossNotionalUsd: 0,
      netNotionalUsd: 0,
      markCoveragePct: null,
      netBiasPct: null,
      largestConcentrationPct: null,
    });
    expect(desk.scenarios.every((scenario) => scenario.pnlChangeUsd === 0 && scenario.stressedEquityUsd === 10_000)).toBe(true);
  });

  it("maps only exact supported persisted identities", () => {
    const cases = [
      ["hyperliquid", "mainnet", "BTC-PERP", "BTC"],
      ["hyperliquid", "testnet", "HYPE-PERP", "HYPE"],
      ["phoenix", "mainnet", "SOL-PERP", "SOL"],
      ["coinbase", "mainnet", "ETH-USD", "ETH"],
    ] as const;
    for (const [venueId, network, product, market] of cases) {
      const positionKey = paperPositionKey({ venue_id: venueId, network, product });
      expect(resolveTerminalPaperMarketTarget({ positionKey, venueId, network, product })).toEqual({
        venueId,
        network,
        product,
        market,
      });
    }
    expect(resolveTerminalPaperMarketTarget({
      positionKey: "hyperliquid:mainnet:BTC-PERP",
      venueId: "hyperliquid",
      network: "mainnet",
      product: "BTC",
    })).toBeNull();
    expect(resolveTerminalPaperMarketTarget({
      positionKey: "phoenix:testnet:SOL-PERP",
      venueId: "phoenix",
      network: "testnet",
      product: "SOL-PERP",
    })).toBeNull();
    expect(resolveTerminalPaperMarketTarget({
      positionKey: "coinbase:mainnet:BTC-PERP",
      venueId: "coinbase",
      network: "mainnet",
      product: "BTC-PERP",
    })).toBeNull();
  });

  it("restores a mark from a new exact fresh live frame without evaluating orders or positions", () => {
    const markedState = portfolio([
      position("hyperliquid", "BTC-PERP", 1, 100),
    ], [
      mark("hyperliquid", "BTC-PERP", 90, STALE),
    ]);
    const state = placePaperOrder(markedState, {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "sell",
      order_type: "market",
      time_in_force: "IOC",
      reference_price: 90,
      quote_notional_usd: 90,
      base_size: 1,
      reduce_only: true,
      submitted_at: STALE,
    }, { now: STALE, maxAgeMs: 30_000 });
    const request = createTerminalPaperMarkRefreshRequest(state, "hyperliquid:mainnet:BTC-PERP");
    expect(request).not.toBeNull();
    const before = structuredClone(state);
    const restored = restoreTerminalPaperPositionMark(state, request!, {
      frame: { ...marketFrame({ fetchedAt: FRESH, markPrice: "105" }), markPrice: null, mid: null },
      selectedVenueId: "hyperliquid",
      selectedNetwork: "mainnet",
      selectedProduct: "BTC-PERP",
      marketDataLive: true,
      observedAt: NOW,
      maxAgeMs: 30_000,
    });

    expect(state).toEqual(before);
    expect(restored.refreshed).toBe(true);
    expect(restored.state.positions).toEqual(state.positions);
    expect(restored.state.orders).toEqual(state.orders);
    expect(restored.state.orders[0]).toMatchObject({ status: "pending", filled_base_size: 0 });
    expect(restored.state.fills).toEqual(state.fills);
    expect(restored.state.marks.find((item) => item.position_key === request?.positionKey)).toMatchObject({
      mark_price: 105,
      fetched_at: FRESH,
      observed_at: NOW,
    });
    expect(terminalPaperMarkRefreshComplete(restored.state, request!, NOW, 30_000)).toBe(true);
    expect(() => serializePaperTradingState(restored.state)).not.toThrow();

    const repeated = restoreTerminalPaperPositionMark(restored.state, request!, {
      frame: marketFrame({ fetchedAt: FRESH, markPrice: "106" }),
      selectedVenueId: "hyperliquid",
      selectedNetwork: "mainnet",
      selectedProduct: "BTC-PERP",
      marketDataLive: true,
      observedAt: NOW,
      maxAgeMs: 30_000,
    });
    expect(repeated).toEqual({ state: restored.state, refreshed: false });
  });

  it("keeps the state untouched for synthetic, stale, or identity-mismatched frames", () => {
    const state = portfolio([
      position("hyperliquid", "BTC-PERP", 1, 100),
    ], [
      mark("hyperliquid", "BTC-PERP", 90, STALE),
    ]);
    const request = createTerminalPaperMarkRefreshRequest(state, "hyperliquid:mainnet:BTC-PERP");
    if (!request) throw new Error("missing mark refresh request");
    const base = {
      frame: marketFrame({ fetchedAt: FRESH, markPrice: "105" }),
      selectedVenueId: "hyperliquid",
      selectedNetwork: "mainnet",
      selectedProduct: "BTC-PERP",
      marketDataLive: true,
      observedAt: NOW,
      maxAgeMs: 30_000,
    };
    const blocked = [
      { ...base, marketDataLive: false },
      { ...base, frame: { ...base.frame, stale: true } },
      { ...base, frame: { ...base.frame, venue: "coinbase" as const } },
      { ...base, frame: { ...base.frame, product: "ETH-PERP" } },
      { ...base, frame: { ...base.frame, product: "BTC-USD" } },
      { ...base, frame: { ...base.frame, network: "testnet" } },
      { ...base, selectedNetwork: "testnet" },
      { ...base, selectedProduct: "BTC-USD" },
      { ...base, frame: marketFrame({ fetchedAt: STALE, markPrice: "105" }) },
      { ...base, frame: { ...base.frame, componentTimestamps: {} } },
      { ...base, frame: { ...base.frame, componentTimestamps: { quote: Date.parse(STALE) } } },
      { ...base, frame: { ...base.frame, componentTimestamps: { quote: Date.parse(NOW) + 1 } } },
      { ...base, frame: { ...base.frame, bestBid: null } },
      { ...base, frame: { ...base.frame, bestAsk: null } },
      { ...base, frame: { ...base.frame, bestBid: "106", bestAsk: "106" } },
    ];

    for (const input of blocked) {
      expect(restoreTerminalPaperPositionMark(state, request, input)).toEqual({ state, refreshed: false });
    }
    expect(terminalPaperMarkRefreshComplete(state, request, NOW, 30_000)).toBe(false);

    const nativeHyperliquidProduct = restoreTerminalPaperPositionMark(state, request, {
      ...base,
      frame: { ...base.frame, product: "BTC" },
    });
    expect(nativeHyperliquidProduct.refreshed).toBe(true);
  });
});

function portfolio(positions: PaperPosition[], marks: PaperMark[]): PaperTradingState {
  return {
    ...createPaperTradingState({ now: NOW }),
    positions,
    marks,
  };
}

function position(
  venueId: string,
  product: string,
  quantityBase: number,
  averageEntryPrice: number,
  realizedPnlGrossUsd = 0,
  feesPaidUsd = 0,
): PaperPosition {
  const identity = { venue_id: venueId, network: "mainnet", product };
  return {
    position_key: paperPositionKey(identity),
    ...identity,
    quantity_base: quantityBase,
    average_entry_price: averageEntryPrice,
    realized_pnl_gross_usd: realizedPnlGrossUsd,
    fees_paid_usd: feesPaidUsd,
    opened_at: "2026-08-12T11:00:00.000Z",
    updated_at: FRESH,
  };
}

function mark(venueId: string, product: string, markPrice: number, time: string): PaperMark {
  const identity = { venue_id: venueId, network: "mainnet", product };
  return {
    position_key: paperPositionKey(identity),
    ...identity,
    mark_price: markPrice,
    fetched_at: time,
    observed_at: time,
  };
}

function marketFrame(input: { fetchedAt: string; markPrice: string }): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    interval: "5m",
    fetchedAt: input.fetchedAt,
    stale: false,
    mid: input.markPrice,
    bestBid: "104",
    bestAsk: "106",
    spreadBps: 2,
    markPrice: input.markPrice,
    oraclePrice: input.markPrice,
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
    componentTimestamps: {
      quote: Date.parse(input.fetchedAt),
      book: Date.parse(input.fetchedAt),
    },
  };
}
