import type {
  CarryLiveMarketPatch,
  CarryShadowSnapshot,
  CarryVenueShadow,
} from "./carry-market";
import { CARRY_BROWSER_STREAM_VENUES } from "./carry-venues";

export type CarryLiveVenueStatus = "connecting" | "live" | "reconnecting" | "unavailable";

type WebSocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

type WebSocketConstructor = new (url: string) => WebSocketLike;

type MarketRef = {
  venueId: string;
  asset: string;
  contractId: string;
  fundingIntervalMs: number | null;
};

type BookState = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  bestBid: number | null;
  bestAsk: number | null;
};

const UNCHANGED_PATCH_HEARTBEAT_MS = 1_000;
// One visual frame: preserve every latest venue value without asking React to
// render faster than the display can present it.
export const CARRY_UI_PUBLISH_INTERVAL_MS = 16;

export interface CarryLiveMarketStream {
  start: () => void;
  stop: () => void;
}

export interface CarryPatchPublisher {
  push: (patch: CarryLiveMarketPatch) => void;
  stop: () => void;
}

export function createCarryPatchPublisher(options: {
  onPublish: (patches: CarryLiveMarketPatch[]) => void;
  intervalMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}): CarryPatchPublisher {
  const intervalMs = Math.max(1, options.intervalMs ?? CARRY_UI_PUBLISH_INTERVAL_MS);
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  const patches = new Map<string, CarryLiveMarketPatch>();
  let active = true;
  let lastPublishedAt: number | null = null;
  let cancelScheduled: (() => void) | null = null;

  const publish = () => {
    cancelScheduled = null;
    if (!active || patches.size === 0) return;
    lastPublishedAt = now();
    options.onPublish([...patches.values()]);
  };

  return {
    push(patch) {
      if (!active) return;
      const key = `${patch.venue_id}:${patch.asset}`;
      patches.set(key, { ...patches.get(key), ...patch });
      if (cancelScheduled) return;
      const elapsed = lastPublishedAt == null ? intervalMs : now() - lastPublishedAt;
      const delay = Math.max(0, intervalMs - elapsed);
      if (delay === 0) publish();
      else cancelScheduled = schedule(publish, delay);
    },
    stop() {
      active = false;
      cancelScheduled?.();
      cancelScheduled = null;
      patches.clear();
    },
  };
}

export function carryLiveDescriptorKey(venues: CarryVenueShadow[]) {
  return venues
    .flatMap((venue) => venue.snapshots.map((snapshot) => [
      venue.venue_id,
      snapshot.contract_id,
      snapshot.asset,
      snapshot.funding_interval_ms ?? "",
    ].join(":")))
    .sort()
    .join("|");
}

export function createCarryLiveMarketStream(options: {
  venues: CarryVenueShadow[];
  onPatch: (patch: CarryLiveMarketPatch) => void;
  onStatus: (venueId: string, status: CarryLiveVenueStatus) => void;
  webSocketCtor?: WebSocketConstructor | null;
  now?: () => number;
}): CarryLiveMarketStream {
  return new BrowserCarryLiveMarketStream(options);
}

class BrowserCarryLiveMarketStream implements CarryLiveMarketStream {
  private active = false;
  private readonly sockets = new Map<string, WebSocketLike>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly books = new Map<string, BookState>();
  private readonly lastEmittedValues = new Map<string, Record<string, number>>();
  private readonly lastEmittedAt = new Map<string, number>();
  private readonly refs: MarketRef[];

  constructor(private readonly options: {
    venues: CarryVenueShadow[];
    onPatch: (patch: CarryLiveMarketPatch) => void;
    onStatus: (venueId: string, status: CarryLiveVenueStatus) => void;
    webSocketCtor?: WebSocketConstructor | null;
    now?: () => number;
  }) {
    this.refs = options.venues.flatMap((venue) => venue.snapshots.map((snapshot) => marketRef(snapshot)));
  }

  start() {
    if (this.active) return;
    this.active = true;
    for (const venueId of CARRY_BROWSER_STREAM_VENUES) {
      if (this.venueRefs(venueId).length > 0) this.connect(venueId);
    }
  }

  stop() {
    this.active = false;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const socket of this.sockets.values()) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // The stream is already inactive.
      }
    }
    this.sockets.clear();
    this.books.clear();
    this.lastEmittedValues.clear();
    this.lastEmittedAt.clear();
  }

  private connect(venueId: string) {
    if (!this.active || this.sockets.has(venueId)) return;
    const WebSocketCtor = this.options.webSocketCtor ?? (typeof WebSocket === "undefined" ? null : WebSocket);
    if (!WebSocketCtor) {
      this.options.onStatus(venueId, "unavailable");
      return;
    }
    this.options.onStatus(venueId, this.reconnectAttempts.get(venueId) ? "reconnecting" : "connecting");
    try {
      const socket = new WebSocketCtor(this.url(venueId));
      this.sockets.set(venueId, socket);
      socket.onopen = () => {
        if (!this.active || socket !== this.sockets.get(venueId)) return;
        this.reconnectAttempts.set(venueId, 0);
        this.options.onStatus(venueId, "live");
        this.subscribe(venueId, socket);
      };
      socket.onmessage = (event) => {
        if (!this.active || socket !== this.sockets.get(venueId)) return;
        this.handleMessage(venueId, socket, event.data);
      };
      socket.onerror = () => {
        if (this.active) this.options.onStatus(venueId, "reconnecting");
      };
      socket.onclose = () => {
        if (socket !== this.sockets.get(venueId)) return;
        this.sockets.delete(venueId);
        if (!this.active) return;
        this.options.onStatus(venueId, "reconnecting");
        this.scheduleReconnect(venueId);
      };
    } catch {
      this.options.onStatus(venueId, "unavailable");
      this.scheduleReconnect(venueId);
    }
  }

  private url(venueId: string) {
    if (venueId === "lighter") return "wss://mainnet.zklighter.elliot.ai/stream?readonly=true";
    if (venueId === "aster") {
      const streams = this.venueRefs("aster").flatMap((ref) => {
        const symbol = ref.contractId.replace(/^aster:/, "").toLowerCase();
        return [`${symbol}@bookTicker`, `${symbol}@markPrice@1s`];
      });
      return `wss://fstream.asterdex.com/stream?streams=${streams.join("/")}`;
    }
    if (venueId === "dydx") return "wss://indexer.dydx.trade/v4/ws";
    return "wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws";
  }

  private subscribe(venueId: string, socket: WebSocketLike) {
    if (venueId === "lighter") {
      for (const ref of this.venueRefs(venueId)) {
        const marketId = ref.contractId.replace(/^lighter:/, "");
        sendJson(socket, { type: "subscribe", channel: `ticker/${marketId}` });
        sendJson(socket, { type: "subscribe", channel: `market_stats/${marketId}` });
      }
      return;
    }
    if (venueId === "dydx") {
      sendJson(socket, { type: "subscribe", channel: "v4_markets", batched: true });
      for (const ref of this.venueRefs(venueId)) {
        sendJson(socket, { type: "subscribe", channel: "v4_orderbook", id: `${ref.asset}-USD`, batched: true });
      }
      return;
    }
    if (venueId === "edgex") {
      sendJson(socket, { type: "subscribe", channel: "ticker.all.1s" });
      sendJson(socket, { type: "subscribe", channel: "fundingRate.all" });
      for (const ref of this.venueRefs(venueId)) {
        sendJson(socket, { type: "subscribe", channel: `depth.${ref.contractId.replace(/^edgex:/, "")}.15` });
      }
    }
  }

  private handleMessage(venueId: string, socket: WebSocketLike, raw: unknown) {
    const message = parseMessage(raw);
    if (!message) return;
    if (venueId === "lighter") return this.handleLighter(message);
    if (venueId === "aster") return this.handleAster(message);
    if (venueId === "dydx") return this.handleDydx(message);
    if (message.type === "ping") {
      sendJson(socket, { type: "pong", time: message.time });
      return;
    }
    this.handleEdgeX(message);
  }

  private handleLighter(message: Record<string, unknown>) {
    const ticker = record(message.ticker);
    const marketStats = record(message.market_stats);
    const marketId = stringValue(
      marketStats.market_id ?? ticker.market_id ?? channelId(message.channel),
    );
    const ref = this.venueRefs("lighter").find((item) => item.contractId === `lighter:${marketId}`);
    if (!ref) return;
    const ask = record(ticker.a);
    const bid = record(ticker.b);
    this.emit(ref, {
      best_bid_e8: scaledDecimal(bid.price, 100_000_000),
      best_ask_e8: scaledDecimal(ask.price, 100_000_000),
      mark_price_e8: scaledDecimal(marketStats.mark_price, 100_000_000),
      index_price_e8: scaledDecimal(marketStats.index_price, 100_000_000),
      funding_rate_e12_per_interval: scaledDecimal(
        percentFraction(marketStats.current_funding_rate ?? marketStats.funding_rate),
        1_000_000_000_000,
        true,
      ),
      funding_interval_ms: 3_600_000,
      source_at_ms: numericValue(message.timestamp),
    });
  }

  private handleAster(message: Record<string, unknown>) {
    const data = record(message.data);
    const symbol = stringValue(data.s).toUpperCase();
    const ref = this.venueRefs("aster").find((item) => item.contractId === `aster:${symbol}`);
    if (!ref) return;
    this.emit(ref, {
      best_bid_e8: scaledDecimal(data.b, 100_000_000),
      best_ask_e8: scaledDecimal(data.a, 100_000_000),
      mark_price_e8: scaledDecimal(data.p, 100_000_000),
      index_price_e8: scaledDecimal(data.i, 100_000_000),
      funding_rate_e12_per_interval: scaledDecimal(data.r, 1_000_000_000_000, true),
      funding_interval_ms: ref.fundingIntervalMs,
      source_at_ms: numericValue(data.E),
    });
  }

  private handleDydx(message: Record<string, unknown>) {
    const channel = stringValue(message.channel);
    const contentRows = Array.isArray(message.contents)
      ? arrayValue(message.contents).map(record)
      : [record(message.contents)];
    if (channel === "v4_orderbook") {
      const market = stringValue(message.id);
      const asset = market.split("-")[0];
      const ref = this.venueRefs("dydx").find((item) => item.asset === asset);
      if (!ref) return;
      const key = `dydx:${asset}`;
      const book = this.book(key, message.type === "subscribed");
      for (const contents of contentRows) {
        applyBookLevels(book, "bid", contents.bids);
        applyBookLevels(book, "ask", contents.asks);
      }
      this.emit(ref, {
        best_bid_e8: bestBookPrice(book, "bid"),
        best_ask_e8: bestBookPrice(book, "ask"),
      });
      return;
    }
    if (channel !== "v4_markets") return;
    for (const contents of contentRows) {
      const markets = {
        ...record(contents.markets),
        ...record(contents.trading),
      };
      for (const [ticker, value] of Object.entries(markets)) {
        const row = record(value);
        const asset = ticker.split("-")[0];
        const ref = this.venueRefs("dydx").find((item) => item.asset === asset);
        if (!ref) continue;
        this.emit(ref, {
          mark_price_e8: scaledDecimal(row.oraclePrice, 100_000_000),
          index_price_e8: scaledDecimal(row.oraclePrice, 100_000_000),
          funding_rate_e12_per_interval: scaledDecimal(row.nextFundingRate, 1_000_000_000_000, true),
          funding_interval_ms: ref.fundingIntervalMs,
        });
      }
    }
  }

  private handleEdgeX(message: Record<string, unknown>) {
    if (message.type !== "quote-event") return;
    const content = record(message.content);
    const channel = stringValue(message.channel || content.channel);
    const rows = arrayValue(content.data).map(record);
    if (channel.startsWith("depth.")) {
      const reset = content.dataType === "Snapshot";
      for (const row of rows) {
        const ref = this.edgeXRef(row.contractId ?? channel.split(".")[1]);
        if (!ref) continue;
        const book = this.book(`edgex:${ref.asset}`, reset);
        applyBookLevels(book, "bid", row.bids);
        applyBookLevels(book, "ask", row.asks);
        this.emit(ref, {
          best_bid_e8: bestBookPrice(book, "bid"),
          best_ask_e8: bestBookPrice(book, "ask"),
          source_at_ms: numericValue(row.timestamp),
        });
      }
      return;
    }
    for (const row of rows) {
      const ref = this.edgeXRef(row.contractId);
      if (!ref) continue;
      this.emit(ref, {
        mark_price_e8: scaledDecimal(row.markPrice, 100_000_000),
        index_price_e8: scaledDecimal(row.indexPrice ?? row.oraclePrice, 100_000_000),
        funding_rate_e12_per_interval: scaledDecimal(
          row.predictedFundingRate ?? row.fundingRate,
          1_000_000_000_000,
          true,
        ),
        funding_interval_ms: ref.fundingIntervalMs,
        source_at_ms: numericValue(row.timestamp),
      });
    }
  }

  private emit(ref: MarketRef, values: Omit<CarryLiveMarketPatch, "venue_id" | "asset" | "received_at_ms">) {
    const patch = Object.fromEntries(Object.entries(values).filter(([, value]) => value != null));
    if (Object.keys(patch).length === 0) return;
    const now = this.options.now?.() ?? Date.now();
    const key = `${ref.venueId}:${ref.asset}`;
    const economicValues = Object.fromEntries(Object.entries(patch)
      .filter(([field]) => field !== "source_at_ms")) as Record<string, number>;
    const previous = this.lastEmittedValues.get(key) || {};
    const changed = Object.entries(economicValues).some(([field, value]) => previous[field] !== value);
    const lastAt = this.lastEmittedAt.get(key) || 0;
    if (!changed && now - lastAt < UNCHANGED_PATCH_HEARTBEAT_MS) return;
    this.lastEmittedValues.set(key, { ...previous, ...economicValues });
    this.lastEmittedAt.set(key, now);
    this.options.onPatch({
      venue_id: ref.venueId,
      asset: ref.asset,
      received_at_ms: now,
      ...patch,
    });
  }

  private venueRefs(venueId: string) {
    return this.refs.filter((ref) => ref.venueId === venueId);
  }

  private edgeXRef(contractId: unknown) {
    const id = stringValue(contractId);
    return this.venueRefs("edgex").find((item) => item.contractId === `edgex:${id}`);
  }

  private book(key: string, reset = false) {
    if (reset || !this.books.has(key)) {
      this.books.set(key, { bids: new Map(), asks: new Map(), bestBid: null, bestAsk: null });
    }
    return this.books.get(key)!;
  }

  private scheduleReconnect(venueId: string) {
    if (!this.active || this.reconnectTimers.has(venueId)) return;
    const attempt = (this.reconnectAttempts.get(venueId) || 0) + 1;
    this.reconnectAttempts.set(venueId, attempt);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(venueId);
      this.connect(venueId);
    }, Math.min(8_000, 500 * 2 ** Math.min(attempt - 1, 4)));
    this.reconnectTimers.set(venueId, timer);
  }
}

function marketRef(snapshot: CarryShadowSnapshot): MarketRef {
  return {
    venueId: snapshot.venue_id,
    asset: snapshot.asset,
    contractId: snapshot.contract_id,
    fundingIntervalMs: snapshot.funding_interval_ms,
  };
}

function sendJson(socket: WebSocketLike, payload: Record<string, unknown>) {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // The socket lifecycle will reconnect after close.
  }
}

function parseMessage(raw: unknown): Record<string, unknown> | null {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return record(value);
  } catch {
    return null;
  }
}

function applyBookLevels(book: BookState, side: "bid" | "ask", value: unknown) {
  const levels = side === "bid" ? book.bids : book.asks;
  const bestKey = side === "bid" ? "bestBid" : "bestAsk";
  for (const raw of arrayValue(value)) {
    const row = Array.isArray(raw) ? raw : [record(raw).price, record(raw).size];
    const price = Number(row[0]);
    const size = Number(row[1]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size)) continue;
    if (size <= 0) {
      levels.delete(price);
    } else {
      levels.set(price, size);
      const current = book[bestKey];
      if (current == null || (side === "bid" ? price > current : price < current)) book[bestKey] = price;
    }
  }
  if (book[bestKey] != null && !levels.has(book[bestKey]!)) book[bestKey] = findBestPrice(levels, side);
}

function findBestPrice(levels: Map<number, number>, side: "bid" | "ask") {
  let best: number | null = null;
  for (const price of levels.keys()) {
    if (best == null || (side === "bid" ? price > best : price < best)) best = price;
  }
  return best;
}

function bestBookPrice(book: BookState, side: "bid" | "ask") {
  return scaledDecimal(side === "bid" ? book.bestBid : book.bestAsk, 100_000_000);
}

function scaledDecimal(value: unknown, scale: number, signed = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || (!signed && number <= 0)) return null;
  const result = Math.round(number * scale);
  return Number.isSafeInteger(result) ? result : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return value == null ? "" : String(value);
}

function numericValue(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function percentFraction(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result / 100 : null;
}

function channelId(value: unknown) {
  const channel = stringValue(value);
  return channel.split(/[/:]/).at(-1) || "";
}
