import { randomBytes } from "node:crypto";
import { createOrGetStoredPrivateAccount, json, privateAccountLiveGuard } from "../../../../_lib";
import {
  ASTER_OWNER_ACTIVATION_SCHEMA,
  AsterOwnerActivationError,
  asterOwnerActivationNonce,
  buildAsterOwnerActivationChallenge,
} from "@/lib/aster-owner-activation";
import { resolveLighterTurnkeyPerpsOwnerBinding } from "@/lib/lighter-turnkey-owner-binding.server";
import {
  acquirePrivateCoordinatorLock,
  createPrivateAsterOwnerActivationAttempt,
  getPrivateAsterOwnerActivationAttempt,
  releasePrivateCoordinatorLock,
  type PrivateAsterOwnerActivationAttemptRecordV1,
} from "@/lib/private-account-store";

export const dynamic = "force-dynamic";

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const ATTEMPT_TTL_MS = 5 * 60_000;

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const input = record(guarded.body);
  const ownerAddress = string(input.owner_address).toLowerCase();
  if (input.version !== 1 || !onlyKeys(input, ["version", "owner_address"]) || !EVM_ADDRESS.test(ownerAddress)) {
    return json({ error: "aster_owner_activation_request_invalid" }, 400);
  }

  try {
    await resolveLighterTurnkeyPerpsOwnerBinding({
      sessionEmail: guarded.owner.user.email,
      ownerAddress,
    });
  } catch (error) {
    return bindingFailure(error);
  }

  const account = await createOrGetStoredPrivateAccount(guarded.owner);
  let existing: PrivateAsterOwnerActivationAttemptRecordV1 | null;
  try {
    existing = await getPrivateAsterOwnerActivationAttempt({
      owner_commitment: account.owner_commitment,
      owner_address: ownerAddress as `0x${string}`,
    });
  } catch (error) {
    return ledgerFailure(error);
  }
  if (existing?.status === "pending" && new Date(existing.expires_at).getTime() > Date.now()) {
    return json(preparationPayload(existing), 200);
  }
  if (existing && existing.status !== "rejected" && existing.status !== "pending") {
    return locked(existing);
  }

  const lockId = `aster-owner-activation-prepare:${account.owner_commitment}:${ownerAddress}`;
  const runWindowCommitment = `aster_owner_activation_prepare_${randomBytes(16).toString("hex")}`;
  let lock;
  try {
    lock = await acquirePrivateCoordinatorLock({
      lock_id: lockId,
      run_window_commitment: runWindowCommitment,
      now: new Date(),
      ttl_ms: 30_000,
    });
  } catch (error) {
    return ledgerFailure(error);
  }
  if (!lock.acquired) {
    return json({
      error: "aster_owner_activation_preparation_in_progress",
      retry_allowed: false,
      new_preparation_allowed: false,
    }, 409);
  }

  try {
    const afterLock = await getPrivateAsterOwnerActivationAttempt({
      owner_commitment: account.owner_commitment,
      owner_address: ownerAddress as `0x${string}`,
    });
    if (afterLock?.status === "pending" && new Date(afterLock.expires_at).getTime() > Date.now()) {
      return json(preparationPayload(afterLock), 200);
    }
    if (afterLock && afterLock.status !== "rejected" && afterLock.status !== "pending") {
      return locked(afterLock);
    }

    const response = await fetch(
    new URL(ASTER_OWNER_ACTIVATION_SCHEMA.nonceEndpoint, ASTER_OWNER_ACTIVATION_SCHEMA.origin),
    {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        clientType: ASTER_OWNER_ACTIVATION_SCHEMA.clientType,
      },
      body: JSON.stringify({
        type: ASTER_OWNER_ACTIVATION_SCHEMA.nonceType,
        sourceAddr: ownerAddress,
      }),
      signal: AbortSignal.timeout(8_000),
    },
    ).catch(() => null);
    if (!response) return json({ error: "aster_owner_activation_nonce_unavailable" }, 503);
    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      return json({
        error: "aster_owner_activation_nonce_rejected",
        provider_code: providerCode(responseBody),
      }, response.status >= 500 ? 503 : 409);
    }

    let challenge;
    try {
      challenge = buildAsterOwnerActivationChallenge({
        ownerAddress,
        nonce: asterOwnerActivationNonce(responseBody),
      });
    } catch (error) {
      return activationFailure(error, "aster_owner_activation_nonce_invalid", 502);
    }
    let claimed;
    try {
      claimed = await createPrivateAsterOwnerActivationAttempt({
        activation_id: `aster_owner_activation_${randomBytes(32).toString("hex")}`,
        owner_commitment: account.owner_commitment,
        account_commitment: account.account_commitment,
        owner_address: ownerAddress as `0x${string}`,
        nonce: challenge.nonce,
        now: new Date(),
        ttl_ms: ATTEMPT_TTL_MS,
      });
    } catch (error) {
      return ledgerFailure(error);
    }
    if (!claimed.created) {
      if (claimed.record.status === "pending" && new Date(claimed.record.expires_at).getTime() > Date.now()) {
        return json(preparationPayload(claimed.record), 200);
      }
      return locked(claimed.record);
    }
    return json(preparationPayload(claimed.record), 201);
  } catch (error) {
    return ledgerFailure(error);
  } finally {
    await releasePrivateCoordinatorLock(lockId, runWindowCommitment).catch(() => undefined);
  }
}

function preparationPayload(attempt: PrivateAsterOwnerActivationAttemptRecordV1) {
  return {
    version: 1,
    activation_id: attempt.activation_id,
    account_commitment: attempt.account_commitment,
    venue_id: "aster",
    owner_address: attempt.owner_address,
    challenge: buildAsterOwnerActivationChallenge({
      ownerAddress: attempt.owner_address,
      nonce: attempt.nonce,
    }),
    setup: {
      nonce_requested: true,
      login_submitted: false,
      may_deposit: false,
      may_trade: false,
      may_transfer: false,
      may_withdraw: false,
    },
  };
}

function locked(attempt: PrivateAsterOwnerActivationAttemptRecordV1) {
  return json({
    error: "aster_owner_activation_attempt_locked",
    status: attempt.status,
    retry_allowed: false,
    new_preparation_allowed: attempt.status === "rejected",
  }, 409);
}

function bindingFailure(error: unknown) {
  const source = error instanceof Error ? error.message : "";
  const code = source.replace(/^lighter_turnkey_owner_binding_/, "aster_turnkey_owner_binding_");
  const status = Number((error as { status?: unknown } | null)?.status);
  return json({ error: code || "aster_turnkey_owner_binding_failed" }, [400, 403, 409, 503].includes(status) ? status : 503);
}

function activationFailure(error: unknown, fallback: string, status: number) {
  const code = error instanceof AsterOwnerActivationError ? error.code : fallback;
  return json({ error: code }, status);
}

function ledgerFailure(error: unknown) {
  const code = string((error as { code?: unknown } | null)?.code) || "aster_owner_activation_attempt_ledger_unavailable";
  const status = Number((error as { status?: unknown } | null)?.status);
  return json({ error: code }, [409, 503].includes(status) ? status : 503);
}

function providerCode(value: unknown): string | number | null {
  const code = record(value).code;
  return typeof code === "string" || typeof code === "number" ? code : null;
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
