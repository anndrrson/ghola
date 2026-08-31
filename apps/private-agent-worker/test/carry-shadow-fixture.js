import {
  CARRY_SHADOW_ASSETS,
  CORE_PERP_VENUES,
  cashflowValuationEvidenceMessage,
  venueAdapterCapability,
} from "@ghola/execution-core";

export function carryShadowFixture(nowMs, assets = CARRY_SHADOW_ASSETS) {
  return CORE_PERP_VENUES.map((venueId) => ({
    venue_id: venueId,
    ok: true,
    snapshots: assets.map((asset) => snapshot(venueId, asset, nowMs)),
  }));
}

function snapshot(venueId, asset, nowMs) {
  const declared = venueAdapterCapability(venueId, "perp_shadow");
  const quoteAsset = venueId === "hyperliquid" ? asset === "HYPE" ? "USDC" : "USDT" : venueId === "aster" ? "USDT" : "USD";
  const settlementAsset = venueId === "aster" ? "USDT" : "USDC";
  return {
    version: 1,
    venue_id: venueId,
    adapter_mode: "shadow_read_only",
    source_schema: declared.source_schema,
    trading_api_available: true,
    contract_id: `${venueId}:${asset}`,
    economic_equivalence_id: `carry:${asset}-usd-linear`,
    asset,
    market: `${asset}-USD`,
    quote_asset: quoteAsset,
    collateral_asset: venueId === "aster" ? "USDT" : "USDC",
    funding_settlement_asset: settlementAsset,
    fee_settlement_asset: settlementAsset,
    asset_valuations: quoteAsset === "USDC" ? [] : [cashflowValuation(quoteAsset, nowMs)],
    contract_type: "linear_perp",
    mark_price_e8: 10_000_000_000,
    index_price_e8: 10_000_000_000,
    best_bid_e8: 9_999_000_000,
    best_ask_e8: 10_001_000_000,
    depth_bids: [{ price_e8: 9_999_000_000, size_e8: 100_000_000 }],
    depth_asks: [{ price_e8: 10_001_000_000, size_e8: 100_000_000 }],
    funding_rate_e12_per_interval: 10_000,
    funding_interval_ms: 3_600_000,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    minimum_notional_micro_usdc: 1_000_000,
    quantity_step_e8: 1_000,
    price_tick_e8: 1_000,
    initial_margin_bps: 500,
    maintenance_margin_bps: 250,
    liquidation_fee_bps: 0,
    margin_model: declared.margin_model,
    liquidation_model: declared.liquidation_model,
    as_of_ms: nowMs,
    source_observed_at_ms: { market: nowMs, funding: nowMs, orderbook: nowMs },
    source_max_age_ms: {
      market: 60_000,
      funding: venueId === "edgex" ? 120_000 : 60_000,
      orderbook: 60_000,
    },
    stale_sources: [],
    status: "ready",
    stale: false,
    missing_fields: [],
    quality_flags: [],
    executable: false,
  };
}

function cashflowValuation(sourceAsset, observedAtMs) {
  const valuation = {
    version: 1,
    source_asset: sourceAsset,
    valuation_asset: "USDC",
    verified: true,
    credit_rate_e8: 99_000_000,
    debit_rate_e8: 101_000_000,
    observed_at_ms: observedAtMs,
    expires_at_ms: observedAtMs + 30_000,
    evidence_source: "test:stablecoin-book:v1",
    evidence_commitment: `carry:cashflow-valuation:evidence:${(sourceAsset === "USDT" ? "a" : "b").repeat(64)}`,
  };
  return { ...valuation, evidence_message: cashflowValuationEvidenceMessage(valuation) };
}
