import { describe, expect, it } from "vitest";

import {
  clearPayoutAttempt,
  payoutAttemptStorageKey,
  preparePayoutAttempt,
  readPendingPayoutAttempt,
} from "./payout-idempotency";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("payout idempotency", () => {
  it("reuses the same key when a response-loss retry has the same request", () => {
    const storage = memoryStorage();
    const key = payoutAttemptStorageKey("bounty", "user_1");
    const request = { to_address: "solana-address", amount_usdc: 2_000_000 };
    const first = preparePayoutAttempt(storage, key, request, () => "11111111-1111-4111-8111-111111111111");
    const retry = preparePayoutAttempt(storage, key, request, () => "22222222-2222-4222-8222-222222222222");

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.attempt.idempotency_key).toBe(first.attempt.idempotency_key);
    }
  });

  it("blocks a different payout while an earlier attempt is unresolved", () => {
    const storage = memoryStorage();
    const key = payoutAttemptStorageKey("bounty", "user_1");
    preparePayoutAttempt(
      storage,
      key,
      { to_address: "first-address", amount_usdc: 1_000_000 },
      () => "11111111-1111-4111-8111-111111111111",
    );

    const next = preparePayoutAttempt(
      storage,
      key,
      { to_address: "second-address", amount_usdc: 1_000_000 },
      () => "22222222-2222-4222-8222-222222222222",
    );

    expect(next.ok).toBe(false);
  });

  it("clears only the matching completed attempt", () => {
    const storage = memoryStorage();
    const key = payoutAttemptStorageKey("provider", "user_2");
    const prepared = preparePayoutAttempt(
      storage,
      key,
      { amount_usdc: 3_000_000 },
      () => "33333333-3333-4333-8333-333333333333",
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    clearPayoutAttempt(storage, key, "payout_wrong_key_1234");
    expect(readPendingPayoutAttempt(storage, key)).not.toBeNull();
    clearPayoutAttempt(storage, key, prepared.attempt.idempotency_key);
    expect(readPendingPayoutAttempt(storage, key)).toBeNull();
  });
});
