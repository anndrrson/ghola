import assert from "node:assert/strict";
import test from "node:test";
import { mainnetReadinessConfig } from "../scripts/hyperliquid-mainnet-readiness.mjs";
import { fundedProofConfig } from "../scripts/hyperliquid-mainnet-funded-proof.mjs";
import {
  hardenedCanaryPolicyCommitment,
  hardenedMainnetCanaryConfig,
} from "../scripts/hyperliquid-mainnet-hardened-roundtrip.mjs";
import { MAINNET_PROOF_CONFIRMATION } from "../src/execution/hyperliquid-mainnet-roundtrip.js";

const VALID = {
  PRIVATE_AGENT_VENUE_DRY_RUN: "false",
  PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
  PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket",
  PRIVATE_AGENT_MAINNET_CANARY_POSTGRES_URL: "postgresql://127.0.0.1:55432/ghola_mainnet_canary",
  GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS: `0x${"1".repeat(40)}`,
  GHOLA_HYPERLIQUID_MAINNET_API_WALLET_PRIVATE_KEY: `0x${"2".repeat(64)}`,
};

test("mainnet readiness is real-only, full-ticket, credentialed, and Postgres-backed", () => {
  assert.deepEqual(mainnetReadinessConfig(VALID), {
    accountAddress: VALID.GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS,
    privateKey: VALID.GHOLA_HYPERLIQUID_MAINNET_API_WALLET_PRIVATE_KEY,
    databaseUrl: VALID.PRIVATE_AGENT_MAINNET_CANARY_POSTGRES_URL,
  });
  assert.throws(() => mainnetReadinessConfig({ ...VALID, PRIVATE_AGENT_VENUE_DRY_RUN: "true" }), /must be false/);
  assert.throws(() => mainnetReadinessConfig({
    ...VALID,
    PRIVATE_AGENT_HYPERLIQUID_NO_SUBMIT_LOCAL_CHECKS: "true",
  }), /simulated/);
  assert.throws(() => mainnetReadinessConfig({ ...VALID, PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "tiny_fill" }), /full_ticket/);
  assert.throws(() => mainnetReadinessConfig({ ...VALID, PRIVATE_AGENT_MAINNET_CANARY_POSTGRES_URL: "./state.json" }), /Postgres/);
});

test("funded proof dossier requires an explicit mainnet account and resolves its source", () => {
  const source = "/tmp/ghola-hardened-proof.json";
  assert.deepEqual(fundedProofConfig({
    GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS: VALID.GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS,
  }, source), {
    accountAddress: VALID.GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS.toLowerCase(),
    sourcePath: source,
  });
  assert.throws(() => fundedProofConfig({}, source), /account address is required/);
});

test("hardened funded canary requires every exact live gate, confirmation, and Postgres", () => {
  const env = {
    ...VALID,
    PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED: "true",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "100",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "500",
    PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
    GHOLA_MAINNET_FUNDED_CANARY_CONFIRMATION: MAINNET_PROOF_CONFIRMATION,
  };
  assert.deepEqual(hardenedMainnetCanaryConfig(env), {
    accountAddress: VALID.GHOLA_HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS,
    privateKey: VALID.GHOLA_HYPERLIQUID_MAINNET_API_WALLET_PRIVATE_KEY,
    databaseUrl: VALID.PRIVATE_AGENT_MAINNET_CANARY_POSTGRES_URL,
  });
  assert.throws(() => hardenedMainnetCanaryConfig({ ...env, GHOLA_MAINNET_FUNDED_CANARY_CONFIRMATION: "yes" }), /confirmation/);
  assert.throws(() => hardenedMainnetCanaryConfig({ ...env, PRIVATE_AGENT_VENUE_DRY_RUN: "true" }), /must be false/);
  assert.throws(() => hardenedMainnetCanaryConfig({ ...env, PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "101" }), /must be 100/);
});

test("each separately authorized canary gets a fresh one-order policy scope", () => {
  const accountCommitment = `hyperliquid_account_${"a".repeat(48)}`;
  const first = hardenedCanaryPolicyCommitment({
    accountCommitment,
    vaultCommitment: `hyperliquid_mainnet_vault_${"b".repeat(48)}`,
  });
  const second = hardenedCanaryPolicyCommitment({
    accountCommitment,
    vaultCommitment: `hyperliquid_mainnet_vault_${"c".repeat(48)}`,
  });
  assert.match(first, /^hyperliquid_mainnet_policy_[0-9a-f]{48}$/u);
  assert.notEqual(first, second);
});
