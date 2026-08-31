import assert from "node:assert/strict";
import test from "node:test";
import { CORE_PERP_VENUES, cashflowValuationEvidenceMessage, venueAdapterCapability } from "@ghola/execution-core";
import {
  carryShadowSnapshotKey,
  readCarryShadowSnapshot,
  writeCarryShadowSnapshot,
} from "../src/execution/carry-shadow-snapshot.js";

const NOW = 1_800_000_000_000;

function stateStore() {
  const rows = new Map();
  return {
    rows,
    getIdempotency: async (key) => rows.get(key) || null,
    putIdempotency: async (key, receipt) => rows.set(key, { receipt }),
  };
}

function venues(observedAt = NOW) {
  return CORE_PERP_VENUES.map((venueId) => ({
    venue_id: venueId,
    ok: true,
    snapshots: [snapshot(venueId, observedAt)],
  }));
}

const routingAdvantage = Object.freeze({
  transaction_broadcast: false,
  ready: false,
  evidence_commitment: `carry:routing:advantage:${"a".repeat(64)}`,
});

function snapshot(venueId, observedAt) {
  const declared = venueAdapterCapability(venueId, "perp_shadow");
  const freshness = declared.source_max_age_ms;
  const quoteAsset = venueId === "hyperliquid" || venueId === "aster" ? "USDT" : "USD";
  const settlementAsset = venueId === "aster" ? "USDT" : "USDC";
  return {
    version: 1,
    venue_id: venueId,
    adapter_mode: "shadow_read_only",
    source_schema: declared.source_schema,
    trading_api_available: true,
    contract_id: `${venueId}:BTC`,
    economic_equivalence_id: "carry:BTC-usd-linear",
    asset: "BTC",
    market: "BTC-USD",
    quote_asset: quoteAsset,
    collateral_asset: "USDC",
    funding_settlement_asset: settlementAsset,
    fee_settlement_asset: settlementAsset,
    asset_valuations: [cashflowValuation(quoteAsset, observedAt)],
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
    as_of_ms: observedAt,
    source_observed_at_ms: { market: observedAt, funding: observedAt, orderbook: observedAt },
    source_max_age_ms: {
      market: Math.max(60_000, freshness?.market || 0),
      funding: Math.max(60_000, freshness?.funding || 0),
      orderbook: Math.max(60_000, freshness?.orderbook || 0),
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

test("serves a fresh commitment-backed five-venue snapshot from the durable observer", async () => {
  const state = stateStore();
  const stored = await writeCarryShadowSnapshot({
    state,
    venues: venues(),
    assets: ["btc"],
    funding_persistence: { transaction_broadcast: false, observed_route_count: 6 },
    shadow_qualification: { transaction_broadcast: false, ready: true },
    routing_advantage: routingAdvantage,
    observed_at_ms: NOW,
  });
  const recovered = await readCarryShadowSnapshot({
    state,
    assets: ["BTC"],
    now_ms: NOW + 1_000,
  });

  assert.equal(stored.ready, true);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.snapshot.served_from, "durable_observer");
  assert.equal(recovered.snapshot.cache_age_ms, 1_000);
  assert.equal(recovered.snapshot.readiness.ok, true);
  assert.equal(recovered.snapshot.venues.length, 5);
  assert.equal(recovered.snapshot.executable, false);
  assert.equal(recovered.snapshot.evidence_commitment, stored.evidence_commitment);
});

test("rejects stale, tampered, or degraded durable snapshots and forces a live refresh", async () => {
  const incompleteState = stateStore();
  const incomplete = await writeCarryShadowSnapshot({
    state: incompleteState,
    venues: venues(),
    assets: ["BTC"],
    observed_at_ms: NOW,
  });
  assert.equal(incomplete.stored, false);
  assert.equal(incomplete.reason, "shadow_snapshot_proof_incomplete");

  const state = stateStore();
  await writeCarryShadowSnapshot({
    state,
    venues: venues(),
    assets: ["BTC"],
    funding_persistence: { transaction_broadcast: false },
    shadow_qualification: { transaction_broadcast: false },
    routing_advantage: routingAdvantage,
    observed_at_ms: NOW,
  });

  const stale = await readCarryShadowSnapshot({ state, assets: ["BTC"], now_ms: NOW + 60_001 });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "shadow_snapshot_stale");

  const row = state.rows.get(carryShadowSnapshotKey(["BTC"]));
  row.receipt.venues[0].snapshots[0].mark_price_e8 += 1;
  const tampered = await readCarryShadowSnapshot({ state, assets: ["BTC"], now_ms: NOW + 1_000 });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, "shadow_snapshot_evidence_invalid");

  await writeCarryShadowSnapshot({
    state,
    venues: venues(NOW - 60_001),
    assets: ["BTC"],
    funding_persistence: { transaction_broadcast: false },
    shadow_qualification: { transaction_broadcast: false },
    routing_advantage: routingAdvantage,
    observed_at_ms: NOW,
  });
  const degraded = await readCarryShadowSnapshot({ state, assets: ["BTC"], now_ms: NOW });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.reason, "shadow_snapshot_source_stale");
});
