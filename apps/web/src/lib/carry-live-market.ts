import type {
  CarryDepthLevel,
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
  bidOffsets: Map<number, bigint>;
  askOffsets: Map<number, bigint>;
  bestBid: number | null;
  bestAsk: number | null;
  complete: boolean;
  sequence: bigint | null;
};

type DydxStreamState = {
  connectionId: string | null;
  protocolVersion: string | null;
  subscribed: Map<string, bigint>;
  subscriptionFrames: Map<string, Record<string, unknown>>;
  pending: Record<string, unknown>[];
  handshakeComplete: boolean;
  sequence: bigint | null;
};

const UNCHANGED_PATCH_HEARTBEAT_MS = 1_000;
export const CARRY_STREAM_HANDSHAKE_TIMEOUT_MS = 10_000;
export const CARRY_STREAM_SILENCE_TIMEOUT_MS = 15_000;
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
    const batch = [...patches.values()];
    patches.clear();
    lastPublishedAt = now();
    options.onPublish(batch);
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
  private readonly handshakeWatchdogs = new Map<WebSocketLike, ReturnType<typeof setTimeout>>();
  private readonly bookWatchdogs = new Map<string, {
    socket: WebSocketLike;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly orderbookReadySockets = new Set<WebSocketLike>();
  private readonly books = new Map<string, BookState>();
  private readonly dydxStreams = new Map<WebSocketLike, DydxStreamState>();
  private readonly lastEmittedValues = new Map<string, Record<string, unknown>>();
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
    for (const timer of this.handshakeWatchdogs.values()) clearTimeout(timer);
    this.handshakeWatchdogs.clear();
    for (const { timer } of this.bookWatchdogs.values()) clearTimeout(timer);
    this.bookWatchdogs.clear();
    this.orderbookReadySockets.clear();
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
    this.dydxStreams.clear();
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
        if (this.requiresOrderbookProof(venueId)) {
          this.armHandshakeWatchdog(venueId, socket);
        } else {
          this.reconnectAttempts.set(venueId, 0);
          this.options.onStatus(venueId, "live");
        }
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
        if (this.requiresOrderbookProof(venueId)) {
          this.invalidateVenueOrderBooks(venueId, socket);
          return;
        }
        this.sockets.delete(venueId);
        this.dydxStreams.delete(socket);
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
        return [`${symbol}@bookTicker`, `${symbol}@markPrice@1s`, `${symbol}@depth20@100ms`];
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
    if (venueId === "dydx") return this.handleDydx(socket, message);
    if (message.type === "ping") {
      sendJson(socket, { type: "pong", time: message.time });
      return;
    }
    this.handleEdgeX(socket, message);
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
      depth_bids: singleDepthLevel(bid.price, bid.size ?? bid.amount ?? bid.quantity),
      depth_asks: singleDepthLevel(ask.price, ask.size ?? ask.amount ?? ask.quantity),
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
    const stream = stringValue(message.stream).toLowerCase();
    if (stream.includes("@depth20")) {
      const book = this.book(`aster:${ref.asset}`, true);
      applyBookLevels(book, "bid", data.bids ?? data.b);
      applyBookLevels(book, "ask", data.asks ?? data.a);
      this.emit(ref, {
        best_bid_e8: bestBookPrice(book, "bid"),
        best_ask_e8: bestBookPrice(book, "ask"),
        depth_bids: bookDepthLevels(book, "bid"),
        depth_asks: bookDepthLevels(book, "ask"),
        depth_complete: true,
        source_at_ms: numericValue(data.E ?? data.T),
      });
      return;
    }
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

  private handleDydx(socket: WebSocketLike, message: Record<string, unknown>) {
    const state = this.dydxState(socket);
    const connectionId = stringValue(message.connection_id);
    if (message.type === "connected") {
      if (!connectionId || (state.connectionId && state.connectionId !== connectionId)) {
        this.invalidateVenueOrderBooks("dydx", socket);
        return;
      }
      state.connectionId = connectionId;
      return;
    }
    if (!connectionId || !state.connectionId || connectionId !== state.connectionId) {
      this.invalidateVenueOrderBooks("dydx", socket);
      return;
    }

    const sequence = sequenceValue(message.message_id);
    const subscriptionKey = this.dydxSubscriptionKey(message);
    if (!state.connectionId || sequence == null || !subscriptionKey) {
      this.invalidateVenueOrderBooks("dydx", socket);
      return;
    }
    if (message.type === "subscribed") {
      if (state.handshakeComplete || state.subscribed.has(subscriptionKey)) {
        this.invalidateVenueOrderBooks("dydx", socket);
        return;
      }
      state.subscribed.set(subscriptionKey, sequence);
      state.subscriptionFrames.set(subscriptionKey, message);
      const expected = this.dydxSubscriptionKeys();
      if (state.subscribed.size !== expected.size) return;
      if ([...expected].some((key) => !state.subscribed.has(key))) {
        this.invalidateVenueOrderBooks("dydx", socket);
        return;
      }
      const subscriptionFrames = [...state.subscriptionFrames.values()].sort((left, right) =>
        compareBigInts(sequenceValue(left.message_id)!, sequenceValue(right.message_id)!));
      if (subscriptionFrames.some((frame) => !this.validDydxSnapshot(frame))) {
        this.invalidateVenueOrderBooks("dydx", socket);
        return;
      }
      const handshakeFrames = [...subscriptionFrames, ...state.pending].sort((left, right) =>
        compareBigInts(sequenceValue(left.message_id)!, sequenceValue(right.message_id)!));
      if (handshakeFrames.some((frame, index) => sequenceValue(frame.message_id) !== BigInt(index + 1))) {
        this.invalidateVenueOrderBooks("dydx", socket);
        return;
      }
      state.sequence = BigInt(0);
      for (const frame of handshakeFrames) {
        if (frame.type === "subscribed") {
          const frameSequence = sequenceValue(frame.message_id)!;
          if (frameSequence !== state.sequence + BigInt(1) || !this.applyDydxMessage(frame, true)) {
            this.invalidateVenueOrderBooks("dydx", socket);
            return;
          }
          state.sequence = frameSequence;
          continue;
        }
        if (!this.applyDydxSequencedMessage(socket, state, frame)) return;
      }
      state.handshakeComplete = true;
      state.pending.length = 0;
      this.markOrderbookLive("dydx", socket);
      return;
    }
    if (!state.handshakeComplete) {
      if (state.pending.length >= 1_000) {
        this.invalidateVenueOrderBooks("dydx", socket);
        return;
      }
      state.pending.push(message);
      return;
    }
    this.applyDydxSequencedMessage(socket, state, message);
  }

  private applyDydxSequencedMessage(
    socket: WebSocketLike,
    state: DydxStreamState,
    message: Record<string, unknown>,
  ) {
    const sequence = sequenceValue(message.message_id);
    const version = stringValue(message.version);
    if (sequence == null || state.sequence == null || !version
      || (state.protocolVersion && state.protocolVersion !== version)
      || sequence !== state.sequence + BigInt(1)) {
      this.invalidateVenueOrderBooks("dydx", socket);
      return false;
    }
    state.protocolVersion = version;
    state.sequence = sequence;
    if (!this.applyDydxMessage(message, false)) {
      this.invalidateVenueOrderBooks("dydx", socket);
      return false;
    }
    if (stringValue(message.channel) === "v4_orderbook") {
      this.touchOrderbook("dydx", stringValue(message.id).split("-")[0], socket);
    }
    return true;
  }

  private applyDydxMessage(message: Record<string, unknown>, snapshot: boolean) {
    const channel = stringValue(message.channel);
    const contentRows = Array.isArray(message.contents)
      ? arrayValue(message.contents).map(record)
      : [record(message.contents)];
    if (channel === "v4_orderbook") {
      const market = stringValue(message.id);
      const asset = market.split("-")[0];
      const ref = this.venueRefs("dydx").find((item) => item.asset === asset);
      if (!ref) return false;
      const book = this.book(`dydx:${asset}`, snapshot);
      if (!snapshot && !book.complete) return false;
      const logicalOffset = sequenceValue(message.message_id);
      if (logicalOffset == null) return false;
      for (const contents of contentRows) {
        if (!applyBookLevels(book, "bid", contents.bids, logicalOffset)
          || !applyBookLevels(book, "ask", contents.asks, logicalOffset)) return false;
      }
      book.complete = true;
      if (!uncrossDydxBook(book)) {
        this.emit(ref, {
          depth_bids: [],
          depth_asks: [],
          depth_complete: false,
          orderbook_valid: false,
        });
        return true;
      }
      this.emit(ref, {
        best_bid_e8: bestBookPrice(book, "bid"),
        best_ask_e8: bestBookPrice(book, "ask"),
        depth_bids: bookDepthLevels(book, "bid"),
        depth_asks: bookDepthLevels(book, "ask"),
        depth_complete: true,
        orderbook_valid: true,
      });
      return true;
    }
    if (channel !== "v4_markets") return false;
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
    return true;
  }

  private validDydxSnapshot(message: Record<string, unknown>) {
    const channel = stringValue(message.channel);
    if (channel === "v4_markets") return true;
    if (channel !== "v4_orderbook") return false;
    const market = stringValue(message.id);
    const asset = market.split("-")[0];
    if (!this.venueRefs("dydx").some((item) => item.asset === asset)) return false;
    const book: BookState = {
      bids: new Map(),
      asks: new Map(),
      bidOffsets: new Map(),
      askOffsets: new Map(),
      bestBid: null,
      bestAsk: null,
      complete: false,
      sequence: null,
    };
    const contentRows = Array.isArray(message.contents)
      ? arrayValue(message.contents).map(record)
      : [record(message.contents)];
    const logicalOffset = sequenceValue(message.message_id);
    if (logicalOffset == null) return false;
    for (const contents of contentRows) {
      if (!applyBookLevels(book, "bid", contents.bids, logicalOffset)
        || !applyBookLevels(book, "ask", contents.asks, logicalOffset)) return false;
    }
    const twoSidedSnapshot = book.bids.size > 0 && book.asks.size > 0;
    uncrossDydxBook(book);
    return twoSidedSnapshot;
  }

  private dydxState(socket: WebSocketLike) {
    let state = this.dydxStreams.get(socket);
    if (!state) {
      state = {
        connectionId: null,
        protocolVersion: null,
        subscribed: new Map(),
        subscriptionFrames: new Map(),
        pending: [],
        handshakeComplete: false,
        sequence: null,
      };
      this.dydxStreams.set(socket, state);
    }
    return state;
  }

  private dydxSubscriptionKeys() {
    return new Set([
      "v4_markets",
      ...this.venueRefs("dydx").map((ref) => `v4_orderbook:${ref.asset}-USD`),
    ]);
  }

  private dydxSubscriptionKey(message: Record<string, unknown>) {
    const channel = stringValue(message.channel);
    if (channel === "v4_markets") return channel;
    if (channel !== "v4_orderbook") return "";
    const key = `${channel}:${stringValue(message.id)}`;
    return this.dydxSubscriptionKeys().has(key) ? key : "";
  }

  private handleEdgeX(socket: WebSocketLike, message: Record<string, unknown>) {
    if (message.type !== "quote-event") return;
    const content = record(message.content);
    const channel = stringValue(message.channel || content.channel);
    const rows = arrayValue(content.data).map(record);
    if (channel.startsWith("depth.")) {
      for (const row of rows) {
        const ref = this.edgeXRef(row.contractId ?? channel.split(".")[1]);
        if (!ref) continue;
        const snapshot = stringValue(row.depthType ?? content.dataType).toLowerCase() === "snapshot";
        const startVersion = sequenceValue(row.startVersion);
        const endVersion = sequenceValue(row.endVersion);
        const bookKey = `edgex:${ref.asset}`;
        const existingBook = this.books.get(bookKey);
        if (startVersion == null
          || endVersion == null
          || endVersion < startVersion
          || (snapshot && existingBook?.sequence != null && endVersion < existingBook.sequence)
          || (!snapshot && (!existingBook?.complete
            || existingBook.sequence == null
            || startVersion > existingBook.sequence + BigInt(1)))) {
          this.invalidateVenueOrderBooks("edgex", socket);
          return;
        }
        const book = this.book(bookKey, snapshot);
        if (!snapshot && endVersion <= book.sequence!) continue;
        if (!applyBookLevels(book, "bid", row.bids)
          || !applyBookLevels(book, "ask", row.asks)) {
          this.invalidateVenueOrderBooks("edgex", socket);
          return;
        }
        if (book.bids.size === 0 || book.asks.size === 0 || bookIsCrossed(book)) {
          this.invalidateVenueOrderBooks("edgex", socket);
          return;
        }
        book.complete = true;
        book.sequence = endVersion;
        this.emit(ref, {
          best_bid_e8: bestBookPrice(book, "bid"),
          best_ask_e8: bestBookPrice(book, "ask"),
          depth_bids: bookDepthLevels(book, "bid"),
          depth_asks: bookDepthLevels(book, "ask"),
          depth_complete: true,
          orderbook_valid: true,
          source_at_ms: numericValue(row.timestamp),
        });
        if (this.venueRefs("edgex").every((item) => this.books.get(`edgex:${item.asset}`)?.complete)) {
          this.markOrderbookLive("edgex", socket);
        }
        this.touchOrderbook("edgex", ref.asset, socket);
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
      .filter(([field]) => field !== "source_at_ms" && field !== "depth_complete")) as Record<string, unknown>;
    const previous = this.lastEmittedValues.get(key) || {};
    const changed = Object.entries(economicValues).some(([field, value]) => !samePatchValue(previous[field], value));
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
      this.books.set(key, {
        bids: new Map(),
        asks: new Map(),
        bidOffsets: new Map(),
        askOffsets: new Map(),
        bestBid: null,
        bestAsk: null,
        complete: false,
        sequence: null,
      });
    }
    return this.books.get(key)!;
  }

  private invalidateVenueOrderBooks(venueId: string, socket: WebSocketLike) {
    this.clearOrderbookWatchdogs(socket);
    this.dydxStreams.delete(socket);
    for (const ref of this.venueRefs(venueId)) {
      this.books.delete(`${venueId}:${ref.asset}`);
      this.emit(ref, {
        depth_bids: [],
        depth_asks: [],
        depth_complete: false,
        orderbook_valid: false,
      });
    }
    if (socket !== this.sockets.get(venueId)) return;
    this.sockets.delete(venueId);
    socket.onmessage = null;
    this.options.onStatus(venueId, "reconnecting");
    this.scheduleReconnect(venueId);
    try {
      socket.close();
    } catch {
      // The scheduled reconnect already owns recovery.
    }
  }

  private requiresOrderbookProof(venueId: string) {
    return venueId === "dydx" || venueId === "edgex";
  }

  private markOrderbookLive(venueId: string, socket: WebSocketLike) {
    if (socket !== this.sockets.get(venueId) || this.orderbookReadySockets.has(socket)) return;
    this.orderbookReadySockets.add(socket);
    this.clearHandshakeWatchdog(socket);
    this.reconnectAttempts.set(venueId, 0);
    this.options.onStatus(venueId, "live");
    for (const ref of this.venueRefs(venueId)) this.armBookWatchdog(venueId, ref.asset, socket);
  }

  private armHandshakeWatchdog(venueId: string, socket: WebSocketLike) {
    this.clearHandshakeWatchdog(socket);
    const timer = setTimeout(() => {
      this.handshakeWatchdogs.delete(socket);
      if (!this.active || socket !== this.sockets.get(venueId)) return;
      this.invalidateVenueOrderBooks(venueId, socket);
    }, CARRY_STREAM_HANDSHAKE_TIMEOUT_MS);
    this.handshakeWatchdogs.set(socket, timer);
  }

  private touchOrderbook(venueId: string, asset: string, socket: WebSocketLike) {
    if (!this.orderbookReadySockets.has(socket)) return;
    this.armBookWatchdog(venueId, asset, socket);
  }

  private armBookWatchdog(venueId: string, asset: string, socket: WebSocketLike) {
    const key = `${venueId}:${asset}`;
    const existing = this.bookWatchdogs.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const current = this.bookWatchdogs.get(key);
      if (!current || current.socket !== socket) return;
      this.bookWatchdogs.delete(key);
      if (!this.active || socket !== this.sockets.get(venueId)) return;
      this.invalidateVenueOrderBooks(venueId, socket);
    }, CARRY_STREAM_SILENCE_TIMEOUT_MS);
    this.bookWatchdogs.set(key, { socket, timer });
  }

  private clearHandshakeWatchdog(socket: WebSocketLike) {
    const timer = this.handshakeWatchdogs.get(socket);
    if (timer) clearTimeout(timer);
    this.handshakeWatchdogs.delete(socket);
  }

  private clearOrderbookWatchdogs(socket: WebSocketLike) {
    this.clearHandshakeWatchdog(socket);
    this.orderbookReadySockets.delete(socket);
    for (const [key, entry] of this.bookWatchdogs) {
      if (entry.socket !== socket) continue;
      clearTimeout(entry.timer);
      this.bookWatchdogs.delete(key);
    }
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

function applyBookLevels(
  book: BookState,
  side: "bid" | "ask",
  value: unknown,
  logicalOffset?: bigint,
) {
  const levels = side === "bid" ? book.bids : book.asks;
  const offsets = side === "bid" ? book.bidOffsets : book.askOffsets;
  const bestKey = side === "bid" ? "bestBid" : "bestAsk";
  for (const raw of arrayValue(value)) {
    const object = record(raw);
    const row = Array.isArray(raw)
      ? raw
      : [object.price ?? object.px, object.size ?? object.sz, object.offset];
    const price = Number(row[0]);
    const size = Number(row[1]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) return false;
    const rawOffset = row[2];
    const offset = rawOffset == null || rawOffset === "" ? logicalOffset : sequenceValue(rawOffset);
    if (logicalOffset != null && offset == null) return false;
    if (size === 0) {
      levels.delete(price);
      offsets.delete(price);
    } else {
      levels.set(price, size);
      if (offset != null) offsets.set(price, offset);
      const current = book[bestKey];
      if (current == null || (side === "bid" ? price > current : price < current)) book[bestKey] = price;
    }
  }
  if (book[bestKey] != null && !levels.has(book[bestKey]!)) book[bestKey] = findBestPrice(levels, side);
  return true;
}

function uncrossDydxBook(book: BookState) {
  book.bestBid = findBestPrice(book.bids, "bid");
  book.bestAsk = findBestPrice(book.asks, "ask");
  while (book.bestBid != null && book.bestAsk != null && book.bestBid >= book.bestAsk) {
    const bidPrice = book.bestBid;
    const askPrice = book.bestAsk;
    const bidOffset = book.bidOffsets.get(bidPrice) ?? BigInt(0);
    const askOffset = book.askOffsets.get(askPrice) ?? BigInt(0);
    const bidSize = book.bids.get(bidPrice)!;
    const askSize = book.asks.get(askPrice)!;
    if (bidOffset < askOffset) {
      book.bids.delete(bidPrice);
      book.bidOffsets.delete(bidPrice);
    } else if (bidOffset > askOffset) {
      book.asks.delete(askPrice);
      book.askOffsets.delete(askPrice);
    } else if (bidSize > askSize) {
      book.bids.set(bidPrice, bidSize - askSize);
      book.asks.delete(askPrice);
      book.askOffsets.delete(askPrice);
    } else if (bidSize < askSize) {
      book.asks.set(askPrice, askSize - bidSize);
      book.bids.delete(bidPrice);
      book.bidOffsets.delete(bidPrice);
    } else {
      book.bids.delete(bidPrice);
      book.bidOffsets.delete(bidPrice);
      book.asks.delete(askPrice);
      book.askOffsets.delete(askPrice);
    }
    book.bestBid = findBestPrice(book.bids, "bid");
    book.bestAsk = findBestPrice(book.asks, "ask");
  }
  return book.bestBid != null && book.bestAsk != null;
}

function sequenceValue(value: unknown): bigint | null {
  const text = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function compareBigInts(left: bigint, right: bigint) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bookIsCrossed(book: BookState) {
  return book.bestBid != null && book.bestAsk != null && book.bestBid >= book.bestAsk;
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

function bookDepthLevels(book: BookState, side: "bid" | "ask", limit = 20): CarryDepthLevel[] {
  const levels = side === "bid" ? book.bids : book.asks;
  return [...levels.entries()]
    .filter(([price, size]) => Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0)
    .sort(([left], [right]) => side === "bid" ? right - left : left - right)
    .slice(0, limit)
    .flatMap(([price, size]) => {
      const priceE8 = scaledDecimal(price, 100_000_000);
      const sizeE8 = scaledDecimal(size, 100_000_000);
      return priceE8 == null || sizeE8 == null ? [] : [{ price_e8: priceE8, size_e8: sizeE8 }];
    });
}

function singleDepthLevel(price: unknown, size: unknown): CarryDepthLevel[] | undefined {
  const priceE8 = scaledDecimal(price, 100_000_000);
  const sizeE8 = scaledDecimal(size, 100_000_000);
  return priceE8 == null || sizeE8 == null ? undefined : [{ price_e8: priceE8, size_e8: sizeE8 }];
}

function samePatchValue(left: unknown, right: unknown) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => {
    const leftLevel = record(value);
    const rightLevel = record(right[index]);
    return leftLevel.price_e8 === rightLevel.price_e8 && leftLevel.size_e8 === rightLevel.size_e8;
  });
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
