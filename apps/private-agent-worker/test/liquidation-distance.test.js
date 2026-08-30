import assert from "node:assert/strict";
import test from "node:test";
import {
  asterLiquidationDistance,
  hyperliquidLiquidationDistance,
  lighterLiquidationDistance,
} from "../src/venues/liquidation-distance.js";

test("derives Hyperliquid distance only from clearinghouse position fields", () => {
  const result = hyperliquidLiquidationDistance({ assetPositions: [{ position: {
    coin: "BTC",
    szi: "0.5",
    positionValue: "50000",
    liquidationPx: "80000",
  } }] });
  assert.deepEqual(result, {
    position_count: 1,
    liquidation_distance_bps: 2_000,
    liquidation_distance_verified: true,
    liquidation_distance_source: "hyperliquid_clearinghouse_state_asset_positions_v1",
  });
});

test("Hyperliquid flat is explicit and malformed open evidence fails closed", () => {
  assert.deepEqual(hyperliquidLiquidationDistance({ assetPositions: [] }), flat());
  assert.deepEqual(hyperliquidLiquidationDistance({ assetPositions: [{ position: {
    szi: "0.5",
    positionValue: "50000",
    liquidationPx: null,
  } }] }), { ...flat(), position_count: 1 });
  assert.deepEqual(hyperliquidLiquidationDistance({}), { ...flat(), position_count: null });
});

test("derives Lighter distance from its documented Position JSON", () => {
  const result = lighterLiquidationDistance({ positions: [{
    market_id: 101,
    symbol: "BTC-USD",
    sign: -1,
    position: "0.5",
    position_value: "50000",
    liquidation_price: "125000",
  }] });
  assert.deepEqual(result, {
    position_count: 1,
    liquidation_distance_bps: 2_500,
    liquidation_distance_verified: true,
    liquidation_distance_source: "lighter_account_positions_position_value_v1",
  });
});

test("Lighter flat is explicit and never defaults malformed positions", () => {
  assert.deepEqual(lighterLiquidationDistance({ positions: [] }), flat());
  assert.deepEqual(lighterLiquidationDistance({ positions: [{
    sign: 1,
    position: "1",
    position_value: "100000",
  }] }), { ...flat(), position_count: 1 });
  assert.deepEqual(lighterLiquidationDistance({ positions: "missing" }), { ...flat(), position_count: null });
});

test("derives Aster distance from fapi v3 position risk fields", () => {
  const result = asterLiquidationDistance([{
    symbol: "BTCUSDT",
    positionAmt: "-0.5",
    markPrice: "100000",
    liquidationPrice: "130000",
  }]);
  assert.deepEqual(result, {
    position_count: 1,
    liquidation_distance_bps: 3_000,
    liquidation_distance_verified: true,
    liquidation_distance_source: "aster_fapi_v3_position_risk_v1",
  });
});

test("Aster flat is explicit and malformed open evidence fails closed", () => {
  assert.deepEqual(asterLiquidationDistance([{ positionAmt: "0", markPrice: "0", liquidationPrice: "0" }]), flat());
  assert.deepEqual(asterLiquidationDistance([{
    positionAmt: "0.5",
    markPrice: "100000",
    liquidationPrice: "",
  }]), { ...flat(), position_count: 1 });
  assert.deepEqual(asterLiquidationDistance(null), { ...flat(), position_count: null });
});

function flat() {
  return {
    position_count: 0,
    liquidation_distance_bps: null,
    liquidation_distance_verified: false,
    liquidation_distance_source: null,
  };
}
