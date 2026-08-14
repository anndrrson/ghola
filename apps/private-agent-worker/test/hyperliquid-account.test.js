import assert from "node:assert/strict";
import test from "node:test";
import {
  createHyperliquidAccountStateStream,
  hyperliquidMarginUtilizationBucket,
  hyperliquidPositionRiskBuckets,
  readHyperliquidAccountSnapshot,
} from "../src/venues/hyperliquid.js";

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
