import { createHash } from "node:crypto";

const SUPPORTED_MARKETS = new Set(["BTC-USD", "ETH-USD", "SOL-USD"]);
const SPOT_VENUES = new Set(["coinbase_advanced", "jupiter"]);
const PERP_VENUES = new Set(["hyperliquid", "phoenix", "backpack"]);
const DEFAULT_FEE_BPS = {
  coinbase_advanced: 60,
  hyperliquid: 5,
  phoenix: 5,
  backpack: 5,
  jupiter: 10,
};

export function isArbitrageSession(session) {
  return session?.session_policy?.strategy_id === "hedged_spread_arbitrage_v1" ||
    session?.strategy?.strategy_id === "hedged_spread_arbitrage_v1";
}

export async function runGuardedArbitrageTick({
  session,
  state,
  recipient,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
  appendEvent,
  executeOrder,
  verifyOrder,
}) {
  const markets = session.session_policy.market_allowlist.filter((market) => SUPPORTED_MARKETS.has(normalizeMarket(market)));
  await appendEvent(state, session, "arb_scan", "Guarded arbitrage scan started.", {
    markets,
    venue_allowlist: session.session_policy.venue_allowlist,
  }, now);

  const opportunity = await bestArbitrageOpportunity({ session, env, fetchImpl, now });
  await state.appendAutopilotOpportunity?.(session.autopilot_session_id, publicOpportunity(opportunity));

  if (!opportunity.ok) {
    await appendEvent(state, session, "arb_reject", opportunity.message, opportunity.data, now);
    return { ok: false, error: opportunity.error };
  }

  await appendEvent(state, session, "arb_opportunity", "Hedged spread opportunity passed deterministic screening.", publicOpportunity(opportunity), now);

  const config = enforceArbitrageLiveConfig({ session, env, requestedNotionalUsd: opportunity.leg_notional_usd });
  if (!config.ok) {
    await appendEvent(state, session, "arb_reject", "Arbitrage live config is not armed.", {
      reason_codes: config.reason_codes,
    }, now);
    return { ok: false, error: "arb_live_config_blocked", reason_codes: config.reason_codes };
  }

  const dayKey = now.toISOString().slice(0, 10);
  const daily = await state.incrementPolicyAmount(
    `arb_daily_notional:${session.session_policy.policy_commitment}:${dayKey}`,
    opportunity.leg_notional_usd * 2,
    config.daily_cap_usd,
  );
  if (!daily.ok) {
    await appendEvent(state, session, "arb_reject", "Arbitrage daily notional cap exceeded.", {
      daily_cap_usd: config.daily_cap_usd,
    }, now);
    return { ok: false, error: "arb_daily_cap_exceeded" };
  }

  if (env.PRIVATE_AGENT_ARB_LIVE_SUBMIT !== "true" && env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    await appendEvent(state, session, "arb_reject", "Arbitrage live submit gate is disabled.", {
      required_env: "PRIVATE_AGENT_ARB_LIVE_SUBMIT=true",
    }, now);
    return { ok: false, error: "arb_live_submit_disabled" };
  }

  const pairCommitment = `arb_pair_${digest({ session: session.autopilot_session_id, opportunity: opportunity.opportunity_id, now: now.toISOString() })}`;
  const buyWorkOrder = `${pairCommitment}_buy`;
  const sellWorkOrder = `${pairCommitment}_sell`;
  const buyInstruction = instructionForLeg({
    venue: opportunity.buy_venue,
    market: opportunity.market,
    side: "buy",
    price: opportunity.buy_price,
    notional: opportunity.leg_notional_usd,
    policy: session.session_policy,
    now,
  });
  const sellInstruction = instructionForLeg({
    venue: opportunity.sell_venue,
    market: opportunity.market,
    side: "sell",
    price: opportunity.sell_price,
    notional: opportunity.leg_notional_usd,
    policy: session.session_policy,
    now,
  });
  let preflightReceipts;
  try {
    const started = Date.now();
    const preflight = Promise.all([
      verifyOrder({
        venue_id: opportunity.buy_venue,
        operation_class: operationForVenue(opportunity.buy_venue),
        work_order_commitment: `${buyWorkOrder}_preflight`,
        policy_commitment: session.session_policy.policy_commitment,
        session_policy: workerSessionPolicy(session),
        instruction: buyInstruction,
        execution: executionForVenue(session, opportunity.buy_venue),
        recipient,
        state,
      }),
      verifyOrder({
        venue_id: opportunity.sell_venue,
        operation_class: operationForVenue(opportunity.sell_venue),
        work_order_commitment: `${sellWorkOrder}_preflight`,
        policy_commitment: session.session_policy.policy_commitment,
        session_policy: workerSessionPolicy(session),
        instruction: sellInstruction,
        execution: executionForVenue(session, opportunity.sell_venue),
        recipient,
        state,
      }),
    ]);
    preflightReceipts = await withTimeout(preflight, config.max_execution_skew_ms, "arb_pair_preflight_timeout");
    const latencyMs = Date.now() - started;
    if (latencyMs > config.max_execution_skew_ms) throw new Error("arb_pair_preflight_skew_exceeded");
  } catch (error) {
    await appendEvent(state, session, "arb_reject", "Arbitrage pair preflight failed before submit.", {
      pair_commitment: pairCommitment,
      error: String(error?.message || "preflight_failed"),
    }, now);
    return { ok: false, error: "arb_pair_preflight_failed" };
  }
  await appendEvent(state, session, "arb_pair_preflight", "Both arbitrage legs passed no-submit preflight.", {
    pair_commitment: pairCommitment,
    verifications: preflightReceipts.map((receipt) => ({
      venue_id: receipt.venue_id || (receipt.platform_class === "hyperliquid_style_market" ? "hyperliquid" : null),
      status: receipt.status,
      verification_commitment: receipt.verification_commitment,
      result_commitment: receipt.result_commitment,
    })),
    max_execution_skew_ms: config.max_execution_skew_ms,
  }, now);
  const buyLeg = executeOrder({
    venue_id: opportunity.buy_venue,
    operation_class: operationForVenue(opportunity.buy_venue),
    work_order_commitment: buyWorkOrder,
    policy_commitment: session.session_policy.policy_commitment,
    session_policy: workerSessionPolicy(session),
    instruction: buyInstruction,
    execution: executionForVenue(session, opportunity.buy_venue),
    recipient,
    state,
  });
  const sellLeg = executeOrder({
    venue_id: opportunity.sell_venue,
    operation_class: operationForVenue(opportunity.sell_venue),
    work_order_commitment: sellWorkOrder,
    policy_commitment: session.session_policy.policy_commitment,
    session_policy: workerSessionPolicy(session),
    instruction: sellInstruction,
    execution: executionForVenue(session, opportunity.sell_venue),
    recipient,
    state,
  });

  let receipts;
  try {
    const started = Date.now();
    receipts = await withTimeout(Promise.all([buyLeg, sellLeg]), config.max_execution_skew_ms, "arb_pair_submit_timeout");
    const latencyMs = Date.now() - started;
    if (latencyMs > config.max_execution_skew_ms) throw new Error("arb_pair_submit_skew_exceeded");
  } catch (error) {
    await appendEvent(state, session, "unhedged_leg_requires_human", "One arbitrage leg failed before pair reconciliation.", {
      pair_commitment: pairCommitment,
      error: String(error?.message || "leg_failed"),
    }, now);
    const paused = { ...session, status: "paused", execution_enabled: false, updated_at: now.toISOString() };
    await state.putAutopilotSession(paused);
    return { ok: false, error: "arb_pair_leg_failed" };
  }

  await appendEvent(state, session, "arb_pair_submitted", "Worker submitted both bounded arbitrage legs.", {
    pair_commitment: pairCommitment,
    buy_venue: opportunity.buy_venue,
    sell_venue: opportunity.sell_venue,
    market: opportunity.market,
    leg_notional_bucket: String(opportunity.leg_notional_usd),
  }, now);

  const updated = await state.getAutopilotSession(session.autopilot_session_id) || session;
  updated.order_count = Number(updated.order_count || 0) + 2;
  updated.last_execution_at = now.toISOString();
  updated.daily_notional_used_bucket = String(
    Math.min(bucketToUsd(updated.session_policy.max_daily_notional_bucket), (
      Number(updated.daily_notional_used_bucket || 0) + opportunity.leg_notional_usd * 2
    )),
  );
  updated.updated_at = now.toISOString();
  await state.putAutopilotSession(updated);

  await appendEvent(state, updated, "arb_pair_reconciled", "Both arbitrage legs reconciled into worker state.", {
    pair_commitment: pairCommitment,
    receipts: receipts.map((receipt) => ({
      venue_id: receipt.venue_id,
      status: receipt.status,
      work_order_commitment: receipt.work_order_commitment,
      provider_ref_commitment: receipt.provider_ref_commitment,
      result_commitment: receipt.result_commitment,
    })),
  }, now);

  return { ok: true, opportunity, receipts };
}

export async function bestArbitrageOpportunity({ session, env = process.env, fetchImpl = fetch, now = new Date() }) {
  const snapshots = await marketSnapshots({ session, env, fetchImpl, now });
  const candidates = [];
  for (const market of session.session_policy.market_allowlist.map(normalizeMarket).filter((item) => SUPPORTED_MARKETS.has(item))) {
    for (const left of snapshots.filter((snap) => snap.market === market)) {
      for (const right of snapshots.filter((snap) => snap.market === market && snap.venue_id !== left.venue_id)) {
        if (!validPair(left.venue_id, right.venue_id)) continue;
        const buy = left.price <= right.price ? left : right;
        const sell = left.price <= right.price ? right : left;
        const grossEdgeBps = ((sell.price - buy.price) / buy.price) * 10_000;
        const costBps = feeBps(buy.venue_id, env) + feeBps(sell.venue_id, env) + Number(session.session_policy.max_slippage_bps || 0) * 2;
        const netEdgeBps = Math.round(grossEdgeBps - costBps);
        const marketDataSkewMs = Math.abs(new Date(left.fetched_at).getTime() - new Date(right.fetched_at).getTime());
        const reasonCodes = [
          ...(netEdgeBps >= minNetEdgeBps(session, env) ? [] : ["net_edge_below_threshold"]),
          ...(marketDataSkewMs <= maxMarketSkewMs(env) ? [] : ["market_data_skew_exceeded"]),
        ];
        const legNotionalUsd = Math.min(
          bucketToUsd(session.session_policy.max_notional_bucket),
          remainingDailyNotional(session),
          capUsd(env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD, Number.POSITIVE_INFINITY),
        );
        if (legNotionalUsd <= 0) reasonCodes.push("notional_cap_exhausted");
        candidates.push({
          version: 1,
          opportunity_id: `arbopp_${digest({ market, buy, sell, now: now.toISOString() }).slice(0, 24)}`,
          status: reasonCodes.length === 0 ? "ready" : "blocked",
          market,
          buy_venue: buy.venue_id,
          sell_venue: sell.venue_id,
          buy_price: buy.price,
          sell_price: sell.price,
          buy_fetched_at: buy.fetched_at,
          sell_fetched_at: sell.fetched_at,
          market_data_skew_ms: marketDataSkewMs,
          gross_edge_bps: Math.round(grossEdgeBps),
          estimated_cost_bps: Math.round(costBps),
          net_edge_bps: netEdgeBps,
          min_net_edge_bps: minNetEdgeBps(session, env),
          leg_notional_usd: legNotionalUsd,
          reason_codes: reasonCodes,
          created_at: now.toISOString(),
        });
      }
    }
  }
  const best = candidates.sort((a, b) => b.net_edge_bps - a.net_edge_bps)[0];
  if (!best) {
    return {
      ok: false,
      error: "arb_no_supported_pair",
      message: "No supported hedged venue pair is ready.",
      data: { snapshots: snapshots.map(publicSnapshot) },
    };
  }
  if (best.status !== "ready") {
    return {
      ok: false,
      error: best.reason_codes[0] || "arb_opportunity_blocked",
      message: "Best arbitrage opportunity did not pass policy.",
      data: publicOpportunity(best),
    };
  }
  return { ok: true, ...best };
}

export function enforceArbitrageLiveConfig({ session, env = process.env, requestedNotionalUsd }) {
  const reasonCodes = [];
  const maxLeg = capUsd(env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD, 0);
  const daily = capUsd(env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD, 0);
  const minEdge = capBps(env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS, 0);
  const maxSkew = capMs(env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS, 0);
  if (env.PRIVATE_AGENT_ARB_LIVE_SUBMIT !== "true" && env.PRIVATE_AGENT_VENUE_DRY_RUN !== "true") {
    reasonCodes.push("arb_live_submit_disabled");
  }
  if (maxLeg <= 0) reasonCodes.push("max_leg_notional_required");
  if (daily <= 0) reasonCodes.push("daily_notional_cap_required");
  if (minEdge <= 0) reasonCodes.push("min_net_edge_required");
  if (maxSkew <= 0) reasonCodes.push("max_execution_skew_required");
  if (maxLeg > 0 && requestedNotionalUsd > maxLeg) reasonCodes.push("leg_notional_exceeds_env_cap");
  const policyMax = bucketToUsd(session.session_policy.max_notional_bucket);
  if (policyMax > 0 && requestedNotionalUsd > policyMax) reasonCodes.push("leg_notional_exceeds_session_cap");
  return reasonCodes.length
    ? { ok: false, reason_codes: reasonCodes }
    : { ok: true, max_leg_notional_usd: maxLeg, daily_cap_usd: daily, min_net_edge_bps: minEdge, max_execution_skew_ms: maxSkew };
}

async function marketSnapshots({ session, env, fetchImpl, now }) {
  if (env.PRIVATE_AGENT_ARB_SIGNAL_MODE === "force" || env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE === "force") {
    const market = normalizeMarket(session.session_policy.market_allowlist[0] || "SOL-USD");
    const base = capUsd(env.PRIVATE_AGENT_ARB_FORCE_BUY_PRICE || env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE, 100);
    const sell = capUsd(env.PRIVATE_AGENT_ARB_FORCE_SELL_PRICE, base * 1.03);
    const ready = readyVenues(session);
    const hedgeVenue = ready.includes("hyperliquid") ? "hyperliquid" : ready.find((venue) => PERP_VENUES.has(venue)) || "hyperliquid";
    const buyVenue = ready.find((venue) => venue !== hedgeVenue) ||
      (session.session_policy.venue_allowlist.includes("coinbase_advanced") ? "coinbase_advanced" : "jupiter");
    return [
      snapshot({ venue_id: buyVenue, market, price: base, now, source: "forced", latency_ms: 0 }),
      snapshot({ venue_id: hedgeVenue, market, price: sell, now, source: "forced", latency_ms: 0 }),
    ];
  }
  const timeoutMs = marketFetchTimeoutMs(env);
  const markets = session.session_policy.market_allowlist
    .map(normalizeMarket)
    .filter((item) => SUPPORTED_MARKETS.has(item));
  const tasks = [];
  for (const venue of readyVenues(session)) {
    if (venue === "hyperliquid") {
      tasks.push(fetchHyperliquidSnapshots({ markets, fetchImpl, timeoutMs }));
      continue;
    }
    for (const market of markets) {
      tasks.push(fetchTimedVenueSnapshot({ venue, market, fetchImpl, timeoutMs }));
    }
  }
  return (await Promise.all(tasks)).flat().filter(Boolean);
}

async function fetchTimedVenueSnapshot({ venue, market, fetchImpl, timeoutMs }) {
  const started = Date.now();
  const price = await withTimeout(
    fetchVenuePrice({ venue, market, fetchImpl }),
    timeoutMs,
    "market_fetch_timeout",
  ).catch(() => null);
  if (!price) return null;
  return snapshot({
    venue_id: venue,
    market,
    price,
    now: new Date(),
    source: "live",
    latency_ms: Date.now() - started,
  });
}

async function fetchHyperliquidSnapshots({ markets, fetchImpl, timeoutMs }) {
  const started = Date.now();
  const request = fetchImpl("https://api.hyperliquid.xyz/info", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  const response = await withTimeout(
    request,
    timeoutMs,
    "market_fetch_timeout",
  ).catch(() => null);
  if (!response?.ok) return [];
  const mids = await withTimeout(response.json(), timeoutMs, "market_parse_timeout").catch(() => null);
  if (!mids || typeof mids !== "object") return [];
  const fetchedAt = new Date();
  return markets
    .map((market) => {
      const price = numberValue(mids[baseMarket(market)]);
      return price
        ? snapshot({
            venue_id: "hyperliquid",
            market,
            price,
            now: fetchedAt,
            source: "live",
            latency_ms: Date.now() - started,
          })
        : null;
    })
    .filter(Boolean);
}

async function fetchVenuePrice({ venue, market, fetchImpl }) {
  if (venue === "coinbase_advanced") {
    const response = await fetchImpl(`https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(market)}`, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return numberValue(body.price || body.mid_market_price || body.pricebook?.best_bid);
  }
  if (venue === "hyperliquid") {
    const response = await fetchImpl("https://api.hyperliquid.xyz/info", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    if (!response.ok) return null;
    const mids = await response.json();
    return numberValue(mids[baseMarket(market)]);
  }
  if (venue === "backpack") {
    const symbol = `${baseMarket(market)}_USDC_PERP`;
    const response = await fetchImpl(`https://api.backpack.exchange/api/v1/ticker?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return numberValue(body.lastPrice || body.markPrice || body.indexPrice);
  }
  if (venue === "phoenix") {
    const response = await fetchImpl("https://perp-api.phoenix.trade/markets", {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    }).catch(() => null);
    if (!response?.ok) return null;
    const body = await response.json().catch(() => null);
    return numberValue(body?.["SOL-PERP"]?.markPrice || body?.markets?.["SOL-PERP"]?.markPrice || body?.[0]?.markPrice);
  }
  return null;
}

function instructionForLeg({ venue, market, side, price, notional, policy, now }) {
  const expiresAt = new Date(now.getTime() + Math.min(5 * 60_000, policy.ttl_ms)).toISOString();
  if (venue === "jupiter") {
    const sol = "So11111111111111111111111111111111111111112";
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    return {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "jupiter",
      operation_class: "swap",
      expires_at: expiresAt,
      order: {
        input_mint: side === "buy" ? usdc : sol,
        output_mint: side === "buy" ? sol : usdc,
        amount: side === "buy" ? String(Math.floor(notional * 1_000_000)) : String(Math.floor((notional / price) * 1_000_000_000)),
        quote_size: String(notional),
        max_slippage_bps: String(policy.max_slippage_bps),
        routing_mode: "meta_aggregator",
      },
    };
  }
  if (venue === "coinbase_advanced") {
    return {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: venue,
      operation_class: "spot_market_order",
      expires_at: expiresAt,
      order: {
        market,
        side,
        quote_size: String(notional),
        order_type: "market",
        size_mode: "quote",
        tif: "ioc",
      },
    };
  }
  const limit = side === "buy"
    ? price * (1 + policy.max_slippage_bps / 10_000)
    : price * (1 - policy.max_slippage_bps / 10_000);
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: venue,
    operation_class: operationForVenue(venue),
    expires_at: expiresAt,
    order: {
      market: venueMarketSymbol(venue, market),
      side,
      quote_size: String(notional),
      limit_price: trim(limit),
      order_type: "market",
      size_mode: "quote",
      live_order_mode: "tiny_fill",
      max_slippage_bps: String(policy.max_slippage_bps),
      tif: "Ioc",
    },
  };
}

function executionForVenue(session, venue) {
  const access = session.venue_access?.[venue] || {};
  return {
    execution_mode: access.execution_mode || defaultExecutionMode(venue),
    vault_commitment: access.vault_commitment || undefined,
    encrypted_vault_commitment: access.encrypted_vault_commitment || undefined,
    encrypted_execution_vault: access.encrypted_execution_vault || undefined,
    allocation_commitment: access.allocation_commitment || undefined,
    managed_allocation_commitment: access.managed_allocation_commitment || undefined,
    omnibus_allocation: access.omnibus_allocation || undefined,
    autopilot_session_id: session.autopilot_session_id,
  };
}

function workerSessionPolicy(session) {
  const policy = session.session_policy;
  return {
    policy_commitment: policy.policy_commitment,
    strategy_id: policy.strategy_id,
    venue_allowlist: policy.venue_allowlist,
    market_allowlist: policy.market_allowlist,
    max_notional_bucket: policy.max_notional_bucket,
    max_position_notional_bucket: policy.max_position_notional_bucket,
    max_daily_notional_bucket: policy.max_daily_notional_bucket,
    max_order_count: policy.max_order_count,
    max_slippage_bps: policy.max_slippage_bps,
    min_net_edge_bps: policy.min_net_edge_bps,
    allowed_order_types: policy.allowed_order_types,
    kill_switch: policy.kill_switch === true || session.status === "killed",
    expires_at: session.expires_at,
  };
}

function validPair(left, right) {
  return (SPOT_VENUES.has(left) && PERP_VENUES.has(right)) ||
    (SPOT_VENUES.has(right) && PERP_VENUES.has(left)) ||
    (PERP_VENUES.has(left) && PERP_VENUES.has(right));
}

function operationForVenue(venue) {
  if (venue === "jupiter") return "swap";
  if (venue === "coinbase_advanced") return "spot_market_order";
  if (venue === "phoenix" || venue === "backpack") return "perp_limit_order";
  return "limit_order";
}

function readyVenues(session) {
  return session.session_policy.venue_allowlist
    .filter((venue) => session.venue_access?.[venue]?.status === "ready");
}

function snapshot({ venue_id, market, price, now, source, latency_ms = 0 }) {
  return { venue_id, market, price, fetched_at: now.toISOString(), source, latency_ms };
}

function publicSnapshot(snapshot) {
  return {
    venue_id: snapshot.venue_id,
    market: snapshot.market,
    price: snapshot.price,
    source: snapshot.source,
    fetched_at: snapshot.fetched_at,
    latency_ms: snapshot.latency_ms,
  };
}

function publicOpportunity(value) {
  if (!value || !value.market) return value;
  return {
    version: 1,
    opportunity_id: value.opportunity_id,
    status: value.status || (value.ok ? "ready" : "blocked"),
    market: value.market,
    buy_venue: value.buy_venue,
    sell_venue: value.sell_venue,
    gross_edge_bps: value.gross_edge_bps,
    estimated_cost_bps: value.estimated_cost_bps,
    net_edge_bps: value.net_edge_bps,
    min_net_edge_bps: value.min_net_edge_bps,
    leg_notional_bucket: String(value.leg_notional_usd || "0"),
    market_data_skew_ms: value.market_data_skew_ms,
    reason_codes: value.reason_codes || [],
    created_at: value.created_at,
  };
}

function minNetEdgeBps(session, env) {
  return Math.max(
    Number(session.session_policy.min_net_edge_bps || 0),
    capBps(env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS, 0),
  );
}

function feeBps(venue, env) {
  const key = `PRIVATE_AGENT_ARB_${String(venue).toUpperCase()}_FEE_BPS`;
  return capBps(env[key], DEFAULT_FEE_BPS[venue] || 10);
}

function defaultExecutionMode(venue) {
  if (venue === "coinbase_advanced" || venue === "hyperliquid") return "byo_api_key";
  return "user_stealth";
}

function remainingDailyNotional(session) {
  return Math.max(0, bucketToUsd(session.session_policy.max_daily_notional_bucket) - Number(session.daily_notional_used_bucket || 0));
}

function bucketToUsd(value) {
  const number = Number.parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function capUsd(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function capBps(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function capMs(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function marketFetchTimeoutMs(env) {
  return Math.min(
    capMs(env.PRIVATE_AGENT_ARB_MARKET_FETCH_TIMEOUT_MS, 1_200),
    capMs(env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS, 2_000),
  );
}

function maxMarketSkewMs(env) {
  return capMs(
    env.PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS,
    capMs(env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS, 2_000),
  );
}

function normalizeMarket(value) {
  const upper = String(value || "").trim().toUpperCase();
  if (upper === "SOL" || upper === "SOLANA" || upper === "SOL/USDC") return "SOL-USD";
  if (upper === "BTC" || upper === "BITCOIN") return "BTC-USD";
  if (upper === "ETH" || upper === "ETHEREUM") return "ETH-USD";
  return upper;
}

function baseMarket(productId) {
  return String(productId || "SOL-USD").split("-")[0].split("/")[0].toUpperCase();
}

function venueMarketSymbol(venue, productId) {
  const base = baseMarket(productId);
  if (venue === "phoenix") return `${base}-PERP`;
  if (venue === "backpack") return `${base}_USDC_PERP`;
  return base;
}

function numberValue(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function trim(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Number(number.toFixed(8))) : String(value);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value, Object.keys(value || {}).sort())).digest("hex");
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
