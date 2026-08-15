import assert from "node:assert/strict";
import test from "node:test";
import { liveTradingReadinessContract } from "../src/server.js";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const FINGERPRINT = "live_trading_config_f67a7172be960ff2abd87d4d889c09546ee06d419e9a35c5";

test("worker live readiness exposes only the exact canonical limit-order contract", () => {
  const readiness = liveTradingReadinessContract(exactEnv());
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.reason_codes, []);
  assert.deepEqual(readiness.capabilities, ["limit_order"]);
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
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "true",
    GHOLA_HYPERLIQUID_LIVE_MODE: "full_ticket",
    PRIVATE_AGENT_HYPERLIQUID_NO_SUBMIT_LOCAL_CHECKS: "true",
  });
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
    PRIVATE_AGENT_LIVE_TRADING_CAPABILITIES: "limit_order",
    PRIVATE_AGENT_VENUE_DRY_RUN: "false",
    PRIVATE_AGENT_STATE_STORE: "postgres",
    PRIVATE_AGENT_STATE_POSTGRES_URL: "postgres://worker-state.example/test",
    PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true",
    PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "true",
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
    PRIVATE_AGENT_BUILD_GIT_SHA: SHA,
    PRIVATE_AGENT_IMAGE_DIGEST: DIGEST,
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: Buffer.alloc(44, 7).toString("base64"),
  };
}
