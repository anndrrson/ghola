import assert from "node:assert/strict";
import test from "node:test";
import {
  createHyperliquidAccountStateStream,
  hyperliquidMarginUtilizationBucket,
  hyperliquidPositionRiskBuckets,
  readHyperliquidAccountSnapshot,
  readHyperliquidExactMarketState,
  readHyperliquidTopOfBook,
  reconcileHyperliquidExecution,
  submitHyperliquidExecution,
} from "../src/venues/hyperliquid.js";

test("reconciles Hyperliquid terminal IOC fills by cloid", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const cloid = `0x${"a".repeat(32)}`;
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      const value = body.type === "orderStatus"
        ? { status: "order", order: { order: { coin: "SOL", oid: 77, cloid }, status: "filled", statusTimestamp: 1 } }
        : [{ coin: "SOL", oid: 77, px: "200", sz: "0.05", side: "B", time: 1 }];
      return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await reconcileHyperliquidExecution({
      credential: credential("testnet"),
      cloid,
      market: "SOL",
      fetchImpl,
    });
    assert.equal(result.terminal, true);
    assert.equal(result.status, "filled");
    assert.equal(result.filled_notional_micro_usdc, 10_000_000);
    assert.equal(result.filled_base_size, "0.05");
    assert.equal(result.venue_order_reference, "oid:77");
    assert.equal(result.final_proof.final_fill_proven, true);
  } finally {
    restore(previous);
  }
});

test("live Hyperliquid adapter returns explicit venue-acceptance proof", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const submitted = await submitHyperliquidExecution({
      credential: credential("testnet"),
      instruction: {
        operation_class: "limit_order",
        order: { market: "HYPE", side: "buy", quote_size: "11", limit_price: "1", order_type: "limit" },
      },
      cloid: `0x${"1".repeat(32)}`,
      runner: async () => ({ status: "submitted", oid: 42, fills: [] }),
    });
    assert.equal(submitted.final_proof.broadcast_performed, true);
    assert.equal(submitted.final_proof.final_venue_execution_proven, true);
    assert.equal(submitted.final_proof.final_fill_proven, false);

    const cancelled = await submitHyperliquidExecution({
      credential: credential("testnet"),
      instruction: { operation_class: "cancel", cancel: { market: "HYPE", client_order_id: `0x${"1".repeat(32)}` } },
      cloid: `0x${"2".repeat(32)}`,
      runner: async () => ({ status: "cancelled", fills: [] }),
    });
    assert.equal(cancelled.final_proof.broadcast_performed, true);
    assert.equal(cancelled.final_proof.final_venue_execution_proven, true);
    assert.equal(cancelled.final_proof.final_fill_proven, false);
  } finally {
    restore(previous);
  }
});

test("account margin utilization is privacy-bucketed", () => {
  const state = (accountValue, totalMarginUsed) => ({ marginSummary: { accountValue, totalMarginUsed } });
  assert.equal(hyperliquidMarginUtilizationBucket(state("100", "0")), "none");
  assert.equal(hyperliquidMarginUtilizationBucket(state("100", "24.99")), "<25%");
  assert.equal(hyperliquidMarginUtilizationBucket(state("100", "25")), "25-50%");
  assert.equal(hyperliquidMarginUtilizationBucket(state("100", "74.99")), "50-75%");
  assert.equal(hyperliquidMarginUtilizationBucket(state("100", "75")), "75-90%");
  assert.equal(hyperliquidMarginUtilizationBucket(state("100", "90")), "90%+");
  assert.equal(hyperliquidMarginUtilizationBucket({ marginSummary: { accountValue: "100" } }), "unknown");
});

test("position risk is privacy-bucketed with direction-aware liquidation distance", () => {
  assert.deepEqual(hyperliquidPositionRiskBuckets({
    szi: "1",
    positionValue: "100",
    liquidationPx: "97",
    leverage: { value: 8 },
  }), {
    leverage_bucket: "5-10x",
    liquidation_distance_bucket: "2-5%",
  });
  assert.deepEqual(hyperliquidPositionRiskBuckets({
    szi: "-2",
    positionValue: "200",
    liquidationPx: "101",
    leverage: { value: 25 },
  }), {
    leverage_bucket: "20x+",
    liquidation_distance_bucket: "<2%",
  });
  assert.deepEqual(hyperliquidPositionRiskBuckets({
    szi: "1",
    positionValue: "100",
    liquidationPx: "101",
    leverage: null,
  }), {
    leverage_bucket: "unknown",
    liquidation_distance_bucket: "at_or_beyond",
  });
});

test("provider pong refreshes account stream liveness without fabricating state", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  const events = [];
  let socket = null;
  class FakeWebSocket {
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    send() {}
    close() {}
  }
  const fetchImpl = async (_url, init) => {
    const type = JSON.parse(init.body).type;
    const value = type === "clearinghouseState"
      ? { marginSummary: { accountValue: "100" }, assetPositions: [] }
      : [];
    return { ok: true, json: async () => value };
  };
  let stop = () => {};
  try {
    stop = await createHyperliquidAccountStateStream({
      credential: credential("testnet"),
      fetchImpl,
      webSocketCtor: FakeWebSocket,
      onEvent: (event) => events.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stateCount = events.filter((event) => event.event === "account_state").length;
    socket.onmessage({ data: JSON.stringify({ channel: "pong" }) });
    assert.equal(events.at(-1)?.event, "stream_status");
    assert.equal(events.at(-1)?.data?.stream_status, "live");
    assert.equal(events.filter((event) => event.event === "account_state").length, stateCount);
  } finally {
    stop();
    restore(previous);
  }
});

test("incremental order updates reconcile the streamed open-order set", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  const events = [];
  let socket = null;
  class FakeWebSocket {
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    send() {}
    close() {}
  }
  const fetchImpl = async (_url, init) => {
    const type = JSON.parse(init.body).type;
    const value = type === "clearinghouseState"
      ? { marginSummary: { accountValue: "100" }, assetPositions: [] }
      : [];
    return { ok: true, json: async () => value };
  };
  let stop = () => {};
  try {
    stop = await createHyperliquidAccountStateStream({
      credential: credential("testnet"),
      fetchImpl,
      webSocketCtor: FakeWebSocket,
      onEvent: (event) => events.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const order = { oid: 42, cloid: "0xabc", coin: "BTC", side: "B", sz: "1", limitPx: "100" };
    socket.onmessage({ data: JSON.stringify({ channel: "orderUpdates", data: [{ order, status: "open" }] }) });
    assert.equal(events.filter((event) => event.event === "account_state").at(-1)?.data?.open_order_count, 1);
    assert.equal(events.filter((event) => event.event === "account_state").at(-1)?.data?.open_orders?.[0]?.side, "buy");

    socket.onmessage({ data: JSON.stringify({ channel: "orderUpdates", data: [{ order, status: "canceled" }] }) });
    assert.equal(events.filter((event) => event.event === "account_state").at(-1)?.data?.open_order_count, 0);
  } finally {
    stop();
    restore(previous);
  }
});

test("account snapshots bind exact public venue and network identity", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  try {
    const snapshot = await readHyperliquidAccountSnapshot({
      credential: credential("testnet"),
      accountSource: "sealed_byo",
    });
    assert.equal(snapshot.platform_class, "hyperliquid_style_market");
    assert.equal(snapshot.venue_id, "hyperliquid");
    assert.equal(snapshot.network, "testnet");
    assert.equal(snapshot.position_total_count, 0);
    assert.equal(snapshot.positions_truncated, false);
    assert.equal(snapshot.margin_utilization_bucket, "unknown");
    assert.equal(snapshot.open_order_total_count, 0);
    assert.equal(snapshot.open_orders_truncated, false);
    assert.deepEqual(snapshot.positions, []);
    assert.deepEqual(snapshot.open_orders, []);
  } finally {
    restore(previous);
  }
});

test("account snapshots disclose bounded open-order truncation", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const fetchImpl = async (_url, init) => {
      const type = JSON.parse(init.body).type;
      const value = type === "clearinghouseState"
        ? { marginSummary: { accountValue: "100" }, assetPositions: [] }
        : type === "openOrders"
          ? Array.from({ length: 13 }, (_, index) => ({ oid: index, coin: "BTC", side: "B", sz: "1", limitPx: "100" }))
          : [];
      return { ok: true, json: async () => value };
    };
    const snapshot = await readHyperliquidAccountSnapshot({ credential: credential("testnet"), fetchImpl });
    assert.equal(snapshot.open_orders.length, 12);
    assert.equal(snapshot.open_order_count, 12);
    assert.equal(snapshot.open_order_total_count, 13);
    assert.equal(snapshot.open_orders_truncated, true);
  } finally {
    restore(previous);
  }
});

test("account snapshots retain the riskiest bounded positions without leaking omitted rows", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const fetchImpl = async (_url, init) => {
      const type = JSON.parse(init.body).type;
      const value = type === "clearinghouseState"
        ? {
            marginSummary: { accountValue: "100", totalMarginUsed: "10" },
            assetPositions: Array.from({ length: 13 }, (_, index) => ({ position: {
              coin: `COIN${index}`,
              szi: "1",
              entryPx: "100",
              positionValue: "100",
              liquidationPx: index === 12 ? "99.5" : "80",
              unrealizedPnl: "0",
              leverage: { value: 2 },
            } })),
          }
        : [];
      return { ok: true, json: async () => value };
    };
    const snapshot = await readHyperliquidAccountSnapshot({
      credential: credential("testnet"),
      accountSource: "sealed_byo",
      fetchImpl,
    });
    assert.equal(snapshot.positions.length, 12);
    assert.equal(snapshot.position_count, 12);
    assert.equal(snapshot.position_total_count, 13);
    assert.equal(snapshot.positions_truncated, true);
    assert.equal(snapshot.positions[0].market, "COIN12");
    assert.equal(snapshot.positions[0].liquidation_distance_bucket, "<2%");
    assert.equal(JSON.stringify(snapshot).includes("COIN11"), false);
  } finally {
    restore(previous);
  }
});

test("account snapshots expose only bounded position risk, never exact liquidation inputs", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const fetchImpl = async (_url, init) => {
      const type = JSON.parse(init.body).type;
      const value = type === "clearinghouseState"
        ? {
            marginSummary: { accountValue: "100", totalMarginUsed: "10" },
            assetPositions: [{ position: {
              coin: "BTC",
              szi: "1",
              entryPx: "100",
              positionValue: "101",
              liquidationPx: "98",
              unrealizedPnl: "1",
              leverage: { type: "cross", value: 8 },
            } }],
          }
        : [];
      return { ok: true, json: async () => value };
    };
    const snapshot = await readHyperliquidAccountSnapshot({
      credential: credential("testnet"),
      accountSource: "sealed_byo",
      fetchImpl,
    });
    assert.deepEqual(snapshot.positions[0], {
      position_commitment: snapshot.positions[0].position_commitment,
      market: "BTC",
      side: "long",
      size_bucket: "1-10",
      entry_price_bucket: "100-1k",
      unrealized_pnl_bucket: "+1-10",
      leverage_bucket: "5-10x",
      liquidation_distance_bucket: "2-5%",
    });
    assert.equal("liquidationPx" in snapshot.positions[0], false);
    assert.equal("positionValue" in snapshot.positions[0], false);
    assert.equal(snapshot.margin_utilization_bucket, "<25%");
    assert.equal(JSON.stringify(snapshot).includes("totalMarginUsed"), false);
  } finally {
    restore(previous);
  }
});

test("account streams retain the exact credential network", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  let close = () => {};
  try {
    const events = [];
    close = await createHyperliquidAccountStateStream({
      credential: credential("testnet"),
      accountSource: "hyperliquid_native_vault",
      onEvent: (event) => events.push(event),
    });
    const snapshot = events.find((event) => event.event === "account_state")?.data;
    assert.equal(snapshot?.platform_class, "hyperliquid_style_market");
    assert.equal(snapshot?.venue_id, "hyperliquid");
    assert.equal(snapshot?.network, "testnet");
  } finally {
    close();
    restore(previous);
  }
});

test("reads exact Hyperliquid target position, orders, and top of book", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const fetchImpl = async (_url, init) => {
      const type = JSON.parse(init.body).type;
      const value = type === "clearinghouseState"
        ? {
            marginSummary: { accountValue: "24.5" },
            withdrawable: "20.1",
            assetPositions: [{ position: { coin: "SOL", szi: "0.14" } }],
          }
        : type === "openOrders"
          ? [{ coin: "SOL", oid: 1 }, { coin: "BTC", oid: 2 }]
          : { levels: [[{ px: "75.70", sz: "3" }], [{ px: "75.72", sz: "2" }]] };
      return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    };
    const account = await readHyperliquidExactMarketState({ credential: credential("testnet"), fetchImpl });
    const book = await readHyperliquidTopOfBook({ credential: credential("testnet"), fetchImpl });
    assert.deepEqual(account, {
      version: 1,
      venue_id: "hyperliquid",
      network: "testnet",
      market: "SOL",
      status: "ready_to_trade",
      position_size: "0.14",
      open_order_count: 1,
      account_value: "24.5",
      withdrawable: "20.1",
      checked_at: account.checked_at,
    });
    assert.deepEqual(book, { bid: 75.7, ask: 75.72, checked_at: book.checked_at });
  } finally {
    restore(previous);
  }
});

function credential(network) {
  return {
    network,
    base_url: network === "testnet" ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz",
    account_address: "0x0000000000000000000000000000000000000001",
    api_wallet_private_key: `0x${"1".repeat(64)}`,
  };
}

function restore(value) {
  if (value == null) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = value;
}
