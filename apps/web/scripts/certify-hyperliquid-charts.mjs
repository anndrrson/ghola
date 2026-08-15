#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const BASE_URL = localBaseUrl(process.env.GHOLA_CHART_CERT_BASE_URL || "http://localhost:3022");
const INFO_URL = "https://api.hyperliquid.xyz/info";
const REPORT_PATH = resolve(REPO_ROOT, process.env.GHOLA_CHART_CERT_REPORT_PATH || ".dev/ghola-chart-certification.json");
const COINS = ["BTC", "ETH", "SOL", "HYPE"];
const INTERVALS = ["1m", "5m", "15m", "1h"];
const INTERVAL_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };
const CANDLE_SAMPLE_SIZE = 60;
const MAX_MARKET_DELTA_BPS = 5;
const MAX_SOURCE_BRACKET_SKEW_MS = 6_000;
const BROWSER_ONLY = process.argv.includes("--browser-only");
const REST_RATE_WINDOW_MS = 60_500;
const REST_RATE_WEIGHT_BUDGET = 900;
const LOCAL_SNAPSHOT_WEIGHT = 72;
const CERTIFY_SNAPSHOT_WEIGHT = 155;
const restRateReservations = [];

const report = {
  version: 1,
  status: "running",
  started_at: new Date().toISOString(),
  completed_at: null,
  base_url: BASE_URL,
  cost_guard: {
    paid_runtime_calls: 0,
    allowed_hosts: [new URL(BASE_URL).hostname, "api.hyperliquid.xyz"],
    phala_contacted: false,
    render_contacted: false,
    funded_actions: 0,
  },
  source: {
    venue: "hyperliquid",
    network: "mainnet",
    info_url: INFO_URL,
  },
  checks: [],
  cases: [],
  browser: null,
};

try {
  await assertLocalServer();
  if (BROWSER_ONLY) {
    const previous = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
    const sourceChecks = previous.checks?.filter((item) => !["browser_trade_flow", "fatal"].includes(item.name)) ?? [];
    if (
      previous.cases?.length !== COINS.length * INTERVALS.length
      || !previous.cases.every((item) => item.ok)
      || !sourceChecks.every((item) => item.ok)
    ) {
      throw new Error("browser_only_requires_green_source_report");
    }
    report.checks = sourceChecks;
    report.cases = previous.cases;
    report.resumed_source_report_started_at = previous.started_at;
  } else {
    await wait(4_100); // Expire the route's four-second in-process snapshot cache.

    for (const coin of COINS) {
      for (const interval of INTERVALS) {
        const result = await certifySnapshot(coin, interval);
        report.cases.push(result);
        process.stdout.write(`[certify-charts] ${result.ok ? "ok" : "fail"} ${coin} ${interval} · ${result.candles_compared} closed candles\n`);
        await wait(100);
      }
      await certifyAssetContext(coin, report.cases.filter((item) => item.coin === coin).at(-1)?.snapshot_summary);
    }
  }

  report.browser = await certifyBrowser();
  check("browser_trade_flow", report.browser.ok, report.browser);
  report.status = report.checks.every((item) => item.ok) ? "certified" : "failed";
} catch (error) {
  check("fatal", false, { error: error instanceof Error ? error.message : String(error) });
  report.status = "failed";
} finally {
  report.completed_at = new Date().toISOString();
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const passed = report.checks.filter((item) => item.ok).length;
  const failed = report.checks.length - passed;
  process.stdout.write(`[certify-charts] ${report.status} · ${passed} passed · ${failed} failed\n`);
  process.stdout.write(`[certify-charts] report=${REPORT_PATH}\n`);
  if (report.status !== "certified") process.exitCode = 1;
}

async function certifySnapshot(coin, interval) {
  // Reserve the whole bracket up front so rate-limit waits never separate
  // the local observation from its before/after venue truth.
  await reserveRestWeight(CERTIFY_SNAPSHOT_WEIGHT);
  const before = await Promise.all([
    postInfo({ type: "l2Book", coin }, true),
    postInfo({ type: "recentTrades", coin }, true),
    postInfo({ type: "allMids" }, true),
  ]);
  const snapshot = await getJson(
    `${BASE_URL}/v1/private-account/hyperliquid/market-snapshot?coin=${coin}&interval=${interval}&network=mainnet`,
  );
  const now = Date.now();
  const [afterBook, afterTrades, afterMids, truthCandles] = await Promise.all([
    postInfo({ type: "l2Book", coin }, true),
    postInfo({ type: "recentTrades", coin }, true),
    postInfo({ type: "allMids" }, true),
    postInfo({
      type: "candleSnapshot",
      req: {
        coin,
        interval,
        startTime: now - INTERVAL_MS[interval] * 250,
        endTime: now,
      },
    }, true),
  ]);

  const schema = inspectSnapshot(snapshot, coin, interval);
  const candles = compareClosedCandles(snapshot.candles, truthCandles, now);
  const book = compareBook(snapshot, before[0], afterBook);
  const mids = compareMid(snapshot.mid, before[2]?.[coin], afterMids?.[coin]);
  const trades = compareTrades(snapshot.recent_trades, before[1], afterTrades);
  const prefix = `${coin.toLowerCase()}_${interval}`;
  check(`${prefix}_snapshot_schema`, schema.ok, schema);
  check(`${prefix}_closed_candles_exact`, candles.ok, candles);
  check(`${prefix}_book_and_mid_truth`, book.ok && mids.ok, { book, mids });
  check(`${prefix}_recent_trades_truth`, trades.ok, trades);

  return {
    coin,
    interval,
    ok: schema.ok && candles.ok && book.ok && mids.ok && trades.ok,
    candles_compared: candles.compared,
    candle_mismatches: candles.mismatches,
    bbo_max_delta_bps: Math.max(book.bid_delta_bps, book.ask_delta_bps),
    mid_delta_bps: mids.delta_bps,
    trade_overlap_ratio: trades.overlap_ratio,
    source_age_ms: Date.now() - Number(snapshot.source_timestamp),
    snapshot_summary: {
      mark_price: snapshot.mark_price,
      oracle_price: snapshot.oracle_price,
      funding_rate: snapshot.funding_rate,
      open_interest: snapshot.open_interest,
      day_notional_volume: snapshot.day_notional_volume,
    },
  };
}

async function certifyAssetContext(coin, snapshot) {
  const response = await postInfo({ type: "metaAndAssetCtxs" });
  const context = assetContext(response, coin);
  const comparison = {
    coin,
    available: Boolean(context && snapshot),
    mark_delta_bps: relativeBps(snapshot?.mark_price, context?.markPx),
    oracle_delta_bps: relativeBps(snapshot?.oracle_price, context?.oraclePx),
    funding_delta: absoluteDelta(snapshot?.funding_rate, context?.funding),
    open_interest_delta_ratio: relativeRatio(snapshot?.open_interest, context?.openInterest),
  };
  comparison.ok = comparison.available
    && comparison.mark_delta_bps <= 2
    && comparison.oracle_delta_bps <= 2
    && comparison.funding_delta <= 0.0000001
    && comparison.open_interest_delta_ratio <= 0.01;
  check(`${coin.toLowerCase()}_asset_context_truth`, comparison.ok, comparison);
}

function inspectSnapshot(snapshot, coin, interval) {
  const bids = Array.isArray(snapshot?.bids) ? snapshot.bids : [];
  const asks = Array.isArray(snapshot?.asks) ? snapshot.asks : [];
  const candles = Array.isArray(snapshot?.candles) ? snapshot.candles : [];
  const sourceTimestamp = Number(snapshot?.source_timestamp);
  const fetchedAt = Date.parse(String(snapshot?.fetched_at || ""));
  const bid = Number(snapshot?.best_bid);
  const ask = Number(snapshot?.best_ask);
  const spread = Number(snapshot?.spread_bps);
  const expectedSpread = bid > 0 && ask > bid ? ((ask - bid) / ((ask + bid) / 2)) * 10_000 : Number.NaN;
  const sortedBids = bids.every((item, index) => index === 0 || Number(bids[index - 1].px) >= Number(item.px));
  const sortedAsks = asks.every((item, index) => index === 0 || Number(asks[index - 1].px) <= Number(item.px));
  const evidence = {
    platform: snapshot?.platform,
    network: snapshot?.network,
    coin: snapshot?.coin,
    interval: snapshot?.interval,
    stale: snapshot?.stale,
    candle_count: candles.length,
    bid_levels: bids.length,
    ask_levels: asks.length,
    source_age_ms: Date.now() - sourceTimestamp,
    spread_error_bps: Math.abs(spread - expectedSpread),
    size_decimals: snapshot?.size_decimals,
    sorted_bids: sortedBids,
    sorted_asks: sortedAsks,
  };
  evidence.ok = snapshot?.platform === "hyperliquid"
    && snapshot?.network === "mainnet"
    && snapshot?.coin === coin
    && snapshot?.interval === interval
    && snapshot?.stale === false
    && Number.isFinite(fetchedAt)
    && Number.isFinite(sourceTimestamp)
    && Number.isInteger(snapshot?.size_decimals)
    && snapshot.size_decimals >= 0
    && snapshot.size_decimals <= 6
    && Date.now() - sourceTimestamp >= -30_000
    && Date.now() - sourceTimestamp <= 120_000
    && candles.length >= 200
    && bids.length > 0 && bids.length <= 20
    && asks.length > 0 && asks.length <= 20
    && sortedBids && sortedAsks
    && bid > 0 && ask > bid
    && snapshot.best_bid === bids[0]?.px
    && snapshot.best_ask === asks[0]?.px
    // Ghola intentionally publishes spread to two decimal places (0.01 bp).
    && evidence.spread_error_bps <= 0.0050001;
  return evidence;
}

function compareClosedCandles(localValue, truthValue, now) {
  const local = Array.isArray(localValue) ? localValue : [];
  const truth = new Map((Array.isArray(truthValue) ? truthValue : []).map((item) => [Number(item?.t), item]));
  const closed = local
    .filter((item) => Number(item?.T) < now - 1_000)
    .slice(-CANDLE_SAMPLE_SIZE);
  const mismatches = [];
  for (const candle of closed) {
    const expected = truth.get(Number(candle.t));
    const fields = ["T", "o", "h", "l", "c", "v", "n"];
    const different = !expected || fields.some((field) => String(candle?.[field]) !== String(expected?.[field]));
    if (different && mismatches.length < 5) {
      mismatches.push({ t: candle?.t, local: compactCandle(candle), venue: compactCandle(expected) });
    }
  }
  return {
    ok: closed.length >= 50 && mismatches.length === 0,
    compared: closed.length,
    mismatches: mismatches.length,
    first_mismatches: mismatches,
  };
}

function compareBook(snapshot, before, after) {
  const source = Number(snapshot?.source_timestamp);
  const beforeTime = Number(before?.time);
  const afterTime = Number(after?.time);
  const beforeBid = before?.levels?.[0]?.[0]?.px;
  const beforeAsk = before?.levels?.[1]?.[0]?.px;
  const afterBid = after?.levels?.[0]?.[0]?.px;
  const afterAsk = after?.levels?.[1]?.[0]?.px;
  const closest = Math.abs(source - beforeTime) <= Math.abs(source - afterTime)
    ? { bid: beforeBid, ask: beforeAsk, time: beforeTime }
    : { bid: afterBid, ask: afterAsk, time: afterTime };
  const result = {
    source_timestamp: source,
    truth_before: beforeTime,
    truth_after: afterTime,
    closest_truth_timestamp: closest.time,
    bid_delta_bps: relativeBps(snapshot?.best_bid, closest.bid),
    ask_delta_bps: relativeBps(snapshot?.best_ask, closest.ask),
  };
  result.ok = Number.isFinite(source)
    && source >= Math.min(beforeTime, afterTime) - MAX_SOURCE_BRACKET_SKEW_MS
    && source <= Math.max(beforeTime, afterTime) + MAX_SOURCE_BRACKET_SKEW_MS
    && result.bid_delta_bps <= MAX_MARKET_DELTA_BPS
    && result.ask_delta_bps <= MAX_MARKET_DELTA_BPS;
  return result;
}

function compareMid(local, before, after) {
  const deltas = [relativeBps(local, before), relativeBps(local, after)].filter(Number.isFinite);
  const delta = deltas.length ? Math.min(...deltas) : Number.POSITIVE_INFINITY;
  return { ok: delta <= MAX_MARKET_DELTA_BPS, delta_bps: delta };
}

function compareTrades(localValue, beforeValue, afterValue) {
  const local = Array.isArray(localValue) ? localValue : [];
  const truth = new Set([...normalizeTruthTrades(beforeValue), ...normalizeTruthTrades(afterValue)].map(tradeKey));
  const overlap = local.filter((item) => truth.has(tradeKey(item))).length;
  const overlapRatio = local.length ? overlap / local.length : 0;
  return {
    ok: local.length > 0 && overlapRatio >= 0.5,
    local_count: local.length,
    truth_union_count: truth.size,
    overlap_count: overlap,
    overlap_ratio: overlapRatio,
  };
}

async function certifyBrowser() {
  const browser = await chromium.launch({ headless: true });
  try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const blockedHosts = new Set();
  const allowedHosts = new Set([new URL(BASE_URL).hostname, "api.hyperliquid.xyz"]);
  await context.route("**/*", async (route) => {
    const host = new URL(route.request().url()).hostname;
    if (allowedHosts.has(host)) await route.continue();
    else {
      blockedHosts.add(host);
      await route.abort("blockedbyclient");
    }
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const failedMarketRequests = [];
  const websocketHosts = new Set();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("market-snapshot") && response.status() >= 400) {
      failedMarketRequests.push({ url: response.url(), status: response.status() });
    }
  });
  page.on("websocket", (socket) => websocketHosts.add(new URL(socket.url()).hostname));

  await reserveRestWeight(LOCAL_SNAPSHOT_WEIGHT);
  const response = await page.goto(`${BASE_URL}/trade`, { waitUntil: "networkidle", timeout: 30_000 });
  const cases = [];
  for (const coin of COINS) {
    await reserveRestWeight(LOCAL_SNAPSHOT_WEIGHT);
    await page.getByLabel("Market", { exact: true }).selectOption(coin);
    for (const interval of INTERVALS) {
      await reserveRestWeight(LOCAL_SNAPSHOT_WEIGHT);
      await page.getByRole("group", { name: "Chart interval" }).getByRole("button", { name: interval, exact: true }).click();
      try {
        await page.waitForFunction(({ expectedCoin, expectedInterval }) => {
          const chart = Array.from(document.querySelectorAll('svg[role="img"]')).find((item) =>
            (item.getAttribute("aria-label") || "").includes(`${expectedCoin} ${expectedInterval} trading chart`));
          const activeInterval = document.querySelector(
            '[role="group"][aria-label="Chart interval"] button[aria-pressed="true"]',
          )?.textContent?.trim();
          const selectedCoin = document.querySelector('select[aria-label="Market"]')?.value;
          const chartLabel = chart?.getAttribute("aria-label") || "";
          const feedHealthy = chartLabel.includes("Live")
            && chartLabel.includes("Certified chart interactions enabled");
          const transport = document.querySelector("[data-terminal-market-transport]");
          const executionFeedReady = transport?.getAttribute("data-terminal-market-transport") === "websocket"
            && transport?.getAttribute("data-terminal-execution-market-ready") === "true";
          const price = Number((document.querySelector("[data-terminal-market-price]")?.textContent || "").replaceAll(/[$,]/gu, ""));
          return selectedCoin === expectedCoin && chart instanceof SVGSVGElement
            && activeInterval === expectedInterval
            && feedHealthy
            && executionFeedReady
            && chart.viewBox.baseVal.width > 0 && chart.viewBox.baseVal.height > 0
            && Number.isFinite(price) && price > 0;
        }, { expectedCoin: coin, expectedInterval: interval }, { timeout: 12_000 });
      } catch (error) {
        const diagnostic = await page.evaluate(() => {
          const transport = document.querySelector("[data-terminal-market-transport]");
          const chartLabels = Array.from(document.querySelectorAll('svg[role="img"]'))
            .map((item) => item.getAttribute("aria-label"))
            .filter(Boolean);
          const feedLabels = Array.from(document.querySelectorAll("section[aria-label]"))
            .map((item) => item.getAttribute("aria-label"))
            .filter((label) => label?.includes("market data"));
          return {
            selected_coin: document.querySelector('select[aria-label="Market"]')?.value || null,
            active_interval: document.querySelector('[role="group"][aria-label="Chart interval"] button[aria-pressed="true"]')?.textContent?.trim() || null,
            transport: transport?.getAttribute("data-terminal-market-transport") || null,
            execution_feed_ready: transport?.getAttribute("data-terminal-execution-market-ready") || null,
            transport_label: transport?.textContent?.trim() || null,
            chart_labels: chartLabels,
            feed_labels: feedLabels,
          };
        });
        throw new Error(`${coin} ${interval} browser readiness timeout: ${JSON.stringify(diagnostic)}; ${error instanceof Error ? error.message : String(error)}`);
      }
      const state = await page.evaluate(({ expectedCoin, expectedInterval }) => {
        const chart = Array.from(document.querySelectorAll('svg[role="img"]')).find((item) =>
          (item.getAttribute("aria-label") || "").includes(`${expectedCoin} ${expectedInterval} trading chart`));
        const activeInterval = document.querySelector(
          '[role="group"][aria-label="Chart interval"] button[aria-pressed="true"]',
        )?.textContent?.trim() || null;
        const feedLabel = Array.from(document.querySelectorAll("section[aria-label]"))
          .map((item) => item.getAttribute("aria-label") || "")
          .find((label) => label.includes("WS ·") || label.includes("Fallback ·")) || "";
        const chartLabel = chart?.getAttribute("aria-label") || "";
        const feedHealthy = chartLabel.includes("Live")
          && chartLabel.includes("Certified chart interactions enabled");
        const transport = document.querySelector("[data-terminal-market-transport]");
        const marketTransport = transport?.getAttribute("data-terminal-market-transport") || null;
        const executionFeedReady = marketTransport === "websocket"
          && transport?.getAttribute("data-terminal-execution-market-ready") === "true";
        const toolbar = document.querySelector('[data-chart-toolbar="terminal"]');
        const inspection = document.querySelector('[data-chart-inspection-strip="terminal"]');
        const chartRoot = toolbar?.closest("[data-terminal-chart-root]");
        const chartBounds = chartRoot?.getBoundingClientRect();
        const controlsFit = Boolean(toolbar && inspection && chartBounds)
          && toolbar.scrollWidth <= toolbar.clientWidth + 1
          && inspection.scrollWidth <= inspection.clientWidth + 1
          && Array.from(toolbar.querySelectorAll("button")).every((button) => {
            const bounds = button.getBoundingClientRect();
            return bounds.left >= chartBounds.left - 1
              && bounds.right <= chartBounds.right + 1
              && button.scrollWidth <= button.clientWidth;
          });
        const price = Number((document.querySelector("[data-terminal-market-price]")?.textContent || "").replaceAll(/[$,]/gu, ""));
        const venueLot = document.querySelector("[data-terminal-venue-lot]");
        const venueBaseSize = Number(venueLot?.getAttribute("data-terminal-base-size"));
        const effectiveNotional = Number(venueLot?.getAttribute("data-terminal-effective-notional"));
        return {
          coin: expectedCoin,
          interval: expectedInterval,
          active_interval: activeInterval,
          feed_healthy: feedHealthy,
          feed_label: feedLabel,
          market_transport: marketTransport,
          execution_feed_ready: executionFeedReady,
          controls_fit: controlsFit,
          toolbar_client_width: toolbar?.clientWidth || 0,
          toolbar_scroll_width: toolbar?.scrollWidth || 0,
          inspection_client_width: inspection?.clientWidth || 0,
          inspection_scroll_width: inspection?.scrollWidth || 0,
          price,
          venue_base_size: venueBaseSize,
          effective_notional: effectiveNotional,
          canvas_width: chart?.viewBox.baseVal.width || 0,
          canvas_height: chart?.viewBox.baseVal.height || 0,
        };
      }, { expectedCoin: coin, expectedInterval: interval });
      cases.push({
        ...state,
        ok: state.active_interval === interval
          && state.feed_healthy
          && state.execution_feed_ready
          && state.controls_fit
          && state.price > 0
          && state.venue_base_size > 0
          && state.effective_notional >= 10
          && state.effective_notional <= 11.01
          && state.canvas_width > 0
          && state.canvas_height > 0,
      });
    }
  }
  await page.screenshot({ path: "/tmp/ghola-chart-certification.png", fullPage: false });
  const overlayCount = await page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay").count();
  await reserveRestWeight(LOCAL_SNAPSHOT_WEIGHT);
  const home = await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle", timeout: 30_000 });
  const disallowedWebsockets = [...websocketHosts].filter((host) => !allowedHosts.has(host));
  return {
    ok: response?.status() === 200
      && home?.status() === 200
      && cases.length === COINS.length * INTERVALS.length
      && cases.every((item) => item.ok)
      && overlayCount === 0
      && consoleErrors.length === 0
      && failedMarketRequests.length === 0
      && disallowedWebsockets.length === 0,
    trade_status: response?.status() ?? null,
    home_status: home?.status() ?? null,
    cases,
    overlay_count: overlayCount,
    console_errors: consoleErrors,
    failed_market_requests: failedMarketRequests,
    blocked_hosts: [...blockedHosts],
    websocket_hosts: [...websocketHosts],
    disallowed_websocket_hosts: disallowedWebsockets,
    screenshot: "/tmp/ghola-chart-certification.png",
  };
  } finally {
    await browser.close();
  }
}

async function assertLocalServer() {
  const response = await fetch(`${BASE_URL}/trade`, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`local_trade_unavailable_${response.status}`);
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`get_${response.status}_${new URL(url).pathname}`);
  return response.json();
}

async function postInfo(body, reserved = false) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!reserved || attempt > 0) await reserveRestWeight(infoRequestWeight(body));
    const response = await fetch(INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) return response.json();
    if (response.status !== 429 || attempt === 3) {
      throw new Error(`hyperliquid_info_${response.status}_${body.type}`);
    }
    await wait(2_000 * (attempt + 1));
  }
  throw new Error(`hyperliquid_info_retry_exhausted_${body.type}`);
}

function assetContext(value, coin) {
  if (!Array.isArray(value) || !Array.isArray(value[0]?.universe) || !Array.isArray(value[1])) return null;
  const index = value[0].universe.findIndex((item) => item?.name === coin);
  return index >= 0 ? value[1][index] : null;
}

function normalizeTruthTrades(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || (item.side !== "B" && item.side !== "A")) return [];
    return [{ side: item.side === "B" ? "buy" : "sell", px: String(item.px), sz: String(item.sz), time: Number(item.time) }];
  });
}

function tradeKey(item) {
  return `${item?.time}:${item?.side}:${item?.px}:${item?.sz}`;
}

function compactCandle(value) {
  if (!value) return null;
  return { T: value.T, o: value.o, h: value.h, l: value.l, c: value.c, v: value.v, n: value.n };
}

function relativeBps(leftValue, rightValue) {
  const left = Number(leftValue);
  const right = Number(rightValue);
  const midpoint = (Math.abs(left) + Math.abs(right)) / 2;
  return Number.isFinite(left) && Number.isFinite(right) && midpoint > 0
    ? Math.abs(left - right) / midpoint * 10_000
    : Number.POSITIVE_INFINITY;
}

function relativeRatio(leftValue, rightValue) {
  const left = Number(leftValue);
  const right = Number(rightValue);
  const denominator = Math.max(Math.abs(left), Math.abs(right));
  return Number.isFinite(left) && Number.isFinite(right) && denominator > 0
    ? Math.abs(left - right) / denominator
    : Number.POSITIVE_INFINITY;
}

function absoluteDelta(leftValue, rightValue) {
  const left = Number(leftValue);
  const right = Number(rightValue);
  return Number.isFinite(left) && Number.isFinite(right)
    ? Math.abs(left - right)
    : Number.POSITIVE_INFINITY;
}

function check(name, ok, evidence) {
  report.checks.push({ name, ok: ok === true, evidence });
}

function localBaseUrl(value) {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("chart_certification_requires_localhost");
  }
  return url.origin;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function infoRequestWeight(body) {
  if (body.type === "allMids" || body.type === "l2Book") return 2;
  if (body.type === "recentTrades") return 22;
  if (body.type === "candleSnapshot") return 25;
  return 20;
}

async function reserveRestWeight(weight) {
  while (true) {
    const now = Date.now();
    while (restRateReservations[0]?.at <= now - REST_RATE_WINDOW_MS) {
      restRateReservations.shift();
    }
    const used = restRateReservations.reduce((total, item) => total + item.weight, 0);
    if (used + weight <= REST_RATE_WEIGHT_BUDGET) {
      restRateReservations.push({ at: now, weight });
      return;
    }
    await wait(Math.max(100, restRateReservations[0].at + REST_RATE_WINDOW_MS - now));
  }
}
