import assert from "node:assert/strict";
import test from "node:test";
import {
  fiveSignificant,
  hyperliquidTestnetCloid,
  testnetCanaryConfig,
} from "../scripts/hyperliquid-testnet-lifecycle.mjs";

const VALID = {
  PRIVATE_AGENT_TEST_POSTGRES_URL: "postgresql://localhost/ghola_test",
  GHOLA_HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS: `0x${"1".repeat(40)}`,
  GHOLA_HYPERLIQUID_TESTNET_API_WALLET_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  GHOLA_HYPERLIQUID_TESTNET_CANARY_CONFIRM: "I_UNDERSTAND_THIS_BROADCASTS_AND_CANCELS_TESTNET_ONLY",
};

test("testnet lifecycle canary is credentialed, Postgres-backed, and testnet-only", () => {
  assert.deepEqual(testnetCanaryConfig(VALID), {
    databaseUrl: VALID.PRIVATE_AGENT_TEST_POSTGRES_URL,
    accountAddress: VALID.GHOLA_HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS,
    privateKey: VALID.GHOLA_HYPERLIQUID_TESTNET_API_WALLET_PRIVATE_KEY,
    market: "HYPE",
    notionalUsd: 11,
  });
  assert.throws(() => testnetCanaryConfig({ ...VALID, PRIVATE_AGENT_VENUE_DRY_RUN: "true" }), /refuses dry-run/);
  assert.throws(() => testnetCanaryConfig({ ...VALID, GHOLA_HYPERLIQUID_TESTNET_CANARY_CONFIRM: "wrong" }), /must equal/);
  assert.throws(() => testnetCanaryConfig({ ...VALID, GHOLA_HYPERLIQUID_TESTNET_API_WALLET_PRIVATE_KEY: "" }), /is required/);
});

test("canary resting price uses five significant digits", () => {
  assert.equal(fiveSignificant(1234.5678), "1234.6");
  assert.equal(fiveSignificant(0.12345678), "0.12346");
  assert.throws(() => fiveSignificant(0), /invalid/);
});

test("canary derives a deterministic 16-byte Hyperliquid cloid", () => {
  const first = hyperliquidTestnetCloid("work-order-1");
  assert.match(first, /^0x[0-9a-f]{32}$/);
  assert.equal(first, hyperliquidTestnetCloid("work-order-1"));
  assert.notEqual(first, hyperliquidTestnetCloid("work-order-2"));
});
