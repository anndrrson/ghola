export type PayoutRequest = {
  to_address?: string;
  amount_usdc?: number;
};

export type PendingPayoutAttempt = {
  version: 1;
  fingerprint: string;
  idempotency_key: string;
  request: PayoutRequest;
  created_at: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export function payoutAttemptStorageKey(kind: "bounty" | "provider", userId: string): string {
  return `ghola:payout-attempt:v1:${kind}:${userId}`;
}

export function payoutRequestFingerprint(request: PayoutRequest): string {
  return JSON.stringify({
    to_address: request.to_address?.trim() || null,
    amount_usdc: request.amount_usdc ?? null,
  });
}

export function readPendingPayoutAttempt(
  storage: StorageLike,
  storageKey: string,
): PendingPayoutAttempt | null {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || "null") as Partial<PendingPayoutAttempt> | null;
    if (
      parsed?.version !== 1 ||
      typeof parsed.fingerprint !== "string" ||
      typeof parsed.idempotency_key !== "string" ||
      !IDEMPOTENCY_KEY_PATTERN.test(parsed.idempotency_key) ||
      typeof parsed.created_at !== "string" ||
      !parsed.request ||
      typeof parsed.request !== "object"
    ) return null;
    return parsed as PendingPayoutAttempt;
  } catch {
    return null;
  }
}

export function preparePayoutAttempt(
  storage: StorageLike,
  storageKey: string,
  request: PayoutRequest,
  createId: () => string = () => crypto.randomUUID(),
): { ok: true; attempt: PendingPayoutAttempt } | { ok: false; pending: PendingPayoutAttempt } {
  const fingerprint = payoutRequestFingerprint(request);
  const pending = readPendingPayoutAttempt(storage, storageKey);
  if (pending) {
    if (pending.fingerprint !== fingerprint) return { ok: false, pending };
    return { ok: true, attempt: pending };
  }

  const idempotencyKey = `payout_${createId().replaceAll("-", "_")}`;
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new Error("Unable to create a safe payout request key.");
  }
  const attempt: PendingPayoutAttempt = {
    version: 1,
    fingerprint,
    idempotency_key: idempotencyKey,
    request,
    created_at: new Date().toISOString(),
  };
  storage.setItem(storageKey, JSON.stringify(attempt));
  return { ok: true, attempt };
}

export function clearPayoutAttempt(
  storage: StorageLike,
  storageKey: string,
  idempotencyKey: string,
): void {
  const pending = readPendingPayoutAttempt(storage, storageKey);
  if (pending?.idempotency_key === idempotencyKey) storage.removeItem(storageKey);
}
