import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveTradingReleaseIdentity } from "./live-trading-contract";
import {
  evaluateLiveTradingCapability,
  getActiveLiveTradingAccountGraduation,
  putLiveTradingAccountGraduation,
  putLiveTradingCapabilityEvidence,
  reserveLiveTradingNotional,
  resetLiveTradingStoreForTests,
  settleLiveTradingNotionalReservation,
  type LiveTradingCapabilityEvidence,
} from "./live-trading-store";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const RELEASE: LiveTradingReleaseIdentity = {
  contract_version: 2,
  web_git_sha: "a".repeat(40),
  worker_git_sha: "a".repeat(40),
  worker_image_digest: `sha256:${"b".repeat(64)}`,
  config_fingerprint: "live_config_test",
  valid: true,
  reason_codes: [],
};

describe("durable live-trading state", () => {
  beforeEach(() => resetLiveTradingStoreForTests());
  afterEach(() => resetLiveTradingStoreForTests());

  it("requires three fresh, release-bound proofs from distinct venue accounts", async () => {
    await Promise.all([0, 1, 2].map((index) => putLiveTradingCapabilityEvidence(
      evidence({ index }),
    )));
    expect(await status()).toMatchObject({
      state: "live",
      visible: true,
      consecutive_mainnet_proofs: 3,
    });

    await putLiveTradingCapabilityEvidence(evidence({ index: 3, status: "red", subject: null }));
    expect(await status()).toMatchObject({ state: "disabled", consecutive_mainnet_proofs: 0 });

    await Promise.all([4, 5, 6].map((index) => putLiveTradingCapabilityEvidence(
      evidence({ index }),
    )));
    expect((await status()).state).toBe("live");
  });

  it("does not count a repeated account or mismatched proof amount/release", async () => {
    await Promise.all([0, 1, 2].map((index) => putLiveTradingCapabilityEvidence(
      evidence({
        index,
        venueAccount: venueAccountCommitment(9),
      }),
    )));
    expect(await status()).toMatchObject({ state: "disabled", consecutive_mainnet_proofs: 1 });

    resetLiveTradingStoreForTests();
    await putLiveTradingCapabilityEvidence(evidence({
      index: 0,
      subject: "not_the_validated_venue_account",
    }));
    expect((await status()).reason_codes).toContain("capability_proof_failed");

    resetLiveTradingStoreForTests();
    await putLiveTradingCapabilityEvidence(evidence({ index: 0, notional: 10 }));
    expect((await status()).reason_codes).toContain("capability_proof_failed");

    resetLiveTradingStoreForTests();
    await putLiveTradingCapabilityEvidence(evidence({ index: 0 }));
    const drifted = await status({ ...RELEASE, config_fingerprint: "drifted" });
    expect(drifted.reason_codes).toContain("capability_proof_release_mismatch");
  });

  it("atomically enforces $100/order, $500/24h and idempotency", async () => {
    const attempts = await Promise.all(Array.from({ length: 6 }, (_, index) => reserve({
      idempotency_key: `order_${index}`,
      notional_usd: 100,
    })));
    expect(attempts.filter((result) => result.ok)).toHaveLength(5);
    expect(attempts.filter((result) => !result.ok)).toEqual([
      { ok: false, error: "rolling_notional_cap_exceeded" },
    ]);

    const replay = await reserve({ idempotency_key: "order_0", notional_usd: 100 });
    expect(replay).toMatchObject({ ok: true, disposition: "replayed", rolling_notional_usd: 500 });
    expect(await reserve({ idempotency_key: "order_0", notional_usd: 99 })).toEqual({
      ok: false,
      error: "idempotency_conflict",
    });
    expect(await reserve({
      idempotency_key: "order_0",
      notional_usd: 100,
      request_commitment: `sha256:${"f".repeat(64)}`,
    })).toEqual({ ok: false, error: "idempotency_conflict" });
    expect(await reserve({ idempotency_key: "too_large", notional_usd: 100.01 })).toEqual({
      ok: false,
      error: "order_notional_cap_exceeded",
    });

    const first = attempts.find((result) => result.ok);
    if (!first?.ok) throw new Error("reservation_missing");
    await settleLiveTradingNotionalReservation({
      reservation_id: first.reservation.reservation_id,
      status: "released",
      now: NOW,
    });
    expect(await reserve({ idempotency_key: "order_0", notional_usd: 100 })).toEqual({
      ok: false,
      error: "idempotency_conflict",
    });
    expect(await reserve({ idempotency_key: "replacement", notional_usd: 100 })).toMatchObject({
      ok: true,
      disposition: "created",
      rolling_notional_usd: 500,
    });
  });

  it("binds account graduation to owner, account, and sealed vault", async () => {
    const completedAt = NOW.toISOString();
    await putLiveTradingAccountGraduation({
      version: 2,
      graduation_id: "graduation_old_notional",
      owner_commitment: "owner_test",
      account_commitment: "account_test",
      vault_commitment: "vault_test",
      proof_evidence_commitment: "proof_old",
      proof_notional_usd: 10.5,
      status: "active",
      completed_at: completedAt,
      revoked_at: null,
      created_at: completedAt,
      updated_at: completedAt,
    });
    expect(await getActiveLiveTradingAccountGraduation({
      owner_commitment: "owner_test",
      account_commitment: "account_test",
      vault_commitment: "vault_test",
    })).toBeNull();
    await putLiveTradingAccountGraduation({
      version: 2,
      graduation_id: "graduation_test",
      owner_commitment: "owner_test",
      account_commitment: "account_test",
      vault_commitment: "vault_test",
      proof_evidence_commitment: "proof_test",
      proof_notional_usd: 11,
      status: "active",
      completed_at: completedAt,
      revoked_at: null,
      created_at: completedAt,
      updated_at: completedAt,
    });
    expect(await getActiveLiveTradingAccountGraduation({
      owner_commitment: "owner_test",
      account_commitment: "account_test",
      vault_commitment: "vault_test",
    })).toMatchObject({ graduation_id: "graduation_test", proof_notional_usd: 11 });
    expect(await getActiveLiveTradingAccountGraduation({
      owner_commitment: "owner_test",
      account_commitment: "account_test",
      vault_commitment: "different_vault",
    })).toBeNull();
  });
});

function evidence(input: {
  index: number;
  status?: "green" | "red";
  subject?: string | null;
  venueAccount?: string | null;
  notional?: number;
}): LiveTradingCapabilityEvidence {
  const status = input.status ?? "green";
  const observed = new Date(NOW.getTime() - 60_000 + input.index * 1_000);
  const venueAccount = status === "green"
    ? (input.venueAccount ?? venueAccountCommitment(input.index))
    : null;
  return {
    version: 2,
    evidence_id: `evidence_${input.index}_${status}`,
    capability: "limit_order",
    venue_id: "hyperliquid",
    network: "mainnet",
    status,
    broadcast_performed: status === "green",
    reconciled: status === "green",
    final_flat: status === "green",
    open_order_count: status === "green" ? 0 : -1,
    order_notional_usd: input.notional ?? 11,
    web_git_sha: RELEASE.web_git_sha as string,
    worker_git_sha: RELEASE.worker_git_sha as string,
    worker_image_digest: RELEASE.worker_image_digest as string,
    config_fingerprint: RELEASE.config_fingerprint,
    receipt_commitment: status === "green" ? `receipt_${input.index}` : null,
    result_commitment: status === "green" ? `result_${input.index}` : null,
    venue_account_commitment: venueAccount,
    proof_subject_commitment: status === "green" ? (input.subject ?? venueAccount) : null,
    reason: status === "red" ? "proof_failed" : null,
    observed_at: observed.toISOString(),
    expires_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    created_at: observed.toISOString(),
  };
}

function venueAccountCommitment(index: number) {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

function status(release = RELEASE) {
  return evaluateLiveTradingCapability({
    capability: "limit_order",
    release,
    launch_state: "public",
    visible: true,
    now: NOW,
  });
}

function reserve(input: { idempotency_key: string; notional_usd: number; request_commitment?: string }) {
  return reserveLiveTradingNotional({
    owner_commitment: "owner_test",
    account_commitment: "account_test",
    max_order_notional_usd: 100,
    rolling_24h_notional_usd: 500,
    now: NOW,
    ...input,
    request_commitment: input.request_commitment ??
      `sha256:${Buffer.from(input.idempotency_key).toString("hex").padEnd(64, "a").slice(0, 64)}`,
  });
}
