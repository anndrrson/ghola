import { describe, expect, it } from "vitest";
import { canonicalLiveTradingCaps } from "./live-trading-contract";
import { liveTradingControlBindingFailures } from "./live-trading-release.server";

describe("live-trading launch binding", () => {
  it("accepts canonical caps after Postgres JSONB reorders their keys", () => {
    const caps = canonicalLiveTradingCaps();
    const release = {
      contract_version: 2 as const,
      web_git_sha: "a".repeat(40),
      worker_git_sha: "a".repeat(40),
      worker_image_digest: `sha256:${"b".repeat(64)}`,
      config_fingerprint: "live_trading_config_test",
      valid: true,
      reason_codes: [],
    };
    const failures = liveTradingControlBindingFailures({
      state: "canary",
      contract_version: 2,
      web_git_sha: release.web_git_sha,
      worker_git_sha: release.worker_git_sha,
      worker_image_digest: release.worker_image_digest,
      config_fingerprint: release.config_fingerprint,
      public_capabilities: ["limit_order"],
      caps: {
        max_slippage_bps: caps.max_slippage_bps,
        rolling_24h_notional_usd: caps.rolling_24h_notional_usd,
        max_order_notional_usd: caps.max_order_notional_usd,
        first_proof_notional_usd: caps.first_proof_notional_usd,
        default_slippage_bps: caps.default_slippage_bps,
      },
    }, release, ["limit_order"], ["canary"]);

    expect(failures).not.toContain("launch_caps_binding_mismatch");
    expect(failures).toEqual([]);
  });
});
