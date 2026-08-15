import { describe, expect, it } from "vitest";
import {
  liveTradingConfigSnapshot,
  liveTradingConfigurationFailures,
} from "./live-trading-contract";
import { currentLiveTradingReleaseIdentity } from "./live-trading-release.server";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SIGNER = Buffer.alloc(44, 7).toString("base64");
const FINGERPRINT = "live_trading_config_f67a7172be960ff2abd87d4d889c09546ee06d419e9a35c5";

describe("canonical live-trading contract", () => {
  it("accepts only the exact Hyperliquid mainnet launch contract", () => {
    const env = exactEnv();
    expect(liveTradingConfigurationFailures(env)).toEqual([]);
    expect(currentLiveTradingReleaseIdentity(env)).toMatchObject({
      valid: true,
      web_git_sha: SHA,
      worker_git_sha: SHA,
      worker_image_digest: DIGEST,
      config_fingerprint: FINGERPRINT,
    });
  });

  it("fails closed for legacy aliases, cap drift, unimplemented controls, or a missing signer pin", () => {
    expect(liveTradingConfigurationFailures({
      ...exactEnv(),
      GHOLA_HYPERLIQUID_LIVE_MODE: "full_ticket",
      GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "101",
      GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order,leverage",
      GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: "",
      PRIVATE_AGENT_HYPERLIQUID_NO_SUBMIT_LOCAL_CHECKS: "true",
    })).toEqual(expect.arrayContaining([
      "legacy_hyperliquid_live_mode_present",
      "launch_max_order_cap_mismatch",
      "public_capability_not_implemented",
      "funding_worker_signer_pin_missing",
      "hyperliquid_no_submit_simulation_enabled",
    ]));
  });

  it("binds signer rotation into the configuration fingerprint", () => {
    const first = currentLiveTradingReleaseIdentity(exactEnv());
    const second = currentLiveTradingReleaseIdentity({
      ...exactEnv(),
      GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: Buffer.alloc(44, 8).toString("base64"),
    });
    expect(liveTradingConfigSnapshot(exactEnv()).funding_signer_keys_b64).toEqual([SIGNER]);
    expect(second.config_fingerprint).not.toBe(first.config_fingerprint);
  });
});

function exactEnv(): Record<string, string | undefined> {
  return {
    GHOLA_LIVE_TRADING_PUBLIC_ENABLED: "true",
    GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order",
    GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "100",
    GHOLA_LIVE_TRADING_DAILY_CAP_USD: "500",
    GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS: "100",
    GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET: "secure_private_account_request_proof_secret_value",
    GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
    PRIVATE_AGENT_VENUE_DRY_RUN: "false",
    PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
    PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket",
    PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED: "true",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: "100",
    PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_DAILY_NOTIONAL_CAP_USD: "500",
    PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
    PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD: "100",
    PRIVATE_AGENT_LIVE_DAILY_NOTIONAL_CAP_USD: "500",
    PRIVATE_AGENT_STATE_STORE: "postgres",
    PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true",
    PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "true",
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: SIGNER,
    GHOLA_WEB_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: DIGEST,
  };
}
