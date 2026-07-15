import { describe, expect, it } from "vitest";
import {
  balancedPostings,
  consumerFeeMicroUsdc,
  consumerRolloutEligible,
  evaluateConsumerCircuit,
  validateConsumerRiskPolicy,
} from "./consumer-production";

describe("consumer production policy", () => {
  it("charges 10 bps with a fifty-cent-on-ten-trades minimum of five cents per fill", () => {
    expect(consumerFeeMicroUsdc(5_000_000)).toBe(50_000);
    expect(consumerFeeMicroUsdc(100_000_000)).toBe(100_000);
  });

  it("rejects unbalanced ledger transactions", () => {
    expect(() => balancedPostings([
      { account: "consumer_available", side: "debit", amount_micro_usdc: 10 },
      { account: "consumer_reserved", side: "credit", amount_micro_usdc: 9 },
    ])).toThrow("unbalanced_ledger_transaction");
  });

  it("normalizes and bounds user-defined risk policy", () => {
    const policy = validateConsumerRiskPolicy({
      owner_commitment: "owner_1",
      account_commitment: "account_1",
      max_order_micro_usdc: 5_000_000,
      max_daily_notional_micro_usdc: 15_000_000,
      max_position_micro_usdc: 25_000_000,
      max_slippage_bps: 25,
      market_allowlist: ["sol/usdc", "SOL/USDC"],
    }, 10_000_000);
    expect(policy.market_allowlist).toEqual(["SOL/USDC"]);
    expect(() => validateConsumerRiskPolicy({ ...policy, max_slippage_bps: 101 })).toThrow("max_slippage_bps_outside_policy");
  });

  it("halts at the specified reconciliation, treasury, failure, and attestation thresholds", () => {
    const reasons = evaluateConsumerCircuit({
      negative_balance_detected: false,
      duplicate_settlement_detected: false,
      nonce_or_idempotency_violation: false,
      reconciliation_drift_micro_usdc: 1_000_001,
      pooled_treasury_micro_usdc: 100_000_000,
      treasury_free_micro_usdc: 10_000_000,
      reserved_exposure_micro_usdc: 10_000_000,
      market_data_age_ms: 10_001,
      reconciliation_age_ms: 60_001,
      consecutive_failures: 5,
      failure_rate_5m: 0,
      worker_attested: false,
      venue_available: false,
    });
    expect(reasons).toEqual(expect.arrayContaining([
      "reconciliation_drift",
      "insufficient_treasury_buffer",
      "market_data_stale",
      "reconciliation_stale",
      "execution_failure_rate",
      "worker_attestation_missing",
      "venue_unavailable",
    ]));
  });

  it("uses a stable deterministic rollout bucket while always admitting named canaries", () => {
    const first = consumerRolloutEligible("owner_stable", { GHOLA_CONSUMER_ROLLOUT_PERCENT: "25" });
    expect(consumerRolloutEligible("owner_stable", { GHOLA_CONSUMER_ROLLOUT_PERCENT: "25" })).toEqual(first);
    expect(first.bucket).toBeGreaterThanOrEqual(0);
    expect(first.bucket).toBeLessThan(100);
    expect(consumerRolloutEligible("owner_canary", {
      GHOLA_CONSUMER_ROLLOUT_PERCENT: "0",
      GHOLA_CONSUMER_CANARY_COMMITMENTS: "owner_canary",
    })).toMatchObject({ eligible: true, canary: true });
    expect(consumerRolloutEligible("owner_any", { GHOLA_CONSUMER_ROLLOUT_PERCENT: "100" }).eligible).toBe(true);
  });
});
