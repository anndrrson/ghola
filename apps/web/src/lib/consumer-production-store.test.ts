import { beforeEach, describe, expect, it } from "vitest";
import {
  confirmConsumerDeposit,
  cancelConsumerWithdrawal,
  consumeConsumerNonce,
  consumeConsumerRateLimit,
  createConsumerDepositIntent,
  createConsumerWithdrawal,
  getConsumerBalance,
  markConsumerReservationSubmitted,
  putConsumerWalletBinding,
  prepareConsumerWithdrawal,
  reconcileConsumerVenueOrder,
  recordConsumerVenueOrder,
  reserveConsumerBalance,
  resetConsumerProductionStoreForTests,
  submitPreparedConsumerWithdrawal,
} from "./consumer-production-store";

const owner = "owner_consumer_test";
const account = "account_consumer_test";

describe("consumer production store", () => {
  beforeEach(() => {
    process.env.GHOLA_PRIVATE_ACCOUNT_STORE = "memory";
    resetConsumerProductionStoreForTests();
  });

  it("consumes nonces once and enforces a shared window counter", async () => {
    expect(await consumeConsumerNonce({ namespace: "test", owner_commitment: owner, nonce: "nonce_12345678", expires_at_ms: Date.now() + 60_000 })).toBe(true);
    expect(await consumeConsumerNonce({ namespace: "test", owner_commitment: owner, nonce: "nonce_12345678", expires_at_ms: Date.now() + 60_000 })).toBe(false);
    const results = await Promise.all(Array.from({ length: 4 }, () => consumeConsumerRateLimit({ key: "wake:test", limit: 3, window_ms: 60_000, now_ms: 1_000 })));
    expect(results.map((item) => item.ok)).toEqual([true, true, true, false]);
  });

  it("applies a 24 hour hold only when a bound wallet changes", async () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const first = await putConsumerWalletBinding({ owner_commitment: owner, account_commitment: account, wallet_pubkey: "wallet_a", wallet_commitment: "commitment_a", now });
    expect(first.withdrawal_hold_until).toBe(now.toISOString());
    const changed = await putConsumerWalletBinding({ owner_commitment: owner, account_commitment: account, wallet_pubkey: "wallet_b", wallet_commitment: "commitment_b", now });
    expect(new Date(changed.withdrawal_hold_until).getTime() - now.getTime()).toBe(24 * 60 * 60_000);
  });

  it("credits a confirmed deposit once and atomically prevents concurrent overspend", async () => {
    const deposit = await createConsumerDepositIntent({
      owner_commitment: owner,
      account_commitment: account,
      rail: "solana_usdc",
      expected_wallet_pubkey: "wallet_a",
      amount_micro_usdc: 10_000_000,
      idempotency_key: "deposit_key_123",
    });
    const confirmed = await confirmConsumerDeposit({
      deposit_intent_id: deposit.deposit_intent_id,
      owner_commitment: owner,
      transaction_signature: "signature_a",
    });
    expect(confirmed.ok).toBe(true);
    const duplicate = await confirmConsumerDeposit({
      deposit_intent_id: deposit.deposit_intent_id,
      owner_commitment: owner,
      transaction_signature: "signature_a",
    });
    expect(duplicate).toEqual({ ok: false, error: "deposit_intent_not_pending" });

    const attempts = await Promise.all(["order_a_123", "order_b_123"].map((idempotency_key) => reserveConsumerBalance({
      owner_commitment: owner,
      account_commitment: account,
      idempotency_key,
      venue_id: "phoenix",
      notional_micro_usdc: 8_000_000,
      fee_micro_usdc: 50_000,
    })));
    expect(attempts.filter((item) => item.ok)).toHaveLength(1);
    expect(attempts.filter((item) => !item.ok)).toEqual([{ ok: false, error: "insufficient_available_balance" }]);
    const balance = await getConsumerBalance({ owner_commitment: owner, account_commitment: account });
    expect(balance.available_micro_usdc).toBe(1_950_000);
    expect(balance.reserved_micro_usdc).toBe(8_050_000);
  });

  it("settles a partial fill exactly once and releases unused reservation", async () => {
    const deposit = await createConsumerDepositIntent({
      owner_commitment: owner,
      account_commitment: account,
      rail: "solana_usdc",
      expected_wallet_pubkey: "wallet_a",
      amount_micro_usdc: 10_000_000,
      idempotency_key: "deposit_settle_123",
    });
    await confirmConsumerDeposit({ deposit_intent_id: deposit.deposit_intent_id, owner_commitment: owner, transaction_signature: "signature_settle" });
    const reserved = await reserveConsumerBalance({
      owner_commitment: owner,
      account_commitment: account,
      idempotency_key: "order_settle_123",
      venue_id: "phoenix",
      notional_micro_usdc: 5_000_000,
      fee_micro_usdc: 50_000,
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    await markConsumerReservationSubmitted({ reservation_id: reserved.reservation.reservation_id, owner_commitment: owner });
    const order = await recordConsumerVenueOrder({
      reservation_id: reserved.reservation.reservation_id,
      owner_commitment: owner,
      market: "SOL/USDC",
      work_order_commitment: "work_order_settle_123",
      worker_receipt: { receipt: "sealed" },
    });
    expect(order).not.toBeNull();
    if (!order) return;
    const settled = await reconcileConsumerVenueOrder({
      venue_order_id: order.venue_order_id,
      venue_fill_reference: "phoenix_fill_123",
      filled_notional_micro_usdc: 2_000_000,
      venue_cost_micro_usdc: 10_000,
      ghola_fee_micro_usdc: 50_000,
      final_status: "partially_filled",
      filled_at: new Date("2026-07-14T12:00:00.000Z"),
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.balance).toMatchObject({ available_micro_usdc: 7_940_000, reserved_micro_usdc: 0, open_notional_micro_usdc: 2_000_000 });
    expect(await reconcileConsumerVenueOrder({
      venue_order_id: order.venue_order_id,
      venue_fill_reference: "phoenix_fill_duplicate",
      filled_notional_micro_usdc: 2_000_000,
      venue_cost_micro_usdc: 10_000,
      ghola_fee_micro_usdc: 50_000,
      final_status: "partially_filled",
      filled_at: new Date(),
    })).toEqual({ ok: false, error: "already_reconciled" });
  });

  it("binds withdrawal submission to the prepared transaction commitment", async () => {
    const deposit = await createConsumerDepositIntent({
      owner_commitment: owner,
      account_commitment: account,
      rail: "solana_usdc",
      expected_wallet_pubkey: "wallet_a",
      amount_micro_usdc: 10_000_000,
      idempotency_key: "deposit_withdraw_123",
    });
    await confirmConsumerDeposit({ deposit_intent_id: deposit.deposit_intent_id, owner_commitment: owner, transaction_signature: "signature_withdraw" });
    const created = await createConsumerWithdrawal({
      owner_commitment: owner,
      account_commitment: account,
      idempotency_key: "withdrawal_key_123",
      destination_wallet_commitment: "commitment_a",
      amount_micro_usdc: 4_000_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await prepareConsumerWithdrawal({
      withdrawal_id: created.withdrawal.withdrawal_id,
      owner_commitment: owner,
      message_commitment: "a".repeat(64),
      expires_at: new Date(Date.now() + 60_000),
    });
    expect(prepared?.status).toBe("prepared");
    expect(await submitPreparedConsumerWithdrawal({
      withdrawal_id: created.withdrawal.withdrawal_id,
      owner_commitment: owner,
      message_commitment: "b".repeat(64),
      transaction_signature: "wrong_signature",
    })).toBeNull();
    const submitted = await submitPreparedConsumerWithdrawal({
      withdrawal_id: created.withdrawal.withdrawal_id,
      owner_commitment: owner,
      message_commitment: "a".repeat(64),
      transaction_signature: "solana_signature_123",
    });
    expect(submitted?.status).toBe("submitted");
    expect((await getConsumerBalance({ owner_commitment: owner, account_commitment: account })).available_micro_usdc).toBe(6_000_000);
    const cancellable = await createConsumerWithdrawal({
      owner_commitment: owner,
      account_commitment: account,
      idempotency_key: "withdrawal_cancel_123",
      destination_wallet_commitment: "commitment_a",
      amount_micro_usdc: 2_000_000,
    });
    expect(cancellable.ok).toBe(true);
    if (!cancellable.ok) return;
    expect((await cancelConsumerWithdrawal({ withdrawal_id: cancellable.withdrawal.withdrawal_id, owner_commitment: owner }))?.status).toBe("cancelled");
    expect((await getConsumerBalance({ owner_commitment: owner, account_commitment: account })).available_micro_usdc).toBe(6_000_000);
  });
});
