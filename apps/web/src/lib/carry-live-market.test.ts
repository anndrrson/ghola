import { describe, expect, it } from "vitest";
import {
  applyCarryLivePatches,
  buildPairCandidates,
  rankCarryCandidatesByNet,
  type CarryLiveMarketPatch,
  type CarryVenueShadow,
} from "./carry-market";
import {
  CARRY_UI_PUBLISH_INTERVAL_MS,
  carryLiveDescriptorKey,
  createCarryLiveMarketStream,
  createCarryPatchPublisher,
} from "./carry-live-market";

describe("carry live market stream", () => {
  it("keeps stream identity stable across non-semantic REST refreshes", () => {
    const initial = venue("aster", "BTC", "aster:BTCUSDT", 28_800_000, 30_000_000);
    const refreshed = {
      ...initial,
      snapshots: initial.snapshots.map((snapshot) => ({
        ...snapshot,
        best_bid_e8: snapshot.best_bid_e8! + 100,
        as_of_ms: snapshot.as_of_ms! + 15_000,
      })),
    };
    expect(carryLiveDescriptorKey([refreshed])).toBe(carryLiveDescriptorKey([initial]));

    const changedInterval = {
      ...initial,
      snapshots: initial.snapshots.map((snapshot) => ({ ...snapshot, funding_interval_ms: 3_600_000 })),
    };
    expect(carryLiveDescriptorKey([changedInterval])).not.toBe(carryLiveDescriptorKey([initial]));
  });

  it("subscribes to Lighter BBO and funding updates and emits normalized ticks", () => {
    const sockets: FakeSocket[] = [];
    const patches: CarryLiveMarketPatch[] = [];
    const stream = createCarryLiveMarketStream({
      venues: [venue("lighter", "BTC", "lighter:0", 28_800_000)],
      onPatch: (patch) => patches.push(patch),
      onStatus: () => undefined,
      webSocketCtor: class extends FakeSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
      now: () => 1_800_000_000_100,
    });
    stream.start();
    sockets[0].open();
    expect(sockets[0].sent).toContain(JSON.stringify({ type: "subscribe", channel: "ticker/0" }));
    expect(sockets[0].sent).toContain(JSON.stringify({ type: "subscribe", channel: "market_stats/0" }));
    sockets[0].message({
      channel: "ticker:0",
      ticker: { market_id: 0, b: { price: "59999.5" }, a: { price: "60000.5" } },
      timestamp: 1_800_000_000_000,
    });
    sockets[0].message({
      channel: "market_stats:0",
      market_stats: { market_id: 0, mark_price: "60000", index_price: "60001", current_funding_rate: "0.0002" },
      timestamp: 1_800_000_000_010,
    });
    expect(patches.at(-1)).toMatchObject({
      venue_id: "lighter",
      asset: "BTC",
      mark_price_e8: 6_000_000_000_000,
      funding_rate_e12_per_interval: 2_000_000,
      funding_interval_ms: 3_600_000,
      received_at_ms: 1_800_000_000_100,
    });
    const emittedCount = patches.length;
    sockets[0].message({
      channel: "market_stats:0",
      market_stats: { market_id: 0, mark_price: "60000", index_price: "60001", current_funding_rate: "0.0002" },
      timestamp: 1_800_000_000_020,
    });
    expect(patches).toHaveLength(emittedCount);
    stream.stop();
  });

  it("keeps a representative recalculation batch inside one 16ms UI frame", () => {
    const venues = [
      venue("hyperliquid", "BTC", "hyperliquid:BTC", 3_600_000, 10_000_000),
      venue("lighter", "BTC", "lighter:0", 28_800_000, 40_000_000),
      venue("aster", "BTC", "aster:BTCUSDT", 28_800_000, 30_000_000),
      venue("edgex", "BTC", "edgex:10000001", 3_600_000, 25_000_000),
      venue("dydx", "BTC", "dydx:BTC-USD", 3_600_000, 20_000_000),
    ];
    const patch: CarryLiveMarketPatch = {
      venue_id: "hyperliquid",
      asset: "BTC",
      received_at_ms: 1_800_000_000_000,
      source_at_ms: 1_800_000_000_000,
      best_bid_e8: 5_999_990_000_000,
      best_ask_e8: 6_000_010_000_000,
      mark_price_e8: 6_000_000_000_000,
      index_price_e8: 6_000_000_000_000,
      funding_rate_e12_per_interval: 11_000_000,
      funding_interval_ms: 3_600_000,
    };
    const iterations = 2_000;
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      const candidates = buildPairCandidates(applyCarryLivePatches(venues, [patch], patch.received_at_ms));
      rankCarryCandidatesByNet(candidates);
    }
    expect(performance.now() - started).toBeLessThan(CARRY_UI_PUBLISH_INTERVAL_MS);
  });

  it("publishes the first tick immediately and coalesces later ticks within one frame", () => {
    let now = 100;
    let scheduled: { callback: () => void; delayMs: number; cancelled: boolean } | null = null;
    const publications: CarryLiveMarketPatch[][] = [];
    const publisher = createCarryPatchPublisher({
      now: () => now,
      onPublish: (patches) => publications.push(patches),
      schedule: (callback, delayMs) => {
        scheduled = { callback, delayMs, cancelled: false };
        return () => {
          if (scheduled) scheduled.cancelled = true;
        };
      },
    });

    publisher.push(livePatch({ funding_rate_e12_per_interval: 10_000_000 }));
    expect(publications).toHaveLength(1);
    now = 110;
    publisher.push(livePatch({ received_at_ms: 110, best_bid_e8: 5_999_990_000_000 }));
    publisher.push(livePatch({ received_at_ms: 111, best_ask_e8: 6_000_010_000_000 }));
    expect(publications).toHaveLength(1);
    expect(scheduled).toMatchObject({ delayMs: 6, cancelled: false });

    now = 116;
    scheduled!.callback();
    expect(publications).toHaveLength(2);
    expect(publications[1]).toEqual([expect.objectContaining({
      received_at_ms: 111,
      funding_rate_e12_per_interval: 10_000_000,
      best_bid_e8: 5_999_990_000_000,
      best_ask_e8: 6_000_010_000_000,
    })]);
    publisher.stop();
  });

  it("suppresses non-BBO dYdX depth churn before it reaches React", () => {
    const sockets: FakeSocket[] = [];
    const patches: CarryLiveMarketPatch[] = [];
    const stream = createCarryLiveMarketStream({
      venues: [venue("dydx", "BTC", "dydx:BTC-USD", 3_600_000)],
      onPatch: (patch) => patches.push(patch),
      onStatus: () => undefined,
      webSocketCtor: class extends FakeSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
      now: () => 1_800_000_000_100,
    });
    stream.start();
    sockets[0].open();
    expect(sockets[0].sent).toContain(JSON.stringify({
      type: "subscribe",
      channel: "v4_orderbook",
      id: "BTC-USD",
      batched: true,
    }));
    sockets[0].message({
      type: "subscribed",
      channel: "v4_orderbook",
      id: "BTC-USD",
      contents: { bids: [["60000", "1"]], asks: [["60001", "1"]] },
    });
    sockets[0].message({
      type: "channel_batch_data",
      channel: "v4_orderbook",
      id: "BTC-USD",
      contents: [{ bids: [["59999", "2"]] }, { asks: [["60002", "2"]] }],
    });
    for (let index = 0; index < 4_000; index += 1) {
      sockets[0].message({
        type: "channel_data",
        channel: "v4_orderbook",
        id: "BTC-USD",
        contents: { bids: [["59000", String(index + 1)]], asks: [] },
      });
    }
    expect(patches).toHaveLength(1);
    stream.stop();
  });
});

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(value: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

function venue(
  venueId: string,
  asset: string,
  contractId: string,
  fundingIntervalMs: number,
  funding = 20_000_000,
): CarryVenueShadow {
  return {
    venue_id: venueId,
    ok: true,
    snapshots: [{
      venue_id: venueId,
      contract_id: contractId,
      asset,
      status: "ready",
      stale: false,
      funding_rate_e12_per_interval: funding,
      funding_interval_ms: fundingIntervalMs,
      maker_fee_bps: 1,
      taker_fee_bps: 2,
      minimum_notional_micro_usdc: 10_000_000,
      initial_margin_bps: 500,
      maintenance_margin_bps: 250,
      mark_price_e8: 6_000_000_000_000,
      index_price_e8: 6_000_000_000_000,
      best_bid_e8: 5_999_900_000_000,
      best_ask_e8: 6_000_100_000_000,
      as_of_ms: 1_800_000_000_000,
      missing_fields: [],
    }],
  };
}

function livePatch(overrides: Partial<CarryLiveMarketPatch> = {}): CarryLiveMarketPatch {
  return {
    venue_id: "hyperliquid",
    asset: "BTC",
    received_at_ms: 100,
    ...overrides,
  };
}
