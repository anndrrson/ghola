import { createHash } from "node:crypto";
import { createOrGetStoredPrivateAccount, json, privateAccountLiveGuard } from "../../../../_lib";
import {
  ASTER_OWNER_ACTIVATION_SCHEMA,
  AsterOwnerActivationError,
  buildAsterOwnerActivationChallenge,
  validateAsterOwnerActivationLogin,
  verifyAsterOwnerActivationSignature,
} from "@/lib/aster-owner-activation";
import { resolveLighterTurnkeyPerpsOwnerBinding } from "@/lib/lighter-turnkey-owner-binding.server";
import {
  claimPrivateAsterOwnerActivationSubmission,
  settlePrivateAsterOwnerActivationAttempt,
  type PrivateAsterOwnerActivationAttemptRecordV1,
} from "@/lib/private-account-store";

export const dynamic = "force-dynamic";

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const ACTIVATION_ID = /^aster_owner_activation_[0-9a-f]{64}$/;

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const input = record(guarded.body);
  const ownerAddress = string(input.owner_address).toLowerCase();
  const activationId = string(input.activation_id);
  if (
    input.version !== 1 ||
    !onlyKeys(input, ["version", "activation_id", "owner_address", "nonce", "message", "signature"]) ||
    !EVM_ADDRESS.test(ownerAddress) ||
    !ACTIVATION_ID.test(activationId)
  ) return json({ error: "aster_owner_activation_request_invalid" }, 400);

  const account = await createOrGetStoredPrivateAccount(guarded.owner);
  try {
    await resolveLighterTurnkeyPerpsOwnerBinding({
      sessionEmail: guarded.owner.user.email,
      ownerAddress,
    });
  } catch (error) {
    return bindingFailure(error);
  }
  let challenge;
  try {
    challenge = buildAsterOwnerActivationChallenge({ ownerAddress, nonce: string(input.nonce) });
  } catch (error) {
    return activationFailure(error, "aster_owner_activation_challenge_invalid", 400);
  }
  if (
    string(input.message) !== challenge.message
  ) return json({ error: "aster_owner_activation_binding_invalid" }, 409);

  let signature: `0x${string}`;
  try {
    signature = await verifyAsterOwnerActivationSignature({
      challenge,
      signature: string(input.signature),
    });
  } catch (error) {
    return activationFailure(error, "aster_owner_activation_signature_invalid", 403);
  }

  let claim;
  try {
    claim = await claimPrivateAsterOwnerActivationSubmission({
      activation_id: activationId,
      owner_commitment: account.owner_commitment,
      account_commitment: account.account_commitment,
      owner_address: ownerAddress as `0x${string}`,
      nonce: challenge.nonce,
      now: new Date(),
    });
  } catch (error) {
    return ledgerFailure(error);
  }
  if (!claim.claimed) return existingAttempt(claim.record);

  const response = await fetch(
    new URL(ASTER_OWNER_ACTIVATION_SCHEMA.loginEndpoint, ASTER_OWNER_ACTIVATION_SCHEMA.origin),
    {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        clientType: ASTER_OWNER_ACTIVATION_SCHEMA.clientType,
      },
      body: JSON.stringify({
        signature,
        sourceAddr: ownerAddress,
        chainId: ASTER_OWNER_ACTIVATION_SCHEMA.chainId,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  ).catch(() => null);
  if (!response || response.status >= 500 || [408, 425, 429].includes(response.status)) {
    return ambiguousAndFreeze({
      activationId,
      account,
      ownerAddress: ownerAddress as `0x${string}`,
      nonce: challenge.nonce,
    });
  }

  const responseBody = await response.json().catch(() => null);
  const rejection = explicitRejection(responseBody);
  if (rejection) {
    try {
      await settlePrivateAsterOwnerActivationAttempt({
        activation_id: activationId,
        owner_commitment: account.owner_commitment,
        account_commitment: account.account_commitment,
        owner_address: ownerAddress as `0x${string}`,
        nonce: challenge.nonce,
        status: "rejected",
        provider_uid_commitment: null,
        failure_code: "aster_owner_activation_rejected",
        now: new Date(),
      });
    } catch {
      return ambiguous();
    }
    return json({
      error: "aster_owner_activation_rejected",
      retry_allowed: false,
      new_preparation_allowed: true,
      provider_code: rejection.code,
    }, 409);
  }
  if (!response.ok) {
    return ambiguousAndFreeze({
      activationId,
      account,
      ownerAddress: ownerAddress as `0x${string}`,
      nonce: challenge.nonce,
    });
  }

  let receipt;
  try {
    receipt = validateAsterOwnerActivationLogin(responseBody);
  } catch {
    return ambiguousAndFreeze({
      activationId,
      account,
      ownerAddress: ownerAddress as `0x${string}`,
      nonce: challenge.nonce,
    });
  }
  const providerUidCommitment = `sha256:${createHash("sha256").update(JSON.stringify({
    account_commitment: account.account_commitment,
    owner_address: ownerAddress,
    provider_uid: receipt.providerUid,
  })).digest("hex")}`;
  try {
    await settlePrivateAsterOwnerActivationAttempt({
      activation_id: activationId,
      owner_commitment: account.owner_commitment,
      account_commitment: account.account_commitment,
      owner_address: ownerAddress as `0x${string}`,
      nonce: challenge.nonce,
      status: "accepted",
      provider_uid_commitment: providerUidCommitment,
      failure_code: null,
      now: new Date(),
    });
  } catch {
    return ambiguous();
  }
  return accepted({
    activationId,
    ownerAddress,
    providerUidCommitment,
  });
}

function accepted(input: {
  activationId: string;
  ownerAddress: string;
  providerUidCommitment: string;
}) {
  return json({
    version: 1,
    venue_id: "aster",
    status: "owner_login_accepted",
    activation_id: input.activationId,
    owner_address: input.ownerAddress,
    provider_uid_commitment: input.providerUidCommitment,
    setup: {
      login_submitted: true,
      owner_login_accepted: true,
      may_deposit: false,
      may_trade: false,
      may_transfer: false,
      may_withdraw: false,
    },
  }, 201);
}

async function ambiguousAndFreeze(input: {
  activationId: string;
  account: { owner_commitment: string; account_commitment: string };
  ownerAddress: `0x${string}`;
  nonce: string;
}) {
  try {
    await settlePrivateAsterOwnerActivationAttempt({
      activation_id: input.activationId,
      owner_commitment: input.account.owner_commitment,
      account_commitment: input.account.account_commitment,
      owner_address: input.ownerAddress,
      nonce: input.nonce,
      status: "ambiguous",
      provider_uid_commitment: null,
      failure_code: "aster_owner_activation_outcome_ambiguous",
      now: new Date(),
    });
  } catch {
    // A submitted attempt remains frozen even if durable settlement fails.
  }
  return ambiguous();
}

function existingAttempt(attempt: PrivateAsterOwnerActivationAttemptRecordV1 | null) {
  if (attempt?.status === "accepted" && attempt.provider_uid_commitment) {
    return accepted({
      activationId: attempt.activation_id,
      ownerAddress: attempt.owner_address,
      providerUidCommitment: attempt.provider_uid_commitment,
    });
  }
  const pendingExpired = attempt?.status === "pending" &&
    new Date(attempt.expires_at).getTime() <= Date.now();
  return json({
    error: pendingExpired
      ? "aster_owner_activation_attempt_expired"
      : "aster_owner_activation_attempt_locked",
    status: attempt?.status ?? "missing",
    retry_allowed: false,
    new_preparation_allowed: attempt?.status === "rejected" || pendingExpired,
  }, 409);
}

function ambiguous() {
  return json({
    error: "aster_owner_activation_outcome_ambiguous",
    retry_allowed: false,
    new_preparation_allowed: false,
  }, 502);
}

function explicitRejection(value: unknown): { code: string | number } | null {
  const envelope = record(value);
  const code = envelope.code;
  if (
    envelope.success !== false ||
    (typeof code !== "string" && typeof code !== "number") ||
    !String(code).trim() ||
    String(code) === "000000"
  ) return null;
  return { code };
}

function activationFailure(error: unknown, fallback: string, status: number) {
  const code = error instanceof AsterOwnerActivationError ? error.code : fallback;
  return json({ error: code }, status);
}

function bindingFailure(error: unknown) {
  const source = error instanceof Error ? error.message : "";
  const code = source.replace(/^lighter_turnkey_owner_binding_/, "aster_turnkey_owner_binding_");
  const status = Number((error as { status?: unknown } | null)?.status);
  return json({ error: code || "aster_turnkey_owner_binding_failed" }, [400, 403, 409, 503].includes(status) ? status : 503);
}

function ledgerFailure(error: unknown) {
  const code = string((error as { code?: unknown } | null)?.code) || "aster_owner_activation_attempt_ledger_unavailable";
  const status = Number((error as { status?: unknown } | null)?.status);
  return json({ error: code }, [409, 503].includes(status) ? status : 503);
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
