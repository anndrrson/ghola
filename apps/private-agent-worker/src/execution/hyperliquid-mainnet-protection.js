export async function buildHyperliquidMainnetProtection({
  fetchImpl = fetch,
  baseUrl = "https://api.hyperliquid.xyz",
  market = "HYPE",
  now = Date.now(),
}) {
  const endpoint = new URL(baseUrl);
  const coin = String(market || "").toUpperCase();
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.hyperliquid.xyz") {
    throw protectionError("protection endpoint is not Hyperliquid mainnet");
  }
  const [book, meta] = await Promise.all([
    info(fetchImpl, endpoint.origin, { type: "l2Book", coin }),
    info(fetchImpl, endpoint.origin, { type: "meta" }),
  ]);
  const sourceTimeMs = Number(book?.time);
  const sourceAgeMs = now - sourceTimeMs;
  const bids = Array.isArray(book?.levels?.[0]) ? book.levels[0] : [];
  const asks = Array.isArray(book?.levels?.[1]) ? book.levels[1] : [];
  const bestBid = Math.max(...bids.map((level) => Number(level?.px)).filter((value) => value > 0));
  const bestAsk = Math.min(...asks.map((level) => Number(level?.px)).filter((value) => value > 0));
  const asset = Array.isArray(meta?.universe)
    ? meta.universe.find((row) => String(row?.name || "").toUpperCase() === coin)
    : null;
  const sizeDecimals = Number(asset?.szDecimals);
  if (!Number.isInteger(sourceTimeMs) || sourceAgeMs < -1_000 || sourceAgeMs > 2_000 ||
      !Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= bestBid ||
      !Number.isInteger(sizeDecimals) || sizeDecimals < 0 || sizeDecimals > 6) {
    throw protectionError("fresh executable protection inputs are unavailable");
  }
  const stopLoss = quantizePerpPrice(bestBid * 0.99, sizeDecimals, "down");
  const takeProfit = quantizePerpPrice(bestAsk * 1.03, sizeDecimals, "up");
  const entryReference = (bestBid + bestAsk) / 2;
  if (!(stopLoss < bestBid && takeProfit > bestAsk)) {
    throw protectionError("bounded protection prices are invalid");
  }
  return {
    position_protection: {
      mode: "normal_tpsl",
      trigger_source: "mark",
      take_profit_trigger_price: decimalText(takeProfit),
      stop_loss_trigger_price: decimalText(stopLoss),
      entry_reference_price: decimalText(entryReference),
      max_slippage_bps: "100",
    },
    reference: {
      source: "hyperliquid_l2_book",
      source_time_ms: sourceTimeMs,
      source_age_ms: Math.max(0, sourceAgeMs),
      best_bid: decimalText(bestBid),
      best_ask: decimalText(bestAsk),
      stop_distance_bps: 100,
      take_profit_distance_bps: 300,
      triggered_exit_slippage_cap_bps: 100,
      modeled_max_loss_bps_before_gap_risk: 200,
      checked_at: new Date(now).toISOString(),
    },
  };
}

function quantizePerpPrice(value, sizeDecimals, direction) {
  const decimalQuantum = 10 ** -(6 - sizeDecimals);
  const significantQuantum = 10 ** (Math.floor(Math.log10(value)) - 4);
  const quantum = Math.max(decimalQuantum, significantQuantum);
  const scaled = value / quantum;
  const units = direction === "down" ? Math.floor(scaled + 1e-10) : Math.ceil(scaled - 1e-10);
  return units * quantum;
}

async function info(fetchImpl, baseUrl, body) {
  const response = await fetchImpl(`${baseUrl}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response?.ok) throw protectionError("Hyperliquid protection query failed");
  return response.json();
}

function decimalText(value) {
  return Number(value).toFixed(10).replace(/0+$/u, "").replace(/\.$/u, "");
}

function protectionError(message) {
  return Object.assign(new Error(message), { status: 502, code: "position_protection_unavailable" });
}
