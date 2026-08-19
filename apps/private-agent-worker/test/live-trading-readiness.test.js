import assert from "node:assert/strict";
import test from "node:test";
import { liveTradingReadinessContract } from "../src/server.js";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const FINGERPRINT = "live_trading_config_055b97759b904c5000781b7d4d54402e28dbd99caba0453c";

test("worker live readiness exposes the exact five-capability investor contract", () => {
  const readiness = liveTradingReadinessContract(exactEnv(), bakedIdentity());
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.reason_codes, []);
  assert.deepEqual(readiness.capabilities, ["cancel", "limit_order", "reduce_only", "stop_loss", "take_profit"]);
  assert.deepEqual(readiness.caps, {
    max_order_notional_usd: 100,
    rolling_24h_notional_usd: 500,
    max_slippage_bps: 100,
  });
  assert.equal(readiness.worker_git_sha, SHA);
  assert.equal(readiness.worker_image_digest, DIGEST);
  assert.equal(readiness.config_fingerprint, FINGERPRINT);
});

test("worker live readiness fails closed on durability, attestation, capability, proof, or release drift", () => {
  const readiness = liveTradingReadinessContract({
    ...exactEnv(),
    PRIVATE_AGENT_STATE_STORE: "json",
    PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "false",
    PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "false",
    PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED: "false",
    PRIVATE_AGENT_BUILD_GIT_SHA: "",
    PRIVATE_AGENT_IMAGE_DIGEST: "",
    PHALA_CVM_IMAGE_DIGEST: "",
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "true",
    GHOLA_HYPERLIQUID_LIVE_MODE: "full_ticket",
    PRIVATE_AGENT_HYPERLIQUID_NO_SUBMIT_LOCAL_CHECKS: "true",
  }, bakedIdentity());
  assert.equal(readiness.ready, false);
  for (const reason of [
    "worker_state_store_not_postgres",
    "worker_dstack_quote_not_required",
    "worker_capability_auth_not_required",
    "hyperliquid_mainnet_proof_disabled",
    "worker_release_identity_missing",
    "worker_image_digest_missing",
    "worker_global_kill_active",
    "legacy_hyperliquid_live_mode_present",
    "hyperliquid_no_submit_simulation_enabled",
  ]) assert.ok(readiness.reason_codes.includes(reason), reason);
});

test("worker rejects a missing investor capability or implementation flag", () => {
  const readiness = liveTradingReadinessContract({
    ...exactEnv(),
    PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED: "false",
    GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED: "false",
    PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES: "limit_order",
  }, bakedIdentity());
  assert.equal(readiness.ready, false);
  for (const reason of [
    "hyperliquid_risk_reduction_disabled",
    "position_protection_disabled",
    "required_live_capabilities_mismatch",
  ]) assert.ok(readiness.reason_codes.includes(reason), reason);
});

test("worker rejects weak execution and capability secrets", () => {
  const readiness = liveTradingReadinessContract({
    ...exactEnv(),
    PRIVATE_AGENT_EXECUTION_TOKEN: "short",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "placeholder-secret-placeholder-secret",
  }, bakedIdentity());
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reason_codes.includes("worker_execution_token_weak"));
  assert.ok(readiness.reason_codes.includes("worker_capability_secret_weak"));
});

test("worker requires both canonical runtime digest pins to match literally", () => {
  for (const invalidPins of [
    { PHALA_CVM_IMAGE_DIGEST: "" },
    { PHALA_CVM_IMAGE_DIGEST: `sha256:${"c".repeat(64)}` },
    { PRIVATE_AGENT_IMAGE_DIGEST: `sha256:${"B".repeat(64)}` },
  ]) {
    const readiness = liveTradingReadinessContract({ ...exactEnv(), ...invalidPins }, bakedIdentity());
    assert.equal(readiness.ready, false);
    assert.equal(readiness.worker_image_digest, null);
    assert.ok(readiness.reason_codes.includes("worker_image_digest_pin_mismatch"));
  }
});

test("worker readiness binds the configured release to the SHA baked into the image", () => {
  assert.deepEqual(
    liveTradingReadinessContract(exactEnv(), null).reason_codes,
    ["worker_baked_release_identity_missing"],
  );
  const mismatch = liveTradingReadinessContract(exactEnv(), { git_sha: "c".repeat(40) });
  assert.equal(mismatch.ready, false);
  assert.ok(mismatch.reason_codes.includes("worker_baked_release_identity_mismatch"));
  assert.equal(mismatch.worker_git_sha, "c".repeat(40));
  const short = liveTradingReadinessContract({
    ...exactEnv(),
    PRIVATE_AGENT_BUILD_GIT_SHA: "a".repeat(12),
  }, { git_sha: "a".repeat(12) });
  assert.ok(short.reason_codes.includes("worker_release_identity_missing"));
  assert.ok(short.reason_codes.includes("worker_baked_release_identity_missing"));
});

function exactEnv() {
  return {
    PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket",
    PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED: "true",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "100",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "500",
    PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
    PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD: "100",
    PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD: "500",
    PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES: "limit_order,cancel,reduce_only,stop_loss,take_profit",
    PRIVATE_AGENT_VENUE_DRY_RUN: "false",
    PRIVATE_AGENT_STATE_STORE: "postgres",
    PRIVATE_AGENT_STATE_POSTGRES_URL: "postgres://worker-state.example/test",
    PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true",
    PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "true",
    PRIVATE_AGENT_EXECUTION_TOKEN: "B7zL4qN9wX2cV8mK5rT1yP6sD3fH0jUa",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "M8pR2vW7xZ4cN9kL5tQ1sD6fH3jY0uBa",
    PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED: "true",
    GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED: "true",
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
    PRIVATE_AGENT_BUILD_GIT_SHA: SHA,
    PRIVATE_AGENT_IMAGE_DIGEST: DIGEST,
    PHALA_CVM_IMAGE_DIGEST: DIGEST,
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: Buffer.alloc(44, 7).toString("base64"),
  };
}

function bakedIdentity() {
  return { git_sha: SHA };
}
