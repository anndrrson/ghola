import { describe, expect, it } from "vitest";
import {
  liveTradingConfigSnapshot,
  liveTradingConfigurationFailures,
} from "./live-trading-contract";
import { currentLiveTradingReleaseIdentity } from "./live-trading-release.server";
import { liveTradingReadinessContract } from "../../../private-agent-worker/src/server.js";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SIGNER = Buffer.alloc(44, 7).toString("base64");
const FINGERPRINT = "live_trading_config_055b97759b904c5000781b7d4d54402e28dbd99caba0453c";

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

  it("keeps the shared execution fingerprint identical to the worker", () => {
    const env = exactEnv();
    const web = currentLiveTradingReleaseIdentity(env);
    const worker = liveTradingReadinessContract(env, { git_sha: SHA });
    expect(worker.ready).toBe(true);
    expect(worker.config_fingerprint).toBe(web.config_fingerprint);
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

  it("requires the app execution ledger to use durable Postgres", () => {
    const invalidEnv = {
      ...exactEnv(),
      GHOLA_PRIVATE_ACCOUNT_STORE: "memory",
      GHOLA_PRIVATE_ACCOUNT_DATABASE_URL: undefined,
    };
    expect(liveTradingConfigurationFailures(invalidEnv)).toEqual(expect.arrayContaining([
      "app_state_store_not_postgres",
      "app_state_database_not_configured",
    ]));
    expect(currentLiveTradingReleaseIdentity(invalidEnv)).toMatchObject({
      valid: false,
      config_fingerprint: FINGERPRINT,
    });
  });

  it("requires the exact worker URL and Google identity dependency for a live release", () => {
    const fallbackOnly = {
      ...exactEnv(),
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: undefined,
      GHOLA_PRIVATE_AGENT_WORKER_URL: "https://fallback-worker.ghola.xyz",
      PHALA_AGENT_ENDPOINT: "https://fallback-phala.ghola.xyz",
      NEXT_PUBLIC_GOOGLE_CLIENT_ID: undefined,
    };
    expect(liveTradingConfigurationFailures(fallbackOnly)).toEqual(expect.arrayContaining([
      "worker_execution_url_missing",
      "google_client_id_missing",
    ]));
    expect(currentLiveTradingReleaseIdentity(fallbackOnly).valid).toBe(false);

    expect(liveTradingConfigurationFailures({
      ...exactEnv(),
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://other-worker.ghola.xyz",
      GHOLA_PRIVATE_AGENT_WORKER_URL: "https://worker.ghola.xyz/",
      PHALA_AGENT_ENDPOINT: "https://worker.ghola.xyz",
    })).toContain("worker_execution_url_alias_mismatch");
  });

  it.each([
    "http://worker.ghola.xyz",
    "https://localhost",
    "https://127.0.0.1",
    "https://10.0.0.8",
    "https://worker.test",
    "https://operator:secret@worker.ghola.xyz",
    "https://worker.ghola.xyz/private-agent",
  ])("rejects a non-stable live worker URL: %s", (executionUrl) => {
    expect(liveTradingConfigurationFailures({
      ...exactEnv(),
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: executionUrl,
    })).toContain("worker_execution_url_not_stable_https");
  });

  it("requires an exact source-bound worker image tag with a separately pinned digest", () => {
    expect(liveTradingConfigurationFailures({
      ...exactEnv(),
      GHOLA_PRIVATE_AGENT_WORKER_IMAGE: undefined,
    })).toContain("worker_image_tag_missing");

    for (const image of [
      "ghcr.io/anndrrson/ghola:private-agent-worker-latest",
      `ghcr.io/anndrrson/ghola:private-agent-worker-${"c".repeat(40)}`,
      `ghcr.io/anndrrson/other:private-agent-worker-${SHA}`,
      `ghcr.io/anndrrson/ghola:private-agent-worker-${SHA}@${DIGEST}`,
    ]) expect(liveTradingConfigurationFailures({
      ...exactEnv(),
      GHOLA_PRIVATE_AGENT_WORKER_IMAGE: image,
    })).toContain("worker_image_tag_release_mismatch");

    const digestMissing = currentLiveTradingReleaseIdentity({
      ...exactEnv(),
      GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: undefined,
      PRIVATE_AGENT_IMAGE_DIGEST: undefined,
      PHALA_CVM_IMAGE_DIGEST: undefined,
    });
    expect(digestMissing.reason_codes).toContain("worker_image_digest_missing");
    expect(digestMissing.reason_codes).not.toContain("worker_image_tag_release_mismatch");

    for (const invalidPins of [
      { PHALA_CVM_IMAGE_DIGEST: undefined },
      { PHALA_CVM_IMAGE_DIGEST: `sha256:${"c".repeat(64)}` },
      { PRIVATE_AGENT_IMAGE_DIGEST: `sha256:${"B".repeat(64)}` },
    ]) {
      const release = currentLiveTradingReleaseIdentity({ ...exactEnv(), ...invalidPins });
      expect(release.valid).toBe(false);
      expect(release.worker_image_digest).toBeNull();
      expect(release.reason_codes).toContain("worker_image_digest_pin_mismatch");
    }
  });

  it("rejects abbreviated release SHAs", () => {
    const release = currentLiveTradingReleaseIdentity({
      ...exactEnv(),
      GHOLA_WEB_GIT_SHA: "a".repeat(12),
      GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA: "a".repeat(12),
    });
    expect(release.valid).toBe(false);
    expect(release.reason_codes).toEqual(expect.arrayContaining([
      "web_release_identity_missing",
      "worker_release_identity_missing",
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

  it("requires all five investor trading capabilities and their implementation flags", () => {
    const enabled = exactEnv();
    expect(liveTradingConfigurationFailures(enabled)).toEqual([]);
    expect(liveTradingConfigurationFailures({
      ...enabled,
      PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED: "false",
      GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED: "false",
      GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order",
    })).toEqual(expect.arrayContaining([
      "hyperliquid_risk_reduction_disabled",
      "position_protection_disabled",
      "required_live_capabilities_mismatch",
    ]));
  });

  it("rejects weak worker/operator/canary authentication and release identity drift", () => {
    expect(liveTradingConfigurationFailures({
      ...exactEnv(),
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "short",
      PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "placeholder-secret-placeholder-secret",
      GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN: "A7mP3xN9qR2wV8tL5cD1hF6jB4zY0uSk",
      GHOLA_LIVE_TRADING_CONTROL_TOKEN: "short",
      GHOLA_LIVE_TRADING_RESET_TOKEN: "short",
      GHOLA_INVESTOR_CANARY_SECRET: "placeholder-secret-placeholder-secret",
      GHOLA_BAKED_WEB_GIT_SHA: "d".repeat(40),
      VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
    })).toEqual(expect.arrayContaining([
      "worker_execution_token_weak",
      "worker_capability_secret_weak",
      "worker_execution_token_alias_mismatch",
      "live_trading_control_token_weak",
      "live_trading_reset_token_weak",
      "investor_canary_secret_weak",
      "web_baked_release_mismatch",
      "web_platform_release_mismatch",
    ]));
  });

  it("requires a strong reset credential distinct from ordinary launch control", () => {
    expect(liveTradingConfigurationFailures({
      ...exactEnv(),
      GHOLA_LIVE_TRADING_RESET_TOKEN: exactEnv().GHOLA_LIVE_TRADING_CONTROL_TOKEN,
    })).toContain("live_trading_reset_token_not_distinct");
  });

  it("requires explicit baked and platform web release pins", () => {
    expect(liveTradingConfigurationFailures({
      ...exactEnv(),
      GHOLA_BAKED_WEB_GIT_SHA: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    })).toEqual(expect.arrayContaining([
      "web_baked_release_pin_missing",
      "web_platform_release_pin_missing",
    ]));
  });

  it("requires provisioning mutations to remain explicitly disabled", () => {
    expect(liveTradingConfigurationFailures({
      ...exactEnv(),
      GHOLA_PRIVATE_AGENT_PROVISIONING_MUTATIONS_ENABLED: "true",
    })).toContain("private_agent_provisioning_mutations_not_disabled");
  });
});

function exactEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    GHOLA_LIVE_TRADING_PUBLIC_ENABLED: "true",
    GHOLA_LIVE_TRADING_PUBLIC_CAPABILITIES: "limit_order,cancel,reduce_only,stop_loss,take_profit",
    GHOLA_LIVE_TRADING_MAX_ORDER_NOTIONAL_USD: "100",
    GHOLA_LIVE_TRADING_DAILY_CAP_USD: "500",
    GHOLA_LIVE_TRADING_MAX_SLIPPAGE_BPS: "100",
    GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET: "secure_private_account_request_proof_secret_value",
    GHOLA_LIVE_TRADING_CONTROL_TOKEN: "K7vP3xN9mR2qW8tL5cD1hF6jB4zY0uSa",
    GHOLA_LIVE_TRADING_RESET_TOKEN: "R4nW8qL2xC7mV1pK9tD5hF3jB6zY0uSa",
    GHOLA_INVESTOR_CANARY_SECRET: "Q9mV4xR7kT2pN8cL5wD1hF6jB3zY0uSa",
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
    PRIVATE_AGENT_STATE_POSTGRES_URL: "postgres://configured.example/worker",
    GHOLA_PRIVATE_ACCOUNT_STORE: "postgres",
    GHOLA_PRIVATE_ACCOUNT_DATABASE_URL: "postgres://configured.example/ghola",
    GHOLA_PRIVATE_AGENT_PROVISIONING_MUTATIONS_ENABLED: "false",
    GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.ghola.xyz",
    GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "B7zL4qN9wX2cV8mK5rT1yP6sD3fH0jUa",
    PRIVATE_AGENT_EXECUTION_TOKEN: "B7zL4qN9wX2cV8mK5rT1yP6sD3fH0jUa",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "M8pR2vW7xZ4cN9kL5tQ1sD6fH3jY0uBa",
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: "ghola-investor.apps.googleusercontent.com",
    PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true",
    PRIVATE_AGENT_REQUIRE_WORKER_CAPABILITY: "true",
    PRIVATE_AGENT_HYPERLIQUID_RISK_REDUCTION_ENABLED: "true",
    GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED: "true",
    PRIVATE_AGENT_GLOBAL_KILL_SWITCH: "false",
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: SIGNER,
    GHOLA_WEB_GIT_SHA: SHA,
    GHOLA_BAKED_WEB_GIT_SHA: SHA,
    VERCEL_GIT_COMMIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_GIT_SHA: SHA,
    PRIVATE_AGENT_BUILD_GIT_SHA: SHA,
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE: `ghcr.io/anndrrson/ghola:private-agent-worker-${SHA}`,
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: DIGEST,
    PRIVATE_AGENT_IMAGE_DIGEST: DIGEST,
    PHALA_CVM_IMAGE_DIGEST: DIGEST,
  };
}
