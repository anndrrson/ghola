import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalLiveTradingCaps, type LiveTradingLaunchState, type LiveTradingReleaseIdentity } from "./live-trading-contract";
import {
  evaluateLiveTradingCapability,
  getActiveLiveTradingAccountGraduation,
  getLiveTradingLaunchControl,
  getLiveTradingWorkOrderReconciliation,
  inspectLiveTradingDispatchAbsence,
  LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS,
  liveTradingWorkerRequestDigest,
  putLiveTradingAccountGraduation,
  putLiveTradingCapabilityEvidence,
  putLiveTradingWorkOrderReconciliation,
  reserveLiveTradingNotional,
  resetLiveTradingStoreForTests,
  settleLiveTradingNotionalReservation,
  transitionLiveTradingLaunchControl,
  type LiveTradingAccountGraduation,
  type LiveTradingCapabilityEvidence,
  type LiveTradingWorkOrderReconciliation,
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

  it("binds account graduation to owner, account, sealed vault, and exact release", async () => {
    const completedAt = NOW.toISOString();
    await putLiveTradingAccountGraduation({
      ...graduationRelease(),
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
      ...graduationRelease(),
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
      release: RELEASE,
    })).toMatchObject({ graduation_id: "graduation_test", proof_notional_usd: 11 });
    expect(await getActiveLiveTradingAccountGraduation({
      owner_commitment: "owner_test",
      account_commitment: "account_test",
      vault_commitment: "vault_test",
      release: { ...RELEASE, worker_image_digest: `sha256:${"c".repeat(64)}` },
    })).toBeNull();
    expect(await getActiveLiveTradingAccountGraduation({
      owner_commitment: "owner_test",
      account_commitment: "account_test",
      vault_commitment: "different_vault",
    })).toBeNull();
  });

  it("rejects legacy release-unbound graduation JSON", async () => {
    const completedAt = NOW.toISOString();
    await putLiveTradingAccountGraduation({
      version: 2,
      graduation_id: "graduation_legacy",
      owner_commitment: "owner_test",
      account_commitment: "account_test",
      vault_commitment: "vault_test",
      proof_evidence_commitment: "proof_legacy",
      proof_notional_usd: 11,
      status: "active",
      completed_at: completedAt,
      revoked_at: null,
      created_at: completedAt,
      updated_at: completedAt,
    } as unknown as LiveTradingAccountGraduation);
    expect(await getActiveLiveTradingAccountGraduation({
      owner_commitment: "owner_test",
      account_commitment: "account_test",
      vault_commitment: "vault_test",
      release: RELEASE,
    })).toBeNull();
  });

  it("durably binds recovery to one owner, account, vault, policy, plan, request, and market", async () => {
    const pending = recoveryRecord();
    expect(await putLiveTradingWorkOrderReconciliation(pending)).toBe(true);
    expect(await getLiveTradingWorkOrderReconciliation({
      owner_commitment: pending.owner_commitment,
      plan_digest: pending.plan_digest,
    })).toEqual(pending);
    expect(await getLiveTradingWorkOrderReconciliation({
      owner_commitment: "owner_cross_scope",
      plan_digest: pending.plan_digest,
    })).toBeNull();

    for (const field of [
      "owner_commitment",
      "account_commitment",
      "vault_commitment",
      "vault_policy_commitment",
      "order_policy_commitment",
      "plan_digest",
      "request_commitment",
      "market",
    ] as const) {
      const conflicting = recoveryRecord({
        [field]: field === "plan_digest"
          ? `sha256:${"9".repeat(64)}`
          : field === "order_policy_commitment"
            ? `live_trade_order_policy_${"9".repeat(48)}`
            : field === "request_commitment"
              ? `live_trade_request_${"9".repeat(48)}`
              : field === "market" ? "BTC" : `${pending[field]}_cross`,
      });
      expect(await putLiveTradingWorkOrderReconciliation(conflicting)).toBe(false);
    }

    for (const conflicting of [
      recoveryRecord({ worker_recipient: "phala:cvm:other-recipient" }),
      recoveryRecord({ worker_image_digest: `sha256:${"6".repeat(64)}` }),
      recoveryRecord({ instruction_expires_at: new Date(NOW.getTime() + 30_000).toISOString() }),
      recoveryRecord({ reservation_id: "reservation_recovery_other" }),
    ]) {
      expect(await putLiveTradingWorkOrderReconciliation(conflicting)).toBe(false);
    }
  });

  it("never downgrades a submitted or terminal recovery record", async () => {
    const pending = recoveryRecord();
    const submitted = {
      ...pending,
      status: "submitted" as const,
      result_commitment: "result_commitment_submitted",
    };
    expect(await putLiveTradingWorkOrderReconciliation(pending)).toBe(true);
    expect(await putLiveTradingWorkOrderReconciliation(submitted)).toBe(true);
    expect(await putLiveTradingWorkOrderReconciliation(pending)).toBe(false);
    expect((await getLiveTradingWorkOrderReconciliation({ owner_commitment: pending.owner_commitment, plan_digest: pending.plan_digest }))?.status).toBe("submitted");
    const terminal = { ...pending, status: "reconciled" as const, result_commitment: "result_commitment_terminal", order_id: "hyperliquid:99" };
    expect(await putLiveTradingWorkOrderReconciliation(terminal)).toBe(true);
    expect(await putLiveTradingWorkOrderReconciliation(submitted)).toBe(false);
    expect(await getLiveTradingWorkOrderReconciliation({ owner_commitment: pending.owner_commitment, plan_digest: pending.plan_digest })).toEqual(terminal);
  });

  it("rejects incoherent terminal recovery records", async () => {
    const pending = recoveryRecord();
    expect(await putLiveTradingWorkOrderReconciliation({
      ...pending,
      status: "not_dispatched",
      result_commitment: null,
      order_id: "hyperliquid:123",
    })).toBe(false);
    expect(await putLiveTradingWorkOrderReconciliation({
      ...pending,
      status: "not_dispatched",
      result_commitment: "result_commitment_no_broadcast",
      order_id: null,
    })).toBe(true);
  });

  it("keeps the first exact terminal outcome immutable", async () => {
    const pending = recoveryRecord();
    expect(await putLiveTradingWorkOrderReconciliation(pending)).toBe(true);
    const filled = {
      ...pending,
      status: "reconciled" as const,
      result_commitment: "result_commitment_first_terminal",
      order_id: "hyperliquid:991",
    };
    expect(await putLiveTradingWorkOrderReconciliation(filled)).toBe(true);
    expect(await putLiveTradingWorkOrderReconciliation(filled)).toBe(true);
    expect(await putLiveTradingWorkOrderReconciliation({
      ...pending,
      status: "no_fill",
      result_commitment: "result_commitment_conflicting_terminal",
      order_id: "hyperliquid:992",
    })).toBe(false);
    expect(await getLiveTradingWorkOrderReconciliation({
      owner_commitment: pending.owner_commitment,
      plan_digest: pending.plan_digest,
    })).toEqual(filled);
  });

  it("requires a durable grace window and lets a delayed work-order record win the race", async () => {
    const record = recoveryRecord();
    expect(await inspectLiveTradingDispatchAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      now: NOW,
    })).toMatchObject({ status: "pending", first_observed_at: NOW.toISOString() });
    expect(await inspectLiveTradingDispatchAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      now: new Date(NOW.getTime() + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS - 1),
    })).toMatchObject({ status: "pending" });
    expect(await putLiveTradingWorkOrderReconciliation(record)).toBe(true);
    expect(await inspectLiveTradingDispatchAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      now: new Date(NOW.getTime() + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS),
    })).toEqual({ status: "evidence_present", work_order_record: true, reservation: false });
  });

  it("proves not-dispatched after grace and releases an orphaned reservation", async () => {
    const owner = "owner_absence_test";
    const planDigest = `sha256:${"8".repeat(64)}`;
    await inspectLiveTradingDispatchAbsence({ owner_commitment: owner, plan_digest: planDigest, now: NOW });
    expect(await inspectLiveTradingDispatchAbsence({
      owner_commitment: owner,
      plan_digest: planDigest,
      now: new Date(NOW.getTime() + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS),
    })).toMatchObject({ status: "proven", proof_commitment: expect.stringMatching(/^live_trade_absence_proof_[a-f0-9]{48}$/u) });

    const reservedPlan = `sha256:${"9".repeat(64)}`;
    expect(await reserveLiveTradingNotional({
      owner_commitment: owner,
      account_commitment: "account_absence_test",
      idempotency_key: "idempotency_absence_test",
      request_commitment: reservedPlan,
      notional_usd: 10,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 500,
      now: NOW,
    })).toMatchObject({ ok: true });
    expect(await inspectLiveTradingDispatchAbsence({
      owner_commitment: owner,
      plan_digest: reservedPlan,
      now: new Date(NOW.getTime() + 60_000),
    })).toMatchObject({ status: "pending" });
    expect(await inspectLiveTradingDispatchAbsence({
      owner_commitment: owner,
      plan_digest: reservedPlan,
      now: new Date(NOW.getTime() + 90_000),
    })).toMatchObject({ status: "proven" });
  });

  it("turns a proven dispatch absence into a permanent late-submit tombstone", async () => {
    const record = recoveryRecord();
    await inspectLiveTradingDispatchAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      now: NOW,
    });
    expect(await inspectLiveTradingDispatchAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      now: new Date(NOW.getTime() + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS),
    })).toMatchObject({ status: "proven" });

    expect(await reserveLiveTradingNotional({
      owner_commitment: record.owner_commitment,
      account_commitment: record.account_commitment,
      idempotency_key: "idempotency_late_after_absence",
      request_commitment: record.plan_digest,
      notional_usd: 11,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 500,
      now: new Date(NOW.getTime() + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS + 1),
    })).toEqual({ ok: false, error: "dispatch_absence_proven" });
    expect(await putLiveTradingWorkOrderReconciliation(record)).toBe(false);
  });

  it("does not let an orphaned reservation defeat the late-dispatch tombstone", async () => {
    const record = recoveryRecord();
    await inspectLiveTradingDispatchAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      now: NOW,
    });
    expect(await reserveLiveTradingNotional({
      owner_commitment: record.owner_commitment,
      account_commitment: record.account_commitment,
      idempotency_key: "idempotency_before_absence_deadline",
      request_commitment: record.plan_digest,
      notional_usd: 11,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 500,
      now: new Date(NOW.getTime() + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS - 1),
    })).toMatchObject({ ok: true });
    expect(await inspectLiveTradingDispatchAbsence({
      owner_commitment: record.owner_commitment,
      plan_digest: record.plan_digest,
      now: new Date(NOW.getTime() + LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS),
    })).toMatchObject({ status: "proven" });
    expect(await putLiveTradingWorkOrderReconciliation(record)).toBe(false);
  });

  it("keeps unresolved and terminal-fill notional counted after reservation expiry", async () => {
    const record = recoveryRecord();
    const first = await reserveLiveTradingNotional({
      owner_commitment: record.owner_commitment,
      account_commitment: record.account_commitment,
      idempotency_key: "idempotency_unresolved_cap",
      request_commitment: record.plan_digest,
      notional_usd: 11,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 500,
      now: NOW,
    });
    if (!first.ok) throw new Error(first.error);
    const submitted = {
      ...record,
      reservation_id: first.reservation.reservation_id,
      status: "submitted" as const,
      result_commitment: "result_commitment_unresolved_submitted",
    };
    expect(await putLiveTradingWorkOrderReconciliation(submitted)).toBe(true);
    const later = new Date(NOW.getTime() + 6 * 60_000);
    expect(await reserveLiveTradingNotional({
      owner_commitment: record.owner_commitment,
      account_commitment: record.account_commitment,
      idempotency_key: "idempotency_blocked_by_unresolved",
      request_commitment: `sha256:${"6".repeat(64)}`,
      notional_usd: 11,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 500,
      now: later,
    })).toEqual({ ok: false, error: "unresolved_work_order" });

    expect(await putLiveTradingWorkOrderReconciliation({
      ...submitted,
      status: "reconciled",
      result_commitment: "result_commitment_unresolved_cap",
      order_id: "hyperliquid:123",
    })).toBe(true);
    expect(await reserveLiveTradingNotional({
      owner_commitment: record.owner_commitment,
      account_commitment: record.account_commitment,
      idempotency_key: "idempotency_fill_still_counted",
      request_commitment: `sha256:${"7".repeat(64)}`,
      notional_usd: 11,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 20,
      now: later,
    })).toEqual({ ok: false, error: "rolling_notional_cap_exceeded" });
  });

  it("releases expired reserved notional after terminal no-fill", async () => {
    const record = recoveryRecord();
    const first = await reserveLiveTradingNotional({
      owner_commitment: record.owner_commitment,
      account_commitment: record.account_commitment,
      idempotency_key: "idempotency_no_fill_release",
      request_commitment: record.plan_digest,
      notional_usd: 11,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 500,
      now: NOW,
    });
    if (!first.ok) throw new Error(first.error);
    expect(await putLiveTradingWorkOrderReconciliation({
      ...record,
      reservation_id: first.reservation.reservation_id,
      status: "no_fill",
      result_commitment: "result_commitment_no_fill_release",
      order_id: "hyperliquid:124",
    })).toBe(true);
    expect(await reserveLiveTradingNotional({
      owner_commitment: record.owner_commitment,
      account_commitment: record.account_commitment,
      idempotency_key: "idempotency_after_no_fill",
      request_commitment: `sha256:${"a".repeat(64)}`,
      notional_usd: 11,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 20,
      now: new Date(NOW.getTime() + 6 * 60_000),
    })).toMatchObject({ ok: true });
  });

  it("keeps kill absorbing against a queued stale activation", async () => {
    const canary = await transitionLiveTradingLaunchControl({
      kind: "set",
      expected_revision: 0,
      control: launchControl("canary", NOW.toISOString()),
    });
    expect(canary).toMatchObject({ ok: true, control: { state: "canary", revision: 1 } });

    const killedPromise = transitionLiveTradingLaunchControl({
      kind: "kill",
      updated_by: "operator:kill",
      updated_at: new Date(NOW.getTime() + 1_000).toISOString(),
      evidence_commitment: "kill_evidence",
    });
    const staleActivationPromise = transitionLiveTradingLaunchControl({
      kind: "set",
      expected_revision: 1,
      control: launchControl("public", new Date(NOW.getTime() + 2_000).toISOString()),
    });
    const [killed, staleActivation] = await Promise.all([killedPromise, staleActivationPromise]);

    expect(killed).toMatchObject({ ok: true, control: { state: "killed", revision: 2 } });
    expect(staleActivation).toMatchObject({
      ok: false,
      error: "launch_killed_absorbing",
      control: { state: "killed", revision: 2 },
    });
    expect(await getLiveTradingLaunchControl()).toMatchObject({ state: "killed", revision: 2 });
  });

  it("permits leaving killed only through an exact-version reset", async () => {
    await transitionLiveTradingLaunchControl({
      kind: "kill",
      updated_by: "operator:kill",
      updated_at: NOW.toISOString(),
      evidence_commitment: "kill_evidence",
    });
    expect(await transitionLiveTradingLaunchControl({
      kind: "set",
      expected_revision: 1,
      control: launchControl("canary", new Date(NOW.getTime() + 1_000).toISOString()),
    })).toMatchObject({ ok: false, error: "launch_killed_absorbing" });
    expect(await transitionLiveTradingLaunchControl({
      kind: "reset",
      expected_revision: 2,
      updated_by: "operator:reset",
      updated_at: new Date(NOW.getTime() + 2_000).toISOString(),
      evidence_commitment: "reset_evidence",
    })).toMatchObject({ ok: false, error: "launch_revision_conflict" });
    expect(await transitionLiveTradingLaunchControl({
      kind: "reset",
      expected_revision: 1,
      updated_by: "operator:reset",
      updated_at: new Date(NOW.getTime() + 3_000).toISOString(),
      evidence_commitment: "reset_evidence",
    })).toMatchObject({ ok: true, control: { state: "disabled", revision: 2 } });
  });
});

function launchControl(state: LiveTradingLaunchState, updatedAt: string) {
  return {
    version: 2 as const,
    state,
    contract_version: 2 as const,
    web_git_sha: RELEASE.web_git_sha,
    worker_git_sha: RELEASE.worker_git_sha,
    worker_image_digest: RELEASE.worker_image_digest,
    config_fingerprint: RELEASE.config_fingerprint,
    public_capabilities: ["limit_order" as const],
    caps: canonicalLiveTradingCaps(),
    evidence_commitment: `evidence_${state}`,
    updated_by: "operator:test",
    created_at: NOW.toISOString(),
    updated_at: updatedAt,
  };
}

function recoveryRecord(overrides: Partial<LiveTradingWorkOrderReconciliation> = {}): LiveTradingWorkOrderReconciliation {
  const workOrder = `live_trade_work_order_${"1".repeat(48)}`;
  const orderPolicy = `live_trade_order_policy_${"2".repeat(48)}`;
  const planDigest = `sha256:${"3".repeat(64)}`;
  const requestCommitment = `live_trade_request_${"4".repeat(48)}`;
  const request: Record<string, unknown> = {
    version: 1,
    reconciliation_binding_version: 1,
    owner_commitment: "owner_recovery_test",
    account_commitment: "account_recovery_test",
    vault_commitment: "vault_recovery_test",
    policy_commitment: "vault_policy_recovery_test",
    order_policy_commitment: orderPolicy,
    plan_digest: planDigest,
    request_commitment: requestCommitment,
    work_order_commitment: workOrder,
    operation_class: "limit_order",
    market: "HYPE",
    session_policy: { policy_commitment: orderPolicy },
  };
  const base: LiveTradingWorkOrderReconciliation = {
    version: 1,
    work_order_commitment: workOrder,
    owner_commitment: String(request.owner_commitment),
    account_commitment: String(request.account_commitment),
    vault_commitment: String(request.vault_commitment),
    vault_policy_commitment: String(request.policy_commitment),
    order_policy_commitment: orderPolicy,
    plan_digest: planDigest,
    request_commitment: requestCommitment,
    worker_request_digest: liveTradingWorkerRequestDigest(request),
    market: "HYPE",
    require_protection: false,
    protection_slippage_bps: null,
    worker_recipient: "phala:cvm:recovery-test",
    worker_image_digest: `sha256:${"5".repeat(64)}`,
    instruction_expires_at: new Date(NOW.getTime() + 15_000).toISOString(),
    reservation_id: "reservation_recovery_test",
    status: "pending",
    result_commitment: null,
    order_id: null,
    worker_request: request,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const record = { ...base, ...overrides };
  if (overrides.owner_commitment) record.worker_request = { ...request, owner_commitment: overrides.owner_commitment };
  if (overrides.account_commitment) record.worker_request = { ...record.worker_request, account_commitment: overrides.account_commitment };
  if (overrides.vault_commitment) record.worker_request = { ...record.worker_request, vault_commitment: overrides.vault_commitment };
  if (overrides.vault_policy_commitment) record.worker_request = { ...record.worker_request, policy_commitment: overrides.vault_policy_commitment };
  if (overrides.order_policy_commitment) record.worker_request = { ...record.worker_request, order_policy_commitment: overrides.order_policy_commitment, session_policy: { policy_commitment: overrides.order_policy_commitment } };
  if (overrides.plan_digest) record.worker_request = { ...record.worker_request, plan_digest: overrides.plan_digest };
  if (overrides.request_commitment) record.worker_request = { ...record.worker_request, request_commitment: overrides.request_commitment };
  if (overrides.market) record.worker_request = { ...record.worker_request, market: overrides.market };
  record.worker_request_digest = liveTradingWorkerRequestDigest(record.worker_request);
  return record;
}

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

function graduationRelease() {
  return {
    version: 3 as const,
    contract_version: 2 as const,
    web_git_sha: RELEASE.web_git_sha as string,
    worker_git_sha: RELEASE.worker_git_sha as string,
    worker_image_digest: RELEASE.worker_image_digest as string,
    config_fingerprint: RELEASE.config_fingerprint,
  };
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
