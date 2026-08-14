import assert from "node:assert/strict";
import test from "node:test";
import {
  MAINNET_ROUNDTRIP_CONFIRMATION,
  mainnetRoundTripConfig,
  positionSizeForMarket,
  testnetRoundTripConfig,
} from "../scripts/hyperliquid-testnet-roundtrip.mjs";
import { assertHyperliquidPilotNetwork } from "../src/venues/hyperliquid.js";

const VALID = {
  PRIVATE_AGENT_TEST_POSTGRES_URL: "postgresql://localhost/ghola_test",
  GHOLA_HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: `0x${"1".repeat(40)}`,
  GHOLA_HYPERLIQUID_TESTNET_API_WALLET_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_CONFIRM: "I_UNDERSTAND_THIS_OPENS_AND_CLOSES_A_FUNDED_TESTNET_POSITION",
};

const VALID_MAINNET = {
  PRIVATE_AGENT_MAINNET_CANARY_POSTGRES_URL: "postgresql://localhost/ghola_mainnet_canary",
  PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "tiny_fill",
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "11",
  PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: "25",
  PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
  GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS: `0x${"3".repeat(40)}`,
  GHOLA_HYPERLIQUID_MAINNET_API_WALLET_PRIVATE_KEY: `0x${"4".repeat(64)}`,
  GHOLA_HYPERLIQUID_MAINNET_ROUNDTRIP_CONFIRM: MAINNET_ROUNDTRIP_CONFIRMATION,
};

test("filled round-trip canary is bounded, Postgres-backed, and testnet-only", () => {
  assert.deepEqual(testnetRoundTripConfig(VALID), {
    databaseUrl: VALID.PRIVATE_AGENT_TEST_POSTGRES_URL,
    accountAddress: VALID.GHOLA_HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS,
    privateKey: VALID.GHOLA_HYPERLIQUID_TESTNET_API_WALLET_PRIVATE_KEY,
    market: "HYPE",
    notionalUsd: 11,
    slippageBps: 200,
  });
  assert.throws(() => testnetRoundTripConfig({ ...VALID, PRIVATE_AGENT_VENUE_DRY_RUN: "true" }), /refuses dry-run/);
  assert.throws(() => testnetRoundTripConfig({ ...VALID, GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_CONFIRM: "wrong" }), /must equal/);
  assert.throws(() => testnetRoundTripConfig({ ...VALID, GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_NOTIONAL_USD: "16" }), /between 10 and 15/);
  assert.throws(() => testnetRoundTripConfig({ ...VALID, GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_SLIPPAGE_BPS: "251" }), /between 25 and 250/);
});

test("extracts only the exact requested market position", () => {
  const state = {
    assetPositions: [
      { position: { coin: "BTC", szi: "1" } },
      { position: { coin: "HYPE", szi: "-0.25" } },
    ],
  };
  assert.equal(positionSizeForMarket(state, "HYPE"), "-0.25");
  assert.equal(positionSizeForMarket(state, "SOL"), "0");
  assert.equal(positionSizeForMarket({ assetPositions: [] }, "HYPE"), "0");
  assert.throws(
    () => positionSizeForMarket({ assetPositions: [{ position: { coin: "HYPE", szi: "bad" } }] }, "HYPE"),
    /position size is invalid/,
  );
});

test("mainnet round-trip config is Postgres-only and hard capped", () => {
  assert.deepEqual(mainnetRoundTripConfig(VALID_MAINNET), {
    databaseUrl: VALID_MAINNET.PRIVATE_AGENT_MAINNET_CANARY_POSTGRES_URL,
    accountAddress: VALID_MAINNET.GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS,
    privateKey: VALID_MAINNET.GHOLA_HYPERLIQUID_MAINNET_API_WALLET_PRIVATE_KEY,
    market: "HYPE",
    notionalUsd: 10.5,
    slippageBps: 100,
  });
  assert.throws(() => mainnetRoundTripConfig({ ...VALID_MAINNET, PRIVATE_AGENT_VENUE_DRY_RUN: "true" }), /refuses dry-run/);
  assert.throws(() => mainnetRoundTripConfig({ ...VALID_MAINNET, GHOLA_HYPERLIQUID_MAINNET_ROUNDTRIP_CONFIRM: "wrong" }), /must equal/);
  assert.throws(() => mainnetRoundTripConfig({ ...VALID_MAINNET, PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket" }), /tiny_fill/);
  assert.throws(() => mainnetRoundTripConfig({ ...VALID_MAINNET, PRIVATE_AGENT_MAINNET_CANARY_POSTGRES_URL: "./state.json" }), /must use Postgres/);
  assert.throws(() => mainnetRoundTripConfig({ ...VALID_MAINNET, GHOLA_HYPERLIQUID_MAINNET_ROUNDTRIP_NOTIONAL_USD: "11.01" }), /between 10 and 11/);
  assert.throws(() => mainnetRoundTripConfig({ ...VALID_MAINNET, PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "12" }), /at most 11/);
  assert.throws(() => mainnetRoundTripConfig({ ...VALID_MAINNET, PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: "26" }), /at most 25/);
  assert.throws(() => mainnetRoundTripConfig({ ...VALID_MAINNET, GHOLA_HYPERLIQUID_MAINNET_ROUNDTRIP_SLIPPAGE_BPS: "101" }), /between 25 and 100/);
});

test("mainnet tiny-fill permits only quote entry or exact reduce-only base exit", () => {
  const previousAllow = process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET;
  const previousMode = process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE;
  process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
  const credential = { network: "mainnet" };
  const instruction = (order) => ({ operation_class: "limit_order", order });
  const common = { market: "HYPE", tif: "Ioc", live_order_mode: "tiny_fill" };

  try {
    assert.doesNotThrow(() => assertHyperliquidPilotNetwork(
      credential,
      instruction({ ...common, side: "buy", quote_size: "10.5", reduce_only: false }),
    ));
    assert.doesNotThrow(() => assertHyperliquidPilotNetwork(
      credential,
      instruction({ ...common, side: "sell", base_size: "0.18", reduce_only: true }),
    ));
    assert.throws(() => assertHyperliquidPilotNetwork(
      credential,
      instruction({ ...common, side: "buy", base_size: "0.18", reduce_only: false }),
    ), /quote-sized entry or exact reduce-only base-sized exit/);
    assert.throws(() => assertHyperliquidPilotNetwork(
      credential,
      instruction({ ...common, side: "sell", quote_size: "10.5", reduce_only: true }),
    ), /quote-sized entry or exact reduce-only base-sized exit/);
    assert.throws(() => assertHyperliquidPilotNetwork(
      credential,
      instruction({ ...common, side: "sell", base_size: "0.18", quote_size: "10.5", reduce_only: true }),
    ), /quote-sized entry or exact reduce-only base-sized exit/);
  } finally {
    if (previousAllow === undefined) delete process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET;
    else process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = previousAllow;
    if (previousMode === undefined) delete process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE;
    else process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = previousMode;
  }
});
