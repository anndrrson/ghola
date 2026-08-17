import assert from "node:assert/strict";
import test from "node:test";
import {
  createHyperliquidAccountStateStream,
  hyperliquidMarginUtilizationBucket,
  hyperliquidPositionRiskBuckets,
  hyperliquidProtectionCloids,
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

test("treats venue-declared IOC rejection statuses as terminal no-fill outcomes", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const cloid = `0x${"b".repeat(32)}`;
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      const value = body.type === "orderStatus"
        ? { status: "order", order: { order: { coin: "BTC", oid: 78, cloid }, status: "iocCancelRejected", statusTimestamp: 1 } }
        : [];
      return Response.json(value);
    };
    const result = await reconcileHyperliquidExecution({
      credential: credential("testnet"),
      cloid,
      market: "BTC",
      fetchImpl,
    });
    assert.equal(result.terminal, true);
    assert.equal(result.status, "rejected");
    assert.equal(result.final_proof.final_no_fill_proven, true);
    assert.equal(result.final_proof.terminal_status, "iocCancelRejected");
  } finally {
    restore(previous);
  }
});

test("reconciles both deterministic OCO children before resolving a protected fill", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const cloid = `0x${"c".repeat(32)}`;
    const children = hyperliquidProtectionCloids(cloid);
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.type === "userFills") {
        return Response.json([{ coin: "BTC", oid: 79, px: "63000", sz: "0.001", side: "B", time: 1 }]);
      }
      if (body.oid === cloid) {
        return Response.json({ status: "order", order: { order: { coin: "BTC", oid: 79, cloid }, status: "filled" } });
      }
      if (body.oid === children.take_profit_cloid || body.oid === children.stop_loss_cloid) {
        return Response.json({
          status: "order",
          order: { order: { coin: "BTC", cloid: body.oid, reduceOnly: true, isTrigger: true }, status: "open" },
        });
      }
      throw new Error("unexpected info request");
    };
    const result = await reconcileHyperliquidExecution({
      credential: credential("testnet"),
      cloid,
      market: "BTC",
      protection: { max_slippage_bps: "50" },
      fetchImpl,
    });
    assert.equal(result.terminal, true);
    assert.equal(result.protection.state, "both_open");
    assert.equal(result.final_proof.position_protection_proven, true);
    assert.equal(result.final_proof.protection_max_slippage_bps, 50);
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
      runner: async () => ({
        status: "submitted",
        oid: 42,
        fills: [],
        execution_configuration: { margin_mode: "isolated", leverage: 1, venue_accepted: true },
        execution_market_gate: {
          source_time_ms: 1_786_800_000_000,
          source_age_ms: 350,
          max_age_ms: 2_000,
          freshness_proven: true,
          slippage_bound_proven: true,
        },
        expires_after_ms: 1_786_800_015_000,
        action_expiry_enforced: true,
        venue_order_readback: {
          verified: true,
          status: "open",
          oid: 42,
          cloid: `0x${"1".repeat(32)}`,
        },
      }),
    });
    assert.equal(submitted.final_proof.broadcast_performed, true);
    assert.equal(submitted.final_proof.final_venue_execution_proven, true);
    assert.equal(submitted.final_proof.final_fill_proven, false);
    assert.equal(submitted.final_proof.market_data_freshness_proven, true);
    assert.equal(submitted.final_proof.action_expiry_proven, true);
    assert.equal(submitted.final_proof.venue_order_readback_proven, true);
    assert.equal(submitted.final_proof.venue_order_status, "open");

    const cancelled = await submitHyperliquidExecution({
      credential: credential("testnet"),
      instruction: {
        operation_class: "cancel",
        expires_at: new Date(Date.now() + 90_000).toISOString(),
        cancel: { market: "HYPE", client_order_id: `0x${"1".repeat(32)}` },
      },
      cloid: `0x${"2".repeat(32)}`,
      runner: async () => ({
        status: "cancelled",
        fills: [],
        broadcast_performed: true,
        expires_after_ms: Date.now() + 90_000,
        action_expiry_enforced: true,
        venue_cancel_readback: {
          verified: true,
          status: "canceled",
          oid: 42,
          cloid: `0x${"1".repeat(32)}`,
        },
      }),
    });
    assert.equal(cancelled.final_proof.broadcast_performed, true);
    assert.equal(cancelled.final_proof.final_venue_execution_proven, true);
    assert.equal(cancelled.final_proof.final_fill_proven, false);
    assert.equal(cancelled.final_proof.cancellation_readback_proven, true);
    assert.equal(cancelled.final_proof.action_expiry_proven, true);
  } finally {
    restore(previous);
  }
});

test("live Hyperliquid cancel proves already-terminal children without rebroadcast", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  const target = `0x${"7".repeat(32)}`;
  try {
    const result = await submitHyperliquidExecution({
      credential: credential("testnet"),
      instruction: {
        operation_class: "cancel",
        expires_at: new Date(Date.now() + 90_000).toISOString(),
        cancel: { market: "HYPE", client_order_id: target },
      },
      cloid: `0x${"8".repeat(32)}`,
      runner: async () => ({
        status: "cancelled",
        broadcast_performed: false,
        expires_after_ms: Date.now() + 90_000,
        action_expiry_enforced: true,
        venue_cancel_readback: { verified: true, status: "canceled", oid: 77, cloid: target },
      }),
    });
    assert.equal(result.final_proof.broadcast_performed, false);
    assert.equal(result.final_proof.final_no_broadcast_proven, true);
    assert.equal(result.final_proof.final_venue_execution_proven, true);

    await assert.rejects(() => submitHyperliquidExecution({
      credential: credential("testnet"),
      instruction: {
        operation_class: "cancel",
        expires_at: new Date(Date.now() + 90_000).toISOString(),
        cancel: { market: "HYPE", client_order_id: target },
      },
      cloid: `0x${"9".repeat(32)}`,
      runner: async () => ({
        status: "cancelled",
        broadcast_performed: true,
        expires_after_ms: Date.now() + 90_000,
        action_expiry_enforced: true,
        venue_cancel_readback: {
          verified: true,
          status: "canceled",
          oid: 77,
          cloid: `0x${"6".repeat(32)}`,
        },
      }),
    }), /cancellation readback proof is missing/);
  } finally {
    restore(previous);
  }
});

test("live Hyperliquid adapter fails closed without worker-side freshness and expiry proof", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    await assert.rejects(() => submitHyperliquidExecution({
      credential: credential("testnet"),
      instruction: {
        operation_class: "limit_order",
        order: { market: "HYPE", side: "buy", quote_size: "11", limit_price: "1", order_type: "limit" },
      },
      cloid: `0x${"3".repeat(32)}`,
      runner: async () => ({
        status: "submitted",
        oid: 43,
        fills: [],
        execution_configuration: { margin_mode: "isolated", leverage: 1, venue_accepted: true },
      }),
    }), /execution freshness proof is missing/);
    await assert.rejects(() => submitHyperliquidExecution({
      credential: credential("testnet"),
      instruction: {
        operation_class: "limit_order",
        order: { market: "HYPE", side: "buy", quote_size: "11", limit_price: "1", order_type: "limit" },
      },
      cloid: `0x${"3".repeat(32)}`,
      runner: async () => ({
        status: "submitted",
        oid: 43,
        fills: [],
        execution_configuration: { margin_mode: "isolated", leverage: 1, venue_accepted: true },
        execution_market_gate: {
          source_time_ms: 1_786_800_000_000,
          source_age_ms: 350,
          max_age_ms: 2_000,
          freshness_proven: true,
          slippage_bound_proven: true,
        },
        expires_after_ms: 1_786_800_015_000,
        action_expiry_enforced: true,
      }),
    }), /venue order readback proof is missing/);
  } finally {
    restore(previous);
  }
});

test("live Hyperliquid adapter requires venue-accepted OCO proof when protection is bound", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  const instruction = {
    operation_class: "limit_order",
    order: { market: "HYPE", side: "buy", base_size: "0.1", limit_price: "100", order_type: "limit" },
    position_protection: {
      mode: "normal_tpsl",
      trigger_source: "mark",
      take_profit_trigger_price: "110",
      stop_loss_trigger_price: "95",
      max_slippage_bps: "50",
    },
  };
  const baseRunnerResult = {
    status: "filled",
    oid: 44,
    fills: [{ coin: "HYPE", px: "100", sz: "0.1", fee: "0", time: 1 }],
    execution_configuration: { margin_mode: "isolated", leverage: 1, venue_accepted: true },
    execution_market_gate: {
      source_time_ms: 1_786_800_000_000,
      source_age_ms: 350,
      max_age_ms: 2_000,
      freshness_proven: true,
      slippage_bound_proven: true,
    },
    expires_after_ms: 1_786_800_015_000,
    action_expiry_enforced: true,
    venue_order_readback: {
      verified: true,
      status: "filled",
      oid: 44,
      cloid: `0x${"4".repeat(32)}`,
    },
  };
  try {
    await assert.rejects(() => submitHyperliquidExecution({
      credential: credential("testnet"),
      instruction,
      cloid: `0x${"4".repeat(32)}`,
      runner: async () => baseRunnerResult,
    }), /position protection proof is missing/);
    const submitted = await submitHyperliquidExecution({
      credential: credential("testnet"),
      instruction,
      cloid: `0x${"4".repeat(32)}`,
      runner: async () => ({
        ...baseRunnerResult,
        position_protection: {
          venue_accepted: true,
          grouping: "normalTpsl",
          trigger_source: "mark",
          trigger_order_type: "bounded_limit",
          take_profit_cloid: `0x${"5".repeat(32)}`,
          stop_loss_cloid: `0x${"6".repeat(32)}`,
          take_profit_oid: 51,
          stop_loss_oid: 52,
          max_slippage_bps: 50,
        },
      }),
    });
    assert.equal(submitted.final_proof.position_protection_proven, true);
    assert.equal(submitted.final_proof.protection_grouping, "normalTpsl");
    assert.equal(submitted.final_proof.protection_max_slippage_bps, 50);
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
    const value = type === "userAbstraction"
      ? "default"
      : type === "clearinghouseState"
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
    const value = type === "userAbstraction"
      ? "default"
      : type === "clearinghouseState"
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

test("unified account snapshots use exact spot collateral without leaking values", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const requests = [];
    const snapshot = await readHyperliquidAccountSnapshot({
      credential: credential("testnet"),
      accountSource: "sealed_byo",
      fetchImpl: unifiedAccountFetch({ requests }),
    });
    assert.equal(snapshot.status, "ready_to_trade");
    assert.equal(snapshot.trading_enabled, true);
    assert.equal(snapshot.equity_bucket, "ready");
    assert.equal(snapshot.margin_utilization_bucket, "unknown");
    assert.equal(snapshot.position_count, 0);
    assert.equal(snapshot.open_order_count, 0);
    assert.deepEqual(new Set(requests), new Set([
      "userAbstraction",
      "clearinghouseState",
      "openOrders",
      "userFills",
      "spotClearinghouseState",
    ]));
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("21.75"), false);
  } finally {
    restore(previous);
  }
});

test("unified account snapshots fail closed on unsupported modes and malformed spot state", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    await assert.rejects(() => readHyperliquidAccountSnapshot({
      credential: credential("testnet"),
      fetchImpl: unifiedAccountFetch({ abstraction: "portfolioMargin" }),
    }), /account abstraction mode is unsupported/);
    await assert.rejects(() => readHyperliquidAccountSnapshot({
      credential: credential("testnet"),
      fetchImpl: unifiedAccountFetch({ total: "10", hold: "10.01" }),
    }), /USDC hold is invalid/);
  } finally {
    restore(previous);
  }
});

test("unified account streams update exact spot collateral and reject cross-user state", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  const events = [];
  const subscriptions = [];
  let socket = null;
  class FakeWebSocket {
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.method === "subscribe") subscriptions.push(message.subscription);
    }
    close() {}
  }
  let stop = () => {};
  try {
    stop = await createHyperliquidAccountStateStream({
      credential: credential("testnet"),
      fetchImpl: unifiedAccountFetch(),
      webSocketCtor: FakeWebSocket,
      onEvent: (event) => events.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(subscriptions.some((row) => row.type === "spotState"), true);
    assert.equal(subscriptions.some((row) => row.type === "activeAssetData" && row.coin === "BTC"), true);
    assert.equal(events.filter((event) => event.event === "account_state").at(-1)?.data?.status, "ready_to_trade");

    const accountStateCount = events.filter((event) => event.event === "account_state").length;
    socket.onmessage({ data: JSON.stringify({
      channel: "spotState",
      data: {
        user: "0x0000000000000000000000000000000000000002",
        spotState: { balances: [{ coin: "USDC", token: 0, total: "100", hold: "0" }] },
      },
    }) });
    assert.equal(events.at(-1)?.event, "error");
    assert.equal(events.filter((event) => event.event === "account_state").length, accountStateCount);

    socket.onmessage({ data: JSON.stringify({
      channel: "spotState",
      data: {
        user: credential("testnet").account_address,
        spotState: { balances: [{ coin: "USDC", token: 0, total: "2", hold: "0" }] },
      },
    }) });
    assert.equal(events.filter((event) => event.event === "account_state").at(-1)?.data?.status, "needs_funds");
  } finally {
    stop();
    restore(previous);
  }
});

test("account snapshots disclose bounded open-order truncation", async () => {
  const previous = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  try {
    const fetchImpl = async (_url, init) => {
      const type = JSON.parse(init.body).type;
      const value = type === "userAbstraction"
        ? "default"
        : type === "clearinghouseState"
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
      const value = type === "userAbstraction"
        ? "default"
        : type === "clearinghouseState"
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
      const value = type === "userAbstraction"
        ? "default"
        : type === "clearinghouseState"
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

function unifiedAccountFetch({
  abstraction = "unifiedAccount",
  total = "21.75",
  hold = "0.0",
  requests = [],
} = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body.type);
    const value = body.type === "userAbstraction"
      ? abstraction
      : body.type === "clearinghouseState"
        ? { marginSummary: { accountValue: "0", totalMarginUsed: "0" }, assetPositions: [] }
        : body.type === "spotClearinghouseState"
          ? { balances: [{ coin: "USDC", token: 0, total, hold }] }
          : [];
    return Response.json(value);
  };
}

function restore(value) {
  if (value == null) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = value;
}
