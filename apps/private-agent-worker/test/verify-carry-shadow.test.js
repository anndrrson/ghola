import assert from "node:assert/strict";
import test from "node:test";
import { CORE_PERP_VENUES, venueAdapterCapability } from "@ghola/execution-core";
import {
  DEFAULT_CARRY_SHADOW_ASSETS,
  verifyCarryShadowSet,
} from "../scripts/verify-carry-shadow.mjs";

const NOW = 1_800_000_000_000;

test("accepts one fresh normalized shadow for every venue and core asset", () => {
  const result = verifyCarryShadowSet(fixture(), { now_ms: NOW });
  assert.deepEqual(result, {
    ok: true,
    checked_at_ms: NOW,
    venues: 5,
    assets: 3,
    expected_snapshots: 15,
    failures: [],
  });
});

test("rejects missing assets, stale data, and executable shadow adapters", () => {
  const rows = fixture();
  rows[0].snapshots.shift();
  rows[1].snapshots[0].as_of_ms = NOW - 30_001;
  rows[2].snapshots[0].executable = true;
  const result = verifyCarryShadowSet(rows, { now_ms: NOW });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((value) => value.startsWith("asset_snapshot_count:")));
  assert.ok(result.failures.some((value) => value.startsWith("snapshot_stale:")));
  assert.ok(result.failures.some((value) => value.startsWith("read_only_boundary_invalid:")));
});

test("rejects an empty requested asset set", () => {
  const result = verifyCarryShadowSet(fixture(), { assets: [], now_ms: NOW });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("asset_set_empty"));
});

test("rejects normalized gaps without explicit quality evidence", () => {
  const rows = fixture();
  rows[0].snapshots[0].missing_fields = ["maker_fee_bps"];
  const result = verifyCarryShadowSet(rows, { now_ms: NOW });
  assert.ok(result.failures.includes("missing_field_unjustified:hyperliquid:BTC:maker_fee_bps"));
  rows[0].snapshots[0].quality_flags = ["fees_account_specific"];
  assert.equal(verifyCarryShadowSet(rows, { now_ms: NOW }).ok, true);
});

test("rejects crossed books, registry drift, and invalid margin evidence", () => {
  const rows = fixture();
  const snapshot = rows[0].snapshots[0];
  snapshot.best_ask_e8 = snapshot.best_bid_e8;
  snapshot.source_schema = "unregistered_schema";
  snapshot.initial_margin_bps = snapshot.maintenance_margin_bps;
  const result = verifyCarryShadowSet(rows, { now_ms: NOW });
  assert.ok(result.failures.includes("orderbook_bbo_invalid:hyperliquid:BTC"));
  assert.ok(result.failures.includes("source_schema_mismatch:hyperliquid:BTC"));
  assert.ok(result.failures.includes("margin_evidence_invalid:hyperliquid:BTC"));
});

test("rejects duplicate or unregistered venue rows instead of silently overwriting them", () => {
  const rows = fixture();
  rows.push(structuredClone(rows[0]));
  rows.push({ venue_id: "unknown_perp", ok: true, snapshots: [] });
  const result = verifyCarryShadowSet(rows, { now_ms: NOW });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("venue_duplicate:hyperliquid"));
  assert.ok(result.failures.includes("venue_unregistered:unknown_perp"));
});

test("rejects malformed snapshot identity, prices, and evidence arrays", () => {
  const rows = fixture();
  const snapshot = rows[0].snapshots[0];
  snapshot.version = 2;
  snapshot.contract_id = "lighter:BTC";
  snapshot.mark_price_e8 = 0;
  snapshot.index_price_e8 = -1;
  snapshot.quality_flags = null;
  snapshot.missing_fields = null;
  const result = verifyCarryShadowSet(rows, { now_ms: NOW });
  assert.ok(result.failures.includes("snapshot_version_invalid:hyperliquid:BTC"));
  assert.ok(result.failures.includes("contract_id_invalid:hyperliquid:BTC"));
  assert.ok(result.failures.includes("reference_price_invalid:hyperliquid:BTC"));
  assert.ok(result.failures.includes("quality_flags_invalid:hyperliquid:BTC"));
  assert.ok(result.failures.includes("missing_fields_invalid:hyperliquid:BTC"));
});

function fixture() {
  return CORE_PERP_VENUES.map((venueId) => ({
    venue_id: venueId,
    ok: true,
    snapshots: DEFAULT_CARRY_SHADOW_ASSETS.map((asset) => snapshot(venueId, asset)),
  }));
}

function snapshot(venueId, asset) {
  return {
    version: 1,
    venue_id: venueId,
    adapter_mode: "shadow_read_only",
    source_schema: venueAdapterCapability(venueId, "perp_shadow").source_schema,
    trading_api_available: true,
    contract_id: `${venueId}:${asset}`,
    economic_equivalence_id: `carry:${asset}-usd-linear`,
    asset,
    market: `${asset}-USD`,
    quote_asset: venueId === "hyperliquid" || venueId === "aster" ? "USDT" : "USD",
    collateral_asset: venueId === "aster" ? "USDT" : "USDC",
    contract_type: "linear_perp",
    mark_price_e8: 10_000_000_000,
    index_price_e8: 10_000_000_000,
    best_bid_e8: 9_999_000_000,
    best_ask_e8: 10_001_000_000,
    funding_rate_e12_per_interval: 10_000,
    funding_interval_ms: 3_600_000,
    quantity_step_e8: 1_000,
    initial_margin_bps: 500,
    maintenance_margin_bps: 250,
    liquidation_model: "test_margin_liquidation",
    as_of_ms: NOW,
    status: "ready",
    stale: false,
    missing_fields: [],
    quality_flags: [],
    executable: false,
  };
}
