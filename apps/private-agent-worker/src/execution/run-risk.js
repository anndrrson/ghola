const EPSILON = 1e-9;

export function applyEstimatedFill(existing, fill) {
  const price = positiveNumber(fill.price);
  const notional = positiveNumber(fill.notional_usd);
  if (!price || !notional) throw new Error("run risk fill requires positive price and notional");

  const oldQuantity = signedQuantity(existing);
  const fillQuantity = (fill.side === "sell" ? -1 : 1) * (notional / price);
  const oldAverage = positiveNumber(existing?.average_entry_price) || price;
  const oldRealized = finiteNumber(existing?.realized_pnl_usd);
  const sameDirection = Math.sign(oldQuantity) === Math.sign(fillQuantity) || Math.abs(oldQuantity) < EPSILON;
  const nextQuantity = oldQuantity + fillQuantity;

  let averageEntryPrice = oldAverage;
  let realizedDelta = 0;
  if (sameDirection) {
    const grossQuantity = Math.abs(oldQuantity) + Math.abs(fillQuantity);
    averageEntryPrice = grossQuantity > EPSILON
      ? ((Math.abs(oldQuantity) * oldAverage) + (Math.abs(fillQuantity) * price)) / grossQuantity
      : price;
  } else {
    const closingQuantity = Math.min(Math.abs(oldQuantity), Math.abs(fillQuantity));
    realizedDelta = closingQuantity * (price - oldAverage) * Math.sign(oldQuantity);
    if (Math.abs(nextQuantity) < EPSILON) averageEntryPrice = 0;
    else if (Math.sign(nextQuantity) !== Math.sign(oldQuantity)) averageEntryPrice = price;
  }

  const markPrice = price;
  const normalizedQuantity = Math.abs(nextQuantity) < EPSILON ? 0 : nextQuantity;
  const unrealizedPnl = normalizedQuantity * (markPrice - averageEntryPrice);
  return {
    ...existing,
    venue_id: fill.venue_id,
    market: fill.market,
    side: normalizedQuantity < 0 ? "sell" : "buy",
    signed_quantity: round(normalizedQuantity),
    average_entry_price: round(averageEntryPrice),
    last_mark_price: round(markPrice),
    mark_updated_at: fill.at,
    estimated_exposure_notional_usd: round(Math.abs(normalizedQuantity) * markPrice),
    realized_pnl_usd: round(oldRealized + realizedDelta),
    unrealized_pnl_usd: round(unrealizedPnl),
    estimated_total_pnl_usd: round(oldRealized + realizedDelta + unrealizedPnl),
    last_order_notional_usd: notional,
    last_work_order_commitment: fill.work_order_commitment,
    source: "autopilot_execution_receipt_estimate",
  };
}

export function markRunPositions(positions, market, now) {
  const markPrice = positiveNumber(market?.price ?? market?.mid);
  const product = normalizeMarket(market?.product_id);
  if (!markPrice || !product) return positions;
  return positions.map((position) => {
    if (normalizeMarket(position.market) !== product) return position;
    const quantity = signedQuantity(position);
    const averageEntryPrice = positiveNumber(position.average_entry_price) || markPrice;
    const unrealizedPnl = quantity * (markPrice - averageEntryPrice);
    return {
      ...position,
      last_mark_price: round(markPrice),
      mark_updated_at: now.toISOString(),
      estimated_exposure_notional_usd: round(Math.abs(quantity) * markPrice),
      unrealized_pnl_usd: round(unrealizedPnl),
      estimated_total_pnl_usd: round(finiteNumber(position.realized_pnl_usd) + unrealizedPnl),
    };
  });
}

export function summarizeRunRisk(positions, { now = new Date(), maxMarkAgeMs = 30_000 } = {}) {
  let exposure = 0;
  let realized = 0;
  let unrealized = 0;
  const staleMarkets = [];
  for (const position of positions) {
    const quantity = signedQuantity(position);
    realized += finiteNumber(position.realized_pnl_usd);
    if (Math.abs(quantity) < EPSILON) continue;
    const markPrice = positiveNumber(position.last_mark_price);
    const markAt = Date.parse(String(position.mark_updated_at || ""));
    if (!markPrice || !Number.isFinite(markAt) || now.getTime() - markAt > maxMarkAgeMs) {
      staleMarkets.push(`${position.venue_id || "unknown"}:${position.market || "unknown"}`);
      continue;
    }
    exposure += Math.abs(quantity) * markPrice;
    unrealized += finiteNumber(position.unrealized_pnl_usd);
  }
  return {
    complete: staleMarkets.length === 0,
    stale_markets: staleMarkets,
    exposure_usd: round(exposure),
    realized_pnl_usd: round(realized),
    unrealized_pnl_usd: round(unrealized),
    estimated_total_pnl_usd: round(realized + unrealized),
    checked_at: now.toISOString(),
  };
}

export function lossCircuitDecision(summary, maxLossUsd) {
  const limit = positiveNumber(maxLossUsd);
  if (!summary.complete) return { ok: false, trip: true, reason: "risk_mark_stale" };
  if (!limit) return { ok: false, trip: true, reason: "loss_limit_missing" };
  if (summary.estimated_total_pnl_usd <= -limit) {
    return { ok: false, trip: true, reason: "loss_limit_reached" };
  }
  return { ok: true, trip: false, reason: null };
}

export function projectRunExposure(positions, fill, options) {
  const key = `${fill.venue_id}:${normalizeMarket(fill.market)}`;
  const existing = positions.find((position) => `${position.venue_id}:${normalizeMarket(position.market)}` === key) || null;
  const projected = applyEstimatedFill(existing, fill);
  const next = positions.filter((position) => `${position.venue_id}:${normalizeMarket(position.market)}` !== key).concat(projected);
  return { position: projected, summary: summarizeRunRisk(next, options) };
}

function signedQuantity(position) {
  const explicit = Number(position?.signed_quantity);
  if (Number.isFinite(explicit)) return explicit;
  const exposure = positiveNumber(position?.estimated_exposure_notional_usd);
  const price = positiveNumber(position?.average_entry_price ?? position?.last_mark_price);
  if (!exposure || !price) return 0;
  return (position?.side === "sell" ? -1 : 1) * (exposure / price);
}

function normalizeMarket(value) {
  const market = String(value || "").toUpperCase();
  if (market === "SOL/USDC" || market === "SOL-USDC") return "SOL-USD";
  return market;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}
