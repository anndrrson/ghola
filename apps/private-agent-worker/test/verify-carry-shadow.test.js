import assert from "node:assert/strict";
import test from "node:test";
import { CORE_PERP_VENUES, venueAdapterCapability } from "@ghola/execution-core";
import {
  DEFAULT_CARRY_SHADOW_ASSETS,
  verifyCarryShadowSet,
  verifyCarryShadowSoak,
} from "../scripts/verify-carry-shadow.mjs";

const NOW = 1_800_000_000_000;

test("accepts one fresh normalized shadow for every venue and core asset", () => {
  const result = verifyCarryShadowSet(fixture(), { now_ms: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.checked_at_ms, NOW);
  assert.equal(result.venues, 5);
  assert.equal(result.assets, 3);
  assert.deepEqual(result.requested_assets, ["BTC", "ETH", "SOL"]);
  assert.equal(result.expected_snapshots, 15);
  assert.equal(result.snapshot_evidence.length, 15);
  assert.equal(new Set(result.snapshot_evidence.map((row) => `${row.venue_id}:${row.asset}`)).size, 15);
  assert.equal(result.snapshot_evidence.every((row) => /^carry:shadow:snapshot:[0-9a-f]{64}$/.test(row.snapshot_commitment)), true);
  assert.match(result.sample_commitment, /^carry:shadow:sample:[0-9a-f]{64}$/);
  assert.deepEqual(result.failures, []);
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

test("binds custom requested assets without narrowing evidence to the default set", () => {
  const result = verifyCarryShadowSet(fixture(["HYPE"]), { assets: ["HYPE"], now_ms: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.requested_assets, ["HYPE"]);
  assert.equal(result.snapshot_evidence.length, 5);
  assert.equal(verifyCarryShadowSoak([
    result,
    verifyCarryShadowSet(fixture(["HYPE"]), { assets: ["HYPE"], now_ms: NOW + 1_000 }),
    verifyCarryShadowSet(fixture(["HYPE"]), { assets: ["HYPE"], now_ms: NOW + 2_000 }),
  ]).ok, true);
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

test("rejects normalized shadow proof without valid two-sided liquidity depth", () => {
  const rows = fixture();
  rows[0].snapshots[0].depth_bids = [];
  rows[1].snapshots[0].depth_asks[0].size_e8 = 0;
  rows[2].snapshots[0].depth_bids = [
    { price_e8: 9_998_000_000, size_e8: 100_000_000 },
    { price_e8: 9_999_000_000, size_e8: 100_000_000 },
  ];
  rows[3].snapshots[0].depth_bids[0].price_e8 = 10_002_000_000;
  const result = verifyCarryShadowSet(rows, { now_ms: NOW });
  assert.ok(result.failures.includes("liquidity_depth_missing:hyperliquid:BTC:bid"));
  assert.ok(result.failures.includes("liquidity_depth_invalid:lighter:BTC:ask"));
  assert.ok(result.failures.includes("liquidity_depth_unsorted:aster:BTC:bid"));
  assert.ok(result.failures.includes("liquidity_depth_crossed:edgex:BTC"));
});

test("rejects stale component feeds hidden behind a fresh aggregate timestamp", () => {
  const rows = fixture();
  rows[0].snapshots[0].source_observed_at_ms.funding = NOW - 30_001;
  rows[1].snapshots[0].source_observed_at_ms.orderbook = null;
  rows[2].snapshots[0].source_max_age_ms.market = 600_000;
  rows[3].snapshots[0].stale_sources = ["funding"];
  const result = verifyCarryShadowSet(rows, { now_ms: NOW });
  assert.ok(result.failures.includes("source_observation_stale:hyperliquid:BTC:funding"));
  assert.ok(result.failures.includes("source_observation_missing:lighter:BTC:orderbook"));
  assert.ok(result.failures.includes("source_freshness_policy_mismatch:aster:BTC:market"));
  assert.ok(result.failures.includes("stale_source_evidence_invalid:edgex:BTC"));
});

test("honors only the registry-declared edgeX funding cadence exception", () => {
  const rows = fixture();
  rows[3].snapshots[0].source_observed_at_ms.funding = NOW - 119_999;
  rows[3].snapshots[0].source_max_age_ms.funding = 120_000;
  assert.equal(verifyCarryShadowSet(rows, { now_ms: NOW }).ok, true);
  rows[3].snapshots[0].source_observed_at_ms.funding = NOW - 120_001;
  const result = verifyCarryShadowSet(rows, { now_ms: NOW });
  assert.ok(result.failures.includes("source_observation_stale:edgex:BTC:funding"));
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

test("qualifies only consecutive complete five-venue shadow samples", () => {
  const samples = [0, 1, 2].map((offset) => verifyCarryShadowSet(fixture(), {
    now_ms: NOW + offset * 1_000,
  }));
  const result = verifyCarryShadowSoak(samples);
  assert.equal(result.ok, true);
  assert.equal(result.required_samples, 3);
  assert.equal(result.completed_samples, 3);
  assert.equal(result.duration_ms, 2_000);
  assert.equal(result.venues, 5);
  assert.equal(result.assets, 3);
  assert.deepEqual(result.requested_assets, ["BTC", "ETH", "SOL"]);
  assert.equal(result.expected_snapshots_per_sample, 15);
  assert.deepEqual(result.sample_commitments, samples.map((sample) => sample.sample_commitment));
  assert.deepEqual(result.failures, []);
});

test("rejects tampered or reused shadow sample commitments", () => {
  const samples = [0, 1, 2].map((offset) => verifyCarryShadowSet(fixture(), {
    now_ms: NOW + offset * 1_000,
  }));
  samples[1] = {
    ...samples[1],
    snapshot_evidence: samples[1].snapshot_evidence.map((row, index) => index === 0
      ? { ...row, contract_id: "lighter:tampered" }
      : row),
  };
  samples[2] = { ...samples[2], sample_commitment: samples[0].sample_commitment };
  const result = verifyCarryShadowSoak(samples);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("shadow_soak_snapshot_evidence_invalid:1"));
  assert.ok(result.failures.includes("shadow_soak_sample_commitment_invalid:1"));
  assert.ok(result.failures.includes("shadow_soak_sample_commitment_invalid:2"));
  assert.ok(result.failures.includes("shadow_soak_sample_commitments_reused"));
});

test("rejects intermittent failure, coverage drift, and non-monotonic shadow samples", () => {
  const samples = [0, 1, 2].map((offset) => verifyCarryShadowSet(fixture(), {
    now_ms: NOW + offset * 1_000,
  }));
  samples[1] = { ...samples[1], ok: false, failures: ["venue_fetch_failed:lighter:timeout"] };
  samples[2] = { ...samples[2], checked_at_ms: NOW + 500, assets: 2, expected_snapshots: 10 };
  const result = verifyCarryShadowSoak(samples);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("shadow_soak_sample_failed:1"));
  assert.ok(result.failures.includes("shadow_soak_timeline_invalid:2"));
  assert.ok(result.failures.includes("shadow_soak_coverage_drift:2"));
});

test("rejects a one-shot snapshot as durable shadow qualification", () => {
  const sample = verifyCarryShadowSet(fixture(), { now_ms: NOW });
  const result = verifyCarryShadowSoak([sample]);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("shadow_soak_samples_insufficient:1:3"));
});

function fixture(assets = DEFAULT_CARRY_SHADOW_ASSETS) {
  return CORE_PERP_VENUES.map((venueId) => ({
    venue_id: venueId,
    ok: true,
    snapshots: assets.map((asset) => snapshot(venueId, asset)),
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
    quote_asset: venueId === "hyperliquid" ? asset === "HYPE" ? "USDC" : "USDT" : venueId === "aster" ? "USDT" : "USD",
    collateral_asset: venueId === "aster" ? "USDT" : "USDC",
    contract_type: "linear_perp",
    mark_price_e8: 10_000_000_000,
    index_price_e8: 10_000_000_000,
    best_bid_e8: 9_999_000_000,
    best_ask_e8: 10_001_000_000,
    depth_bids: [{ price_e8: 9_999_000_000, size_e8: 100_000_000 }],
    depth_asks: [{ price_e8: 10_001_000_000, size_e8: 100_000_000 }],
    funding_rate_e12_per_interval: 10_000,
    funding_interval_ms: 3_600_000,
    quantity_step_e8: 1_000,
    initial_margin_bps: 500,
    maintenance_margin_bps: 250,
    liquidation_model: "test_margin_liquidation",
    as_of_ms: NOW,
    source_observed_at_ms: { market: NOW, funding: NOW, orderbook: NOW },
    source_max_age_ms: {
      market: 30_000,
      funding: venueId === "edgex" ? 120_000 : 30_000,
      orderbook: 30_000,
    },
    stale_sources: [],
    status: "ready",
    stale: false,
    missing_fields: [],
    quality_flags: [],
    executable: false,
  };
}
