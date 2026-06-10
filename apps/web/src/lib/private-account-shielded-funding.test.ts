import { describe, it, expect } from "vitest";
import {
  verifyFreshWalletFunded,
  verifiedFundingCommitment,
  NATIVE_SHIELDED_RAIL,
  type ShieldedFundingClaim,
  type ShieldedWithdrawObservation,
} from "./private-account-shielded-funding";
import type { ShieldedPoolConfig } from "./private-account-shielded-pool";

const NOW = new Date("2026-05-29T00:00:00.000Z");

function config(overrides: Partial<ShieldedPoolConfig> = {}): ShieldedPoolConfig {
  return {
    mode: "http",
    indexer_url: "https://indexer.example",
    prover_url: "https://prover.example",
    relayer_url: "https://relayer.example",
    private_runtime_url: "https://runtime.example",
    private_runtime_token: "tok",
    network: "solana-shielded-pool-v1",
    program_id: "ProgRAM1111111111111111111111111111111111",
    mint: "USDC1111111111111111111111111111111111111",
    tree_id: "tree-1",
    min_confirmations: 3,
    max_stale_ms: 300_000,
    ...overrides,
  };
}

function claim(overrides: Partial<ShieldedFundingClaim> = {}): ShieldedFundingClaim {
  return {
    rail: NATIVE_SHIELDED_RAIL,
    relay_id: "relay-abc",
    destination_commitment: "dest-commit-1",
    amount_bucket: "25",
    ...overrides,
  };
}

function observation(
  overrides: Partial<ShieldedWithdrawObservation> = {},
): ShieldedWithdrawObservation {
  return {
    relay_id: "relay-abc",
    status: "confirmed",
    confirmations: 3,
    destination_commitment: "dest-commit-1",
    amount_bucket: "25",
    observed_at: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("verifyFreshWalletFunded", () => {
  it("verifies a confirmed native withdraw bound to the fresh credential", () => {
    const result = verifyFreshWalletFunded(claim(), observation(), config(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rail).toBe(NATIVE_SHIELDED_RAIL);
      expect(result.amount_bucket).toBe("25");
      expect(result.confirmations).toBe(3);
      expect(result.funding_evidence_commitment).toMatch(/^verified_shielded_funding_[0-9a-f]{48}$/);
    }
  });

  it("binds the commitment to the verified facts (preimage is real, not opaque)", () => {
    const a = verifyFreshWalletFunded(claim(), observation(), config(), NOW);
    const b = verifyFreshWalletFunded(
      claim({ destination_commitment: "dest-commit-2" }),
      observation({ destination_commitment: "dest-commit-2" }),
      config(),
      NOW,
    );
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      // Different destinations => different commitments. The commitment is a
      // function of the verified withdraw, not a free-form string.
      expect(a.funding_evidence_commitment).not.toBe(b.funding_evidence_commitment);
    }
  });

  it("rejects a third-party privacy rail (SOC 2 minimization)", () => {
    for (const rail of ["railgun_evm", "aleo_usdcx", "wormhole", ""]) {
      const result = verifyFreshWalletFunded(claim({ rail }), observation(), config(), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("rail_not_native");
    }
  });

  it("rejects when the relayer has no record of the withdraw", () => {
    const result = verifyFreshWalletFunded(claim(), null, config(), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("withdraw_not_found");
  });

  it("rejects a failed withdraw", () => {
    const result = verifyFreshWalletFunded(
      claim(),
      observation({ status: "failed" }),
      config(),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("withdraw_failed");
  });

  it("rejects an unconfirmed (still pending/batched/submitted) withdraw", () => {
    for (const status of ["pending", "batched", "submitted"] as const) {
      const result = verifyFreshWalletFunded(
        claim(),
        observation({ status }),
        config(),
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("withdraw_not_confirmed");
    }
  });

  it("rejects insufficient confirmations", () => {
    const result = verifyFreshWalletFunded(
      claim(),
      observation({ confirmations: 2 }),
      config({ min_confirmations: 3 }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient_confirmations");
  });

  it("rejects a destination mismatch (funding not bound to this credential)", () => {
    const result = verifyFreshWalletFunded(
      claim({ destination_commitment: "dest-A" }),
      observation({ destination_commitment: "dest-B" }),
      config(),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("destination_mismatch");
  });

  it("rejects an amount-bucket mismatch", () => {
    const result = verifyFreshWalletFunded(
      claim({ amount_bucket: "25" }),
      observation({ amount_bucket: "100" }),
      config(),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("amount_bucket_mismatch");
  });

  it("rejects an invalid amount bucket in the claim", () => {
    const result = verifyFreshWalletFunded(
      claim({ amount_bucket: "37" }),
      observation({ amount_bucket: "37" }),
      config(),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("amount_bucket_invalid");
  });

  it("rejects a stale observation", () => {
    const result = verifyFreshWalletFunded(
      claim(),
      observation({ observed_at: "2026-05-28T23:50:00.000Z" }), // 10 min old
      config({ max_stale_ms: 300_000 }), // 5 min window
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("observation_stale");
  });

  it("rejects when the shielded pool relayer is unconfigured in http mode", () => {
    const result = verifyFreshWalletFunded(
      claim(),
      observation(),
      config({ relayer_url: "" }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("shielded_pool_unconfigured");
  });

  it("requires a relay id and destination commitment", () => {
    const noRelay = verifyFreshWalletFunded(claim({ relay_id: "  " }), observation(), config(), NOW);
    expect(noRelay.ok).toBe(false);
    if (!noRelay.ok) expect(noRelay.reason).toBe("relay_id_missing");

    const noDest = verifyFreshWalletFunded(
      claim({ destination_commitment: "" }),
      observation(),
      config(),
      NOW,
    );
    expect(noDest.ok).toBe(false);
    if (!noDest.ok) expect(noDest.reason).toBe("destination_commitment_missing");
  });
});

describe("verifiedFundingCommitment", () => {
  it("returns the commitment on success and null on failure", () => {
    const ok = verifyFreshWalletFunded(claim(), observation(), config(), NOW);
    expect(verifiedFundingCommitment(ok)).toMatch(/^verified_shielded_funding_[0-9a-f]{48}$/);

    const bad = verifyFreshWalletFunded(claim({ rail: "railgun_evm" }), observation(), config(), NOW);
    expect(verifiedFundingCommitment(bad)).toBeNull();
  });
});
